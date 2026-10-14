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

const MAX_ARCHIVOS = 12; // archivos que entran en el diff
const MAX_LINEAS_POR_ARCHIVO = 160; // líneas de cambio por archivo (con contexto)
const MAX_CHARS = 24000; // tope duro del texto final
const MAX_BYTES_ORIGINAL = 2 * 1024 * 1024;

/* Las DOS tablas se indexan por DUEÑO + espacio de trabajo. El dueño es la conversación
   que escribe (el agente manda su id de sesión): dos conversaciones que compartan carpeta
   no pueden pisarse la pre-imagen la una a la otra — el `olvidar` del arranque de turno
   de una borraba el diff de la otra y «Revisar cambios» enseñaba archivos del turno
   ajeno. Sin dueño (todas las llamadas de antes) la clave es la de siempre y el
   comportamiento es idéntico. El espacio de trabajo sigue guardándose tal cual para las
   rutas y para `nombreRel`: la clave solo indexa, no sustituye a la carpeta. */
const claveDueno = (workspace, owner) => String(owner || '') + '\0' + String(workspace || '');
/* clave -> Map(rutaAbsoluta -> contenido anterior | null si no existía) */
const guardados = new Map();
/* clave -> Set(rutas cuya pre-imagen NO se pudo leer: no se pueden restaurar) */
const noRestaurables = new Map();

/** El contenido de un archivo tal y como estaba, o null si no existía / no es texto. */
function leerAntes(absPath) {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size > MAX_BYTES_ORIGINAL) return '';
    const buf = fs.readFileSync(absPath);
    if (buf.subarray(0, 8192).includes(0)) return '';
    return buf.toString('utf8');
  } catch {
    return null;
  } // no existía: la pre-imagen es «nada»
}

/**
 * Guarda la pre-imagen ANTES de escribir. La primera vez manda: si un archivo se
 * escribe dos veces en el mismo turno, el diff debe partir de cómo estaba al
 * empezar, no de la escritura intermedia.
 */
function recordar(workspace, absPath, contenidoAnterior, owner = '') {
  if (!workspace || !absPath) return;
  const k = claveDueno(workspace, owner);
  if (!guardados.has(k)) guardados.set(k, new Map());
  const mapa = guardados.get(k);
  if (mapa.has(absPath)) return;
  if (mapa.size >= MAX_ARCHIVOS * 4) return; // un turno que toca cien archivos no se revisa así
  let antes = contenidoAnterior;
  if (antes === undefined) {
    antes = leerAntes(absPath);
    /* '' significa dos cosas distintas: un archivo vacío de verdad, o uno que no se
       pudo leer (binario o enorme). Para revisar daba igual; para DESHACER no: escribir
       '' en un binario de 30 MB lo dejaría a cero. Se marca y el deshacer lo respeta. */
    if (antes === '') {
      try {
        if (fs.statSync(absPath).size > 0) {
          if (!noRestaurables.has(k)) noRestaurables.set(k, new Set());
          noRestaurables.get(k).add(absPath);
        }
      } catch {}
    }
  }
  mapa.set(absPath, antes);
}

/** Lo que hay guardado para un espacio de trabajo (para decidir si hay algo que revisar). */
function hay(workspace, owner = '') {
  const m = guardados.get(claveDueno(workspace, owner));
  return !!m && m.size > 0;
}

function nombreRel(workspace, abs) {
  const w = String(workspace || '').replace(/[\\/]+$/, '');
  const a = String(abs);
  return a.toLowerCase().startsWith(w.toLowerCase()) ? a.slice(w.length).replace(/^[\\/]/, '') : a;
}

/** Normaliza una ruta para compararla (barras '/', sin barra final, minúsculas). */
function normalRuta(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** ¿`abs` cae DENTRO del espacio de trabajo? La comparación es por CARPETA (`<raíz>/`),
    nunca por prefijo de texto: `C:\proj-viejo` no está dentro de `C:\proj`. Lo usan las
    dos vías de deshacer (el turno entero y el panel de revisión), que antes daban
    respuestas OPUESTAS para el mismo archivo. */
function dentroDelEspacio(workspace, abs) {
  const w = String(workspace || '');
  if (!w) return false;
  const raiz = normalRuta(w);
  const a = normalRuta(abs);
  return a === raiz || a.startsWith(raiz + '/');
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
  const A = lineas(antes),
    B = lineas(despues);
  let ini = 0;
  while (ini < A.length && ini < B.length && A[ini] === B[ini]) ini++;
  let finA = A.length,
    finB = B.length;
  while (finA > ini && finB > ini && A[finA - 1] === B[finB - 1]) {
    finA--;
    finB--;
  }
  const medioA = A.slice(ini, finA),
    medioB = B.slice(ini, finB);
  const ops = [];
  if (medioA.length * medioB.length <= 400000) {
    // ~600x600 líneas como mucho
    const dp = Array.from({ length: medioA.length + 1 }, () => new Uint32Array(medioB.length + 1));
    for (let i = medioA.length - 1; i >= 0; i--) {
      for (let j = medioB.length - 1; j >= 0; j--) {
        dp[i][j] = medioA[i] === medioB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0,
      j = 0;
    while (i < medioA.length && j < medioB.length) {
      if (medioA[i] === medioB[j]) {
        ops.push({ tipo: ' ', texto: medioA[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ tipo: '-', texto: medioA[i] });
        i++;
      } else {
        ops.push({ tipo: '+', texto: medioB[j] });
        j++;
      }
    }
    while (i < medioA.length) ops.push({ tipo: '-', texto: medioA[i++] });
    while (j < medioB.length) ops.push({ tipo: '+', texto: medioB[j++] });
  } else {
    // cambio masivo (reescritura): no se calcula el diff fino, se cuentan los tramos
    for (const l of medioA.slice(0, 60)) ops.push({ tipo: '-', texto: l });
    for (const l of medioB.slice(0, 60)) ops.push({ tipo: '+', texto: l });
    if (medioA.length > 60 || medioB.length > 60)
      ops.push({ tipo: '~', texto: `(cambio masivo: ${medioA.length} líneas sustituidas por ${medioB.length})` });
  }
  return ops;
}

/** Contexto de 3 líneas alrededor de cada cambio y recorte con marca de omisión. */
function hunk(ops, contexto = 3, maxLineas = MAX_LINEAS_POR_ARCHIVO) {
  const interesantes = ops.map((o, i) => (o.tipo === ' ' ? -1 : i)).filter((i) => i >= 0);
  if (!interesantes.length) return [];
  const porLinea = new Map();
  for (let i = 0; i < ops.length; i++) porLinea.set(i, false);
  for (const i of interesantes) {
    for (let k = Math.max(0, i - contexto); k <= Math.min(ops.length - 1, i + contexto); k++) porLinea.set(k, true);
  }
  const out = [];
  let salto = 0;
  for (let i = 0; i < ops.length; i++) {
    if (!porLinea.get(i)) {
      salto++;
      continue;
    }
    if (salto) {
      out.push({ tipo: '~', texto: `… (${salto} línea(s) sin cambios)` });
      salto = 0;
    }
    out.push(ops[i]);
    if (out.length >= maxLineas) {
      out.push({ tipo: '~', texto: '… (recortado: hay más cambios)' });
      break;
    }
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
function diff(workspace, opts = {}, owner = '') {
  const mapa = guardados.get(claveDueno(workspace, owner));
  if (!mapa || !mapa.size) return '';
  const partes = [];
  let usados = 0;
  let n = 0;
  for (const [abs, antes] of mapa) {
    if (n++ >= (opts.maxArchivos || MAX_ARCHIVOS)) {
      partes.push(`… (y ${mapa.size - n + 1} archivo(s) más)`);
      break;
    }
    let ahora = null;
    try {
      ahora = fs.readFileSync(abs, 'utf8');
    } catch {}
    if (antes === null && ahora === null) continue; // se creó y se borró en el mismo turno
    const rel = nombreRel(workspace, abs);
    const cabecera = antes === null ? `--- NUEVO: ${rel}` : `--- ${rel}`;
    const ops =
      antes === null
        ? lineas(ahora)
            .slice(0, 120)
            .map((t) => ({ tipo: '+', texto: t }))
        : diffLineas(antes, ahora);
    const cuerpo = antes === null ? ops : hunk(ops, opts.contexto || 3, opts.maxLineasPorArchivo || MAX_LINEAS_POR_ARCHIVO);
    if (antes !== null && !cuerpo.length) continue; // sin cambios reales (se escribió igual)
    const texto = [cabecera, ...cuerpo.map((o) => (o.tipo === ' ' ? '  ' : o.tipo + ' ') + o.texto)].join('\n');
    if (usados + texto.length > (opts.maxChars || MAX_CHARS)) {
      partes.push('… (diff recortado por tamaño)');
      break;
    }
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
function lineasCambiadas(workspace, absPath, owner = '') {
  const mapa = guardados.get(claveDueno(workspace, owner));
  if (!mapa || !mapa.has(absPath)) return null;
  const antes = mapa.get(absPath);
  if (antes === null || antes === undefined) return null; // archivo nuevo: todo es nuevo
  let ahora = null;
  try {
    ahora = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
  const ops = diffLineas(antes, ahora);
  /* `diffLineas` devuelve SOLO el tramo del medio: las líneas iguales del principio no
     vienen en la lista. Sin contarlas, la numeración salía desplazada y una línea
     tocada arriba del archivo se daba por no tocada (y al revés). */
  const A = String(antes).split(/\r?\n/),
    B = String(ahora).split(/\r?\n/);
  let ini = 0;
  while (ini < A.length && ini < B.length && A[ini] === B[ini]) ini++;
  const set = new Set();
  let n = ini; // línea en el archivo nuevo
  for (const o of ops) {
    if (o.tipo === '~') return null; // cambio masivo: no se puede afinar
    if (o.tipo === ' ') {
      n++;
      continue;
    }
    if (o.tipo === '-') continue; // esa línea ya no existe
    if (o.tipo === '+') {
      n++;
      set.add(n);
    }
  }
  return set;
}

/** Resumen de una línea: qué archivos cambiaron (para logs y para el prompt). */
function resumen(workspace, owner = '') {
  const mapa = guardados.get(claveDueno(workspace, owner));
  if (!mapa) return '';
  return [...mapa.keys()].map((a) => nombreRel(workspace, a)).join(', ');
}

/* --------------------------------------------------------------------------- *
 *  v4.1: el diff ESTRUCTURADO del panel
 *
 *  El texto de `diff()` está pensado para que lo lea un modelo (el revisor); el panel
 *  necesita lo mismo, pero en datos: archivos, contadores y líneas con su tipo. Es el
 *  MISMO differ (diffLineas + hunk), no una segunda implementación que pueda divergir:
 *  aquí solo se cambian las etiquetas (' ', '+', '-', '~') por las del panel
 *  ('ctx', 'add', 'del') y se parte la lista en hunks.
 * --------------------------------------------------------------------------- */

/** '~' es una marca de omisión o de cambio masivo: el panel la pinta como contexto. */
const TIPO_PANEL = { ' ': 'ctx', '+': 'add', '-': 'del', '~': 'ctx' };

/** Parte el resultado de `hunk()` en hunks: una marca '~' cierra el hunk abierto (su
    texto se queda dentro, como línea informativa) y lo que venga después abre otro. */
function hunksDe(cuerpo, cabecera) {
  const hunks = [];
  let actual = null;
  const abrir = () => {
    actual = { cabecera, lineas: [] };
    hunks.push(actual);
  };
  for (const o of cuerpo) {
    if (o.tipo === '~') {
      if (!actual) abrir();
      actual.lineas.push({ tipo: 'ctx', texto: o.texto });
      actual = null; // la omisión separa: lo siguiente es otro hunk
      continue;
    }
    if (!actual) abrir();
    actual.lineas.push({ tipo: TIPO_PANEL[o.tipo] || 'ctx', texto: o.texto });
  }
  return hunks;
}

/**
 * El diff del turno en datos, para el panel de revisión:
 *   [{ path, rel, adds, dels, noReversible?, hunks: [{ cabecera, lineas: [{tipo, texto}] }] }]
 * `path` es la ruta ABSOLUTA (es lo que devuelve `archivoRevertir`), `rel` la relativa al
 * espacio de trabajo. `noReversible` solo aparece cuando el archivo no se puede restaurar
 * (binario o enorme: su pre-imagen no se pudo leer). Devuelve [] si no hay nada guardado.
 */
function diffEstructurado(workspace, opts = {}, owner = '') {
  const mapa = guardados.get(claveDueno(workspace, owner));
  if (!mapa || !mapa.size) return [];
  const no = noRestaurables.get(claveDueno(workspace, owner)) || new Set();
  const out = [];
  let n = 0;
  for (const [abs, antes] of mapa) {
    if (n++ >= (opts.maxArchivos || MAX_ARCHIVOS)) break;
    let ahora = null;
    try {
      ahora = fs.readFileSync(abs, 'utf8');
    } catch {}
    if (antes === null && ahora === null) continue; // se creó y se borró en el mismo turno
    const rel = nombreRel(workspace, abs);
    const cabecera = antes === null ? `--- NUEVO: ${rel}` : `--- ${rel}`;
    const ops = antes === null ? lineas(ahora).map((t) => ({ tipo: '+', texto: t })) : diffLineas(antes, ahora);
    const corte = 120; // igual que el diff de texto: un archivo nuevo se enseña, no se copia entero
    const cuerpo =
      antes === null
        ? ops.length > corte
          ? [...ops.slice(0, corte), { tipo: '~', texto: `… (${ops.length - corte} línea(s) más)` }]
          : ops
        : hunk(ops, opts.contexto ?? 3, opts.maxLineasPorArchivo || MAX_LINEAS_POR_ARCHIVO);
    if (antes !== null && !cuerpo.length) continue; // sin cambios reales (se escribió igual)
    out.push({
      path: abs,
      rel,
      adds: ops.filter((o) => o.tipo === '+').length,
      dels: ops.filter((o) => o.tipo === '-').length,
      ...(no.has(abs) ? { noReversible: true } : {}),
      hunks: hunksDe(cuerpo, cabecera),
    });
  }
  return out;
}

/**
 * Vuelve atrás UN archivo del turno, dejando los demás como están.
 *
 * Acepta la ruta absoluta (la que da `diffEstructurado`) o la relativa (la del panel), y
 * compara normalizando separadores: Windows mezcla `\` y `/` según quién escriba la ruta.
 * Si la pre-imagen es `null`, el turno CREÓ el archivo y revertir es borrarlo. Al terminar,
 * el archivo sale del estado del turno (el panel vuelve a preguntar y ya no aparece, y
 * deshacer el turno entero tampoco lo vuelve a tocar).
 *
 * @returns {{ok: boolean, rel?: string, borrado?: boolean, accion?: string, error?: string}}
 */
function archivoRevertir(workspace, archivo, owner = '') {
  const k = claveDueno(workspace, owner);
  const mapa = guardados.get(k);
  if (!mapa || !mapa.size) return { ok: false, error: 'no hay ningún cambio de este turno que revertir' };
  const clave = normalRuta(archivo);
  let abs = null;
  for (const [a] of mapa) {
    if (normalRuta(a) === clave || normalRuta(nombreRel(workspace, a)) === clave) {
      abs = a;
      break;
    }
  }
  if (!abs) return { ok: false, error: `«${String(archivo)}» no forma parte de los cambios de este turno` };

  const no = noRestaurables.get(k);
  if (no && no.has(abs)) {
    return {
      ok: false,
      error: `no puedo revertir «${nombreRel(workspace, abs)}»: no se pudo leer antes (es binario o demasiado grande) y escribir la pre-imagen lo dejaría peor`,
    };
  }
  /* Solo se toca lo que está DENTRO del espacio de trabajo: la lista sale de la pre-imagen,
     pero una entrada de fuera no se restaura ni aunque esté en el mapa. */
  if (!dentroDelEspacio(workspace, abs))
    return { ok: false, error: `«${nombreRel(workspace, abs)}» está fuera del espacio de trabajo: no lo toco` };

  const antes = mapa.get(abs);
  const rel = nombreRel(workspace, abs);
  try {
    if (antes === null) {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } else {
      fs.writeFileSync(abs, antes, 'utf8');
    }
  } catch (e) {
    return { ok: false, error: `no pude escribir «${rel}»: ${String((e && e.message) || e)}` };
  }
  mapa.delete(abs);
  if (no) no.delete(abs);
  if (!mapa.size) {
    guardados.delete(k);
    noRestaurables.delete(k);
  }
  return { ok: true, rel, borrado: antes === null, accion: antes === null ? 'borrado' : 'restaurado' };
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
function puedeDeshacer(workspace, owner = '') {
  return hay(workspace, owner);
}

/** Archivos que tocaría deshacer, con su acción ({rel, accion}). */
function planDeshacer(workspace, owner = '') {
  const k = claveDueno(workspace, owner);
  const mapa = guardados.get(k);
  if (!mapa) return [];
  const no = noRestaurables.get(k) || new Set();
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
function deshacer(workspace, { soloRel = null } = {}, owner = '') {
  const k = claveDueno(workspace, owner);
  const mapa = guardados.get(k);
  const vacio = { archivos: [], restaurados: 0, borrados: 0, fallos: 0 };
  if (!mapa || !mapa.size) return vacio;
  const no = noRestaurables.get(k) || new Set();
  const archivos = [];
  let restaurados = 0,
    borrados = 0,
    fallos = 0;
  for (const [abs, antes] of mapa) {
    if (!dentroDelEspacio(workspace, abs)) {
      archivos.push({ ruta: nombreRel(workspace, abs), accion: 'fuera-del-espacio' });
      continue;
    }
    if (soloRel && nombreRel(workspace, abs) !== soloRel) continue;
    const rel = nombreRel(workspace, abs);
    if (no.has(abs)) {
      archivos.push({ ruta: rel, accion: 'no-restaurable' });
      fallos++;
      continue;
    }
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
  olvidar(workspace, owner);
  noRestaurables.delete(k);
  return { archivos, restaurados, borrados, fallos };
}

/** Rutas absolutas que este turno ha tocado (para hooks, resúmenes y avisos). */
function archivosTocados(workspace, owner = '') {
  return planDeshacer(workspace, owner)
    .map((x) => x.rutaAbs)
    .filter(Boolean);
}

function olvidar(workspace, owner = '') {
  guardados.delete(claveDueno(workspace, owner));
}
function limpiar() {
  guardados.clear();
  noRestaurables.clear();
}

module.exports = {
  recordar,
  leerAntes,
  diff,
  resumen,
  hay,
  olvidar,
  limpiar,
  diffLineas,
  hunk,
  diffEstructurado,
  archivoRevertir,
  lineasCambiadas,
  puedeDeshacer,
  planDeshacer,
  deshacer,
  archivosTocados,
  MAX_ARCHIVOS,
};
