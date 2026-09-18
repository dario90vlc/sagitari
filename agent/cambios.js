'use strict';

/* ============================================================================
   cambios.js — el diff de lo que se ha tocado en este turno.

   Para revisar un cambio hay que poder VERLO. Este módulo guarda, antes de cada
   escritura, cómo estaba el archivo (o que no existía) y luego compone un diff
   legible: eso es lo que recibe el agente de revisión.

   ¿Por qué no `git diff`? Porque funcionaría solo en repos git y mezclaría los
   cambios del usuario con los del turno. Aquí interesa exactamente lo que ha
   cambiado EL AGENTE ahora, que es lo que hay que revisar; y funciona igual en
   una carpeta sin repositorio.
   ============================================================================ */

const fs = require('fs');

const MAX_ARCHIVOS = 12;              // archivos que entran en el diff
const MAX_LINEAS_POR_ARCHIVO = 160;   // líneas de cambio por archivo (con contexto)
const MAX_CHARS = 24000;              // tope duro del texto final
const MAX_BYTES_ORIGINAL = 2 * 1024 * 1024;

/* workspace -> Map(rutaAbsoluta -> contenido anterior | null si no existía) */
const guardados = new Map();
/* workspace -> Set(rutas cuya pre-imagen NO se pudo leer: no se pueden restaurar) */
const noRestaurables = new Map();

/** El contenido de un archivo tal y como estaba, o null si no existía / no es texto. */
function leerAntes(absPath) {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size > MAX_BYTES_ORIGINAL) return '';
    const buf = fs.readFileSync(absPath);
    if (buf.subarray(0, 8192).includes(0)) return '';
    return buf.toString('utf8');
  } catch { return null; }   // no existía: la pre-imagen es «nada»
}

/**
 * Guarda la pre-imagen ANTES de escribir. La primera vez manda: si un archivo se
 * escribe dos veces en el mismo turno, el diff debe partir de cómo estaba al
 * empezar, no de la escritura intermedia.
 */
function recordar(workspace, absPath, contenidoAnterior) {
  if (!workspace || !absPath) return;
  if (!guardados.has(workspace)) guardados.set(workspace, new Map());
  const mapa = guardados.get(workspace);
  if (mapa.has(absPath)) return;
  if (mapa.size >= MAX_ARCHIVOS * 4) return;   // un turno que toca cien archivos no se revisa así
  let antes = contenidoAnterior;
  if (antes === undefined) {
    antes = leerAntes(absPath);
    /* '' significa dos cosas distintas: un archivo vacío de verdad, o uno que no se
       pudo leer (binario o enorme). Para revisar daba igual; para DESHACER no: escribir
       '' en un binario de 30 MB lo dejaría a cero. Se marca y el deshacer lo respeta. */
    if (antes === '') {
      try {
        if (fs.statSync(absPath).size > 0) {
          if (!noRestaurables.has(workspace)) noRestaurables.set(workspace, new Set());
          noRestaurables.get(workspace).add(absPath);
        }
      } catch {}
    }
  }
  mapa.set(absPath, antes);
}

/** Lo que hay guardado para un espacio de trabajo (para decidir si hay algo que revisar). */
function hay(workspace) {
  const m = guardados.get(workspace);
  return !!m && m.size > 0;
}

function nombreRel(workspace, abs) {
  const w = String(workspace || '').replace(/[\\/]+$/, '');
  const a = String(abs);
  return a.toLowerCase().startsWith(w.toLowerCase()) ? a.slice(w.length).replace(/^[\\/]/, '') : a;
}

/* --------------------------------------------------------------------------- *
 *  Diff por líneas
 * --------------------------------------------------------------------------- */

const lineas = (t) => String(t == null ? '' : t).split(/\r?\n/);

/**
 * Diff de dos textos por prefijo/sufijo común y, si el trozo intermedio es
 * asumible, con una comparación real (LCS). Devuelve la lista de operaciones
 * { tipo: ' ', '-' o '+', texto } — sin índices de línea, que aquí no aportan.
 */
function diffLineas(antes, despues) {
  const A = lineas(antes), B = lineas(despues);
  let ini = 0;
  while (ini < A.length && ini < B.length && A[ini] === B[ini]) ini++;
  let finA = A.length, finB = B.length;
  while (finA > ini && finB > ini && A[finA - 1] === B[finB - 1]) { finA--; finB--; }
  const medioA = A.slice(ini, finA), medioB = B.slice(ini, finB);
  const ops = [];
  if (medioA.length * medioB.length <= 400000) {   // ~600x600 líneas como mucho
    const dp = Array.from({ length: medioA.length + 1 }, () => new Uint32Array(medioB.length + 1));
    for (let i = medioA.length - 1; i >= 0; i--) {
      for (let j = medioB.length - 1; j >= 0; j--) {
        dp[i][j] = medioA[i] === medioB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < medioA.length && j < medioB.length) {
      if (medioA[i] === medioB[j]) { ops.push({ tipo: ' ', texto: medioA[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ tipo: '-', texto: medioA[i] }); i++; }
      else { ops.push({ tipo: '+', texto: medioB[j] }); j++; }
    }
    while (i < medioA.length) ops.push({ tipo: '-', texto: medioA[i++] });
    while (j < medioB.length) ops.push({ tipo: '+', texto: medioB[j++] });
  } else {
    // cambio masivo (reescritura): no se calcula el diff fino, se cuentan los tramos
    for (const l of medioA.slice(0, 60)) ops.push({ tipo: '-', texto: l });
    for (const l of medioB.slice(0, 60)) ops.push({ tipo: '+', texto: l });
    if (medioA.length > 60 || medioB.length > 60) ops.push({ tipo: '~', texto: `(cambio masivo: ${medioA.length} líneas sustituidas por ${medioB.length})` });
  }
  return ops;
}

/** Contexto de 3 líneas alrededor de cada cambio y recorte con marca de omisión. */
function hunk(ops, contexto = 3, maxLineas = MAX_LINEAS_POR_ARCHIVO) {
  const interesantes = ops.map((o, i) => (o.tipo === ' ' ? -1 : i)).filter(i => i >= 0);
  if (!interesantes.length) return [];
  const porLinea = new Map();
  for (let i = 0; i < ops.length; i++) porLinea.set(i, false);
  for (const i of interesantes) {
    for (let k = Math.max(0, i - contexto); k <= Math.min(ops.length - 1, i + contexto); k++) porLinea.set(k, true);
  }
  const out = [];
  let salto = 0;
  for (let i = 0; i < ops.length; i++) {
    if (!porLinea.get(i)) { salto++; continue; }
    if (salto) { out.push({ tipo: '~', texto: `… (${salto} línea(s) sin cambios)` }); salto = 0; }
    out.push(ops[i]);
    if (out.length >= maxLineas) { out.push({ tipo: '~', texto: '… (recortado: hay más cambios)' }); break; }
  }
  return out;
}

/**
 * Texto del diff del turno. Devuelve '' si no hay nada guardado.
 *
 * NO se consume al leerlo: el diff del turno lo puede querer más de uno (la revisión,
 * un panel de cambios) y quien lo da por cerrado es `olvidar`, que el agente llama al
 * empezar el turno siguiente. Así el mapa nunca crece sin control.
 */
function diff(workspace, opts = {}) {
  const mapa = guardados.get(workspace);
  if (!mapa || !mapa.size) return '';
  const partes = [];
  let usados = 0;
  let n = 0;
  for (const [abs, antes] of mapa) {
    if (n++ >= (opts.maxArchivos || MAX_ARCHIVOS)) { partes.push(`… (y ${mapa.size - n + 1} archivo(s) más)`); break; }
    let ahora = null;
    try { ahora = fs.readFileSync(abs, 'utf8'); } catch {}
    if (antes === null && ahora === null) continue;            // se creó y se borró en el mismo turno
    const rel = nombreRel(workspace, abs);
    const cabecera = antes === null ? `--- NUEVO: ${rel}` : `--- ${rel}`;
    const ops = antes === null
      ? lineas(ahora).slice(0, 120).map(t => ({ tipo: '+', texto: t }))
      : diffLineas(antes, ahora);
    const cuerpo = antes === null ? ops : hunk(ops, opts.contexto || 3, opts.maxLineasPorArchivo || MAX_LINEAS_POR_ARCHIVO);
    if (antes !== null && !cuerpo.length) continue;             // sin cambios reales (se escribió igual)
    const texto = [cabecera, ...cuerpo.map(o => (o.tipo === ' ' ? '  ' : o.tipo + ' ') + o.texto)].join('\n');
    if (usados + texto.length > (opts.maxChars || MAX_CHARS)) { partes.push('… (diff recortado por tamaño)'); break; }
    partes.push(texto);
    usados += texto.length + 1;
  }
  return partes.join('\n');
}

/**
 * Líneas del archivo ACTUAL (1-based) que han cambiado en este turno, o null si no
 * se puede saber (no hay pre-imagen, el archivo es nuevo de este turno o el cambio
 * fue masivo).
 *
 * Sirve para no culpar al agente del desorden que YA estaba en el archivo: los
 * diagnósticos del proyecto que caen fuera de estas líneas son preexistentes, y
 * exigirle esos convierte cada comprobación en una invitación a refactorizar lo que
 * nadie le ha pedido (que es justo lo que la regla 4 de los subagentes prohíbe).
 */
function lineasCambiadas(workspace, absPath) {
  const mapa = guardados.get(workspace);
  if (!mapa || !mapa.has(absPath)) return null;
  const antes = mapa.get(absPath);
  if (antes === null || antes === undefined) return null;   // archivo nuevo: todo es nuevo
  let ahora = null;
  try { ahora = fs.readFileSync(absPath, 'utf8'); } catch { return null; }
  const ops = diffLineas(antes, ahora);
  /* `diffLineas` devuelve SOLO el tramo del medio: las líneas iguales del principio no
     vienen en la lista. Sin contarlas, la numeración salía desplazada y una línea
     tocada arriba del archivo se daba por no tocada (y al revés). */
  const A = String(antes).split(/\r?\n/), B = String(ahora).split(/\r?\n/);
  let ini = 0;
  while (ini < A.length && ini < B.length && A[ini] === B[ini]) ini++;
  const set = new Set();
  let n = ini;                                            // línea en el archivo nuevo
  for (const o of ops) {
    if (o.tipo === '~') return null;                     // cambio masivo: no se puede afinar
    if (o.tipo === ' ') { n++; continue; }
    if (o.tipo === '-') continue;                        // esa línea ya no existe
    if (o.tipo === '+') { n++; set.add(n); }
  }
  return set;
}

/** Resumen de una línea: qué archivos cambiaron (para logs y para el prompt). */
function resumen(workspace) {
  const mapa = guardados.get(workspace);
  if (!mapa) return '';
  return [...mapa.keys()].map(a => nombreRel(workspace, a)).join(', ');
}

/* --------------------------------------------------------------------------- *
 *  v2.5: deshacer el turno
 *
 *  La pre-imagen que ya se guardaba para revisar el cambio sirve también para
 *  volver atrás: es la misma información vista al revés. Lo que NO se puede
 *  restaurar son los archivos que no se pudieron leer antes (binarios o enormes):
 *  ahí la pre-imagen es '' y escribirla vaciaría el archivo, así que se marcan y
 *  el deshacer los deja como están, diciéndolo.
 * --------------------------------------------------------------------------- */

/** ¿Hay algo que deshacer en este espacio de trabajo? */
function puedeDeshacer(workspace) { return hay(workspace); }

/** Archivos que tocaría deshacer, con su acción ({rel, accion}). */
function planDeshacer(workspace) {
  const mapa = guardados.get(workspace);
  if (!mapa) return [];
  const no = noRestaurables.get(workspace) || new Set();
  const out = [];
  for (const [abs, antes] of mapa) {
    const rel = nombreRel(workspace, abs);
    if (no.has(abs)) out.push({ ruta: rel, rutaAbs: abs, accion: 'no-restaurable' });
    else if (antes === null) out.push({ ruta: rel, rutaAbs: abs, accion: 'borrar' });
    else out.push({ ruta: rel, rutaAbs: abs, accion: 'restaurar' });
  }
  return out;
}

/**
 * Deshace los cambios del turno: restaura lo que se modificó, borra lo que se creó.
 *
 * Solo toca lo que está DENTRO del espacio de trabajo y solo los archivos que este
 * turno tocó (la lista sale de la pre-imagen, no de adivinar). Después se olvida el
 * turno: no se puede deshacer dos veces ni «deshacer» un deshacer que ya no aplica.
 *
 * @returns {{archivos: Array<{ruta, accion}>, restaurados: number, borrados: number, fallos: number}}
 */
function deshacer(workspace, { soloRel = null } = {}) {
  const mapa = guardados.get(workspace);
  const vacio = { archivos: [], restaurados: 0, borrados: 0, fallos: 0 };
  if (!mapa || !mapa.size) return vacio;
  const no = noRestaurables.get(workspace) || new Set();
  const raiz = String(workspace || '').replace(/[\\/]+$/, '').toLowerCase();
  const archivos = [];
  let restaurados = 0, borrados = 0, fallos = 0;
  for (const [abs, antes] of mapa) {
    if (!String(abs).toLowerCase().startsWith(raiz)) { archivos.push({ ruta: nombreRel(workspace, abs), accion: 'fuera-del-espacio' }); continue; }
    if (soloRel && nombreRel(workspace, abs) !== soloRel) continue;
    const rel = nombreRel(workspace, abs);
    if (no.has(abs)) { archivos.push({ ruta: rel, accion: 'no-restaurable' }); fallos++; continue; }
    try {
      if (antes === null) {
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
        archivos.push({ ruta: rel, accion: 'borrado' });
        borrados++;
      } else {
        fs.writeFileSync(abs, antes, 'utf8');
        archivos.push({ ruta: rel, accion: 'restaurado' });
        restaurados++;
      }
    } catch (e) {
      archivos.push({ ruta: rel, accion: 'fallo', error: String((e && e.message) || e) });
      fallos++;
    }
  }
  // lo deshecho ya no está pendiente de revisión ni de deshacer
  olvidar(workspace);
  noRestaurables.delete(workspace);
  return { archivos, restaurados, borrados, fallos };
}

/** Rutas absolutas que este turno ha tocado (para hooks, resúmenes y avisos). */
function archivosTocados(workspace) {
  return planDeshacer(workspace).map(x => x.rutaAbs).filter(Boolean);
}

function olvidar(workspace) { guardados.delete(workspace); }
function limpiar() { guardados.clear(); noRestaurables.clear(); }

module.exports = {
  recordar, leerAntes, diff, resumen, hay, olvidar, limpiar, diffLineas, hunk, lineasCambiadas,
  puedeDeshacer, planDeshacer, deshacer, archivosTocados, MAX_ARCHIVOS,
};
