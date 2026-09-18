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
  mapa.set(absPath, contenidoAnterior === undefined ? leerAntes(absPath) : contenidoAnterior);
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

/** Resumen de una línea: qué archivos cambiaron (para logs y para el prompt). */
function resumen(workspace) {
  const mapa = guardados.get(workspace);
  if (!mapa) return '';
  return [...mapa.keys()].map(a => nombreRel(workspace, a)).join(', ');
}

function olvidar(workspace) { guardados.delete(workspace); }
function limpiar() { guardados.clear(); }

module.exports = { recordar, leerAntes, diff, resumen, hay, olvidar, limpiar, diffLineas, hunk, MAX_ARCHIVOS };
