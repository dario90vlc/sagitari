'use strict';

/* Transporte MCP: JSON-RPC 2.0 delimitado por líneas (stdio) o por HTTP con SSE.
   Aquí no se sabe nada de herramientas: solo de mensajes, ids y timeouts. */

const { StringDecoder } = require('string_decoder');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { killTree } = require('./proc');

const DEFAULT_TIMEOUT_MS = 60000;

/* Tope de un mensaje del servidor: ni el búfer de stdio ni el cuerpo HTTP pueden
   crecer sin límite. 8 MB es holgadísimo para un mensaje MCP real (el resultado que
   acaba viendo el modelo se recorta mucho antes, en agent/mcp.js), así que pasarse
   solo lo hace un servidor roto o comprometido —y ahí hay que cortar la conexión en
   vez de dejar que el proceso principal se coma la memoria. */
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/**
 * Lector incremental: entrega cada mensaje JSON completo y cuenta el ruido.
 * Algunos servidores escriben un banner de arranque en stdout antes del primer
 * mensaje; una línea que no parsea no puede tumbar la conexión.
 * `onOverflow(motivo)`: se llama UNA vez si un mensaje pasa de MAX_MESSAGE_BYTES sin
 * terminar (una sola línea sin salto basta para llenar el búfer); a partir de ahí el
 * lector deja de acumular. El transporte decide cómo matar la conexión.
 */
function createLineReader(onMessage, onOverflow) {
  let buf = '';
  let noise = 0;
  let pendientes = 0; // bytes de `buf` (Buffer.byteLength sería O(n) por chunk)
  let roto = false;
  const dec = new StringDecoder('utf8'); // la conversión tiene que ser incremental:
  // un chunk puede cortar un carácter multibyte
  return (chunk) => {
    if (roto) return;
    const s = typeof chunk === 'string' ? chunk : dec.write(chunk);
    buf += s;
    pendientes += Buffer.byteLength(s, 'utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const crudo = buf.slice(0, idx);
      const line = crudo.replace(/\r$/, '');
      pendientes -= Buffer.byteLength(crudo, 'utf8') + 1; // + el '\n'
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
        noise++;
        continue;
      }
      onMessage(msg, noise);
    }
    if (pendientes > MAX_MESSAGE_BYTES) {
      roto = true;
      buf = '';
      pendientes = 0;
      if (typeof onOverflow === 'function') {
        onOverflow(
          `un mensaje del servidor MCP pasó de ${Math.round(MAX_MESSAGE_BYTES / (1024 * 1024))} MB sin terminar; se cortó la conexión.`,
        );
      }
    }
  };
}

/** Peticiones en vuelo emparejadas por id, con timeout y fallo global. */
class Rpc {
  constructor({ send, onNotice, defaultTimeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.send = send; // (text) => void
    this.onNotice = onNotice || (() => {}); // (method, params, id) => void; id es null
    // en las notificaciones y no-null cuando el
    // servidor espera respuesta (contestar con
    // send(JSON.stringify({ jsonrpc: '2.0', id, result })))
    this.timeoutMs = defaultTimeoutMs;
    this._id = 0;
    this._pending = new Map();
    this._dead = null;
  }

  request(method, params = {}, { timeoutMs, onStart } = {}) {
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
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      // El llamante puede querer el id para poder cancelar ESTA petición mientras
      // está en vuelo (p. ej. el botón Detener del agente).
      if (typeof onStart === 'function') {
        try {
          onStart(id);
        } catch {}
      }
      try {
        this.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (e) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  /**
   * Cancela UNA petición en vuelo (el usuario pulsó Detener): rechaza solo esa, no
   * la conexión entera. Devuelve true si había algo que cancelar.
   */
  cancel(id, reason) {
    const p = this._pending.get(id);
    if (!p) return false;
    this._pending.delete(id);
    p.reject(new Error(reason || 'petición cancelada'));
    return true;
  }

  notify(method, params = {}) {
    if (this._dead) return;
    try {
      this.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    } catch {}
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
    if (msg.method) {
      this.onNotice(msg.method, msg.params || {}, msg.id ?? null);
      return;
    }
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

  get alive() {
    return !this._dead;
  }
}

/* Línea de comandos para cmd.exe. En Windows `npx`/`npm` son .cmd y Node ≥20 se
   niega a lanzarlos directamente, así que hay que pasar por cmd.exe. Nada de
   `shell: true` con texto interpolado: los argumentos se citan uno a uno y lo que
   no se puede citar con seguridad se rechaza con un motivo legible. */
function buildCmdLine(command, args = []) {
  const partes = [String(command || ''), ...args.map((a) => String(a))];
  for (const p of partes) {
    if (/["%^&|<>]/.test(p) || /[\r\n]/.test(p)) {
      throw new Error(
        'El comando o un argumento contiene caracteres que cmd.exe interpretaría (" % ^ & | < > o salto de línea). Simplifícalo.',
      );
    }
  }
  return partes.map((p) => (/\s/.test(p) ? '"' + p + '"' : p)).join(' ');
}

/** ¿Hay que lanzarlo por cmd.exe? (los .cmd/.bat de npm en Windows) */
function needsShell(command) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(command || ''));
}

/* ¿Es el intérprete de Node? Los servidores MCP de stdio se configuran así en TODOS
   los clientes (`"command": "node"`), y es además lo que sugiere la propia interfaz. */
const ES_NODE = /^node(\.exe|\.cmd)?$/i;
/* Gestores de paquetes: son guiones de Node, así que sin Node.js no hay nada que hacer. */
const ES_GESTOR = /^(npx|npm|yarn|pnpm)$/i;

/** El valor del PATH, que en Windows viene como `Path` y en el resto como `PATH`. */
function valorPath(env) {
  if (!env) return '';
  for (const clave of ['PATH', 'Path', 'path']) if (env[clave]) return String(env[clave]);
  return '';
}

/**
 * ¿Existe este ejecutable en el PATH? Se comprueba a mano (sin lanzar `where.exe` ni
 * nada parecido) para que sea barato, puro y testeable: aquí se decide si un servidor
 * MCP arranca con el Node del equipo o con el que la app ya trae dentro.
 */
function buscarEnPath(nombre, { env = process.env, fsMod = fs } = {}) {
  const dirs = valorPath(env).split(path.delimiter).filter(Boolean);
  const conExt = /\.[a-z0-9]+$/i.test(nombre); // si ya trae extensión no se prueba a añadirle otra
  const exts =
    !conExt && process.platform === 'win32'
      ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
      : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      const p = path.join(d, nombre + ext);
      try {
        if (fsMod.existsSync(p)) return p;
      } catch {}
    }
  }
  return null;
}

/** El nombre con el que se llama a Node EN ESTE sistema. */
const nombreNode = () => (process.platform === 'win32' ? 'node.exe' : 'node');

/** ¿Tiene este equipo Node.js instalado (en el PATH)? De eso depende `npx`/`npm`; el
    Node que trae la app no sirve para eso, porque npm no viene dentro de Electron. */
function hayNodeEnPath(opts = {}) {
  return !!buscarEnPath(nombreNode(), opts);
}

/** El Node que YA viaja dentro de la app (Electron lo lleva): sirve para levantar un
    servidor MCP local sin que el usuario instale nada. `null` si esto no es Electron. */
function nodeDeLaApp({ esElectron = !!process.versions.electron, execPath = process.execPath } = {}) {
  return esElectron && execPath ? execPath : null;
}

function resolveCommand(command, args, opts = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('Falta el comando del servidor MCP.');

  /* Node: primero el que tenga el EQUIPO (no se cambia lo que ya funciona, ni su
     versión, ni el ABI de sus módulos nativos). Solo si no hay ninguno se usa el que
     la propia app trae dentro —`ELECTRON_RUN_AS_NODE` arranca SAGITARI como Node—
     para que un servidor MCP local funcione sin instalar nada. En desarrollo no hace
     falta casi nunca; en la app instalada, donde el usuario puede no tener Node, es
     la diferencia entre que el servidor arranque o muera con «spawn node ENOENT». */
  if (ES_NODE.test(cmd)) {
    const enPath = buscarEnPath(nombreNode(), opts);
    if (enPath) return { file: enPath, argv: args.map(String), verbatim: false, env: {} };
    const bundled = nodeDeLaApp(opts);
    if (bundled) return { file: bundled, argv: args.map(String), verbatim: false, env: { ELECTRON_RUN_AS_NODE: '1' } };
    throw new Error('No encuentro Node.js en este equipo. Instálalo (nodejs.org) o apunta el comando a un ejecutable concreto.');
  }

  if (needsShell(cmd) || ES_GESTOR.test(cmd)) {
    /* `npx`/`npm` son guiones que interpreta Node: sin Node.js el único resultado
       posible es un «no se reconoce como un comando» de cmd.exe que el usuario no
       puede arreglar sin saber qué falta. Se dice antes y con el arreglo. */
    if (ES_GESTOR.test(cmd) && !hayNodeEnPath(opts)) {
      throw new Error(
        '«' +
          cmd +
          '» necesita Node.js instalado en este equipo (la app no incluye npm). Instala Node.js desde nodejs.org y vuelve a probar; si el servidor es un archivo .js local, pon el COMANDO como «node» y su ruta en los argumentos.',
      );
    }
    const com = process.env.ComSpec || 'cmd.exe';
    // `verbatim` es imprescindible: si Node vuelve a citar por su cuenta, escapa las
    // comillas internas con \" y cmd.exe no entiende ese escape, así que un argumento
    // con espacios llegaba partido. cmd.exe espera /d /s /c "<línea>" tal cual.
    return { file: com, argv: ['/d', '/s', '/c', `"${buildCmdLine(cmd, args)}"`], verbatim: true, env: {} };
  }
  return { file: cmd, argv: args.map(String), verbatim: false, env: {} };
}

/**
 * Servidor MCP local por stdio. `stderr` se guarda en un bucle (los últimos 8 KB)
 * porque es donde los servidores explican por qué no arrancan.
 */
function createStdioTransport({ command, args = [], cwd, env = {}, defaultTimeoutMs, onNotice }) {
  const { file, argv, verbatim, env: envDelResolver = {} } = resolveCommand(command, args);
  const child = spawn(file, argv, {
    cwd: cwd || undefined,
    /* Lo que decida el resolver (por ejemplo `ELECTRON_RUN_AS_NODE` cuando se usa el
       Node que trae la app) va ANTES del entorno del servidor: lo que configure el
       usuario manda sobre nuestra decisión. */
    env: { ...process.env, ...envDelResolver, ...env },
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr = (stderr + d.toString('utf8')).slice(-8192);
  });
  // stdin de un servidor que acaba de morir: sin este listener, el EPIPE del write
  // es un error no capturado y se lleva por delante el proceso principal.
  child.stdin.on('error', () => {});
  const exitHandlers = [];
  let exited = false;
  // `rpc` se declara ANTES de los listeners que lo usan: `const rpc =` más abajo
  // dejaría a esos callbacks cerrando sobre una variable en zona muerta temporal.
  let rpc = null;
  // Muerte única: ninguna petición en vuelo puede quedarse esperando y quien escuche
  // recibe el motivo. `aviso` es lo que se le pasa al callback (el código del hijo
  // cuando lo hay); el motivo es siempre texto para poder enseñarlo.
  const terminar = (motivo, aviso) => {
    if (exited) return;
    exited = true;
    if (rpc) rpc.fail(motivo);
    for (const h of exitHandlers) {
      try {
        h(aviso);
      } catch {}
    }
  };
  const avisarSalida = (code) =>
    terminar(
      `el servidor MCP terminó (código ${code === null || code === undefined ? 'desconocido' : code}).` +
        (stderr ? '\n' + stderr.trim().split('\n').slice(-4).join('\n') : ''),
      code,
    );
  child.on('error', (e) => avisarSalida('error: ' + e.message));
  child.on('exit', (code) => avisarSalida(code));

  const feed = createLineReader(
    (m, noise) => {
      if (m && rpc) rpc.handleMessage(m);
    },
    // Un mensaje desmedido mataría la memoria del proceso: se corta la conexión y se
    // mata el hijo para que deje de escribir (mismo trato que una salida anómala).
    (motivo) => {
      terminar(motivo, motivo);
      try {
        killTree(child);
      } catch {}
    },
  );
  child.stdout.on('data', feed);
  rpc = new Rpc({
    send: (text) => {
      if (!child.stdin.destroyed) child.stdin.write(text + '\n');
    },
    onNotice,
    defaultTimeoutMs,
  });
  // cerrar stdin sin destruirlo a lo bruto: el servidor ve el final del flujo
  return {
    rpc,
    pid: child.pid,
    stderrTail: () => stderr,
    onExit: (cb) => {
      exitHandlers.push(cb);
      if (exited) cb(-1);
    },
    kill: () => {
      try {
        child.stdin.end();
      } catch {}
      try {
        killTree(child);
      } catch {}
    },
  };
}

/** Solo https, o http si el destino es loopback (ahí el token no sale del equipo). */
function httpUrlAllowed(raw) {
  let u = null;
  try {
    u = new URL(String(raw || ''));
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
}

/** Mensajes JSON de un cuerpo SSE (varias líneas `data:` se concatenan). */
function parseSseText(text) {
  const out = [];
  for (const bloque of String(text || '').split(/\r?\n\r?\n/)) {
    const datos = bloque
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart());
    if (!datos.length) continue;
    // Las líneas `data:` del mismo evento se unen con \n (spec SSE): entre tokens
    // ese salto es espacio en blanco válido para JSON. Un mensaje mal formado (una
    // cadena partida, por ejemplo) no parsea y se descarta.
    try {
      out.push(JSON.parse(datos.join('\n')));
    } catch {}
  }
  return out;
}

/**
 * Separa las credenciales que van DENTRO de la URL (`https://usuario:token@host/mcp`).
 * La Fetch API prohíbe el userinfo: `fetch` lanzaría «Request cannot be constructed
 * from a URL that includes credentials» y ese mensaje —con el token dentro— acabaría
 * en el log y en la vista. Aquí se saca del URL y se convierte en una cabecera Basic,
 * con la URL limpia como única forma de conectar.
 */
function partirUserinfo(raw) {
  let u = null;
  try {
    u = new URL(String(raw));
  } catch {
    return { url: String(raw), authorization: null };
  }
  if (!u.username && !u.password) return { url: String(raw), authorization: null };
  // `new URL` percent-codifica el userinfo; el valor original es el decodificado. Una
  // secuencia `%` inválida no puede reventar aquí (se deja tal cual, que es lo que el
  // usuario escribió) ni saltarse la validación de URL con un URIError.
  const dec = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const basic = Buffer.from(`${dec(u.username)}:${dec(u.password)}`, 'utf8').toString('base64');
  u.username = '';
  u.password = '';
  return { url: u.toString(), authorization: 'Basic ' + basic };
}

/**
 * Lee un cuerpo HTTP con un tope duro. `res.text()` carga TODO en memoria antes de
 * mirar nada, así que un servidor roto o comprometido podría llenar la memoria del
 * proceso principal con un cuerpo sin fin. Al pasarse del tope se corta la lectura.
 */
async function leerCuerpoAcotado(res, maxBytes) {
  const motivo = `el cuerpo del servidor MCP pasó de ${Math.round(maxBytes / (1024 * 1024))} MB; se cortó la conexión.`;
  if (!res.body || typeof res.body.getReader !== 'function') {
    const texto = await res.text();
    if (Buffer.byteLength(texto, 'utf8') > maxBytes) throw new Error(motivo);
    return texto;
  }
  const lector = res.body.getReader();
  const trozos = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await lector.cancel();
        } catch {}
        throw new Error(motivo);
      }
      trozos.push(Buffer.from(value));
    }
  } finally {
    try {
      lector.releaseLock();
    } catch {}
  }
  return Buffer.concat(trozos).toString('utf8');
}

/* Lee un flujo SSE y despacha cada evento EN CUANTO llega. La spec permite que el servidor
   deje el stream abierto (notificaciones posteriores); esperar al cierre daba por timeout
   una respuesta que ya estaba en el búfer. Se corta en cuanto llega la respuesta a nuestra
   petición (un mensaje sin `method`), o al agotar el tope de bytes. */
async function despacharSse(res, maxBytes, onMensaje) {
  const motivo = `el cuerpo del servidor MCP pasó de ${Math.round(maxBytes / (1024 * 1024))} MB; se cortó la conexión.`;
  if (!res.body || typeof res.body.getReader !== 'function') {
    const texto = await leerCuerpoAcotado(res, maxBytes);
    for (const m of parseSseText(texto)) if (onMensaje(m) === false) break;
    return;
  }
  const lector = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let total = 0;
  const despachar = (bloque) => parseSseText(bloque).every((m) => onMensaje(m) !== false);
  try {
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(motivo);
      buf += dec.decode(value, { stream: true });
      let corte;
      while ((corte = buf.search(/\r?\n\r?\n/)) !== -1) {
        const bloque = buf.slice(0, corte);
        buf = buf.slice(corte).replace(/^\r?\n\r?\n/, '');
        if (!despachar(bloque)) return;
      }
    }
    buf += dec.decode();
    if (buf.trim()) despachar(buf);
  } finally {
    // el servidor puede no cerrar nunca: se corta el stream al salir, con o sin respuesta
    try {
      await lector.cancel();
    } catch {}
    try {
      lector.releaseLock();
    } catch {}
  }
}

/**
 * Servidor MCP remoto: POST con JSON-RPC; la respuesta puede ser JSON directo o
 * un flujo SSE (streamable HTTP). El id de sesión que devuelva `initialize` se
 * reenvía en las peticiones siguientes.
 */
function createHttpTransport({ url, headers = {}, defaultTimeoutMs, fetchFn = fetch, onNotice }) {
  // Las credenciales del userinfo nunca viajan en la URL a fetch (la Fetch API las
  // rechaza y el token acabaría en el mensaje de error): se convierten en cabecera
  // Basic. Una cabecera Authorization puesta a mano manda sobre el userinfo.
  const { url: urlLimpia, authorization } = partirUserinfo(url);
  if (!httpUrlAllowed(urlLimpia)) throw new Error('La URL del servidor MCP debe ser https (o http en localhost).');
  const base = { ...headers };
  if (authorization && !Object.keys(base).some((k) => k.toLowerCase() === 'authorization')) {
    base.Authorization = authorization;
  }
  let session = null;
  const exitHandlers = [];
  let muerto = null;
  const avisarMuerte = (motivo) => {
    if (muerto) return;
    muerto = motivo;
    rpc.fail(motivo);
    for (const h of exitHandlers) {
      try {
        h(motivo);
      } catch {}
    }
  };
  const rpc = new Rpc({
    send: (text) => {
      void enviar(text);
    },
    onNotice,
    defaultTimeoutMs,
  });
  async function enviar(text) {
    const cabeceras = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...base };
    if (session) cabeceras['mcp-session-id'] = session;
    try {
      // El temporizador del Rpc acota la espera lógica; este signal acota la
      // petición HTTP de verdad (si no, una petición colgada deja el socket vivo
      // para siempre aunque la llamada ya haya fallado por timeout).
      const res = await fetchFn(urlLimpia, {
        method: 'POST',
        headers: cabeceras,
        body: text,
        // Sin esto, un endpoint comprometido contesta 302 a otro origen y las
        // cabeceras secretas viajan allí, saltándose el «solo https» de
        // httpUrlAllowed. Con `error`, fetch rechaza cualquier redirección.
        redirect: 'error',
        signal: AbortSignal.timeout((defaultTimeoutMs || DEFAULT_TIMEOUT_MS) + 2000),
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) session = sid;
      if (!res.ok) {
        avisarMuerte(`el servidor MCP respondió ${res.status}.`);
        return;
      }
      const tipo = String(res.headers.get('content-type') || '');
      /* Un flujo SSE se lee EN VIVO: según la spec el servidor puede dejarlo abierto y aun
         así haber respondido. Se corta en cuanto llega la respuesta a nuestra petición. */
      if (tipo.includes('text/event-stream')) {
        await despacharSse(res, MAX_MESSAGE_BYTES, (m) => {
          rpc.handleMessage(m);
          return !(m && m.method === undefined && ('result' in m || 'error' in m));
        });
        return;
      }
      const body = await leerCuerpoAcotado(res, MAX_MESSAGE_BYTES);
      // 202 sin cuerpo: es lo que la spec manda para notificaciones y respuestas, así
      // que no hay nada que interpretar (y no puede contar como caída del servidor)
      if (!body.trim()) return;
      rpc.handleMessage(JSON.parse(body));
    } catch (e) {
      // Un abort causado por nuestro propio tope no significa que el servidor esté
      // caído: el Rpc ya rechazó la petición con su mensaje de timeout, así que no
      // se marca muerto (si lo estuviera, la siguiente llamada lo comprobaría).
      // `AbortSignal.timeout()` rechaza con un DOMException llamado `TimeoutError`,
      // no `AbortError`: hay que cubrir los dos o la guarda no coincide nunca.
      if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) return;
      avisarMuerte('no se pudo hablar con el servidor MCP: ' + e.message);
    }
  }
  return {
    rpc,
    sessionId: () => session,
    onExit: (cb) => {
      exitHandlers.push(cb);
      if (muerto) cb(muerto);
    },
    kill: () => {
      session = null;
    },
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  createLineReader,
  Rpc,
  buildCmdLine,
  resolveCommand,
  buscarEnPath,
  createStdioTransport,
  httpUrlAllowed,
  parseSseText,
  createHttpTransport,
};
