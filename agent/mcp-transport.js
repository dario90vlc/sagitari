'use strict';

/* Transporte MCP: JSON-RPC 2.0 delimitado por líneas (stdio) o por HTTP con SSE.
   Aquí no se sabe nada de herramientas: solo de mensajes, ids y timeouts. */

const { StringDecoder } = require('string_decoder');
const { spawn } = require('child_process');
const { killTree } = require('./proc');

const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Lector incremental: entrega cada mensaje JSON completo y cuenta el ruido.
 * Algunos servidores escriben un banner de arranque en stdout antes del primer
 * mensaje; una línea que no parsea no puede tumbar la conexión.
 */
function createLineReader(onMessage) {
  let buf = '';
  let noise = 0;
  const dec = new StringDecoder('utf8');   // la conversión tiene que ser incremental:
                                           // un chunk puede cortar un carácter multibyte
  return (chunk) => {
    buf += typeof chunk === 'string' ? chunk : dec.write(chunk);
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { noise++; continue; }
      onMessage(msg, noise);
    }
  };
}

/** Peticiones en vuelo emparejadas por id, con timeout y fallo global. */
class Rpc {
  constructor({ send, onNotice, defaultTimeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.send = send;                       // (text) => void
    this.onNotice = onNotice || (() => {}); // (method, params, id) => void; id es null
                                            // en las notificaciones y no-null cuando el
                                            // servidor espera respuesta (contestar con
                                            // send(JSON.stringify({ jsonrpc: '2.0', id, result })))
    this.timeoutMs = defaultTimeoutMs;
    this._id = 0;
    this._pending = new Map();
    this._dead = null;
  }

  request(method, params = {}, { timeoutMs } = {}) {
    if (this._dead) return Promise.reject(new Error(this._dead));
    const id = ++this._id;
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        const cuanto = ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms)} ms`;
        reject(new Error(`timeout: ${method} no respondió en ${cuanto}.`));
      }, ms);
      this._pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { this.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }
      catch (e) { this._pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  notify(method, params = {}) {
    if (this._dead) return;
    try { this.send(JSON.stringify({ jsonrpc: '2.0', method, params })); } catch {}
  }

  /**
   * Respuesta o mensaje del servidor.
   * `onNotice(method, params, id)`: el tercer argumento es null en las
   * notificaciones y no-null cuando el servidor espera respuesta.
   */
  handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    // Las peticiones del servidor se miran ANTES que las respuestas: una respuesta
    // nunca lleva `method`, y un `ping` del servidor con un id que choque con una
    // petición nuestra se consumía como si fuera su respuesta.
    if (msg.method) { this.onNotice(msg.method, msg.params || {}, msg.id ?? null); return; }
    if (msg.id != null && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) p.reject(new Error('servidor MCP: ' + (msg.error.message || JSON.stringify(msg.error))));
      else p.resolve(msg.result);
    }
  }

  /** El transporte murió: ninguna petición en vuelo puede quedarse esperando. */
  fail(reason) {
    this._dead = String(reason || 'la conexión con el servidor MCP se cerró.');
    for (const p of this._pending.values()) p.reject(new Error(this._dead));
    this._pending.clear();
  }

  get alive() { return !this._dead; }
}

/* Línea de comandos para cmd.exe. En Windows `npx`/`npm` son .cmd y Node ≥20 se
   niega a lanzarlos directamente, así que hay que pasar por cmd.exe. Nada de
   `shell: true` con texto interpolado: los argumentos se citan uno a uno y lo que
   no se puede citar con seguridad se rechaza con un motivo legible. */
function buildCmdLine(command, args = []) {
  const partes = [String(command || ''), ...args.map((a) => String(a))];
  for (const p of partes) {
    if (/["%^&|<>]/.test(p) || /[\r\n]/.test(p)) {
      throw new Error('El comando o un argumento contiene caracteres que cmd.exe interpretaría (" % ^ & | < > o salto de línea). Simplifícalo.');
    }
  }
  return partes.map((p) => (/\s/.test(p) ? '"' + p + '"' : p)).join(' ');
}

/** ¿Hay que lanzarlo por cmd.exe? (los .cmd/.bat de npm en Windows) */
function needsShell(command) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(command || ''));
}

function resolveCommand(command, args) {
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('Falta el comando del servidor MCP.');
  if (needsShell(cmd) || /^(npx|npm|yarn|pnpm)$/i.test(cmd)) {
    const com = process.env.ComSpec || 'cmd.exe';
    // `verbatim` es imprescindible: si Node vuelve a citar por su cuenta, escapa las
    // comillas internas con \" y cmd.exe no entiende ese escape, así que un argumento
    // con espacios llegaba partido. cmd.exe espera /d /s /c "<línea>" tal cual.
    return { file: com, argv: ['/d', '/s', '/c', `"${buildCmdLine(cmd, args)}"`], verbatim: true };
  }
  return { file: cmd, argv: args.map(String), verbatim: false };
}

/**
 * Servidor MCP local por stdio. `stderr` se guarda en un bucle (los últimos 8 KB)
 * porque es donde los servidores explican por qué no arrancan.
 */
function createStdioTransport({ command, args = [], cwd, env = {}, defaultTimeoutMs, onNotice }) {
  const { file, argv, verbatim } = resolveCommand(command, args);
  const child = spawn(file, argv, {
    cwd: cwd || undefined,
    env: { ...process.env, ...env },
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d.toString('utf8')).slice(-8192); });
  // stdin de un servidor que acaba de morir: sin este listener, el EPIPE del write
  // es un error no capturado y se lleva por delante el proceso principal.
  child.stdin.on('error', () => {});
  const exitHandlers = [];
  let exited = false;
  // `rpc` se declara ANTES de los listeners que lo usan: `const rpc =` más abajo
  // dejaría a esos callbacks cerrando sobre una variable en zona muerta temporal.
  let rpc = null;
  const avisarSalida = (code) => {
    if (exited) return;
    exited = true;
    if (rpc) rpc.fail(`el servidor MCP terminó (código ${code === null || code === undefined ? 'desconocido' : code}).` + (stderr ? '\n' + stderr.trim().split('\n').slice(-4).join('\n') : ''));
    for (const h of exitHandlers) { try { h(code); } catch {} }
  };
  child.on('error', (e) => avisarSalida('error: ' + e.message));
  child.on('exit', (code) => avisarSalida(code));

  const feed = createLineReader((m, noise) => { if (m && rpc) rpc.handleMessage(m); });
  child.stdout.on('data', feed);
  rpc = new Rpc({
    send: (text) => { if (!child.stdin.destroyed) child.stdin.write(text + '\n'); },
    onNotice,
    defaultTimeoutMs,
  });
  // cerrar stdin sin destruirlo a lo bruto: el servidor ve el final del flujo
  return {
    rpc,
    pid: child.pid,
    stderrTail: () => stderr,
    onExit: (cb) => { exitHandlers.push(cb); if (exited) cb(-1); },
    kill: () => { try { child.stdin.end(); } catch {} try { killTree(child); } catch {} },
  };
}

/** Solo https, o http si el destino es loopback (ahí el token no sale del equipo). */
function httpUrlAllowed(raw) {
  let u = null;
  try { u = new URL(String(raw || '')); } catch { return false; }
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
}

/** Mensajes JSON de un cuerpo SSE (varias líneas `data:` se concatenan). */
function parseSseText(text) {
  const out = [];
  for (const bloque of String(text || '').split(/\r?\n\r?\n/)) {
    const datos = bloque.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart());
    if (!datos.length) continue;
    // La spec SSE une las líneas `data:` con \n, pero hay emisores que parten el
    // JSON en mitad de una cadena: ahí ese \n lo invalida, así que se reintenta con
    // la concatenación cruda (que reproduce el JSON original tal cual).
    let m;
    try { m = JSON.parse(datos.join('\n')); }
    catch { try { m = JSON.parse(datos.join('')); } catch { continue; } }
    out.push(m);
  }
  return out;
}

/**
 * Servidor MCP remoto: POST con JSON-RPC; la respuesta puede ser JSON directo o
 * un flujo SSE (streamable HTTP). El id de sesión que devuelva `initialize` se
 * reenvía en las peticiones siguientes.
 */
function createHttpTransport({ url, headers = {}, defaultTimeoutMs, fetchFn = fetch, onNotice }) {
  if (!httpUrlAllowed(url)) throw new Error('La URL del servidor MCP debe ser https (o http en localhost).');
  let session = null;
  const exitHandlers = [];
  let muerto = null;
  const avisarMuerte = (motivo) => {
    if (muerto) return;
    muerto = motivo;
    rpc.fail(motivo);
    for (const h of exitHandlers) { try { h(motivo); } catch {} }
  };
  const rpc = new Rpc({
    send: (text) => { void enviar(text); },
    onNotice,
    defaultTimeoutMs,
  });
  async function enviar(text) {
    const cabeceras = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers };
    if (session) cabeceras['mcp-session-id'] = session;
    try {
      // El temporizador del Rpc acota la espera lógica; este signal acota la
      // petición HTTP de verdad (si no, una petición colgada deja el socket vivo
      // para siempre aunque la llamada ya haya fallado por timeout).
      const res = await fetchFn(url, { method: 'POST', headers: cabeceras, body: text, signal: AbortSignal.timeout((defaultTimeoutMs || DEFAULT_TIMEOUT_MS) + 2000) });
      const sid = res.headers.get('mcp-session-id');
      if (sid) session = sid;
      if (!res.ok) { avisarMuerte(`el servidor MCP respondió ${res.status}.`); return; }
      const tipo = String(res.headers.get('content-type') || '');
      const body = await res.text();
      const mensajes = tipo.includes('text/event-stream') ? parseSseText(body) : [JSON.parse(body)];
      for (const m of mensajes) rpc.handleMessage(m);
    } catch (e) {
      // Un abort causado por nuestro propio tope no significa que el servidor esté
      // caído: el Rpc ya rechazó la petición con su mensaje de timeout, así que no
      // se marca muerto (si lo estuviera, la siguiente llamada lo comprobaría).
      if (e && e.name === 'AbortError') return;
      avisarMuerte('no se pudo hablar con el servidor MCP: ' + e.message);
    }
  }
  return {
    rpc,
    sessionId: () => session,
    onExit: (cb) => { exitHandlers.push(cb); if (muerto) cb(muerto); },
    kill: () => { session = null; },
  };
}

module.exports = { DEFAULT_TIMEOUT_MS, createLineReader, Rpc, buildCmdLine, resolveCommand, createStdioTransport, httpUrlAllowed, parseSseText, createHttpTransport };
