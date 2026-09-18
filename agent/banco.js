'use strict';
/*
 * banco.js — v2.5: el banco de pruebas de TAREAS.
 *
 *  Todo lo demás que hay en este proyecto mide el CÓDIGO de SAGITARI (344 pruebas muy
 *  contentas de sí mismas). Esto mide lo otro: si el AGENTE hace bien su trabajo. La
 *  diferencia importa porque la calidad de un agente no vive en una función que se puede
 *  aislar, vive en el conjunto (prompt + herramientas + orquestación + skills), y contra
 *  ese conjunto un test unitario no dice nada. Un banco de tareas sí: le das un punto de
 *  partida, un objetivo y un criterio de éxito, y mira si lo cumple.
 *
 *  Una TAREA es una carpeta en `bench/tareas/<nombre>/` con:
 *    · `tarea.json`  — qué se pide y cómo se decide si está bien.
 *    · `inicio/`     — los archivos del punto de partida (se copian a un espacio temporal;
 *                      el banco NUNCA trabaja sobre tu proyecto).
 *
 *  Y un criterio de éxito tiene dos mitades, las dos objetivas:
 *    · `comprobar`: un comando (normalmente las pruebas del propio proyecto de la tarea).
 *      Si sale 0, la mitad está ganada. Es la verdad del mundo, no la opinión del modelo.
 *    · `espera`: qué tiene que existir o dejar de existir al terminar (`existe`, `contiene`,
 *      `noExiste`, `sinCambios`).
 *
 *  Lo que produce cada corrida: ¿pasa o no? cuánto tardó, cuántos pasos, cuántos tokens y
 *  cuánto costó. Eso es lo que permite decir «esto es mejor que ayer» con números, y lo
 *  que hace que cambiar un prompt deje de ser una apuesta.
 *
 *  Nada de esto llama al modelo por su cuenta: el banco recibe el agente (o una fábrica),
 *  así que las pruebas del banco corren con un modelo de mentira y no cuestan un céntimo.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR_POR_DEFECTO = path.join(__dirname, '..', 'bench', 'tareas');
const MAX_SALIDA = 4000;   // lo que se guarda de la salida de una comprobación

/* --------------------------------------------------------------------------- *
 *  Leer tareas
 * --------------------------------------------------------------------------- */

/**
 * Lee y valida una tarea. Una tarea mal escrita se DICE (con su motivo): un
 * `tarea.json` roto que se ignora en silencio es peor que no tener banco, porque da
 * la sensación de estar midiendo cuando no se mide nada.
 * @returns {{ok: boolean, error?: string, tarea?: object}}
 */
function leerTarea(dir) {
  const f = path.join(dir, 'tarea.json');
  let json = null;
  try { json = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { return { ok: false, error: 'no se pudo leer tarea.json: ' + ((e && e.message) || e) }; }
  const nombre = String(json.nombre || path.basename(dir)).trim();
  const objetivo = String(json.objetivo || '').trim();
  if (!objetivo) return { ok: false, error: nombre + ': falta «objetivo» (es lo que se le pide al agente)' };
  const espera = Array.isArray(json.espera) ? json.espera.filter(e => e && (e.archivo || e.ruta)) : [];
  const comprobar = json.comprobar ? String(json.comprobar).trim() : '';
  if (!espera.length && !comprobar) return { ok: false, error: nombre + ': sin «espera» ni «comprobar» no hay forma de saber si está bien' };
  return {
    ok: true,
    tarea: {
      nombre,
      dir,
      inicio: path.join(dir, 'inicio'),
      objetivo,
      comprobar,
      espera: espera.map(e => ({
        archivo: String(e.archivo || e.ruta),
        existe: e.existe === undefined ? undefined : !!e.existe,
        contiene: e.contiene === undefined ? undefined : String(e.contiene),
        noContiene: e.noContiene === undefined ? undefined : String(e.noContiene),
        noExiste: e.noExiste === undefined ? undefined : !!e.noExiste,
        sinCambios: e.sinCambios === undefined ? undefined : !!e.sinCambios,
      })),
      pasosMax: Number.isFinite(Number(json.pasosMax)) ? Number(json.pasosMax) : 0,
      tiempoMaxMs: Number.isFinite(Number(json.tiempoMaxMs)) ? Number(json.tiempoMaxMs) : 300000,
      etiquetas: Array.isArray(json.etiquetas) ? json.etiquetas.map(String) : [],
      nota: json.nota ? String(json.nota) : '',
    },
  };
}

/** Todas las tareas de un directorio (y las que están mal, aparte). */
function tareas(dir = DIR_POR_DEFECTO, { filtro = null } = {}) {
  const out = [];
  const malas = [];
  let entradas = [];
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { ok: [], malas: [] }; }
  for (const e of entradas) {
    if (!e.isDirectory()) continue;
    const r = leerTarea(path.join(dir, e.name));
    if (!r.ok) { malas.push({ nombre: e.name, error: r.error }); continue; }
    if (filtro && !new RegExp(String(filtro), 'i').test(r.tarea.nombre)) continue;
    out.push(r.tarea);
  }
  return { ok: out.sort((a, b) => a.nombre.localeCompare(b.nombre)), malas };
}

/* --------------------------------------------------------------------------- *
 *  Decidir si una tarea está bien hecha
 * --------------------------------------------------------------------------- */

/** Comprueba la mitad «espera» sobre el espacio de trabajo ya terminado. */
function revisarEsperas(workspace, espera, antes = {}) {
  const fallos = [];
  for (const e of espera) {
    const abs = path.join(workspace, e.archivo);
    const existe = fs.existsSync(abs);
    if (e.noExiste) {
      if (existe) fallos.push(e.archivo + ': no debería existir y existe');
      continue;
    }
    if (e.existe === false) {
      if (existe) fallos.push(e.archivo + ': no debería existir y existe');
      continue;
    }
    if (e.existe === true && !existe) { fallos.push(e.archivo + ': no se creó'); continue; }
    if (!existe) {
      // sin `existe` explícito, se sobreentiende que hay que leerlo
      if (e.contiene || e.noContiene || e.sinCambios) { fallos.push(e.archivo + ': no existe'); continue; }
      continue;
    }
    let texto = '';
    try { texto = fs.readFileSync(abs, 'utf8'); } catch { fallos.push(e.archivo + ': no se pudo leer'); continue; }
    if (e.contiene && !texto.includes(e.contiene)) fallos.push(e.archivo + ': no contiene «' + e.contiene + '»');
    if (e.noContiene && texto.includes(e.noContiene)) fallos.push(e.archivo + ': contiene «' + e.noContiene + '» y no debería');
    // `sinCambios` compara con el punto de partida: es la forma de comprobar que se
    // respetó un «no toques esto» en vez de creerse la palabra del modelo.
    if (e.sinCambios) {
      const previo = antes[e.archivo];
      if (previo === undefined) fallos.push(e.archivo + ': sinCambios exige que el archivo estuviera en el punto de partida');
      else if (previo !== texto) fallos.push(e.archivo + ': debía quedarse igual y se modificó');
    }
  }
  return { ok: fallos.length === 0, fallos };
}

/** Contenido original de los archivos del punto de partida (para `sinCambios`). */
function leerInicio(dirInicio) {
  const out = {};
  const rec = (rel) => {
    const abs = path.join(dirInicio, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) rec(r);
      else { try { out[r.replace(/\\/g, '/')] = fs.readFileSync(path.join(dirInicio, r), 'utf8'); } catch {} }
    }
  };
  try { rec(''); } catch {}
  return out;
}

/**
 * Veredicto de una corrida, a partir de los datos ya recogidos. Función pura: no toca
 * disco ni red, para que se pueda probar (y para que el informe sea reproducible).
 */
function juzgar({ esperas = { ok: true, fallos: [] }, comprobacion = null, error = null, ms = 0, pasos = 0, tarea = {} } = {}) {
  const motivos = [];
  if (error) motivos.push('el agente terminó con error: ' + error);
  if (!esperas.ok) motivos.push(...esperas.fallos);
  if (comprobacion) {
    if (comprobacion.code !== 0) {
      motivos.push('«' + comprobacion.comando + '» salió con código ' + (comprobacion.code === null ? 'desconocido' : comprobacion.code));
    }
  } else if (tarea.comprobar) {
    motivos.push('no se llegó a ejecutar «' + tarea.comprobar + '»');
  }
  if (tarea.pasosMax && pasos > tarea.pasosMax) motivos.push('se pasó del tope de pasos (' + pasos + ' > ' + tarea.pasosMax + ')');
  if (tarea.tiempoMaxMs && ms > tarea.tiempoMaxMs) motivos.push('se pasó del tiempo máximo (' + Math.round(ms / 1000) + ' s > ' + Math.round(tarea.tiempoMaxMs / 1000) + ' s)');
  return { pasa: motivos.length === 0, motivos };
}

/* --------------------------------------------------------------------------- *
 *  Correr una tarea
 * --------------------------------------------------------------------------- */

/**
 * Corre UNA tarea: copia el punto de partida a un espacio temporal, deja que el agente
 * trabaje ahí y mide. El espacio temporal se conserva si la tarea falla (o si se pide):
 * el valor de un banco de pruebas está en poder mirar el desastre.
 *
 * @param {object} tarea
 * @param {{agent?: object, settings?: object, signal?: AbortSignal, emit?: Function,
 *          conservar?: boolean, baseTemporal?: string}} opts
 */
async function correrTarea(tarea, opts = {}) {
  const { agent = null, settings = {}, signal = null, emit = () => {}, conservar = false, baseTemporal = null } = opts;
  const tmp = fs.mkdtempSync(path.join(baseTemporal || os.tmpdir(), 'sagi-banco-' + tarea.nombre.replace(/[^\w.-]+/g, '_') + '-'));
  const ws = path.join(tmp, 'trabajo');
  fs.mkdirSync(ws, { recursive: true });
  try { if (fs.existsSync(tarea.inicio)) fs.cpSync(tarea.inicio, ws, { recursive: true }); } catch {}
  const antes = leerInicio(tarea.inicio);

  const ajustes = {
    ...settings,
    settings: { mode: 'act', ...(settings.settings || {}), workspace: ws },
  };

  const t0 = Date.now();
  let error = null;
  let meta = null;
  if (!agent) { error = 'no se pasó ningún agente al banco'; }
  else {
    try { await agent.chat(tarea.objetivo, ajustes); }
    catch (e) { error = String((e && e.message) || e); }
    try { meta = agent.getMeta ? agent.getMeta() : null; } catch { meta = null; }
  }
  const ms = Date.now() - t0;

  // La comprobación del proyecto de la TAREA (no de la app): su salida manda.
  let comprobacion = null;
  if (tarea.comprobar && !error) {
    try {
      const { ejecutarComandoVerificacion } = require('./executors');
      const r = await ejecutarComandoVerificacion(tarea.comprobar, { cwd: ws, timeoutMs: Math.max(30000, tarea.tiempoMaxMs || 0) });
      comprobacion = {
        comando: tarea.comprobar,
        code: r.code,
        salida: String((r.stdout || '') + (String(r.stderr || '').trim() ? '\n' + r.stderr : '')).slice(-MAX_SALIDA),
      };
    } catch (e) {
      comprobacion = { comando: tarea.comprobar, code: null, salida: 'no se pudo ejecutar: ' + ((e && e.message) || e) };
    }
  }

  const esperas = revisarEsperas(ws, tarea.espera, antes);
  const pasos = meta ? (meta.toolCalls || 0) : 0;
  const v = juzgar({ esperas, comprobacion, error, ms, pasos, tarea });
  const resultado = {
    nombre: tarea.nombre,
    etiquetas: tarea.etiquetas,
    pasa: v.pasa,
    motivos: v.motivos,
    ms,
    pasos,
    tokens: meta ? (meta.tokensIn || 0) + (meta.tokensOut || 0) : 0,
    costeUsd: meta ? (meta.costUsd || 0) : 0,
    llamadasModelo: meta ? (meta.llmCalls || 0) : 0,
    herramientas: agent && agent.getToolsFired ? agent.getToolsFired() : [],
    comprobacion,
    espacio: ws,
    conservado: false,
  };
  if (!resultado.pasa || conservar) resultado.conservado = true;
  else { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  resultado.espacio = resultado.conservado ? ws : '(borrado al pasar)';
  emit({ type: 'banco_tarea', ...resultado });
  return resultado;
}

/* --------------------------------------------------------------------------- *
 *  Correr el banco entero y comparar con la línea base
 * --------------------------------------------------------------------------- */

/**
 * Corre todas las tareas (en serie: el banco mide CALIDAD, y con varias a la vez el
 * veredicto se contamina con la contención de la máquina).
 */
async function correrTodo(opts = {}) {
  const { dir = DIR_POR_DEFECTO, filtro = null, nuevoAgente = null, settings = {}, etiqueta = '', conservar = false } = opts;
  const { ok: lista, malas } = tareas(dir, { filtro });
  const resultados = [];
  for (const t of lista) {
    let agent = null;
    try { agent = nuevoAgente ? await nuevoAgente(t) : null; }
    catch (e) { agent = null; }
    resultados.push(await correrTarea(t, { agent, settings, conservar }));
  }
  const resumen = {
    tareas: resultados.length,
    pasaron: resultados.filter(r => r.pasa).length,
    ms: resultados.reduce((a, r) => a + r.ms, 0),
    tokens: resultados.reduce((a, r) => a + r.tokens, 0),
    costeUsd: resultados.reduce((a, r) => a + r.costeUsd, 0),
    pasos: resultados.reduce((a, r) => a + r.pasos, 0),
  };
  return { cuando: new Date().toISOString(), etiqueta, modelo: (settings.active && settings.active.model) || null, resumen, resultados, malas };
}

/**
 * Compara un informe con la línea base. Aquí está la razón de ser del banco: un cambio
 * de prompt que arregla una tarea y rompe otra vez se ve; sin esto, se sube a ciegas.
 * Solo las REGRESIONES hacen fallar el gate: una mejora o una tarea nueva no pueden
 * bloquear nada.
 */
function comparar(reporte, base) {
  const prev = new Map(((base && base.resultados) || []).map(r => [r.nombre, r]));
  const ahora = new Map((reporte.resultados || []).map(r => [r.nombre, r]));
  const regresiones = [], mejoras = [], nuevos = [], faltantes = [], avisos = [];
  for (const [nombre, r] of ahora) {
    const b = prev.get(nombre);
    if (!b) { nuevos.push({ nombre, pasa: r.pasa }); continue; }
    if (b.pasa && !r.pasa) regresiones.push({ nombre, antes: 'pasaba', ahora: 'falla', motivos: r.motivos });
    else if (!b.pasa && r.pasa) mejoras.push({ nombre });
    else if (b.pasa && r.pasa) {
      // pasaba y pasa: pero, ¿a qué precio? Un aviso no bloquea, solo informa.
      const t = r.ms / Math.max(1, b.ms), tok = r.tokens / Math.max(1, b.tokens);
      if (t > 1.6 || tok > 1.6) avisos.push({ nombre, ms: r.ms, antesMs: b.ms, tokens: r.tokens, antesTokens: b.tokens });
    }
  }
  for (const nombre of prev.keys()) if (!ahora.has(nombre)) faltantes.push({ nombre });
  return { regresiones, mejoras, nuevos, faltantes, avisos, hayRegresion: regresiones.length > 0 };
}

/** Línea base en disco (la de `bench/linea-base.json`). */
function leerBase(archivo) {
  try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { return null; }
}
function guardarBase(archivo, reporte) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  fs.writeFileSync(archivo, JSON.stringify({ cuando: reporte.cuando, modelo: reporte.modelo, resumen: reporte.resumen, resultados: reporte.resultados }, null, 2) + '\n');
  return archivo;
}

/** Tabla legible para la consola (lo que ve quien lanza el banco a mano). */
function tabla(reporte) {
  const filas = (reporte.resultados || []).map(r => [
    r.pasa ? 'OK  ' : 'FALLA',
    r.nombre,
    (r.ms / 1000).toFixed(1) + 's',
    String(r.pasos),
    String(r.tokens),
    r.costeUsd ? '$' + r.costeUsd.toFixed(4) : '',
  ]);
  const ancho = (i) => Math.max(...filas.map(f => f[i].length), 4);
  const lineas = filas.map(f => `  ${f[0]}  ${f[1].padEnd(ancho(1))}  ${f[2].padStart(7)}  ${f[3].padStart(5)} paso(s)  ${f[4].padStart(7)} tok  ${f[5]}`);
  const s = reporte.resumen || {};
  const cab = `BANCO DE TAREAS${reporte.modelo ? ' · ' + reporte.modelo : ''} · ${s.pasaron || 0}/${s.tareas || 0} pasaron · ${((s.ms || 0) / 1000).toFixed(1)}s · ${s.tokens || 0} tokens`;
  const fallos = (reporte.resultados || []).filter(r => !r.pasa)
    .map(r => '    - ' + r.nombre + ': ' + r.motivos.join('; '));
  return [cab, ...lineas, ...(fallos.length ? ['  Motivos:', ...fallos] : [])].join('\n');
}

module.exports = {
  DIR_POR_DEFECTO,
  leerTarea, tareas, leerInicio, revisarEsperas, juzgar,
  correrTarea, correrTodo, comparar, leerBase, guardarBase, tabla,
};
