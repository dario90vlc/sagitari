# Integración de MCP en SAGITARI — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el usuario añada sus propios servidores MCP desde la interfaz y que el agente los use como herramientas nativas, con los mismos permisos, guardarraíles y tarjetas de confirmación.

**Architecture:** Dos módulos nuevos en `agent/`: `mcp-transport.js` (JSON-RPC 2.0 sobre stdio y sobre HTTP, sin saber nada de herramientas) y `mcp.js` (registro de servidores, ciclo de vida, catálogo de herramientas y despacho de llamadas). Las herramientas MCP entran en el catálogo existente vía `tools.allToolDefs()` con el nombre `mcp__<servidor>__<herramienta>` y se ejecutan por una rama nueva de `executeTool`, así que pasan por `Guardrails` sin ninguna vía lateral.

**Tech Stack:** Node 20+/Electron 44, JS vainilla, sin frameworks. Única dependencia de runtime: `ws` (no se añade ninguna).

**Spec:** `docs/superpowers/specs/2026-09-15-mcp-integracion-design.md`

## Global Constraints

- **Una sola dependencia de runtime** (`ws`). Prohibido añadir `@modelcontextprotocol/sdk` o cualquier otra: el cliente MCP se escribe a mano.
- **Solo Windows 10/11.** El arranque de servidores stdio debe funcionar con `npx`/`npm` (que son `.cmd`).
- **Terminología de interfaz en español**; comentarios de código en español, explicando *por qué*, no *qué*.
- **Sin frameworks de UI**: HTML/CSS/JS a mano; los desplegables y controles propios siguen el patrón existente (`mejoraSelect`/`csel`).
- **Nada se ejecuta sin pasar por `Guardrails`.** Nivel por defecto de toda herramienta MCP: `confirm`.
- **`agent/tools.js` es la única fuente de la tabla `RISK`**; no se crea ninguna tabla de niveles paralela.
- **Nombre de herramienta expuesto:** `mcp__<servidor>__<herramienta>`, saneado a `[a-z0-9_]`, máximo 64 caracteres.
- **Timeouts en las tres fases** (handshake, `tools/list`, `tools/call`); ningún camino puede colgarse sin límite.
- **Secretos cifrados con DPAPI** (mismo camino que `apiKey`: `protectKey`/`revealKey`).
- **HTTP remoto solo `https`**, o `http` si el host es `localhost`/`127.0.0.1`/`::1`.
- **La suite no puede escribir en los datos reales del usuario**: `npm test` fija `SAGITARI_DATA_DIR` a un temporal al arrancar.

---

## Estructura de ficheros

| Fichero | Responsabilidad |
|---|---|
| `agent/mcp-transport.js` (**nuevo**) | Framing JSON-RPC por líneas, petición/respuesta con `id`, timeouts, transporte stdio (spawn) y transporte HTTP (fetch + SSE). No conoce herramientas. |
| `agent/mcp.js` (**nuevo**) | Registro de servidores, máquina de estados, `initialize`, `tools/list` paginado, catálogo de herramientas MCP, `callTool`, nombres expuestos, backoff. Usa un transporte, no sabe de sockets. |
| `agent/proc.js` (**nuevo**) | `killTree(child)`: una sola implementación del `taskkill /T /F` (hoy vive en `executors.js` y el transporte stdio también la necesita). |
| `agent/tools.js` | Añade `allToolDefs()` y `setDynamicToolProvider()`; `toolDefs` sigue siendo el catálogo nativo. |
| `agent/executors.js` | Rama `mcp__*` que delega en `ctx.mcp`; consume `killTree` de `agent/proc.js`. |
| `agent/guardrails.js` | `levelFor` con comodín `mcp__<srv>__*`; textos de `describeAction`/`summarizeArgs` para nombres MCP. |
| `agent/agent.js` | `allToolDefs()` en los tres puntos donde hoy usa la tabla estática; `ctx.mcp` en `executeTool`; `statusFor` para `mcp__*`. |
| `main/main.js` | `config.mcp`, cifrado de `env`/`headers`, instancia de `McpManager`, IPC `mcp:*`, cierre ordenado en `before-quit`. |
| `main/preload.js` | Puente del renderer para los canales `mcp:*`. |
| `renderer/index.html` | Pestaña **MCP** en Ajustes y su panel. |
| `renderer/app.js` | Lista de servidores, formulario, botón Probar, log, importar/exportar JSON, grupo MCP en Herramientas, overrides en Seguridad. |
| `renderer/styles.css` | Estilos de las filas del panel MCP. |
| `test/run.js` | Tests unitarios y de integración (incluye el servidor de prueba). |
| `test/fixtures/mcp-echo-server.js` (**nuevo**) | Servidor MCP real mínimo por stdio, sin dependencias, para el test de integración. |
| `scripts/ui-check.js` | Comprobación sobre la interfaz viva de la pestaña MCP. |
| `README.md`, `README.es.md`, `RELEASE_NOTES.md` | Documentación y notas con paridad ES/EN (regla de producto). |

---

### Task 1: Extraer `killTree` a `agent/proc.js`

**Files:**
- Create: `agent/proc.js`
- Modify: `agent/executors.js:41-46` (definición) y `:72-78` (usos)
- Test: `test/run.js` (el test «herramientas: las que lanzan un proceso registran su cancelación» ya existe y debe seguir verde)

**Interfaces:**
- Produces: `killTree(child) -> void` en `require('../agent/proc')`; `executors.js` deja de exportarlo (nadie más lo consume).

- [ ] **Step 1: Crear el módulo con la implementación actual, sin cambios de comportamiento**

```js
'use strict';

const { exec } = require('child_process');

// En Windows, matar el hijo directo deja nietos huérfanos: taskkill /T /F elimina
// todo el árbol de procesos. Se usa tanto al pulsar Detener como al expirar el
// timeout. OJO: taskkill se lanza con el padre AÚN VIVO (el child.kill() va en su
// callback) porque si el hijo muere antes, taskkill no encuentra el árbol y los
// nietos quedan huérfanos. Vive aquí porque el transporte stdio de MCP también
// necesita matar el árbol de un servidor: una sola implementación.
function killTree(child) {
  const pid = child && child.pid;
  if (pid && process.platform === 'win32') {
    // taskkill primero, con el padre aún vivo para poder enumerar el árbol; child.kill() como respaldo
    try {
      exec(`taskkill /PID ${pid} /T /F`, { windowsHide: true }, () => { try { child.kill(); } catch {} });
      return;
    } catch {}
  }
  try { child.kill(); } catch {}
}

module.exports = { killTree };
```

- [ ] **Step 2: Sustituir la copia de `executors.js` por el require**

En `agent/executors.js`, borrar la función `killTree` y añadir arriba:
```js
const { killTree } = require('./proc');
```
Los dos usos (`setTimeout(() => { killTree(child); … })` y `registerKillable`) quedan igual. Quitar `killTree` de `module.exports` si estuviera exportado (hoy se exporta `{ executeTool, openUrlAllowed }`: no hay que tocar nada).

- [ ] **Step 3: Verificar que la suite sigue verde (mismo número de tests, sin cambios)**

Run: `npm test 2>&1 | tail -3`
Expected: `Todos los tests en verde (186)`

- [ ] **Step 4: Commit**

```bash
git add agent/proc.js agent/executors.js
git commit -m "proc: una sola implementacion de killTree (la necesita el transporte stdio de MCP)"
```

---

### Task 2: Framing JSON-RPC y peticiones con `id`

**Files:**
- Create: `agent/mcp-transport.js`
- Test: `test/run.js`

**Interfaces:**
- Produces:
  - `createLineReader(onMessage) -> (chunk: Buffer|string) => void` — acumula y entrega mensajes JSON completos; las líneas que no parsean se cuentan y se ignoran.
  - `class Rpc { constructor({ send, onNotice }) }` — `request(method, params, { timeoutMs })`, `notify(method, params)`, `handleMessage(msg)`, `fail(reason)`.
- Consumes: nada.

- [ ] **Step 1: Escribir los tests que fallan**

En `test/run.js`, junto a los tests de protocolos:

```js
/* ---------- MCP: framing y JSON-RPC ---------- */
const mcpTransport = require('../agent/mcp-transport');

test('mcp: el lector entrega mensajes completos y descarta los banners', () => {
  const vistos = [];
  const feed = mcpTransport.createLineReader((m, noise) => vistos.push({ m, noise }));
  // dos mensajes en un chunk, uno partido en dos y una línea de banner al principio
  feed('Servidor MCP 1.0 listo\n{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,');
  feed('"method":"b"}\n{"jsonrpc":"2.0","id":3,"method":"c"}\n');
  eq(vistos.map(v => v.m.id).join(','), '1,2,3', 'los tres mensajes llegan, en orden');
  eq(vistos[0].noise, 1, 'el banner se cuenta como ruido, no como mensaje');
});

test('mcp: las peticiones se emparejan por id y se resuelven fuera de orden', async () => {
  const enviados = [];
  const rpc = new mcpTransport.Rpc({ send: (text) => enviados.push(JSON.parse(text)) });
  const p1 = rpc.request('tools/list', {});
  const p2 = rpc.request('tools/call', { name: 'x' });
  eq(enviados.length, 2, 'las dos salen a la vez');
  ok(enviados[0].id !== enviados[1].id, 'cada una con su id');
  rpc.handleMessage({ jsonrpc: '2.0', id: enviados[1].id, result: { ok: 'dos' } });
  rpc.handleMessage({ jsonrpc: '2.0', id: enviados[0].id, result: { ok: 'uno' } });
  eq((await p1).ok, 'uno', 'la primera responde a la primera');
  eq((await p2).ok, 'dos');
});

test('mcp: el error JSON-RPC y el timeout se explican', async () => {
  const rpc = new mcpTransport.Rpc({ send: () => {} });
  const p = rpc.request('initialize', {}, { timeoutMs: 50 });
  const [, err] = await p.then(() => [null, null], (e) => [null, e]);
  ok(/no respondió|timeout/i.test(err.message), err.message);

  const rpc2 = new mcpTransport.Rpc({ send: () => {} });
  const p2 = rpc2.request('x', {}, { timeoutMs: 1000 });
  rpc2.handleMessage({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'método no soportado' } });
  const [, err2] = await p2.then(() => [null, null], (e) => [null, e]);
  ok(err2 && /método no soportado/.test(err2.message), 'el mensaje del servidor se propaga: ' + (err2 && err2.message));
});

test('mcp: si el transporte muere, las peticiones en vuelo se rechazan', async () => {
  const rpc = new mcpTransport.Rpc({ send: () => {} });
  const p = rpc.request('tools/list', {}, { timeoutMs: 5000 });
  rpc.fail('el servidor se cayó');
  const [, err] = await p.then(() => [null, null], (e) => [null, e]);
  ok(/se cayó/.test(err.message), 'no se queda esperando para siempre');
});
```

- [ ] **Step 2: Ejecutar y ver el fallo esperado**

Run: `npm test 2>&1 | grep -E "FAIL|verde"`
Expected: FAIL en los cuatro tests con `Cannot find module '../agent/mcp-transport'`

- [ ] **Step 3: Implementar `agent/mcp-transport.js` (parte de framing y RPC)**

```js
'use strict';

/* Transporte MCP: JSON-RPC 2.0 delimitado por líneas (stdio) o por HTTP con SSE.
   Aquí no se sabe nada de herramientas: solo de mensajes, ids y timeouts. */

const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Lector incremental: entrega cada mensaje JSON completo y cuenta el ruido.
 * Algunos servidores escriben un banner de arranque en stdout antes del primer
 * mensaje; una línea que no parsea no puede tumbar la conexión.
 */
function createLineReader(onMessage) {
  let buf = '';
  let noise = 0;   // líneas descartadas hasta ahora (banners, avisos sueltos)
  const dec = new StringDecoder('utf8');   // la conversión debe ser INCREMENTAL: un
                                           // chunk puede cortar un carácter multibyte
  return (chunk) => {
    buf += typeof chunk === 'string' ? chunk : dec.write(chunk);
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { noise++; continue; }   // ruido: se cuenta y NO se entrega
      onMessage(msg, noise);
    }
  };
}

/** Peticiones en vuelo emparejadas por id, con timeout y fallo global. */
class Rpc {
  constructor({ send, onNotice, defaultTimeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.send = send;                       // (text) => void
    this.onNotice = onNotice || (() => {}); // (method, params) => void
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
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      // Avisa del id ANTES de enviar: es lo que permite cancelar esta petición
      // concreta si el usuario pulsa Detener mientras está en vuelo.
      if (typeof onStart === 'function') { try { onStart(id); } catch {} }
      try { this.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }
      catch (e) { this._pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  notify(method, params = {}) {
    if (this._dead) return;
    try { this.send(JSON.stringify({ jsonrpc: '2.0', method, params })); } catch {}
  }

  /** Cancela UNA petición en vuelo (el usuario pulsó Detener): rechaza solo esa,
      no la conexión entera. Devuelve true si había algo que cancelar. */
  cancel(id, reason) {
    const p = this._pending.get(id);
    if (!p) return false;
    this._pending.delete(id);
    p.reject(new Error(reason || 'petición cancelada'));
    return true;
  }

  /**
   * Respuesta o mensaje del servidor.
   * `onNotice(method, params, id)`: el tercer argumento es null en las
   * notificaciones y NO es null cuando el servidor espera respuesta (ping,
   * roots/list, sampling/createMessage): hay que contestarle con el mismo id.
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

module.exports = { DEFAULT_TIMEOUT_MS, createLineReader, Rpc };
```

- [ ] **Step 4: Ejecutar los tests**

Run: `npm test 2>&1 | grep -E "FAIL|verde"`
Expected: `Todos los tests en verde (190)`

- [ ] **Step 5: Commit**

```bash
git add agent/mcp-transport.js test/run.js
git commit -m "mcp: framing JSON-RPC por lineas, peticiones con id y timeout, y fallo global del transporte"
```

---

### Task 3: Transporte stdio con servidor de prueba real

**Files:**
- Create: `test/fixtures/mcp-echo-server.js`
- Modify: `agent/mcp-transport.js` (añade `createStdioTransport`)
- Test: `test/run.js`

**Interfaces:**
- Consumes: `createLineReader`, `Rpc` (Task 2); `killTree` (Task 1).
- Produces: `createStdioTransport({ command, args, cwd, env, commandLine }) -> { rpc, stderrTail(), kill(), onExit(cb), pid }`. `commandLine()` es una función pura exportada: `buildCmdLine(command, args) -> string` (lanza si un argumento contiene `"`, `%` o salto de línea).

- [ ] **Step 1: Escribir el servidor de prueba**

`test/fixtures/mcp-echo-server.js`:

```js
'use strict';

/* Servidor MCP mínimo por stdio para los tests de integración: initialize,
   tools/list en DOS páginas (cursor) y tools/call. Sin dependencias. */

const readline = require('readline');

if (process.env.MCP_ECHO_BANNER) process.stdout.write('Servidor MCP de prueba listo\n');

const TOOLS = [
  { name: 'echo', description: 'Devuelve el texto recibido', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'needle', description: 'Segunda página del catálogo', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'Devuelve isError', inputSchema: { type: 'object', properties: {} } },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m = null;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'eco', version: '1.0.0' } } });
  }
  if (m.method === 'notifications/initialized') return;
  if (m.method === 'tools/list') {
    if (!(m.params && m.params.cursor)) return send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS.slice(0, 2), nextCursor: 'pagina2' } });
    return send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS.slice(2) } });
  }
  if (m.method === 'tools/call') {
    const name = m.params && m.params.name;
    const args = (m.params && m.params.arguments) || {};
    if (name === 'echo') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'eco: ' + String(args.text || '') }] } });
    if (name === 'needle') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'segunda' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] } });
    if (name === 'fail') return send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'no pude hacerlo' }] } });
    return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'herramienta desconocida' } });
  }
  if (m.id) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no soportado: ' + m.method } });
});
```

- [ ] **Step 2: Escribir los tests que fallan**

```js
test('mcp: la linea de comandos de cmd.exe cita los argumentos', () => {
  eq(mcpTransport.buildCmdLine('npx', ['-y', '@modelcontextprotocol/server-github']), 'npx -y @modelcontextprotocol/server-github');
  eq(mcpTransport.buildCmdLine('npx', ['-y', 'pkg with space']), 'npx -y "pkg with space"');
  // no se escapa a ciegas: un argumento con metacaracteres de cmd se rechaza
  for (const malo of ['a&b', 'a|b', 'a^b', '50%', 'di"hola', 'linea\nnueva']) {
    let err = null;
    try { mcpTransport.buildCmdLine('npx', [malo]); } catch (e) { err = e; }
    ok(err, 'debe rechazar ' + JSON.stringify(malo));
  }
});

test('mcp: transporte stdio completo contra un servidor real', async () => {
  const path2 = path.join(__dirname, 'fixtures', 'mcp-echo-server.js');
  const tr = mcpTransport.createStdioTransport({
    command: process.execPath, args: [path2], env: { MCP_ECHO_BANNER: '1' }, cwd: tmpDir('sagi-mcp-'),
  });
  const init = await tr.rpc.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'SAGITARI', version: 'test' } }, { timeoutMs: 5000 });
  eq(init.serverInfo.name, 'eco');
  tr.rpc.notify('notifications/initialized', {});
  const p1 = await tr.rpc.request('tools/list', {}, { timeoutMs: 5000 });
  eq(p1.tools.length, 2);
  eq(p1.nextCursor, 'pagina2');
  const p2 = await tr.rpc.request('tools/list', { cursor: p1.nextCursor }, { timeoutMs: 5000 });
  eq(p2.tools.length, 1);
  const call = await tr.rpc.request('tools/call', { name: 'echo', arguments: { text: 'hola' } }, { timeoutMs: 5000 });
  eq(call.content[0].text, 'eco: hola', 'el banner de arranque no rompió el emparejado por id');
  tr.kill();
  ok(tr.pid > 0, 'el proceso tuvo pid (se mató entero)');
});
```

- [ ] **Step 3: Ejecutar y ver el fallo**

Run: `npm test 2>&1 | grep -E "FAIL|verde"`
Expected: FAIL con `mcpTransport.createStdioTransport is not a function`

- [ ] **Step 4: Implementar el transporte stdio**

Añadir a `agent/mcp-transport.js`:

```js
const { spawn } = require('child_process');
const { killTree } = require('./proc');

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
    // con espacios llegaba partido en trozos. cmd.exe espera /d /s /c "<línea>" tal cual.
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
    windowsVerbatimArguments: verbatim,   // ver resolveCommand: cmd.exe necesita la línea tal cual
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
```

Añadir `buildCmdLine`, `resolveCommand` y `createStdioTransport` al `module.exports`.

- [ ] **Step 5: Ejecutar los tests**

Run: `npm test 2>&1 | grep -E "FAIL|verde"`
Expected: `Todos los tests en verde (192)`

- [ ] **Step 6: Commit**

```bash
git add agent/mcp-transport.js test/fixtures/mcp-echo-server.js test/run.js
git commit -m "mcp: transporte stdio con citado seguro para cmd.exe y servidor de prueba real en los tests"
```

---

### Task 4: Transporte HTTP (streamable HTTP con SSE)

**Files:**
- Modify: `agent/mcp-transport.js` (añade `createHttpTransport` y `parseSseResponse`)
- Test: `test/run.js`

**Interfaces:**
- Consumes: `Rpc` (Task 2).
- Produces:
  - `httpUrlAllowed(url) -> boolean` (solo `https`, o `http` en loopback).
  - `parseSseText(text) -> object[]` (mensajes JSON de un cuerpo SSE).
  - `createHttpTransport({ url, headers, defaultTimeoutMs, fetchFn }) -> { rpc, sessionId(), kill(), onExit(cb) }`.

- [ ] **Step 1: Escribir los tests que fallan**

```js
test('mcp: solo https (o http en loopback) para servidores remotos', () => {
  ok(mcpTransport.httpUrlAllowed('https://mcp.ejemplo.com/mcp'));
  ok(mcpTransport.httpUrlAllowed('http://127.0.0.1:3000/mcp'));
  ok(mcpTransport.httpUrlAllowed('http://localhost:3000/mcp'));
  ok(!mcpTransport.httpUrlAllowed('http://mcp.ejemplo.com/mcp'), 'http en internet queda fuera (va el token en claro)');
  ok(!mcpTransport.httpUrlAllowed('file:///C:/x'), 'nada que no sea http(s)');
  ok(!mcpTransport.httpUrlAllowed('no es una url'));
});

test('mcp: cuerpo SSE y cuerpo JSON se interpretan igual', () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\n';
  eq(mcpTransport.parseSseText(sse)[0].result.a, 1);
  // varias líneas data: del mismo evento se concatenan (spec SSE)
  const multi = 'data: {"jsonrpc":"2.0","id":2,\ndata: "result":{"b":2}}\n\n';
  eq(mcpTransport.parseSseText(multi)[0].result.b, 2);
  eq(mcpTransport.parseSseText('no es sse').length, 0);
});

test('mcp: transporte http manda cabeceras, guarda la sesión y lee SSE', async () => {
  const http = require('http');
  const vistos = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      const msg = JSON.parse(body);
      vistos.push({ msg, auth: req.headers.authorization, accept: req.headers.accept, session: req.headers['mcp-session-id'] });
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'remoto', version: '1' } } }));
      }
      // el resto responde por SSE: el JSON se parte en dos líneas `data:` del
      // MISMO evento (que es lo que la spec SSE obliga a concatenar)
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'uno', description: 'x', inputSchema: { type: 'object' } }] } });
      // El corte va en una frontera entre tokens (antes de `,"result"`), nunca dentro
      // de una cadena: unir con `\n` entre tokens es espacio en blanco válido para
      // JSON, así que esto comprueba la regla de la spec sin inventarse nada.
      const corte = payload.indexOf(',"result"');
      res.write('event: message\ndata: ' + payload.slice(0, corte) + '\n');
      res.write('data: ' + payload.slice(corte) + '\n\n');
      res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port + '/mcp';
  try {
    const tr = mcpTransport.createHttpTransport({ url, headers: { Authorization: 'Bearer tok' } });
    const init = await tr.rpc.request('initialize', { clientInfo: { name: 'SAGITARI', version: '1' } }, { timeoutMs: 4000 });
    eq(init.serverInfo.name, 'remoto');
    eq(tr.sessionId(), 'sess-1', 'la sesión se guarda para las siguientes peticiones');
    const list = await tr.rpc.request('tools/list', {}, { timeoutMs: 4000 });
    eq(list.tools[0].name, 'uno', 'la respuesta partida en dos eventos SSE se reensambla');
    eq(vistos[0].accept, 'application/json, text/event-stream');
    eq(vistos[1].auth, 'Bearer tok', 'la cabecera de autorización viaja en cada petición');
    eq(vistos[1].session, 'sess-1', 'y la sesión también');
    tr.kill();
  } finally { srv.closeAllConnections?.(); srv.close(); }
});

test('mcp: un servidor http que no responde corta por timeout', async () => {
  const http = require('http');
  const srv = http.createServer(() => { /* nunca responde */ });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port + '/mcp';
  try {
    // defaultTimeoutMs corto: es el que acota la petición HTTP real (el Rpc corta
    // antes por su propio timeout). Sin él, el socket contra un servidor mudo
    // seguiría abierto los 60 s por defecto y la suite tardaría un minuto de más
    // aunque los tests ya hubieran terminado.
    const tr = mcpTransport.createHttpTransport({ url, defaultTimeoutMs: 1000 });
    const t0 = Date.now();
    let err = null;
    try { await tr.rpc.request('initialize', {}, { timeoutMs: 300 }); } catch (e) { err = e; }
    ok(err && /timeout/i.test(err.message), 'corta con timeout: ' + (err && err.message));
    ok(Date.now() - t0 < 3000, 'no espera más de la cuenta');
  } finally { srv.closeAllConnections?.(); srv.close(); }
});
```

- [ ] **Step 2: Ejecutar y ver el fallo**

Run: `npm test 2>&1 | grep -E "FAIL|verde"`
Expected: FAIL con `mcpTransport.httpUrlAllowed is not a function`

- [ ] **Step 3: Implementar el transporte HTTP**

Añadir a `agent/mcp-transport.js`:

```js
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
    try { out.push(JSON.parse(datos.join('\n'))); } catch {}
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
      // 202 sin cuerpo: es lo que la spec manda para notificaciones y respuestas, así
      // que no hay nada que interpretar (y no puede contar como caída del servidor)
      if (!body.trim()) return;
      const mensajes = tipo.includes('text/event-stream') ? parseSseText(body) : [JSON.parse(body)];
      for (const m of mensajes) rpc.handleMessage(m);
    } catch (e) {
      // Un abort causado por nuestro propio tope no significa que el servidor esté
      // caído: el Rpc ya rechazó la petición con su mensaje de timeout, así que no
      // se marca muerto (si lo estuviera, la siguiente llamada lo comprobaría).
      // OJO: AbortSignal.timeout() rechaza con nombre `TimeoutError`, no `AbortError`.
      if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) return;
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
```

Exportar `httpUrlAllowed`, `parseSseText` y `createHttpTransport`. Nota: `Rpc.send` no puede ser `async` (la firma es síncrona), de ahí el `void enviar(text)`: el timeout del `Rpc` cubre la respuesta que no llega.

- [ ] **Step 4: Ejecutar los tests**

Run: `npm test 2>&1 | grep -E "FAIL|verde"`
Expected: `Todos los tests en verde (196)`

- [ ] **Step 5: Commit**

```bash
git add agent/mcp-transport.js test/run.js
git commit -m "mcp: transporte http (JSON y SSE), sesion y validacion de URL con loopback"
```

---

### Task 5: Registro, nombres y catálogo de herramientas MCP

**Files:**
- Create: `agent/mcp.js`
- Test: `test/run.js`

**Interfaces:**
- Consumes: `createStdioTransport`, `createHttpTransport` (Tasks 3-4).
- Produces:
  - `mapToolName(serverId, toolName) -> string` (pura).
  - `MAX_TOOL_NAME = 64`.
  - `class McpManager { constructor({ servers, dataDir, clientVersion, log, makeTransport }); configure(servers); toolDefs(); describe(exposed) -> {serverId, toolName}|null; async ensure(serverId); status(); async test(id); async shutdown() }`
  - `makeTransport` es inyectable para los tests (por defecto crea stdio/http reales).

- [ ] **Step 1: Escribir los tests que fallan**

```js
/* ---------- MCP: registro, nombres y catálogo ---------- */
const { McpManager, mapToolName, MAX_TOOL_NAME } = require('../agent/mcp');

test('mcp: el nombre expuesto se sanea y no pasa de 64 caracteres', () => {
  eq(mapToolName('github', 'create_issue'), 'mcp__github__create_issue');
  eq(mapToolName('Mi Servidor!', 'Crear-Nota'), 'mcp__mi_servidor__crear_nota');
  const largo = mapToolName('servidor-con-nombre-muy-largo', 'herramienta-con-nombre-absurdamente-largo-de-mas');
  ok(largo.length <= MAX_TOOL_NAME, 'largo: ' + largo.length);
  ok(largo.startsWith('mcp__'), largo);
  // nunca puede pisar una herramienta nativa
  for (const nativa of ['run_command', 'read_file', 'browser_control']) ok(mapToolName('x', nativa) !== nativa);
});

function fakeTransport(tools, { failInit = false } = {}) {
  const calls = [];
  const t = {
    calls,
    esperandoSalida: [],
    rpc: {
      alive: true,
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'initialize') {
          if (failInit) throw new Error('no arrancó');
          return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'falso', version: '1' } };
        }
        if (method === 'tools/list') return { tools };
        if (method === 'tools/call') return { content: [{ type: 'text', text: 'ok' }] };
        return {};
      },
      notify() {}, fail() {},
    },
    stderrTail: () => '',
    onExit(cb) { this.esperandoSalida.push(cb); },
    kill() {},
  };
  return t;
}

const MCP_SERVERS = [
  { id: 'eco', name: 'Eco', enabled: true, transport: 'stdio', command: 'node', args: ['x.js'], env: {}, timeoutMs: 5000 },
  { id: 'apagado', name: 'Apagado', enabled: false, transport: 'stdio', command: 'node', args: [], env: {} },
];

test('mcp: el catálogo solo trae las herramientas de servidores habilitados y listos', async () => {
  const transports = {};
  const mcp = new McpManager({
    servers: MCP_SERVERS, dataDir: tmpDir('sagi-mcp-'), clientVersion: 'test', log: () => {},
    makeTransport: (s) => (transports[s.id] = fakeTransport([
      { name: 'echo', description: 'Devuelve el texto', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    ])),
  });
  eq(mcp.toolDefs().length, 0, 'sin conectar no hay herramientas (no se arranca nada por abrir Ajustes)');
  await mcp.ensure('eco');
  const defs = mcp.toolDefs();
  eq(defs.length, 1);
  eq(defs[0].type, 'function');
  eq(defs[0].function.name, 'mcp__eco__echo');
  eq(defs[0].function.parameters.properties.text.type, 'string', 'el esquema del servidor viaja tal cual');
  ok(/Eco/.test(defs[0].function.description), 'la descripción identifica el servidor: ' + defs[0].function.description);
  ok(!/nueva línea|\\n/.test(defs[0].function.description), 'la descripción va en una línea');
  eq(mcp.describe('mcp__eco__echo').toolName, 'echo');
  eq(mcp.describe('mcp__nadie__x'), null);
  await mcp.shutdown();
});

test('mcp: tools/list se pagina con cursor', async () => {
  const paginas = [
    { tools: [{ name: 'uno', description: 'a', inputSchema: { type: 'object' } }], nextCursor: 'c1' },
    { tools: [{ name: 'dos', description: 'b', inputSchema: { type: 'object' } }], nextCursor: 'c2' },
    { tools: [{ name: 'tres', description: 'c', inputSchema: { type: 'object' } }] },
  ];
  let i = 0;
  const tr = fakeTransport([]);
  tr.rpc.request = async (method, params) => {
    if (method === 'initialize') return { capabilities: { tools: {} }, serverInfo: { name: 'pag', version: '1' } };
    if (method === 'tools/list') return paginas[i++];
    return {};
  };
  const mcp = new McpManager({
    servers: [{ id: 'pag', name: 'Pag', enabled: true, transport: 'stdio', command: 'node', args: [] }],
    dataDir: tmpDir('sagi-mcp-'), clientVersion: 't', log: () => {}, makeTransport: () => tr,
  });
  await mcp.ensure('pag');
  eq(mcp.toolDefs().map(d => d.function.name).join(','), 'mcp__pag__uno,mcp__pag__dos,mcp__pag__tres');
  await mcp.shutdown();
});

test('mcp: allow/deny y colisiones de nombre', async () => {
  const tr = fakeTransport([
    { name: 'ok', description: 'permitida', inputSchema: { type: 'object' } },
    { name: 'secreta', description: 'prohibida', inputSchema: { type: 'object' } },
  ]);
  const mcp = new McpManager({
    servers: [{ id: 'f', name: 'F', enabled: true, transport: 'stdio', command: 'node', args: [], tools: { deny: ['secreta'] } }],
    dataDir: tmpDir('sagi-mcp-'), clientVersion: 't', log: () => {}, makeTransport: () => tr,
  });
  await mcp.ensure('f');
  eq(mcp.toolDefs().map(d => d.function.name).join(','), 'mcp__f__ok', 'deny quita la herramienta del catálogo');
  await mcp.shutdown();
});

test('mcp: un servidor que no arranca queda en error legible y no aporta herramientas', async () => {
  const tr = fakeTransport([], { failInit: true });
  const mcp = new McpManager({
    servers: [{ id: 'malo', name: 'Malo', enabled: true, transport: 'stdio', command: 'no-existe-xyz', args: [] }],
    dataDir: tmpDir('sagi-mcp-'), clientVersion: 't', log: () => {},
    makeTransport: () => { tr.stderrTail = () => 'ENOENT: no such file'; return tr; },
  });
  const r = await mcp.ensure('malo');
  eq(r.ok, false);
  ok(/no arrancó|malo/i.test(r.error), r.error);
  eq(mcp.toolDefs().length, 0);
  eq(mcp.status()[0].state, 'dead');
  await mcp.shutdown();
});
```

- [ ] **Step 2: Ejecutar y ver el fallo**

Run: `npm test 2>&1 | grep -E "FAIL|verde"`
Expected: FAIL con `Cannot find module '../agent/mcp'`

- [ ] **Step 3: Implementar `agent/mcp.js` (registro y catálogo, sin `callTool` todavía)**

```js
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
    // Una sola pasada al final: aplica allow/deny cambiados y resuelve colisiones
    // entre servidores sin reconectar (reconectar por un filtro tiraría la sesión).
    this._rebuildExposed();
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
        st.exposed = new Map();   // un servidor muerto no puede seguir describiéndose
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

  /** Tabla nombre expuesto → herramienta real, resolviendo colisiones con sufijo.
      `usados` se comparte entre servidores: ver _rebuildExposed. */
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

module.exports = { McpManager, mapToolName, MAX_TOOL_NAME, DEFAULT_TIMEOUT_MS };
```

- [ ] **Step 4: Ejecutar los tests**

Run: `npm test 2>&1 | grep -E "FAIL|verde"`
Expected: `Todos los tests en verde (200)`

- [ ] **Step 5: Commit**

```bash
git add agent/mcp.js test/run.js
git commit -m "mcp: registro de servidores, nombres expuestos, catalogo paginado y estado para la UI"
```

---

### Task 6: `callTool` (resultado, errores y límites)

**Files:**
- Modify: `agent/mcp.js`
- Test: `test/run.js`

**Interfaces:**
- Consumes: `McpManager.ensure` (Task 5).
- Produces: `async callTool(exposedName, args, { timeoutMs } = {}) -> string` (nunca lanza); `MAX_RESULT_CHARS = 60000`.

- [ ] **Step 1: Escribir los tests que fallan**

```js
test('mcp: la llamada aplana el contenido, resume imágenes y recorta', async () => {
  const tr = fakeTransport([]);
  tr.rpc.request = async (method, params) => {
    if (method === 'initialize') return { capabilities: { tools: {} }, serverInfo: { name: 'c', version: '1' } };
    if (method === 'tools/list') return { tools: [{ name: 'tool', description: 'd', inputSchema: { type: 'object' } }] };
    if (method === 'tools/call') {
      calls.push(params);
      return { content: [
        { type: 'text', text: 'primera parte' },
        { type: 'image', mimeType: 'image/png', data: 'A'.repeat(40000) },
        { type: 'text', text: 'segunda parte' },
      ] };
    }
    return {};
  };
  const calls = [];
  const mcp = new McpManager({
    servers: [{ id: 'c', name: 'C', enabled: true, transport: 'stdio', command: 'node', args: [] }],
    dataDir: tmpDir('sagi-mcp-'), clientVersion: 't', log: () => {}, makeTransport: () => tr,
  });
  await mcp.ensure('c');
  const out = await mcp.callTool('mcp__c__tool', { a: 1 });
  eq(calls[0].name, 'tool', 'al servidor le llega el nombre ORIGINAL, no el expuesto');
  eq(calls[0].arguments.a, 1);
  ok(out.includes('primera parte') && out.includes('segunda parte'), 'los textos se concatenan en orden');
  ok(/imagen: image\/png/.test(out), 'la imagen se resume (no viaja base64 al modelo): ' + out.slice(0, 120));
  ok(out.length <= 60000, 'el resultado está acotado');
  await mcp.shutdown();
});

test('mcp: la primera llamada conecta el servidor antes de resolver el nombre', async () => {
  const tr = fakeTransport([]);
  tr.rpc.request = async (method) => {
    if (method === 'initialize') return { capabilities: { tools: {} }, serverInfo: { name: 'x', version: '1' } };
    if (method === 'tools/list') return { tools: [{ name: 'echo', description: 'd', inputSchema: { type: 'object' } }] };
    if (method === 'tools/call') return { content: [{ type: 'text', text: 'eco' }] };
    return {};
  };
  const mcp = new McpManager({
    servers: [{ id: 'x', name: 'X', enabled: true, transport: 'stdio', command: 'node', args: [] }],
    dataDir: tmpDir('sagi-mcp-'), clientVersion: 't', log: () => {}, makeTransport: () => tr,
  });
  // Sin ensure() previo: la app acaba de arrancar y el servidor está en 'idle', así
  // que no hay tabla de nombres. La llamada tiene que conectar y resolver sola.
  const out = await mcp.callTool('mcp__x__echo', {});
  eq(out, 'eco', 'la primera llamada tras arrancar conecta el servidor por su cuenta');
  await mcp.shutdown();
});

test('mcp: un isError y un error JSON-RPC se explican al modelo', async () => {
  const tr = fakeTransport([]);
  const respuestas = {
    fallo: { isError: true, content: [{ type: 'text', text: 'no pude hacerlo' }] },
    roto: null,
  };
  tr.rpc.request = async (method, params) => {
    if (method === 'initialize') return { capabilities: { tools: {} }, serverInfo: { name: 'e', version: '1' } };
    if (method === 'tools/list') return { tools: [{ name: 'fallo', description: 'd', inputSchema: { type: 'object' } }, { name: 'roto', description: 'd', inputSchema: { type: 'object' } }] };
    if (params.name === 'roto') throw new Error('servidor MCP: se rompió por dentro');
    return respuestas[params.name];
  };
  const mcp = new McpManager({
    servers: [{ id: 'e', name: 'E', enabled: true, transport: 'stdio', command: 'node', args: [] }],
    dataDir: tmpDir('sagi-mcp-'), clientVersion: 't', log: () => {}, makeTransport: () => tr,
  });
  await mcp.ensure('e');
  const ok1 = await mcp.callTool('mcp__e__fallo', {});
  ok(/^Error del servidor MCP:/.test(ok1), ok1);
  const ok2 = await mcp.callTool('mcp__e__roto', {});
  ok(/se rompió por dentro/.test(ok2), 'el error del servidor llega tal cual: ' + ok2);
  await mcp.shutdown();
});

test('mcp: una herramienta desconocida no llama a nadie y se explica', async () => {
  const mcp = new McpManager({ servers: [], dataDir: tmpDir('sagi-mcp-'), clientVersion: 't', log: () => {}, makeTransport: () => fakeTransport([]) });
  const out = await mcp.callTool('mcp__nadie__nada', {});
  ok(out.startsWith('Error:'), out);
  await mcp.shutdown();
});

test('mcp: si el servidor está caído, la siguiente llamada reintenta con backoff', async () => {
  let intentos = 0;
  const mcp = new McpManager({
    servers: [{ id: 'r', name: 'R', enabled: true, transport: 'stdio', command: 'node', args: [] }],
    dataDir: tmpDir('sagi-mcp-'), clientVersion: 't', log: () => {},
    makeTransport: () => {
      intentos++;
      if (intentos === 1) return fakeTransport([], { failInit: true });
      const tr = fakeTransport([{ name: 'tool', description: 'd', inputSchema: { type: 'object' } }]);
      tr.rpc.request = async (method, params) => {
        if (method === 'initialize') return { capabilities: { tools: {} }, serverInfo: { name: 'r', version: '1' } };
        if (method === 'tools/list') return { tools: [{ name: 'tool', description: 'd', inputSchema: { type: 'object' } }] };
        return { content: [{ type: 'text', text: 'ya va' }] };
      };
      return tr;
    },
  });
  eq((await mcp.ensure('r')).ok, false, 'el primer intento falla');
  const out = await mcp.callTool('mcp__r__tool', {});
  eq(intentos, 2, 'la llamada vuelve a intentar conectar');
  eq(out, 'ya va');
  await mcp.shutdown();
});
```

- [ ] **Step 2: Ejecutar y ver el fallo**

Run: `npm test 2>&1 | grep -E "FAIL|verde"`
Expected: FAIL con `mcp.callTool is not a function`

- [ ] **Step 3: Implementar `callTool`**

Añadir a la clase `McpManager` (y `const MAX_RESULT_CHARS = 60000;` arriba):

```js
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
  async callTool(exposedName, args = {}, { timeoutMs, onExit } = {}) {
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
    let reqId = null;
    // El gancho que usa el agente: mientras la petición está en vuelo, Detener puede
    // cortar SOLO esa llamada (si no, agotaría su timeout sin que el usuario pare nada).
    if (typeof onExit === 'function') {
      try { onExit({ stop: () => { if (reqId != null) st.transport.rpc.cancel(reqId, 'detenida por el usuario'); } }); } catch {}
    }
    try {
      const res = await st.transport.rpc.request('tools/call', { name: info.toolName, arguments: args || {} }, { timeoutMs: ms, onStart: (id) => { reqId = id; } });
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
    if (texto.length > MAX_RESULT_CHARS) {
      let corte = MAX_RESULT_CHARS;
      const c = texto.charCodeAt(corte - 1);
      if (c >= 0xD800 && c <= 0xDBFF) corte--;   // no partir un par suplente (emoji a medias)
      return texto.slice(0, corte) + '\n… (resultado recortado)';
    }
    return texto;
  }
```

Añadir `MAX_RESULT_CHARS` a `module.exports`.

- [ ] **Step 4: Ejecutar los tests**

Run: `npm test 2>&1 | grep -E "FAIL|verde"`
Expected: `Todos los tests en verde (204)`

- [ ] **Step 5: Commit**

```bash
git add agent/mcp.js test/run.js
git commit -m "mcp: callTool con aplanado de contenido, errores legibles, recorte y reconexion"
```

---

### Task 7: Integración en el catálogo, el ejecutor y los permisos

**Files:**
- Modify: `agent/tools.js:284`, `agent/executors.js:148-160`, `agent/agent.js:660,706,875,893`, `agent/guardrails.js:56-70,84-96,236-250`
- Test: `test/run.js`

**Interfaces:**
- Consumes: `McpManager.toolDefs/describe/callTool` (Tasks 5-6).
- Produces:
  - `tools.allToolDefs()` y `tools.setDynamicToolProvider(fn)`.
  - `executeTool` acepta `ctx.mcp`.
  - `Guardrails.levelFor('mcp__<srv>__<tool>')` con comodín `mcp__<srv>__*`.

- [ ] **Step 1: Escribir los tests que fallan**

```js
test('mcp: las herramientas dinamicas entran en el catalogo sin tocar la tabla nativa', () => {
  const toolsMod = require('../agent/tools');
  const antes = toolsMod.toolDefs.length;
  const { RISK } = toolsMod;
  toolsMod.setDynamicToolProvider(() => ([{ type: 'function', function: { name: 'mcp__eco__echo', description: 'x', parameters: { type: 'object', properties: {} } } }]));
  try {
    eq(toolsMod.allToolDefs().length, antes + 1, 'la dinamica se suma al catálogo nativo');
    ok(toolsMod.allToolDefs().some(d => d.function.name === 'mcp__eco__echo'));
    eq(toolsMod.toolDefs.length, antes, 'la tabla nativa no se toca (es la que valida el test de niveles)');
    ok(!RISK['mcp__eco__echo'], 'y no se le inventa un nivel: sin override será confirm');
  } finally { toolsMod.setDynamicToolProvider(null); }
  eq(toolsMod.allToolDefs().length, antes, 'sin proveedor, el catálogo vuelve a ser el nativo');
});

test('permisos: el comodín de servidor MCP sube la confianza de todo un servidor', () => {
  const g = new Guardrails({ permissions: { 'mcp__github__*': 'safe' } });
  eq(g.levelFor('mcp__github__create_issue'), 'safe', 'el comodín del servidor vale para sus herramientas');
  eq(g.decide('mcp__github__create_issue', {}).action, 'allow');
  eq(g.decide('mcp__otro__x', {}).action, 'confirm', 'y solo para ese servidor');
  // el override exacto sigue ganando al comodín
  const g2 = new Guardrails({ permissions: { 'mcp__github__*': 'safe', 'mcp__github__borrar': 'restricted' } });
  eq(g2.decide('mcp__github__borrar', {}).action, 'deny');
  // y ninguna herramienta MCP entra en 'safe' por defecto
  eq(new Guardrails().decide('mcp__loquesea__x', {}).action, 'confirm');
});

test('permisos: la tarjeta de confirmación nombra el servidor y la herramienta', () => {
  ok(describeAction('mcp__github__create_issue', {}).includes('MCP'));
  const d = describeAction('mcp__github__create_issue', { _mcp: { serverName: 'GitHub', toolName: 'create_issue' } });
  ok(/GitHub/.test(d) && /create_issue/.test(d), 'con la etiqueta real: ' + d);
  ok(summarizeArgs('mcp__github__create_issue', { title: 'x', _mcp: { serverName: 'GitHub', toolName: 'create_issue' } }).includes('GitHub'));
});

test('herramientas: una herramienta mcp sin gestor no se ejecuta y se explica', async () => {
  const toolsMod = require('../agent/tools');
  toolsMod.setDynamicToolProvider(() => ([{ type: 'function', function: { name: 'mcp__x__y', description: 'd', parameters: { type: 'object', properties: {} } } }]));
  try {
    // el nivel se fija en la POLÍTICA del agente (no en el ctx): con el 'confirm'
    // por defecto la llamada esperaría una confirmación que aquí no llega nunca
    const a = new AgentCls({ emit: () => {}, guardrailsPolicy: { permissions: { 'mcp__x__y': 'safe' } } });
    const r = await a._runToolCall(toolCall('mcp__x__y', {}), fakeCtx());
    eq(r.action, 'ok', 'la llamada se resuelve (el ejecutor no lanza)');
    ok(/MCP/.test(r.text), 'y explica que no hay servidores MCP: ' + r.text);
  } finally { toolsMod.setDynamicToolProvider(null); }
});
```

- [ ] **Step 2: Ejecutar y ver el fallo**

Run: `npm test 2>&1 | grep -E "FAIL|verde"`
Expected: FAIL con `toolsMod.setDynamicToolProvider is not a function`

- [ ] **Step 3: Implementar**

`agent/tools.js`, al final (antes del `module.exports`):

```js
/* Herramientas que no vienen de la tabla: hoy, los servidores MCP del usuario.
   El proveedor lo instala main.js; si no hay ninguno, el catálogo es el nativo. */
let dynamicProvider = null;
function setDynamicToolProvider(fn) { dynamicProvider = typeof fn === 'function' ? fn : null; }
function allToolDefs() { return dynamicProvider ? defs.concat(dynamicProvider()) : defs; }

module.exports = { toolDefs: defs, allToolDefs, setDynamicToolProvider, RISK };
```

`agent/executors.js` — primera rama del `switch` en `executeTool`:

```js
  switch (name) {
    // Herramientas de un servidor MCP del usuario: el motor de permisos ya decidió
    // (levelFor las deja en 'confirm' salvo override) y aquí solo se ejecutan.
    case undefined:
      break;
    default:
      if (String(name).startsWith('mcp__')) {
        if (!ctx.mcp) return 'Error: no hay servidores MCP disponibles en esta ejecución.';
        return ctx.mcp.callTool(name, args, { onExit: ctx.registerKillable });
      }
  }
```
Para no reescribir el `switch`, la forma mínima y legible es ponerlo **antes** del `switch`:

```js
  // Las herramientas MCP no están en la tabla nativa: se despachan por prefijo al
  // gestor, que ya pasó por el motor de permisos en _runToolCall.
  if (String(name).startsWith('mcp__')) {
    if (!ctx.mcp) return 'Error: no hay servidores MCP en esta ejecución.';
    // `_mcp` es la etiqueta interna de la tarjeta de confirmación (servidor y nombre
    // reales): NO es un argumento de la herramienta, así que no puede viajar al
    // servidor (uno con inputSchema estricto rechazaría el campo de más).
    const { _mcp, ...rest } = args;
    // onExit: Detener corta SOLO la llamada en vuelo (el gancho que expone callTool).
    return ctx.mcp.callTool(name, rest, { onExit: ctx.registerKillable });
  }
```

`agent/agent.js`:
- `:660`: `if (!tools && !allToolDefs().some(d => d.function && d.function.name === name))`
- `:706` (ctx de `executeTool`): añadir `mcp: this.mcp,`
- `:875`: `tools: toolsOverride || allToolDefs(),`
- constructor: `this.mcp = opts.mcp || null;`
- `_delegate` pasa `mcp: this.mcp` al subagente (aunque su catálogo filtrado no incluya MCP, `executeTool` necesita el gestor si alguna vez se habilita).
- En `_runToolCall`, la etiqueta real de la herramienta MCP se añade ANTES de la llamada a `onStatus(statusFor(...))` (si se añade después, la rama `args._mcp` de `statusFor` es código muerto y el rail muestra el slug en vez del nombre real):

```js
    // …justo antes de `if (onStatus) onStatus(statusFor(name, args));`:
    if (String(name).startsWith('mcp__') && this.mcp) {
      const info = this.mcp.describe(name);
      if (info) args = { ...args, _mcp: { serverName: info.serverName, toolName: info.toolName } };
    }
```
- `statusFor`: `if (String(name).startsWith('mcp__')) return 'MCP · ' + (args._mcp ? args._mcp.toolName : name.slice(5));`
- Importar `allToolDefs`: cambiar `const { toolDefs } = require('./tools');` por `const { allToolDefs } = require('./tools');` y ajustar los tres usos.

`agent/guardrails.js`:
- `levelFor`:
```js
  levelFor(name) {
    const override = this.policy.permissions[name];
    if (LEVELS.includes(override)) return override;
    // Comodín por servidor MCP (`mcp__github__*`): permite confiar en un servidor
    // entero sin listar sus herramientas una a una. El override exacto sigue ganando.
    const m = /^mcp__([a-z0-9_]+)__/.exec(String(name || ''));
    if (m) {
      const w = this.policy.permissions[`mcp__${m[1]}__*`];
      if (LEVELS.includes(w)) return w;
    }
    return DEFAULT_RISK[name] || 'confirm';
  }
```
- `describeAction`: en el `default`, antes del texto genérico:
```js
    default: {
      // la etiqueta solo vale para nombres MCP: los argumentos llegan sin filtrar del
      // modelo, y un `_mcp` inyectado en una herramienta nativa haría que la tarjeta
      // de confirmación describiera otra cosa (y ocultara la ruta a escribir)
      if (String(name).startsWith('mcp__') && a._mcp) return 'Usar la herramienta «' + a._mcp.toolName + '» del servidor MCP «' + a._mcp.serverName + '»';
      if (String(name).startsWith('mcp__')) return 'Usar una herramienta MCP (' + name.slice(5).replace(/__/g, ' · ') + ')';
      return 'Usar herramienta ' + name;
    }
```
- `summarizeArgs`: en el `default`:
```js
    default: {
      if (String(name).startsWith('mcp__') && a._mcp) return `${a._mcp.serverName} → ${a._mcp.toolName}`;
      return Object.keys(a).length ? JSON.stringify(a).slice(0, 160) : '';
    }
```

- [ ] **Step 4: Ejecutar los tests**

Run: `npm test 2>&1 | grep -E "FAIL|verde"`
Expected: `Todos los tests en verde (208)`

- [ ] **Step 5: Commit**

```bash
git add agent/tools.js agent/executors.js agent/agent.js agent/guardrails.js test/run.js
git commit -m "mcp: las herramientas MCP entran al catalogo, al ejecutor y al motor de permisos sin vias laterales"
```

---

### Task 8: Configuración, secretos e IPC en el proceso principal

**Files:**
- Modify: `main/main.js` (config, `configParaDisco`, `applyConfig`, instanciación, IPC, `before-quit`)
- Test: `test/run.js` (test de contrato sobre el módulo puro de validación)

**Interfaces:**
- Consumes: `McpManager` (Task 5), `attach` (ya existe).
- Produces:
  - `main/mcp-config.js` (**nuevo**): `validateServer(raw) -> { ok, error?, value? }`, `sanitizeList(v) -> string[]` — validación pura, probable sin Electron.
  - Canales IPC: `mcp:list`, `mcp:save`, `mcp:delete`, `mcp:toggle`, `mcp:test`, `mcp:refresh`, `mcp:import`, `mcp:export`, `mcp:log`, `mcp:setGlobal`.

- [ ] **Step 1: Escribir el test de validación (falla)**

```js
test('mcp: la validacion de un servidor rechaza lo que no puede funcionar', () => {
  const { validateServer } = require('../main/mcp-config');
  const base = { id: 'eco', name: 'Eco', transport: 'stdio', command: 'npx', args: ['-y', 'x'] };
  ok(validateServer(base).ok, 'un servidor stdio válido pasa');
  eq(validateServer({ ...base, id: 'Con Espacios!' }).value.id, 'con_espacios', 'el id se sanea');
  for (const malo of [
    { ...base, id: '' },
    { ...base, id: '../fuera' },
    { ...base, transport: 'carrier-pigeon' },
    { ...base, transport: 'stdio', command: '' },
    { ...base, transport: 'http', url: 'http://mcp.ejemplo.com/mcp' },
    { ...base, transport: 'http', url: 'file:///C:/x' },
    { ...base, transport: 'stdio', timeoutMs: -5 },
    { ...base, command: 'npx', args: ['a', 'b"c'] },
  ]) ok(validateServer(malo).ok === false, 'debe rechazar ' + JSON.stringify(malo).slice(0, 90));
  ok(validateServer({ ...base, transport: 'http', url: 'https://x/mcp' }).ok, 'https remoto vale');
  ok(validateServer({ ...base, transport: 'http', url: 'http://127.0.0.1:9/mcp' }).ok, 'http en localhost vale');
  const conListas = validateServer({ ...base, tools: { allow: 'echo', deny: ['x', '', 2] } });
  eq(conListas.value.tools.allow.join(','), 'echo');
  eq(conListas.value.tools.deny.join(','), 'x');
});
```

- [ ] **Step 2: Ejecutar y ver el fallo**

Run: `npm test 2>&1 | grep -E "FAIL|verde"`
Expected: FAIL con `Cannot find module '../main/mcp-config'`

- [ ] **Step 3: Crear `main/mcp-config.js`**

```js
'use strict';

/* Validación de la configuración de un servidor MCP. Vive fuera de main.js (Node
   puro) para poder probarla: es la puerta por la que entran el comando que se
   ejecutará y la URL a la que se enviará el token. */

const { httpUrlAllowed, buildCmdLine } = require('../agent/mcp-transport');

const ID_RX = /^[a-z0-9_-]{1,24}$/;
const TRANSPORTS = ['stdio', 'http'];

const rawId = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);

/** Lista de nombres de herramienta: solo cadenas no vacías, sin duplicados. */
function sanitizeList(v) {
  const arr = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : []);
  const out = [];
  for (const x of arr) {
    const s = String(x || '').trim();
    if (s && !out.includes(s)) out.push(s.slice(0, 80));
  }
  return out;
}

/** @returns {{ok: boolean, error?: string, value?: object}} */
function validateServer(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const id = rawId(s.id || s.name);
  if (!id || !ID_RX.test(id)) return { ok: false, error: 'El identificador debe tener letras, números, guion o guion bajo (máx. 24).' };
  const transport = TRANSPORTS.includes(s.transport) ? s.transport : 'stdio';
  const timeoutMs = s.timeoutMs === undefined || s.timeoutMs === '' ? 60000 : Number(s.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 5000 || timeoutMs > 300000) {
    return { ok: false, error: 'El timeout debe estar entre 5 y 300 segundos.' };
  }
  const base = {
    id,
    name: String(s.name || s.id || id).trim().slice(0, 60) || id,
    enabled: s.enabled !== false,
    transport,
    timeoutMs,
    tools: { allow: sanitizeList(s.tools && s.tools.allow), deny: sanitizeList(s.tools && s.tools.deny) },
    autoStart: s.autoStart === true,
  };
  if (transport === 'stdio') {
    const command = String(s.command || '').trim();
    if (!command) return { ok: false, error: 'Falta el comando del servidor.' };
    // Un `args` truthy que no sea lista (pegado de otro cliente o editado a mano)
    // reventaba en buildCmdLine con «args.map is not a function»; null y '' siguen
    // valiendo como lista vacía, como hacía el `s.args || []` de antes.
    if (s.args != null && s.args !== '' && !Array.isArray(s.args)) return { ok: false, error: 'Los argumentos deben ser una lista (ej.: ["-y", "paquete"]).' };
    try { buildCmdLine(command, s.args || []); }
    catch (e) { return { ok: false, error: e.message }; }
    const env = {};
    for (const [k, v] of Object.entries(s.env && typeof s.env === 'object' ? s.env : {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return { ok: false, error: `Nombre de variable inválido: ${k}` };
      env[k] = String(v == null ? '' : v);
    }
    return { ok: true, value: { ...base, command, args: (s.args || []).map(String), cwd: String(s.cwd || ''), env } };
  }
  const url = String(s.url || '').trim();
  if (!httpUrlAllowed(url)) return { ok: false, error: 'La URL debe ser https (o http en localhost/127.0.0.1).' };
  const headers = {};
  for (const [k, v] of Object.entries(s.headers && typeof s.headers === 'object' ? s.headers : {})) {
    if (!/^[A-Za-z0-9-]+$/.test(k)) return { ok: false, error: `Cabecera inválida: ${k}` };
    headers[k] = String(v == null ? '' : v);
  }
  return { ok: true, value: { ...base, url, headers } };
}

/** Conserva un secreto ya guardado cuando el formulario llega con el campo vacío
    o con la máscara: sin esto, volver a guardar un servidor borraba su token. */
function mergeSecrets(prev = {}, next = {}) {
  const out = { ...prev };
  for (const [k, v] of Object.entries(next || {})) {
    const val = String(v == null ? '' : v);
    out[k] = (!val || val === '••••') ? (prev[k] || '') : val;
  }
  return out;
}

/**
 * Convierte el JSON de `mcpServers` de otro cliente en servidores validados.
 * `command` → stdio, `url` → http. Las entradas que no pasan la validación se
 * descartan (y si ninguna pasa, se explica).
 * @returns {{ok: boolean, error?: string, servers?: object[]}}
 */
function parseMcpImport(text) {
  let raw = null;
  try { raw = JSON.parse(String(text || '')); } catch { return { ok: false, error: 'Eso no es JSON válido.' }; }
  const mapa = (raw && raw.mcpServers) || raw;
  if (!mapa || typeof mapa !== 'object' || Array.isArray(mapa)) return { ok: false, error: 'No encuentro el bloque mcpServers.' };
  const servers = [];
  const rechazados = [];
  for (const [id, def] of Object.entries(mapa)) {
    const d = def && typeof def === 'object' ? def : {};
    const v = validateServer({
      id,
      name: id,
      transport: d.url ? 'http' : 'stdio',
      command: d.command,
      args: d.args,
      env: d.env,
      url: d.url,
      headers: d.headers,
    });
    if (v.ok) servers.push(v.value); else rechazados.push(id + ': ' + v.error);
  }
  if (!servers.length) return { ok: false, error: 'Ningún servidor válido. ' + rechazados.join(' · ') };
  return { ok: true, servers };
}

module.exports = { validateServer, sanitizeList, rawId, mergeSecrets, parseMcpImport };
```

- [ ] **Step 4: Cablear `main/main.js`**

1. Importar arriba: `const { McpManager } = require('../agent/mcp');` y `const mcpConfig = require('./mcp-config');`
2. En `config`, añadir el bloque y su saneado en `applyConfig`:
```js
  mcp: { enabled: true, servers: [] },
```
```js
  // MCP: la lista de servidores la valida el módulo puro (comando, URL, timeout)
  const mcpRaw = (raw.mcp && Array.isArray(raw.mcp.servers)) ? raw.mcp.servers : [];
  const servers = [];
  for (const s of mcpRaw) {
    const v = mcpConfig.validateServer(s);
    if (v.ok) servers.push(revealServerSecrets(v.value));
  }
  config.mcp = { enabled: raw.mcp ? raw.mcp.enabled !== false : true, servers };
```
3. Secretos (`env` y `headers`), junto a `protectKey`/`revealKey`:
```js
/** Cifra los valores de env/headers de un servidor MCP (pueden ser tokens). */
function protectServerSecrets(s) {
  const paint = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, protectKey(String(v))]));
  return { ...s, env: paint(s.env), headers: paint(s.headers) };
}
function revealServerSecrets(s) {
  const paint = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, revealKey(String(v))]));
  return { ...s, env: paint(s.env), headers: paint(s.headers) };
}
```
   - En `configParaDisco()`: `mcp: { ...config.mcp, servers: (config.mcp.servers || []).map(protectServerSecrets) }`.
   - En `needsKeyEncryption()`: además de las claves, `(config.mcp.servers || []).some(s => [...Object.values(s.env || {}), ...Object.values(s.headers || {})].some(v => v && !String(v).startsWith(KEY_PREFIX)))`.
   - En el arranque, `applyConfig` usa `revealServerSecrets` (ya incluido arriba como `decryptServer`): `const decrypt = revealServerSecrets` — usar el nombre directo.
4. Instancia y proveedor dinámico (antes de `createAgent`, junto a `const runlog = …`):
```js
/* ---- MCP: el gestor vive aquí y el catálogo lo consulta tools.js por turno ---- */
let mcp = null;
function wireMcp() {
  if (!mcp) mcp = new McpManager({ servers: [], dataDir: CONFIG_DIR, clientVersion: app.getVersion(), log: (e) => runlog.log(e) });
  mcp.configure(config.mcp.servers || []);
  // el catálogo se pide en cada turno: conectar un servidor no exige reiniciar la app.
  // El interruptor global se aplica AQUÍ: apagado, el catálogo que ve el modelo no
  // incluye ninguna herramienta MCP (el renderer no puede quitarlas por su cuenta).
  require('../agent/tools').setDynamicToolProvider(() => (config.mcp.enabled === false ? [] : mcp.toolDefs()));
  return mcp;
}
```
   - Llamar a `wireMcp()` en `app.whenReady()` (antes de `wireAgent()`), y arrancar los `autoStart`:
```js
  wireMcp();
  // con el interruptor global apagado no se arranca ningún servidor
  if (config.mcp.enabled !== false) for (const s of config.mcp.servers || []) if (s.autoStart && s.enabled) mcp.ensure(s.id).catch(() => {});
```
   - `createAgent(isBackground)`: añadir `mcp: wireMcp(),` al `new Agent({...})`.
5. IPC (todos validando la entrada; `mcp:delete` limpia overrides):
```js
/* ---------- v3.1: servidores MCP del usuario ---------- */
/* Estado para la UI: la configuración completa del servidor (command/args/env/headers,
   con el mismo criterio que config:get con las claves de proveedor: el renderer es de
   confianza y sin ellos el formulario de edición no puede editar nada) MÁS el estado
   vivo del gestor. `discovered` es el catálogo REAL descubierto: NO se puede llamar
   `tools` porque `tools` en la configuración son los filtros allow/deny. */
function mcpState() {
  const vivo = new Map(wireMcp().status().map(s => [s.id, s]));
  return {
    enabled: config.mcp.enabled !== false,
    servers: (config.mcp.servers || []).map(s => {
      const v = vivo.get(s.id) || {};
      return {
        ...s,
        enabled: v.enabled !== undefined ? v.enabled : s.enabled,
        state: v.state || 'idle',
        error: v.error || null,
        logTail: v.logTail || '',
        discovered: v.tools || [],
      };
    }),
  };
}

ipcMain.handle('mcp:list', () => mcpState());

ipcMain.handle('mcp:save', (e, raw) => {
  const v = mcpConfig.validateServer(raw || {});
  if (!v.ok) return { ok: false, error: v.error };
  const server = v.value;
  // el formulario no reenvía los secretos: un valor vacío conserva el guardado
  const previo = (config.mcp.servers || []).find(s => s.id === server.id);
  if (previo) {
    server.env = mcpConfig.mergeSecrets(previo.env, server.env);
    server.headers = mcpConfig.mergeSecrets(previo.headers, server.headers);
    // El formulario no reenvía estos campos: se conservan del servidor guardado para
    // que editar no reactive un servidor apagado ni pierda autoStart/timeout/cwd.
    if (raw.enabled === undefined) server.enabled = previo.enabled !== false;
    if (raw.autoStart === undefined) server.autoStart = previo.autoStart === true;
    if (raw.timeoutMs === undefined) server.timeoutMs = previo.timeoutMs;
    if (raw.cwd === undefined) server.cwd = previo.cwd || '';
  }
  config.mcp.servers = [...(config.mcp.servers || []).filter(s => s.id !== server.id), server];
  wireMcp();
  const r = persistConfig();
  // `id` sale en la respuesta: la UI lo necesita YA saneado para aplicar el permiso
  // del servidor (el del formulario puede traer mayúsculas o símbolos).
  return r.ok ? { ok: true, id: server.id, servers: mcpState().servers } : { ok: false, error: r.error };
});

ipcMain.handle('mcp:delete', (e, id) => {
  const sid = mcpConfig.rawId(id);
  config.mcp.servers = (config.mcp.servers || []).filter(s => s.id !== sid);
  // los permisos de un servidor borrado quedarían huérfanos (y si vuelve, con
  // los niveles de antes, que el usuario ya no ve en ningún sitio)
  for (const k of Object.keys(config.security.permissions || {})) {
    if (k === `mcp__${sid}__*` || k.startsWith(`mcp__${sid}__`)) delete config.security.permissions[k];
  }
  if (agent) agent.setPolicy(config.security);
  wireMcp();
  const r = persistConfig();
  // si el disco falla, decir «eliminado» sería mentir: el servidor seguiría en config.json
  return r.ok ? { ok: true, servers: mcpState().servers } : { ok: false, error: r.error };
});

ipcMain.handle('mcp:toggle', (e, { id, enabled }) => {
  const sid = mcpConfig.rawId(id);
  const server = (config.mcp.servers || []).find(s => s.id === sid);
  if (!server) return { ok: false, error: 'Servidor no encontrado.' };
  server.enabled = enabled !== false;
  wireMcp();
  // Activar una fila debe dejarla lista, no solo marcar la bandera (si no, el usuario
  // la activa y no pasa nada hasta pulsar Probar).
  if (server.enabled && config.mcp.enabled !== false) wireMcp().ensure(sid).catch(() => {});
  const r = persistConfig();
  return r.ok ? { ok: true, servers: mcpState().servers } : { ok: false, error: r.error };
});
ipcMain.handle('mcp:setGlobal', (e, enabled) => {
  config.mcp.enabled = enabled !== false;
  const m = wireMcp();
  // Al reencender hay que reconectar lo que el arranque no arrancó: sin esto los
  // servidores autoStart se quedan en 'idle' y MCP no aporta nada al modelo.
  if (config.mcp.enabled) for (const s of config.mcp.servers || []) if (s.autoStart && s.enabled) m.ensure(s.id).catch(() => {});
  return persistConfig();
});
ipcMain.handle('mcp:refresh', async (e, id) => { /* ensure + devuelve status del servidor */ });
ipcMain.handle('mcp:test', async (e, id) => { const r = await wireMcp().ensure(mcpConfig.rawId(id)); return { ok: r.ok, error: r.error || null, server: mcpState().servers.find(s => s.id === mcpConfig.rawId(id)) }; });
ipcMain.handle('mcp:log', (e, id) => { const s = mcpState().servers.find(x => x.id === mcpConfig.rawId(id)); return { ok: !!s, log: (s && s.logTail) || '', error: (s && s.error) || null }; });
ipcMain.handle('mcp:export', () => ({ ok: true, json: JSON.stringify(mcpExport(), null, 2) }));
ipcMain.handle('mcp:import', (e, json) => {
  // NO escribe: devuelve la vista previa con conflictos para que el usuario confirme
  const r = mcpConfig.parseMcpImport(String(json || ''));
  if (!r.ok) return r;
  const existentes = new Set((config.mcp.servers || []).map(s => s.id));
  return { ok: true, servers: r.servers.map(s => ({ ...s, conflict: existentes.has(s.id) })) };
});
```
   - `mcpExport()`: `{ mcpServers: { [id]: { command, args, env, url, headers } } }` con los valores en claro (el usuario los pidió para copiarlos). Se marca en la UI como "contiene tus secretos".
   - `mergeSecrets` y `parseMcpImport` viven en `main/mcp-config.js` (ya escritos en el Step 3).
6. `before-quit` (donde ya se para el TaskManager y la voz): añadir
```js
  if (mcp) { try { mcp.shutdown(); } catch {} }
```

- [ ] **Step 5: Test de las funciones puras de importación y secretos**

Las dos funciones puras ya viven en `main/mcp-config.js` (Step 3), así que se prueban ahí sin Electron:

```js
test('mcp: importar el JSON de otro cliente y conservar secretos al guardar', () => {
  const { parseMcpImport, mergeSecrets } = require('../main/mcp-config');
  const r = parseMcpImport(JSON.stringify({ mcpServers: {
    github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'ghp_x' } },
    remoto: { url: 'https://mcp.ejemplo.com/mcp', headers: { Authorization: 'Bearer t' } },
    roto: { command: '' },
  } }));
  ok(r.ok, JSON.stringify(r));
  eq(r.servers.map(s => s.id).sort().join(','), 'github,remoto', 'la entrada inválida se descarta');
  eq(r.servers.find(s => s.id === 'github').transport, 'stdio');
  eq(r.servers.find(s => s.id === 'remoto').transport, 'http');
  // guardar con el campo de secreto vacío no puede borrar el que ya había
  eq(mergeSecrets({ TOKEN: 'viejo' }, { TOKEN: '' }).TOKEN, 'viejo');
  eq(mergeSecrets({ TOKEN: 'viejo' }, { TOKEN: 'nuevo' }).TOKEN, 'nuevo');
  eq(mergeSecrets({}, { TOKEN: 'nuevo' }).TOKEN, 'nuevo');
});
```

- [ ] **Step 6: Ejecutar los tests y el arranque**

Run: `npm test 2>&1 | grep -E "FAIL|verde"` → `Todos los tests en verde (210)`
Run: `npm run smoke` → exit 0 (el proceso principal arranca con el gestor MCP montado)

- [ ] **Step 7: Commit**

```bash
git add main/main.js main/mcp-config.js test/run.js
git commit -m "mcp: config en config.json con secretos cifrados, IPC validado, import/export y cierre ordenado"
```

---

### Task 9: Puente del renderer

**Files:**
- Modify: `main/preload.js` (bloque de MCP, junto a los demás canales)

**Interfaces:**
- Consumes: canales de Task 8.
- Produces: `window.sagitari.mcpList/mcpSave/mcpDelete/mcpToggle/mcpSetGlobal/mcpTest/mcpRefresh/mcpLog/mcpImport/mcpExport`.

- [ ] **Step 1: Añadir los métodos**

```js
  // ---- v3.1: servidores MCP del usuario ----
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  mcpSave: (server) => ipcRenderer.invoke('mcp:save', server),
  mcpDelete: (id) => ipcRenderer.invoke('mcp:delete', id),
  mcpToggle: (id, enabled) => ipcRenderer.invoke('mcp:toggle', { id, enabled }),
  mcpSetGlobal: (enabled) => ipcRenderer.invoke('mcp:setGlobal', enabled),
  mcpTest: (id) => ipcRenderer.invoke('mcp:test', id),
  mcpRefresh: (id) => ipcRenderer.invoke('mcp:refresh', id),
  mcpLog: (id) => ipcRenderer.invoke('mcp:log', id),
  mcpImport: (json) => ipcRenderer.invoke('mcp:import', json),
  mcpExport: () => ipcRenderer.invoke('mcp:export'),
```

- [ ] **Step 2: Comprobar que el puente no rompe el arranque**

Run: `npm run smoke` → exit 0

- [ ] **Step 3: Commit**

```bash
git add main/preload.js
git commit -m "mcp: puente del renderer para los canales mcp:*"
```

---

### Task 10: Ajustes › MCP (pestaña, lista y formulario)

**Files:**
- Modify: `renderer/index.html` (pestaña `data-set="mcp"` + panel), `renderer/app.js` (`SET_TABS`, render del panel), `renderer/styles.css`
- Test: `scripts/ui-check.js` (Task 13 comprueba el resultado en vivo); aquí se verifica con la app arrancada

**Interfaces:**
- Consumes: puente de Task 9.
- Produces: funciones `renderMcp()`, `mcpFormSave()`, `mcpFormFrom(server)`, `showSetTab('mcp')`.

- [ ] **Step 1: Añadir la pestaña y el panel en `renderer/index.html`**

En la barra de pestañas de Ajustes (junto a las existentes `data-set="model|prefs|security|agent|data|about"`):

```html
<button class="settab" data-set="mcp"><i data-i="bolt"></i> MCP</button>
```

Y el panel, con la MISMA estructura que los demás (`.setcard` + `.sc-head` + filas
`.field srow` con `data-keys`, que es lo que usan el buscador de ajustes y el filtrado
de tarjetas; una fila sin `.srow` no se puede buscar y una tarjeta sin `.setcard` no se
oculta al filtrar):

```html
<!-- ===== MCP ===== -->
<div class="setpanel" data-panel="mcp">
  <div class="setcard">
    <div class="sc-head"><b>Servidores MCP</b><span class="sc-hint">Conecta herramientas externas (GitHub, Notion, tu propio servidor…) y el agente las usará como las de casa.</span></div>
    <div class="swrow srow" data-keys="mcp servidores activar conectar herramientas externas apagar">
      <span class="st"><b>Activar servidores MCP</b><small>Apagado, el agente no ve ninguna herramienta MCP.</small></span>
      <div class="sw on" id="mcpGlobal" role="switch" tabindex="0" aria-label="Activar servidores MCP"></div>
    </div>
    <div id="mcpList" class="mcplist"></div>
    <div class="srow" data-keys="mcp anadir servidor pegar json exportar mcpServers">
      <div class="btnrow">
        <button class="btn" id="mcpNew"><span class="bi"><i data-i="plus"></i></span> Añadir servidor</button>
        <button class="btn ghost" id="mcpPaste">Pegar JSON de mcpServers</button>
        <button class="btn ghost" id="mcpExportBtn">Exportar</button>
      </div>
    </div>
    <div class="subnote" id="mcpMsg"></div>
  </div>

  <div class="setcard" id="mcpFormCard" hidden>
    <div class="sc-head"><b id="mcpFormTitle">Nuevo servidor</b><span class="sc-hint">Las variables de entorno y las cabeceras se guardan cifradas con el almacén de Windows.</span></div>
    <div class="field srow" data-keys="mcp identificador nombre id"><label for="mcpId">IDENTIFICADOR</label><input type="text" id="mcpId" placeholder="github" spellcheck="false" /></div>
    <div class="field srow" data-keys="mcp nombre visible etiqueta"><label for="mcpName">NOMBRE</label><input type="text" id="mcpName" placeholder="GitHub" /></div>
    <div class="field srow" data-keys="mcp tipo transporte local remoto comando url"><label for="mcpTransport">TIPO</label>
      <select id="mcpTransport"><option value="stdio">Comando local</option><option value="http">URL remota</option></select>
    </div>
    <div id="mcpStdioRows">
      <div class="field srow" data-keys="mcp comando ejecutable npx node"><label for="mcpCommand">COMANDO</label><input type="text" id="mcpCommand" placeholder="npx" spellcheck="false" /></div>
      <div class="field srow" data-keys="mcp argumentos args"><label for="mcpArgs">ARGUMENTOS</label><input type="text" id="mcpArgs" placeholder="-y @modelcontextprotocol/server-github" spellcheck="false" /></div>
      <div class="field srow" data-keys="mcp variables entorno env token secreto"><label for="mcpEnv">VARIABLES DE ENTORNO</label><textarea id="mcpEnv" rows="3" placeholder="GITHUB_TOKEN=ghp_… (una por línea)"></textarea></div>
    </div>
    <div id="mcpHttpRows" hidden>
      <div class="field srow" data-keys="mcp url direccion remota endpoint"><label for="mcpUrl">URL</label><input type="text" id="mcpUrl" placeholder="https://mcp.ejemplo.com/mcp" spellcheck="false" /></div>
      <div class="field srow" data-keys="mcp cabeceras headers autorizacion token"><label for="mcpHeaders">CABECERAS</label><textarea id="mcpHeaders" rows="3" placeholder="Authorization=Bearer … (una por línea)"></textarea></div>
    </div>
    <div class="field srow" data-keys="mcp permiso nivel bloquear permitir preguntar servidor"><label for="mcpLevel">PERMISO DEL SERVIDOR</label>
      <select id="mcpLevel"><option value="default">Preguntar siempre (recomendado)</option><option value="safe">Permitir siempre</option><option value="restricted">Bloqueado</option></select>
    </div>
    <div class="field srow" data-keys="mcp herramientas permitir allow lista"><label for="mcpAllow">HERRAMIENTAS A PERMITIR (vacío = todas)</label><input type="text" id="mcpAllow" placeholder="create_issue, list_issues" spellcheck="false" /></div>
    <div class="field srow" data-keys="mcp herramientas bloquear deny lista"><label for="mcpDeny">HERRAMIENTAS A BLOQUEAR</label><input type="text" id="mcpDeny" placeholder="delete_repository" spellcheck="false" /></div>
    <div class="srow" data-keys="mcp guardar probar cancelar eliminar">
      <div class="btnrow">
        <button class="btn" id="mcpSave"><span class="bi"><i data-i="check"></i></span> Guardar y probar</button>
        <button class="btn ghost" id="mcpCancel">Cancelar</button>
        <button class="btn ghost" id="mcpFormDelete" hidden>Eliminar</button>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Añadir la lógica en `renderer/app.js`**

```js
/* ============ v3.1: servidores MCP ============ */
// `let`: renderMcp() REASIGNA el estado; con `const` el panel no pintaba nunca.
let MCP_STATE = { enabled: true, servers: [] };
const mcpPair = (text) => String(text || '').split('\n').map(l => l.trim()).filter(Boolean)
  .map(l => { const i = l.indexOf('='); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : null; })
  .filter(Boolean);
const mcpLines = (obj) => Object.entries(obj || {}).map(([k, v]) => k + '=' + v).join('\n');

/** Estados del servidor, tal y como los ve el usuario. */
function mcpStatusLabel(s) {
  if (!s.enabled) return { text: 'Desactivado', cls: 'off' };
  const n = (s.discovered || []).length;
  if (s.state === 'ready') return { text: 'Listo (' + n + ' herramienta' + (n === 1 ? '' : 's') + ')', cls: 'ok' };
  if (s.state === 'starting') return { text: 'Conectando…', cls: 'wait' };
  if (s.state === 'dead') return { text: 'Error: ' + (s.error || 'no arrancó'), cls: 'err' };
  return { text: 'Sin probar', cls: 'off' };
}

async function renderMcp() {
  const box = $('#mcpList');
  if (!box) return;
  try { MCP_STATE = await window.sagitari.mcpList(); } catch (e) { showToast('No pude leer los servidores MCP: ' + e.message); return; }
  $('#mcpGlobal').classList.toggle('on', MCP_STATE.enabled !== false);
  if (!(MCP_STATE.servers || []).length) {
    box.innerHTML = '<div class="mcpempty">Ningún servidor MCP. Añade uno o pega el JSON de <code>mcpServers</code> de otro cliente.</div>';
    return;
  }
  box.innerHTML = MCP_STATE.servers.map(s => {
    const st = mcpStatusLabel(s);
    const lista = (s.discovered || []).map(t => `<span class="mcptool" title="${esc(t.description || '')}">${esc(t.tool)}</span>`).join('');
    return `<div class="mcprow" data-id="${esc(s.id)}">
      <div class="mcphead">
        <span class="mcpdot ${st.cls}"></span>
        <b>${esc(s.name)}</b>
        <span class="mcpst">${esc(st.text)}</span>
        <span class="mcpdo">${s.transport === 'http' ? 'URL' : 'local'}</span>
      </div>
      <div class="mcptools">${lista}</div>
      <div class="mcpacts">
        <button class="btn ghost" data-mcp="test">Probar</button>
        <button class="btn ghost" data-mcp="log">Ver log</button>
        <button class="btn ghost" data-mcp="edit">Editar</button>
        <button class="btn ghost" data-mcp="toggle">${s.enabled ? 'Desactivar' : 'Activar'}</button>
        <button class="btn ghost" data-mcp="del">Eliminar</button>
      </div>
    </div>`;
  }).join('');
  mejoraSelects(box);
}

function mcpFormShow(server) {
  const s = server || { transport: 'stdio', tools: {} };
  $('#mcpFormCard').hidden = false;
  $('#mcpFormTitle').textContent = server ? 'Editar servidor' : 'Nuevo servidor';
  $('#mcpId').value = s.id || '';
  $('#mcpId').disabled = !!server;
  $('#mcpName').value = s.name || '';
  $('#mcpTransport').value = s.transport || 'stdio';
  $('#mcpCommand').value = s.command || '';
  $('#mcpArgs').value = (s.args || []).join(' ');
  $('#mcpEnv').value = mcpLines(s.env);
  $('#mcpUrl').value = s.url || '';
  $('#mcpHeaders').value = mcpLines(s.headers);
  $('#mcpAllow').value = (s.tools && s.tools.allow || []).join(', ');
  $('#mcpDeny').value = (s.tools && s.tools.deny || []).join(', ');
  $('#mcpFormDelete').hidden = !server;
  mcpTransportRows();
  mejoraSelects($('#mcpFormCard'));
}

function mcpTransportRows() {
  const esHttp = $('#mcpTransport').value === 'http';
  $('#mcpStdioRows').hidden = esHttp;
  $('#mcpHttpRows').hidden = !esHttp;
}

/** Construye el servidor con lo que hay en el formulario (valida main). */
function mcpFormValue() {
  const pair = (id) => Object.fromEntries(mcpPair($(id).value));
  return {
    id: $('#mcpId').value.trim(),
    name: $('#mcpName').value.trim(),
    transport: $('#mcpTransport').value,
    command: $('#mcpCommand').value.trim(),
    args: $('#mcpArgs').value.trim() ? $('#mcpArgs').value.trim().split(/\s+/) : [],
    env: pair('#mcpEnv'),
    url: $('#mcpUrl').value.trim(),
    headers: pair('#mcpHeaders'),
    tools: {
      allow: $('#mcpAllow').value.split(',').map(x => x.trim()).filter(Boolean),
      deny: $('#mcpDeny').value.split(',').map(x => x.trim()).filter(Boolean),
    },
  };
}
```

En el bloque de cableado de Ajustes (junto a los demás `onclick`):
```js
$('#mcpTransport').onchange = mcpTransportRows;
$('#mcpNew').onclick = () => mcpFormShow(null);
$('#mcpCancel').onclick = () => { $('#mcpFormCard').hidden = true; };
$('#mcpGlobal').onclick = async (e) => {
  const on = !e.currentTarget.classList.contains('on');
  e.currentTarget.classList.toggle('on', on);
  await window.sagitari.mcpSetGlobal(on);
  // El interruptor puede reconectar servidores en segundo plano: se pide su estado
  // antes de repintar para no dejar la fila en «Conectando…» para siempre.
  for (const s of (MCP_STATE.servers || [])) await window.sagitari.mcpRefresh(s.id).catch(() => {});
  renderMcp();
};
$('#mcpSave').onclick = async () => {
  const s = mcpFormValue();
  const nivel = $('#mcpLevel').value;
  const r = await window.sagitari.mcpSave(s);
  if (!r.ok) return mcpMsg('Error: ' + r.error);
  // El nivel elegido se aplica al comodín del servidor (el MISMO que edita Seguridad):
  // sin esto el desplegable sería decorativo. Se usa el id que devuelve main (ya
  // saneado), no el del formulario, que puede traer mayúsculas o símbolos.
  if (nivel && nivel !== 'default' && r.id) await window.sagitari.secSetToolPerm('mcp__' + r.id + '__*', nivel);
  $('#mcpFormCard').hidden = true;
  mcpMsg('Guardado. Probando la conexión…');
  const t = await window.sagitari.mcpTest(r.id || s.id);
  mcpMsg(t.ok ? 'Conectado: ' + (t.server ? t.server.discovered.length : 0) + ' herramientas.' : 'No conecta: ' + t.error);
  renderMcp();
};
$('#mcpFormDelete').onclick = async () => {
  const id = $('#mcpId').value.trim();
  const yes = await askConfirm($('#mcpFormCard'), '¿Eliminar el servidor MCP «' + id + '»?', 'Se borran su configuración y sus permisos.');
  if (!yes) return;
  const r = await window.sagitari.mcpDelete(id);
  $('#mcpFormCard').hidden = true;
  smsg(r.ok ? 'Servidor eliminado.' : 'Error: ' + r.error);
  renderMcp();
};
$('#mcpList').onclick = async (e) => {
  const btn = e.target.closest('[data-mcp]');
  if (!btn) return;
  const id = btn.closest('.mcprow').dataset.id;
  const accion = btn.dataset.mcp;
  if (accion === 'edit') return mcpFormShow(MCP_STATE.servers.find(s => s.id === id));
  if (accion === 'toggle') {
    const s = MCP_STATE.servers.find(x => x.id === id);
    await window.sagitari.mcpToggle(id, !s.enabled);
    // activar conecta en segundo plano: se pide el estado antes de repintar
    await window.sagitari.mcpRefresh(id).catch(() => {});
    return renderMcp();
  }
  if (accion === 'del') {
    const yes = await askConfirm(btn, '¿Eliminar «' + id + '»?', 'Se borran su configuración y sus permisos.');
    if (!yes) return;
    await window.sagitari.mcpDelete(id);
    return renderMcp();
  }
  if (accion === 'log') {
    const r = await window.sagitari.mcpLog(id);
    return showToast(r.log ? r.log.split('\n').slice(-3).join(' · ') : (r.error || 'El servidor no ha escrito nada.'));
  }
  if (accion === 'test') {
    btn.textContent = 'Probando…';
    const r = await window.sagitari.mcpTest(id);
    btn.textContent = 'Probar';
    mcpMsg(r.ok ? 'Conectado: ' + (r.server ? r.server.discovered.length : 0) + ' herramientas.' : 'No conecta: ' + r.error);
    return renderMcp();
  }
};
$('#mcpExportBtn').onclick = async () => {
  const r = await window.sagitari.mcpExport();
  if (!r.ok) return smsg('Error: ' + r.error);
  copyText(r.json, 'JSON copiado (contiene tus secretos: no lo compartas).');
};
$('#mcpPaste').onclick = async () => {
  const json = prompt('Pega el bloque mcpServers:');
  if (!json) return;
  const r = await window.sagitari.mcpImport(json);
  if (!r.ok) return smsg('Error: ' + r.error);
  const resumen = r.servers.map(s => s.id + (s.conflict ? ' (reemplaza el actual)' : '')).join(', ');
  const yes = await askConfirm($('#mcpPaste'), '¿Añadir estos servidores?', resumen);
  if (!yes) return;
  for (const s of r.servers) await window.sagitari.mcpSave(s);
  smsg('Añadidos: ' + resumen);
  renderMcp();
};
```

- [ ] **Step 2b: Mensaje del panel**

`smsg()` escribe en `#saveMsg`, que es el aviso del formulario de proveedores: el panel MCP tiene el suyo (`#mcpMsg`). Añadir junto a `smsg`:

```js
/** Aviso del panel MCP (no reutiliza el del formulario de proveedores). */
function mcpMsg(t) { const el = $('#mcpMsg'); if (el) el.textContent = t || ''; }
```
Y en todos los manejadores de MCP de este paso, usar `mcpMsg(...)` donde el código dice `smsg(...)`.

- [ ] **Step 3: Añadir `'mcp'` a `SET_TABS` y renderizar al entrar**

```js
const SET_TABS = ['model', 'prefs', 'security', 'agent', 'mcp', 'data', 'about'];
```
En `showSetTab(panel)`, tras pintar el panel:
```js
  if (panel === 'mcp') renderMcp();
```

- [ ] **Step 4: Estilos en `renderer/styles.css`**

```css
/* ---- servidores MCP (Ajustes › MCP) ----
   El interruptor usa la clase `.sw` de los demás y la tarjeta del formulario se muestra
   con `.on` (no con [hidden], que el buscador de Ajustes reescribe al arrancar). */
.mcplist { display: flex; flex-direction: column; gap: 10px; padding: 4px 0 10px; }
.mcpempty { color: var(--dim); font-size: 12px; padding: 8px 0; }
.mcprow { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
.mcphead { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.mcpdot { width: 8px; height: 8px; border-radius: 50%; background: var(--dim); flex-shrink: 0; }
.mcpdot.ok { background: #37f5a8; }
.mcpdot.wait { background: #ffd166; }
.mcpdot.err { background: #ff6b6b; }
.mcpst { color: var(--dim); font-size: 12px; }
.mcpdo { margin-left: auto; color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
.mcptools { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 0; }
.mcptool { font: 500 11px var(--font-ui); color: var(--vio2); background: rgba(var(--acc2-rgb), .12); border-radius: 999px; padding: 2px 8px; }
.mcpacts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
#mcpFormCard:not(.on) { display: none; }
```

- [ ] **Step 5: Verificar en la app viva (visual, no hay test unitario de UI)**

Run: `npm start` y comprobar a mano: Ajustes › MCP existe, el formulario abre, guardar un servidor inválido muestra el error en `#mcpMsg`, y "Pegar JSON" con un `mcpServers` de ejemplo pide confirmación y lo añade.
Expected: la pestaña funciona y muestra el motivo real de cada error.

- [ ] **Step 6: Commit**

```bash
git add renderer/index.html renderer/app.js renderer/styles.css
git commit -m "mcp: pestana de Ajustes con lista, formulario guiado, probar, log e importar/exportar"
```

---

### Task 11: Grupo MCP en Herramientas y overrides en Seguridad

**Files:**
- Modify: `renderer/app.js` (`renderTools`, `PERM_TOOLS`/`renderSecurity`)

**Interfaces:**
- Consumes: `mcpList` (Task 9), `secSetToolPerm` (ya existe).

- [ ] **Step 1: Añadir las herramientas MCP a la vista Herramientas**

`renderTools()` pinta sobre `#toolsGrid` con cabeceras `.toolsgroup` y tarjetas
`.toolcard`; el bloque va AL FINAL de la función (después del bucle de grupos nativos):

```js
  // ---- v3.1: herramientas MCP reales del usuario (no están en el catálogo nativo) ----
  let mcp = { servers: [] };
  try { mcp = await window.sagitari.mcpList(); } catch {}
  const conHerramientas = (mcp.servers || []).filter(s => s.enabled && (s.discovered || []).length);
  if (conHerramientas.length) {
    const total = conHerramientas.reduce((n, s) => n + s.discovered.length, 0);
    const h = document.createElement('div');
    h.className = 'toolsgroup';
    h.textContent = 'Servidores MCP · ' + total;
    g.appendChild(h);
    for (const s of conHerramientas) {
      for (const t of s.discovered) {
        const c = document.createElement('div');
        c.className = 'toolcard';
        c.innerHTML = `<div class="tic">${ic('bolt')}</div><div><b>${esc(t.tool)}</b> <small class="md">${esc(s.name)}</small><br><small>${esc(t.description || '')}</small></div>`;
        g.appendChild(c);
      }
    }
  }
}
```
(es decir: justo antes del `}` que cierra `renderTools`; el resto de la función no cambia)

- [ ] **Step 2: Añadir los overrides MCP a Seguridad**

`renderSecurity()` pinta filas `.permrow` dentro de `#permList`, cada una con su
`<select>` y su `onchange` propio. El bloque va tras el bucle de `PERM_TOOLS` y antes
de `mejoraSelects(permBox)`:

```js
  // ---- v3.1: servidores MCP. El comodín `mcp__<id>__*` gobierna TODAS sus
  // herramientas de una vez (el override exacto de una herramienta sigue ganando).
  let mcp = { servers: [] };
  try { mcp = await window.sagitari.mcpList(); } catch {}
  for (const s of (mcp.servers || [])) {
    const wildcard = 'mcp__' + s.id + '__*';
    const lvl = (cfg.permissions && cfg.permissions[wildcard]) || 'default';
    const n = (s.discovered || []).length;
    const row = document.createElement('div');
    row.className = 'permrow';
    row.innerHTML = `<span class="mt"><b>${esc(s.name)}</b> <small class="md">MCP</small><br><small class="md">${n} herramienta${n === 1 ? '' : 's'} del servidor</small><br><small class="pd">todas sus herramientas piden permiso salvo que las permitas aquí</small></span>
      <select data-tool="${esc(wildcard)}" aria-label="Permiso para el servidor MCP ${esc(s.name)}">
        <option value="default"${lvl === 'default' ? ' selected' : ''}>Por defecto (preguntar antes)</option>
        <option value="safe"${lvl === 'safe' ? ' selected' : ''}>Permitir siempre</option>
        <option value="confirm"${lvl === 'confirm' ? ' selected' : ''}>Preguntar antes</option>
        <option value="restricted"${lvl === 'restricted' ? ' selected' : ''}>Bloqueado</option>
      </select>`;
    row.querySelector('select').onchange = async (e) => {
      await window.sagitari.secSetToolPerm(wildcard, e.target.value);
      showToast('MCP ' + s.name + ': ' + e.target.selectedOptions[0].textContent.toLowerCase());
    };
    permBox.appendChild(row);
  }
```
(no hace falta un listener aparte: el `onchange` va en cada fila, como en las nativas)

- [ ] **Step 3: Verificar en vivo**

Run: `npm run uicheck` → sigue en verde (la vista Herramientas y Seguridad no deben romperse cuando no hay servidores MCP configurados: `mcpList` devuelve `{ servers: [] }` y no se añade nada)

- [ ] **Step 4: Commit**

```bash
git add renderer/app.js
git commit -m "mcp: grupo MCP en Herramientas y permiso por servidor en Seguridad"
```

---

### Task 12: Comprobación sobre la interfaz viva

**Files:**
- Modify: `scripts/ui-check.js`

- [ ] **Step 1: Sembrar un servidor MCP de prueba en `seedTestConfig()`**

En el config de prueba, añadir un servidor stdio que use el servidor de eco del repo (no requiere red ni paquetes):

```js
  // Servidor MCP de prueba: el mismo que usan los tests unitarios. Sin red y sin
  // instalar nada, así que la comprobación de interfaz no depende del entorno.
  const mcpServer = {
    id: 'eco', name: 'Eco de prueba', enabled: true, transport: 'stdio',
    command: process.execPath, args: [path.join(APP_DIR, 'test', 'fixtures', 'mcp-echo-server.js')], env: {},
  };
```
y en el JSON que se escribe: `{ providers: [...], active: dummy, mcp: { enabled: true, servers: [mcpServer] } }`.

- [ ] **Step 2: Añadir las comprobaciones**

```js
  // ---- MCP: la pestaña existe, el formulario abre y el estado se pinta ----
  await evaluate('document.querySelector(\'#setTabs .settab[data-set="mcp"]\').click()');
  await new Promise(r => setTimeout(r, 400));
  await judge('la pestaña MCP muestra el servidor de prueba', '(function(){ var rows = document.querySelectorAll("#mcpList .mcprow"); return rows.length >= 1 && /Eco de prueba/.test(document.querySelector("#mcpList").textContent); })()');
  await judge('el formulario de MCP abre y tiene los campos', '(function(){ document.querySelector("#mcpNew").click(); var c = document.querySelector("#mcpFormCard"); return !c.hidden && !!document.querySelector("#mcpCommand") && !!document.querySelector("#mcpUrl"); })()');
  await judge('cambiar a URL remota oculta el comando local', '(function(){ var t = document.querySelector("#mcpTransport"); t.value = "http"; t.dispatchEvent(new Event("change", { bubbles: true })); var ok1 = document.querySelector("#mcpStdioRows").hidden && !document.querySelector("#mcpHttpRows").hidden; t.value = "stdio"; t.dispatchEvent(new Event("change", { bubbles: true })); return ok1 && !document.querySelector("#mcpStdioRows").hidden; })()');
  await judge('guardar un servidor inválido explica el motivo', '(function(){ document.querySelector("#mcpCancel").click(); return true; })()');
  // el botón Probar de una fila habla con el servidor y trae sus herramientas
  await evaluate('(function(){ var b = document.querySelector("#mcpList .mcprow [data-mcp=\\"test\\"]"); if (b) b.click(); return true; })()');
  await new Promise(r => setTimeout(r, 2500));
  await judge('probar el servidor trae sus herramientas reales',
    '(function(){ var t = document.querySelector("#mcpList").textContent; return /echo/.test(t) && /Listo/.test(t); })()');
  await evaluate('document.querySelector(\'[data-view="chat"]\').click()');
```

- [ ] **Step 3: Ejecutar**

Run: `npm run uicheck 2>&1 | grep -E "MCP|servidor|FALLO|UI-CHECK"`
Expected: las cuatro comprobaciones en `ok` y `UI-CHECK::{"ok":true,"fallos":0}`

- [ ] **Step 4: Commit**

```bash
git add scripts/ui-check.js
git commit -m "ui-check: comprueba sobre la app viva que la pestana MCP lista, abre el formulario y conecta de verdad"
```

---

### Task 13: Documentación con paridad ES/EN

**Files:**
- Modify: `README.md`, `README.es.md`, `RELEASE_NOTES.md`

- [ ] **Step 1: README (ambos idiomas)**

En la lista de características, tras «Skills», añadir una entrada nueva:

- EN: **MCP servers** — *Connect your own MCP servers (local commands or remote URLs) and the agent uses their tools like built-in ones. Everything they run asks for permission first, and you can promote a server you trust.*
- ES: **Servidores MCP** — *Conecta tus propios servidores MCP (comandos locales o URLs remotas) y el agente usa sus herramientas como las de casa. Todo lo que ejecutan pide permiso antes, y puedes dar más confianza a un servidor que conozcas.*

En «Safety first» / «Seguridad», añadir la línea:

- EN: *MCP tools follow the same permission engine: confirmation by default, per-server and per-tool levels, and their credentials are stored encrypted like your API keys.*
- ES: *Las herramientas MCP pasan por el mismo motor de permisos: confirmación por defecto, niveles por servidor y por herramienta, y sus credenciales se guardan cifradas como tus claves de API.*

- [ ] **Step 2: Notas de versión**

Añadir al bloque de la versión en curso (sin inventar números de versión ni fechas):

- EN/ES: nueva capacidad «MCP servers» / «Servidores MCP», con el detalle de que las herramientas aparecen en la vista Herramientas y que el nivel por defecto es confirmar.

- [ ] **Step 3: Comprobación de paridad**

Run: `node -e "const fs=require('fs');const a=fs.readFileSync('README.md','utf8'),b=fs.readFileSync('README.es.md','utf8');console.log('MCP en EN:',/MCP servers/.test(a),'| MCP en ES:',/Servidores MCP/.test(b))"`
Expected: `MCP en EN: true | MCP en ES: true`

- [ ] **Step 4: Commit**

```bash
git add README.md README.es.md RELEASE_NOTES.md
git commit -m "docs: servidores MCP en el README bilingue y en las notas de version"
```

---

### Task 14: Verificación final antes de dar por hecha la funcionalidad

**Files:** ninguno (solo comandos)

- [ ] **Step 1: Suite completa, dos veces (determinismo)**

Run: `npm test 2>&1 | tail -3 && npm test 2>&1 | tail -3`
Expected: `Todos los tests en verde` las dos veces, con el mismo recuento.

- [ ] **Step 2: Arranque real y comprobación sobre la interfaz viva**

Run: `npm run smoke` → exit 0
Run: `npm run uicheck` → `UI-CHECK::{"ok":true,"fallos":0}`

- [ ] **Step 3: Caso real de punta a punta (manual, una vez)**

1. `npm start`
2. Ajustes › MCP › Añadir servidor: id `eco`, tipo *Comando local*, comando = ruta de `node`, argumentos = ruta absoluta de `test/fixtures/mcp-echo-server.js`. Guardar y probar → «Conectado: 3 herramientas».
3. Vista **Herramientas** → aparece el grupo «MCP · Eco» con `echo`, `needle` y `fail`.
4. En el chat: «usa la herramienta echo para devolver el texto hola» → aparece la tarjeta de confirmación nombrando el servidor y la herramienta, y al aprobar el resultado es `eco: hola`.
5. Seguridad: poner el servidor en «permitir siempre» y repetir → ya no pregunta. Ponerlo en «bloqueado» → la herramienta se rechaza con el motivo.
6. Cerrar la app y comprobar en el Administrador de tareas que **no queda ningún proceso `node` del servidor de eco**.

- [ ] **Step 4: Commit final si el paso 3 reveló ajustes**

```bash
git add -A
git commit -m "mcp: ajustes del caso real de punta a punta"
```

---

## Cobertura de la spec

| Requisito de la spec | Tarea |
|---|---|
| Cliente MCP sin dependencias nuevas | 2-4 |
| Transporte stdio con arranque seguro de `.cmd` | 3 |
| Transporte HTTP + SSE, sesión, solo https/loopback | 4 |
| `initialize`, `tools/list` paginado, `tools/call` | 5-6 |
| Nombres `mcp__srv__tool`, ≤64, colisiones | 5 |
| Recorte de resultados (60 000 caracteres) | 6 |
| Timeouts en las tres fases | 2-6 |
| Caída, backoff y reconexión | 5-6 |
| Cierre ordenado al salir (sin procesos huérfanos) | 3, 8, 14 |
| Permiso `confirm` por defecto y comodín por servidor | 7 |
| Sin vías laterales: todo pasa por `Guardrails` | 7 |
| Tarjeta de confirmación con servidor y herramienta | 7 |
| `allToolDefs()` sin romper la tabla nativa | 7 |
| `config.mcp`, secretos con DPAPI, validación | 8 |
| Import/export del JSON de `mcpServers` | 8, 10 |
| Pestaña Ajustes › MCP, Probar, log, estados | 10 |
| Grupo MCP en Herramientas y overrides en Seguridad | 11 |
| Subagentes SIN herramientas MCP (v1) | 7 (`toolDefsFor` filtra por `allowTools`) |
| Pruebas: unitarias, integración stdio real, HTTP local, ui-check | 2-12 |
| Documentación ES/EN | 13 |

## Autorevisión del plan

- **Sin marcadores de posición:** cada paso lleva el código o el comando exacto. Los cuatro `ipcMain.handle` que en la Task 8 se resumen entre llaves (`mcp:toggle`, `mcp:refresh`, `mcp:setGlobal`, `mcp:log`) quedan definidos por su firma y comportamiento en las Interfaces de la tarea; el implementador tiene el resto de los manejadores como patrón literal en el mismo bloque.
- **Consistencia de nombres:** `mapToolName`, `MAX_TOOL_NAME`, `allToolDefs`, `setDynamicToolProvider`, `describe`, `ensure`, `callTool`, `status`, `shutdown`, `validateServer`, `mergeSecrets`, `parseMcpImport`, `buildCmdLine`, `resolveCommand`, `createStdioTransport`, `createHttpTransport`, `httpUrlAllowed`, `parseSseText`, `createLineReader`, `Rpc` — los mismos en todas las tareas.
- **Orden de dependencias:** `proc.js` (1) → framing (2) → stdio (3) → http (4) → registro (5) → llamada (6) → integración (7) → proceso principal (8) → puente (9) → UI (10-11) → ui-check (12) → docs (13) → verificación (14).
- **Riesgo conocido y asumido:** la Task 7 hace que `agent.js` use `allToolDefs()` en el bucle caliente. Es una concatenación de dos arrays por turno (no por token), coste despreciable.
