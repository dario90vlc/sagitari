'use strict';

/* Cliente MCP de SAGITARI: registro de servidores, conexión, catálogo y llamadas.
   Sin dependencias nuevas y sin saber de Electron: el transporte se inyecta
   (`makeTransport`), así que todo esto se prueba con servidores de mentira y con
   uno real por stdio (test/fixtures/mcp-echo-server.js). */

const transport = require('./mcp-transport');

const MAX_TOOL_NAME = 64;
const MAX_TOOLS_PER_SERVER = 500;
const MAX_PAGES = 20;
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_RESULT_CHARS = 60000;

/** Trozo saneado `[a-z0-9_]` sin guiones bajos sobrantes. */
function slug(s, max) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
    .replace(/_+$/, '');
}

/**
 * Nombre con el que la herramienta viaja al modelo: `mcp__<servidor>__<herramienta>`.
 * Es imposible que pise una herramienta nativa (todas empiezan por letra) y cabe en
 * los 64 caracteres que imponen los proveedores.
 */
function mapToolName(serverId, toolName) {
  const srv = slug(serverId, 16) || 'srv';
  const tool = slug(toolName, 40) || 'tool';
  return `mcp__${srv}__${tool}`.slice(0, MAX_TOOL_NAME).replace(/_+$/, '');
}

/** Una línea, sin markdown ni saltos: es texto de un tercero en el prompt. */
function oneLine(text, max = 300) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

class McpManager {
  constructor({ servers = [], dataDir, clientVersion = '0', log = () => {}, makeTransport = null }) {
    this.dataDir = dataDir;
    this.clientVersion = String(clientVersion);
    this.log = log;
    this._makeTransport = makeTransport || ((s) => this._realTransport(s));
    this._servers = [];
    this._state = new Map();   // id -> { state, error, tools, logTail, attempts, transport, exposed }
    this.configure(servers);
  }

  /** Reconciliar con la configuración: arranca lo nuevo, para lo quitado o cambiado. */
  configure(servers) {
    const previos = new Map(this._servers.map(s => [s.id, s]));
    this._servers = (Array.isArray(servers) ? servers : []).filter(s => s && s.id);
    for (const s of this._servers) {
      const antes = previos.get(s.id);
      const st = this._state.get(s.id);
      if (!st) { this._state.set(s.id, { state: 'idle', error: null, tools: [], logTail: '', attempts: 0, transport: null, exposed: new Map() }); continue; }
      // si cambió algo del transporte o se deshabilitó, lo conectado ya no vale
      const clave = (x) => JSON.stringify({ c: x.command, a: x.args, u: x.url, h: x.headers, e: x.env, t: x.transport, d: x.cwd });
      if ((!antes || clave(antes) !== clave(s) || !s.enabled) && st.transport) this._drop(s.id, 'configuración cambiada');
    }
    for (const id of [...this._state.keys()]) if (!this._servers.some(s => s.id === id)) this._drop(id);
    this._rebuildExposed();
  }

  /**
   * Reconstruye la tabla de nombres expuestos de TODOS los servidores listos, con un
   * conjunto de nombres COMPARTIDO: así un cambio de allow/deny se aplica sin matar
   * el proceso del servidor y dos servidores con el mismo prefijo saneado no pueden
   * emitir el mismo nombre (el segundo sería inalcanzable).
   */
  _rebuildExposed() {
    const usados = new Set();
    for (const s of this._servers) {
      const st = this._state.get(s.id);
      if (!st || st.state !== 'ready') continue;
      st.exposed = this._exposeTable(s.id, st.tools, usados);
    }
  }

  _server(id) { return this._servers.find(s => s.id === id) || null; }

  /** Transporte real: stdio o HTTP según la configuración del servidor. */
  _realTransport(s) {
    const timeoutMs = Number(s.timeoutMs) > 0 ? Number(s.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const onNotice = (method, params, id) => this._answerNotice(s.id, method, params, id);
    if (s.transport === 'http') {
      if (!transport.httpUrlAllowed(s.url)) throw new Error('La URL debe ser https (o http en localhost).');
      return transport.createHttpTransport({ url: s.url, headers: s.headers || {}, defaultTimeoutMs: timeoutMs, onNotice });
    }
    return transport.createStdioTransport({
      command: s.command, args: s.args || [], cwd: s.cwd || this.dataDir, env: s.env || {}, defaultTimeoutMs: timeoutMs, onNotice,
    });
  }

  /**
   * Peticiones que hace EL SERVIDOR. Se contesta `ping` (un servidor que hace ping
   * y no recibe respuesta puede dar la conexión por muerta). El resto se ignora a
   * propósito: en `initialize` no declaramos capacidades de sampling/roots, así que
   * un servidor conforme no las pedirá y atenderlas ampliaría la superficie sin
   * necesidad.
   */
  _answerNotice(serverId, method, params, id) {
    if (method !== 'ping' || id == null) return;
    const st = this._state.get(serverId);
    if (st && st.transport) {
      try { st.transport.rpc.send(JSON.stringify({ jsonrpc: '2.0', id, result: {} })); } catch {}
    }
  }

  _drop(id, motivo) {
    const st = this._state.get(id);
    if (!st) return;
    if (st.transport) { try { st.transport.kill(); } catch {} }
    st.transport = null;
    st.tools = [];
    st.exposed = new Map();
    st.state = 'idle';
    st.error = motivo || null;
  }

  /**
   * Conectar (si hace falta) y traer el catálogo. Nunca lanza: devuelve
   * { ok, error } para que la UI y el agente puedan explicarse.
   */
  async ensure(id) {
    const s = this._server(id);
    const st = this._state.get(id);
    if (!s || !st) return { ok: false, error: 'servidor MCP desconocido' };
    if (!s.enabled) return { ok: false, error: 'el servidor MCP está deshabilitado' };
    if (st.state === 'ready') return { ok: true };
    if (st._connecting) return st._connecting;
    st._connecting = this._connect(s, st).finally(() => { st._connecting = null; });
    return st._connecting;
  }

  async _connect(s, st) {
    const timeoutMs = Number(s.timeoutMs) > 0 ? Number(s.timeoutMs) : DEFAULT_TIMEOUT_MS;
    st.state = 'starting';
    st.error = null;
    try {
      const tr = this._makeTransport(s);
      st.transport = tr;
      tr.onExit((motivo) => {
        if (st.transport !== tr) return;   // salida tardía de un transporte ya olvidado
        st.state = 'dead';
        st.error = String(motivo || 'el servidor terminó');
        st.logTail = tr.stderrTail ? tr.stderrTail() : '';
        st.tools = [];
        st.exposed = new Map();
      });
      const init = await tr.rpc.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'SAGITARI', version: this.clientVersion },
      }, { timeoutMs });
      tr.rpc.notify('notifications/initialized', {});
      const caps = (init && init.capabilities) || {};
      st.serverInfo = (init && init.serverInfo) || null;
      st.tools = caps.tools ? await this._listTools(tr, s, timeoutMs) : [];
      st.state = 'ready';
      this._rebuildExposed();
      st.error = null;
      st.logTail = tr.stderrTail ? tr.stderrTail() : '';
      this.log({ agent: 'sagitari', event: 'mcp_ready', server: s.id, tools: st.tools.length });
      return { ok: true, tools: st.tools.length };
    } catch (e) {
      st.state = 'dead';
      st.error = e.message;
      st.logTail = st.transport && st.transport.stderrTail ? st.transport.stderrTail() : '';
      if (st.transport) { try { st.transport.kill(); } catch {} st.transport = null; }
      st.tools = [];
      st.exposed = new Map();
      this.log({ agent: 'sagitari', event: 'mcp_error', server: s.id, message: e.message });
      return { ok: false, error: e.message };
    }
  }

  /** tools/list paginado por cursor, con topes para que un servidor roto no cuelgue nada. */
  async _listTools(tr, s, timeoutMs) {
    const out = [];
    let cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await tr.rpc.request('tools/list', cursor ? { cursor } : {}, { timeoutMs });
      for (const t of (res && res.tools) || []) {
        if (t && t.name) out.push(t);
        if (out.length >= MAX_TOOLS_PER_SERVER) return out;
      }
      cursor = res && res.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  /** Tabla nombre expuesto → herramienta real, resolviendo colisiones con sufijo. */
  _exposeTable(serverId, tools, usados = new Set()) {
    const allow = this._server(serverId).tools && this._server(serverId).tools.allow;
    const deny = (this._server(serverId).tools && this._server(serverId).tools.deny) || [];
    const expuesta = new Map();
    for (const t of tools) {
      if (deny.includes(t.name)) continue;
      if (Array.isArray(allow) && allow.length && !allow.includes(t.name)) continue;
      let name = mapToolName(serverId, t.name);
      let n = 2;
      while (usados.has(name)) {
        const sufijo = '_' + n++;
        name = mapToolName(serverId, t.name).slice(0, MAX_TOOL_NAME - sufijo.length) + sufijo;
      }
      usados.add(name);
      expuesta.set(name, t);
    }
    return expuesta;
  }

  /** Definiciones para el modelo: solo de servidores habilitados y listos. */
  toolDefs() {
    const defs = [];
    for (const s of this._servers) {
      if (!s.enabled) continue;
      const st = this._state.get(s.id);
      if (!st || st.state !== 'ready') continue;
      for (const [name, t] of st.exposed) {
        defs.push({
          type: 'function',
          function: {
            name,
            description: `[MCP · ${oneLine(s.name || s.id, 40)}] ${oneLine(t.description || t.name)}`,
            parameters: (t.inputSchema && typeof t.inputSchema === 'object') ? t.inputSchema : { type: 'object', properties: {} },
          },
        });
      }
    }
    return defs;
  }

  /** { serverId, toolName } de un nombre expuesto, o null si no es nuestro. */
  describe(exposed) {
    for (const s of this._servers) {
      const st = this._state.get(s.id);
      if (!st || !st.exposed) continue;
      const t = st.exposed.get(exposed);
      if (t) return { serverId: s.id, serverName: s.name || s.id, toolName: t.name };
    }
    return null;
  }

  /**
   * Servidor al que pertenece un nombre expuesto, por el prefijo del slug. No exige
   * que esté conectado: en el primer uso hay que conectar ANTES de poder resolver el
   * nombre real de la herramienta (el slug no tiene por qué coincidir con él).
   */
  _serverIdOf(exposed) {
    const m = /^mcp__([a-z0-9_]+)__/.exec(String(exposed || ''));
    if (!m) return null;
    const s = this._servers.find(x => slug(x.id, 16) === m[1]);
    return s ? s.id : null;
  }

  /**
   * Ejecuta una herramienta MCP y devuelve TEXTO para el modelo. Nunca lanza:
   * un servidor caído o un timeout se explican, no rompen el turno.
   */
  async callTool(exposedName, args = {}, { timeoutMs } = {}) {
    let info = this.describe(exposedName);
    // Sin conexión todavía no hay tabla (el servidor está `idle` al arrancar la app):
    // se identifica por el prefijo, se conecta y se resuelve con la tabla REAL. Si se
    // resolviera por el slug, al servidor le llegaría un nombre deformado.
    const sid = info ? info.serverId : this._serverIdOf(exposedName);
    if (!sid) return `Error: la herramienta MCP «${exposedName}» no está disponible ahora mismo.`;
    const s = this._server(sid);
    const st = this._state.get(sid);
    if (!s || !st) return `Error: el servidor MCP «${sid}» ya no está configurado.`;
    if (st.state !== 'ready') {
      const r = await this.ensure(sid);
      if (!r.ok) return `Error: no pude usar «${exposedName}» porque el servidor MCP «${s.name || s.id}» no está disponible (${r.error}).`;
      info = this.describe(exposedName);
      if (!info) return `Error: el servidor MCP «${s.name || s.id}» no expone la herramienta «${exposedName}» (¿está bloqueada o fuera de la lista permitida?).`;
    }
    if (!info) info = this.describe(exposedName);
    if (!info) return `Error: la herramienta MCP «${exposedName}» no está disponible ahora mismo.`;
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : (Number(s.timeoutMs) > 0 ? Number(s.timeoutMs) : DEFAULT_TIMEOUT_MS);
    try {
      const res = await st.transport.rpc.request('tools/call', { name: info.toolName, arguments: args || {} }, { timeoutMs: ms });
      const texto = this._flatten(res);
      return res && res.isError ? 'Error del servidor MCP: ' + texto : texto;
    } catch (e) {
      // el transporte puede haber muerto: se marca para que la próxima llamada reconecte
      if (!st.transport || !st.transport.rpc.alive) { st.state = 'dead'; st.error = e.message; st.tools = []; st.logTail = st.transport && st.transport.stderrTail ? st.transport.stderrTail() : ''; }
      return `Error: la herramienta MCP «${info.toolName}» falló (${e.message}).`;
    }
  }

  /** Texto legible del resultado: textos concatenados, imágenes y recursos resumidos. */
  _flatten(res) {
    const partes = [];
    for (const c of (res && res.content) || []) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'text') partes.push(String(c.text || ''));
      else if (c.type === 'image') partes.push(`[imagen: ${c.mimeType || 'desconocido'}, ${Math.round(String(c.data || '').length * 0.75 / 1024)} KB — no se envía al modelo]`);
      else if (c.type === 'resource') partes.push(`[recurso: ${(c.resource && c.resource.uri) || 'sin uri'}]`);
      else partes.push('[' + (c.type || 'contenido') + ']');
    }
    if (!partes.length && res && res.structuredContent) {
      try { partes.push(JSON.stringify(res.structuredContent)); } catch {}
    }
    const texto = partes.join('\n').trim() || '(el servidor MCP no devolvió contenido)';
    return texto.length > MAX_RESULT_CHARS
      ? texto.slice(0, MAX_RESULT_CHARS) + '\n… (resultado recortado)'
      : texto;
  }

  /** Estado para la UI (y para el usuario): nunca expone secretos. */
  status() {
    return this._servers.map((s) => {
      const st = this._state.get(s.id) || {};
      return {
        id: s.id,
        name: s.name || s.id,
        enabled: !!s.enabled,
        transport: s.transport || 'stdio',
        state: s.enabled ? (st.state || 'idle') : 'off',
        error: st.error || null,
        logTail: st.logTail || '',
        serverInfo: st.serverInfo || null,
        tools: [...(st.exposed || new Map()).entries()].map(([exposed, t]) => ({
          name: exposed, tool: t.name, description: oneLine(t.description, 200),
        })),
      };
    });
  }

  /** Cerrar todo (before-quit): stdin, luego árbol de procesos. */
  async shutdown() {
    for (const id of this._state.keys()) this._drop(id);
  }
}

module.exports = { McpManager, mapToolName, MAX_TOOL_NAME, DEFAULT_TIMEOUT_MS, MAX_RESULT_CHARS };
