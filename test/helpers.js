'use strict';

/* helpers.js — utilidades compartidas de la suite (test/run.js las reexporta).
 *
 * El runner creció hasta 7500 líneas con los mismos ayudantes copiados en cada
 * época (sseResponse, fakeFetch, evData…). Aquí viven UNA vez: los fakes de red
 * (SSE/fetch), los constructores de turnos (sseTurn/toolTurn) y las esperas
 * (wait/waitFor). Cada ayudante documenta POR QUÉ existe, no solo qué hace.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/* Los tests crean almacenes temporales (memoria, checkpoints, skills…): se anotan
   aquí para borrarlos al terminar. Sin esto, cada ejecución dejaba basura en %TEMP%. */
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };

/* La suite NO puede escribir en los datos reales del usuario. Cada módulo de
   agent/ resuelve su carpeta AL CARGARSE (agent/datadir.js), así que la raíz de
   prueba se fija aquí, antes de requerirlos: sin esto cada `npm test` dejaba un
   run-<ts>.jsonl nuevo en %APPDATA%\SagitariAI\logs, con eventos indistinguibles
   de una sesión real, y el panel de registros de la app los mostraba. */
process.env.SAGITARI_DATA_DIR = tmpDir('sagitari-datadir-');

let pass = 0, fail = 0;
const failures = [];
/* Los tests se ENCOLAN y se ejecutan al final, en orden de registro (ver el cierre
   del fichero). Antes cada uno arrancaba al registrarse, así que las secciones se
   solapaban entre sí: el estado global (directorio de tareas, memoria, hábitos…)
   cambiaba mientras otro test estaba a mitad y aparecían fallos que dependían del
   tiempo y del orden de registro. */
const QUEUE = [];

function test(name, fn) { QUEUE.push({ name, fn }); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'eq') + `: esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)}`); }
function ok(v, msg) { if (!v) throw new Error(msg || 'esperado verdadero'); }

/* Red de seguridad del propio runner: un test async que nunca resuelve dejaba el
   proceso sin resumen y salía con código 0 (CI en verde con la suite colgada).
   El temporizador se deja "vivo" a propósito: mantiene el proceso en pie hasta
   dispararse, y se cancela justo antes de imprimir el resumen. */
/* El tope subió de 120 a 240 s cuando el test del actualizador pasó a ejecutar un
   Electron de verdad (y su control): son ~20 s más, y con el tope anterior la suite
   quedaba a menos de 20 s del límite — un runner de CI cargado habría hecho fallar la
   release por reloj, no por un fallo. Sigue sirviendo para lo que existe: un test
   colgado no espera cuatro minutos. Los dos escenarios del actualizador llevan además
   su PROPIO tope (45 s cada uno), así que un cuelgue ahí se corta solo. */
const SUITE_TIMEOUT_MS = 240000;
const suiteTimer = setTimeout(() => {
  console.error(`\nLa suite no terminó en ${SUITE_TIMEOUT_MS / 1000}s: algún test se quedó colgado.`);
  process.exit(1);
}, SUITE_TIMEOUT_MS);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Espera a que se cumpla una condición, con deadline. La cola de tareas encadena
    varias escrituras síncronas de disco (save → _pump → _start → resume → chat →
    complete → finally) y una espera fija de 60 ms se queda corta en una máquina
    cargada: eso era rojo intermitente en el gate de release. */
const waitFor = async (fn, ms = 4000) => {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await wait(25);
  }
};

/* Fakes de red: el proveedor habla SSE y fetch, así que los tests también. */
function sseResponse(chunks, status = 200) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}
function fakeFetch(chunks, sink) {
  return async (url, opts) => {
    if (sink) { sink.url = url; sink.headers = opts.headers; sink.body = JSON.parse(opts.body); }
    return sseResponse(chunks);
  };
}
const evData = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
const evNamed = (name, o) => `event: ${name}\ndata: ${JSON.stringify(o)}\n\n`;
const noSignal = () => new AbortController().signal;

/* Constructores de turnos: un turno de texto y un turno de llamada a herramienta. */
function sseTurn(content) { return sseResponse([evData({ choices: [{ delta: { content } }] })]); }
function toolTurn(id, name, args) {
  return sseResponse([evData({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] })]);
}
function autoApprove(agent, events) {
  return (e) => { events.push(e); if (e.type === 'confirm_request') setTimeout(() => agent.resolveConfirm(e.id, true), 0); };
}

/* Ajustes mínimos para instanciar un Agent en los tests. */
const SETTINGS_BASE = (extra) => ({
  active: { providerId: 'p1', name: 'uno', baseUrl: 'https://api.uno.com/v1', apiKey: 'k', model: 'gpt-4o' },
  providers: [{ id: 'p1', name: 'uno', baseUrl: 'https://api.uno.com/v1', apiKey: 'k', models: ['gpt-4o'] }],
  settings: { mode: 'act', modelRouting: false, workspace: process.cwd(), ...(extra || {}) },
});

/** Respuesta SSE que se corta a media lectura (fallo del proveedor con el stream abierto). */
function sseRota(chunk) {
  const enc = new TextEncoder();
  let primera = true;
  // el primer trozo SÍ se entrega y solo después revienta la lectura: es el fallo real
  // (proveedor que corta a media respuesta), no un error de conexión antes de empezar
  const body = new ReadableStream({
    pull(c) { if (primera) { primera = false; c.enqueue(enc.encode(chunk)); } else c.error(new Error('conexión cortada')); },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Cierre de la suite: ejecuta TODOS los tests registrados, en orden. */
async function runAll() {
  for (const t of QUEUE) {
    try {
      await t.fn();
      pass++; console.log('  ok  ' + t.name);
    } catch (e) {
      fail++; failures.push({ name: t.name, err: e.message });
      console.error('FAIL  ' + t.name + ' — ' + e.message);
    }
  }
  // limpieza: la suite no debe dejar basura en %TEMP%
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  clearTimeout(suiteTimer);   // fin normal: el vigilante ya no hace falta
  console.log('');
  if (fail) {
    console.error(`${fail} test(s) fallaron, ${pass} pasaron`);
    failures.forEach((f) => console.error('  ✗ ' + f.name + ' → ' + f.err));
    process.exit(1);
  } else {
    console.log(`Todos los tests en verde (${pass})`);
  }
}

module.exports = {
  fs, path, os, TMP_DIRS, tmpDir,
  pass: () => pass, fail: () => fail,
  QUEUE, test, eq, ok,
  SUITE_TIMEOUT_MS, suiteTimer,
  wait, waitFor,
  sseResponse, fakeFetch, evData, evNamed, noSignal,
  sseTurn, toolTurn, autoApprove, SETTINGS_BASE, sseRota,
  runAll,
};
