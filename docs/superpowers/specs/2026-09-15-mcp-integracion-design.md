# Integración de MCP en SAGITARI — diseño

Fecha: 2026-09-15 · Estado: aprobado en diseño, pendiente de plan de implementación.

## Objetivo

Que el usuario añada sus propios servidores MCP (Model Context Protocol) desde la
interfaz y que el agente los use como si fueran herramientas nativas: mismas
tarjetas de confirmación, mismos guardarraíles, mismos límites y mismo registro de
ejecución. Sin dependencias nuevas de runtime.

## Decisiones ya tomadas

| Decisión | Elección | Motivo |
|---|---|---|
| Transportes | `stdio` (proceso local) + HTTP remoto (streamable HTTP sobre `fetch` + SSE) | Cubre el ecosistema actual: servidores locales de referencia y servidores alojados |
| Nivel de permiso por defecto | `confirm` en cada llamada, ajustable por servidor y por herramienta | Un MCP puede hacer cualquier cosa en el PC del usuario; el permiso explícito es la regla del producto |
| Alta de servidores | Formulario guiado + importar/exportar el bloque `mcpServers` de otros clientes | Sirve al principiante y al experto, que son las dos audiencias declaradas |
| Dependencias | Ninguna nueva. Cliente MCP propio | `PRODUCT.md` fija una única dependencia de runtime (`ws`) como decisión de producto |
| Exposición de herramientas | Inyección directa en el catálogo (`mcp__servidor__herramienta`) | Reusa el motor de permisos por herramienta; una meta-herramienta única perdería granularidad y obligaría al modelo a adivinar esquemas |

## No objetivos (v1)

- `prompts`, `resources`, `sampling`, `roots` y `elicitation`. Solo `tools`.
- OAuth para servidores remotos: solo cabeceras estáticas (token del usuario).
- MCP dentro de subagentes: siguen con su lista cerrada de herramientas nativas
  (`subagents.toolDefsFor` filtra por `allowTools`, así que quedan fuera por
  construcción). Es privilegio mínimo, no una limitación accidental.
- Marketplace curado de MCP.

## Arquitectura

```
config.mcp.servers[]                    (config.json, secretos cifrados DPAPI)
        │
        ▼
   agent/mcp.js  ── stdio: spawn + JSON-RPC 2.0 por líneas
        │        └── http: fetch POST + SSE
        │
        ├── initialize → tools/list (paginado) → tools/call
        │
        ├─► agent/tools.js    allToolDefs() = nativas + mcp.toolDefs()  [evaluado por turno]
        ├─► agent/executors.js rama `mcp__*` vía ctx.mcp
        ├─► agent/guardrails.js levelFor(): override exacto → `mcp__srv__*` → RISK → 'confirm'
        └─► main/main.js      IPC + ciclo de vida; renderer/app.js: Ajustes › MCP
```

Regla de oro del diseño: **no hay vía lateral**. Toda herramienta MCP entra por el
mismo catálogo que las nativas y toda llamada pasa por `Guardrails`. Si el motor de
permisos no la ve, no se ejecuta.

## Componentes

### 1. `agent/mcp.js` (nuevo)

Cliente y registro. Sin Electron, sin I/O salvo el de los transportes, para poder
testearlo desde Node puro.

```
class McpManager {
  constructor({ servers, dataDir, log })       // log = runlog opcional
  configure(servers)                           // reconciliar con la config (arranca/para/actualiza)
  toolDefs()                                   // ToolDef[] de servidores listos y habilitados
  has(name) / serverOf(name)                   // enrutado por prefijo
  async callTool(name, args, { onExit })       // → string para el modelo; nunca lanza
  async test(id)                               // conectar + tools/list, para el botón Probar
  async refreshTools(id)
  status()                                     // [{ id, state, error, tools, logTail }]
  async shutdown()                             // cierre ordenado de todos los servidores
}
```

Estados por servidor: `idle → starting → ready → dead`. Un servidor `dead` no aporta
herramientas al prompt y cualquier llamada devuelve un error legible.

### 2. `agent/proc.js` (extracción)

`killTree` vive hoy en `agent/executors.js:42` y hace falta también para matar los
servidores stdio (un `npx` lanzado por `cmd.exe` deja nietos vivos si solo se mata
al hijo directo). Se extrae a `agent/proc.js` **una sola implementación** y
`executors.js` pasa a consumirla. Sin duplicar la tabla de señales.

### 3. `agent/tools.js`

```js
let dynamicProvider = null;                       // lo instala main.js
function setDynamicToolProvider(fn) { dynamicProvider = fn; }
function allToolDefs() { return dynamicProvider ? defs.concat(dynamicProvider()) : defs; }
module.exports = { toolDefs: defs, allToolDefs, setDynamicToolProvider, RISK };
```

`toolDefs` sigue siendo **el catálogo nativo** y `RISK` su tabla de niveles: es lo que
verifica el test «la tabla de riesgo es única y no tiene claves muertas»
(`test/run.js:1788`), que debe seguir midiendo exactamente eso. `allToolDefs()` es lo
que ve el modelo.

### 4. `agent/executors.js`

`executeTool(name, args, ctx)` recibe `ctx.mcp` (misma inyección que `browser` o
`screenshotFn`; nada de `require` que crearía un ciclo) y añade la rama:

```js
if (name.startsWith('mcp__')) {
  if (!ctx.mcp) return 'Error: no hay servidores MCP disponibles en esta ejecución.';
  return ctx.mcp.callTool(name, args, { onExit: ctx.registerKillable });
}
```

### 5. `agent/guardrails.js`

`levelFor(name)` gana un escalón, sin duplicar la tabla de niveles:

1. `policy.permissions[name]` — override exacto (lo que ya existe).
2. `policy.permissions[prefijoDeServidor(name)]` — `mcp__github__*`, para subir de
   confianza un servidor entero de una vez.
3. `DEFAULT_RISK[name]` — nativas.
4. `'confirm'` — lo no reconocido, que es el caso de toda herramienta MCP.

`describeAction`/`summarizeArgs` reciben un caso por defecto para nombres `mcp__*`
(«Herramienta MCP · servidor · herramienta») para que la tarjeta de confirmación diga
algo útil y no un nombre técnico crudo.

### 6. `agent/agent.js`

Tres puntos, y solo tres, donde hoy se usa la lista estática:

- `:660` validación de nombre de herramienta → `allToolDefs()`.
- `:706` construcción del `ctx` de `executeTool` → añadir `mcp: this.mcp`.
- `:875` `tools` que viajan a la API → `allToolDefs()`.

Además `statusFor(name, args)` gana texto para `mcp__*` («MCP · servidor · herramienta»)
para el rail de agentes. El historial, el recorte, la detección de bucles, el coste y
los límites **no cambian**: una llamada MCP es una llamada de herramienta más.

### 7. `main/main.js`

- `config.mcp` con defaults (`enabled`, `servers: []`), reconciliado en `applyConfig`.
- Secretos: cada valor de `env` y `headers` se cifra con `protectKey` al escribir
  (`configParaDisco`) y se descifra con `revealKey` al leer, igual que `apiKey`. El
  renderer recibe los valores en claro como ya hace con las claves de proveedor; el
  guardado tolera el campo vacío sin borrar el secreto existente.
- Instanciación: `mcp = new McpManager({...})` antes de `createAgent`, y
  `tools.setDynamicToolProvider(() => mcp.toolDefs())`.
- `createAgent` pasa `mcp` al `Agent` (chat, background y tareas).
- `before-quit` → `mcp.shutdown()` (cierre ordenado; `killTree` como respaldo).
- IPC (todos con validación de entrada, como el resto):
  `mcp:list`, `mcp:save`, `mcp:delete`, `mcp:toggle`, `mcp:test`, `mcp:refresh`,
  `mcp:import`, `mcp:export`, `mcp:log`, `mcp:setGlobal`.
  `mcp:delete` limpia además los overrides `mcp__<id>__*` de `config.security.permissions`
  para no dejar permisos huérfanos.

### 8. `main/preload.js`

Un método por canal, con la misma forma que el resto del puente (`mcpList`, `mcpSave`,
…). El evento `mcp:status` se emite por `agent:event` (ya existe el canal) para que el
renderer no estrene un segundo bus.

### 9. Renderer

> **Enmienda (2026-09-16, pedida por el usuario tras implementar):** la gestión de MCP
> **no** vive en una pestaña de Ajustes, sino en una **sección propia del sidebar**
> (`#view-mcp`, grupo «Conocimiento», justo antes de Herramientas). Un dato, un sitio:
> la pestaña de Ajustes se eliminó en lugar de dejar dos entradas con lo mismo. La
> sección **no** tiene atajo de teclado (`Alt+0` sigue sin hacer nada; los `Alt+1…9`
> no se tocan). El panel se mudó con el mismo marcado y la misma lógica.

- **Sidebar › MCP** (sección `#view-mcp`): interruptor global, lista de servidores con
  punto de estado, formulario guiado, botón **Probar** que enseña las herramientas
  descubiertas y el error real si falla, botón de log del servidor, y pegar/exportar el
  JSON de `mcpServers`.
- **Herramientas**: grupo «MCP» con las herramientas descubiertas y su nivel de permiso
  editable ahí mismo (mismo control que las nativas).
- **Seguridad**: los overrides MCP aparecen con el resto de permisos. Se editan con
  el canal que ya existe (`sec:setToolPerm`) usando el nombre completo
  (`mcp__github__create_issue`) o el comodín de servidor (`mcp__github__*`); no se
  estrena un almacén de permisos paralelo.

## Contrato de datos

```jsonc
// config.mcp
{
  "enabled": true,
  "servers": [{
    "id": "github",                       // obligatorio, único, [a-z0-9_-]{1,24}
    "name": "GitHub",                     // etiqueta visible
    "enabled": true,
    "transport": "stdio",                 // "stdio" | "http"
    "command": "npx",                     // stdio
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "cwd": "",                            // stdio: por defecto, el directorio de datos
    "env": { "GITHUB_TOKEN": "enc:v1:…" },
    "url": "https://mcp.ejemplo.com/mcp", // http: solo https, o http en localhost
    "headers": { "Authorization": "Bearer enc:v1:…" },
    "autoStart": false,                   // arrancar al abrir la app (si no, en la primera llamada)
    "timeoutMs": 60000,                   // por llamada, 5000..300000
    "tools": { "allow": [], "deny": [] }  // vacías = todas
  }]
}
```

**Nombre de herramienta expuesto:** `mcp__<servidor>__<herramienta>`, con el servidor
saneado a `[a-z0-9_]` (máx. 16) y la herramienta a `[a-z0-9_]` (máx. 40), total ≤ 64
caracteres (los proveedores imponen ese techo y prohíben puntos). Si dos herramientas
colisionan tras el saneado, la segunda recibe sufijo `_2`, `_3`… y el mapeo inverso se
guarda en memoria. El prefijo hace imposible pisar una herramienta nativa.

## Protocolo y ciclo de vida

- **Framing stdio:** JSON-RPC 2.0 delimitado por líneas nuevas sobre stdin/stdout.
  Las líneas que no parsean (banners de arranque de algunos servidores) se ignoran y
  se cuentan; `stderr` se guarda en un buffer circular (últimos 8 KB) que la UI puede
  leer y que se incluye en los mensajes de error.
- **Arranque en Windows:** `spawn` con `shell: false` cuando el comando es un
  ejecutable; si el comando acaba en `.cmd`/`.bat` (el caso de `npx`/`npm`), se lanza
  `cmd.exe /d /s /c` con una línea construida por nosotros y cada argumento entre
  comillas. Un argumento que contenga `"`, `%` o salto de línea se rechaza con un
  error claro en vez de escapar mal: no se interpola nada a ciegas. `windowsHide: true`
  y `env` propio (proceso base + los del servidor; nada de variables del sistema
  heredadas con secretos añadidos).
- **HTTP:** `POST` con `Accept: application/json, text/event-stream` y
  `Content-Type: application/json`; se respeta `Mcp-Session-Id` (se guarda al
  inicializar y se reenvía en cada petición). Se aceptan ambas respuestas: JSON directo
  y SSE (se parsean los `event: message` / `data:`). Solo `https://`, o `http://` si el
  host es `localhost`/`127.0.0.1`/`::1`.
- **Handshake:** `initialize` (con `clientInfo: { name: "SAGITARI", version }`) →
  `notifications/initialized` → `tools/list`. Se acepta la `protocolVersion` que
  devuelva el servidor. Si `capabilities.tools` no está, el servidor queda `ready`
  sin herramientas y la UI lo explica.
- **`tools/list`:** paginado por `cursor` hasta agotarlo; tope de 20 páginas y 500
  herramientas por servidor. Se refresca al conectar, al recibir
  `notifications/tools/list_changed` y cuando el usuario pulsa «Actualizar».
- **`tools/call`:** `params: { name, arguments }`. El resultado se aplana a texto
  (`content[].type === 'text'`); las imágenes y recursos se resumen
  (`[imagen: image/png, 34 KB]`) porque en v1 el modelo solo recibe texto; el total se
  recorta a 60 000 caracteres, como el resto de herramientas.
- **Timeouts:** tres, no uno. Conexión+handshake, `tools/list` y `tools/call`
  (`timeoutMs`). Un cuelgue en cualquiera de las tres fases termina en error legible y
  servidor marcado `dead`.
- **Caída y reconexión:** al detectar `exit`/`error`/cierre del socket, el servidor
  pasa a `dead`, se avisa a la UI y se descarta su entrada del catálogo. La siguiente
  llamada intenta reconectar con backoff (1 s, 2 s, 4 s; máximo 3 intentos por llamada,
  contador reiniciado por un `Probar` manual). Nunca hay reintento en bucle infinito ni
  llamada que se quede esperando para siempre.
- **Parada:** `notifications/cancelled` si la llamada está en vuelo, cierre de stdin,
  500 ms de cortesía y `killTree` si sigue vivo. Se ejecuta al deshabilitar el
  servidor, al borrarlo y en `before-quit`. Un servidor caído **nunca** bloquea el
  cierre de la app ni el fin de un turno.

## Seguridad

| Riesgo | Mitigación |
|---|---|
| Un MCP local ejecuta cualquier cosa en el PC | Nivel `confirm` por defecto en cada llamada; tarjeta de confirmación con nombre de servidor, herramienta y argumentos; `restricted` disponible por servidor o por herramienta |
| Inyección por la línea de comandos | Nada de `shell: true` con interpolación: `cmd.exe /d /s /c` con argumentos citados y rechazo explícito de los que contienen metacaracteres |
| Fuga de secretos a disco | `env` y `headers` cifrados con DPAPI (mismo camino que `apiKey`); nunca se escriben en claro |
| Exfiltración por red | Solo `https` (o `http` en loopback); la URL se valida al guardar y al conectar |
| Respuesta gigante que revienta el contexto | Recorte a 60 000 caracteres y tope de tamaño leído por mensaje |
| Prompt envenenado por un servidor | La descripción de cada herramienta se marca como procedente de un servidor externo y viaja como texto de una sola línea, sin instrucciones ejecutables; el agente no obedece texto de descripciones de herramientas por encima de su prompt de sistema |
| Permisos huérfanos tras borrar un servidor | `mcp:delete` limpia los overrides `mcp__<id>__*` |
| Coste/latencia no contabilizados | Cada llamada MCP cuenta para pasos, llamadas, tiempo y detección de bucles igual que una nativa; se registra en `runlog` |

## Interfaz

Estados que ve el usuario: `Sin probar`, `Conectando…`, `Listo (N herramientas)`,
`Error: <motivo real>`, `Detenido`. Los errores de conexión muestran el `stderr` del
servidor (primeras líneas relevantes) en vez de un «falló la conexión» genérico —
guardarraíles del producto: lo que dice, lo hace.

## Pruebas

En `test/run.js` (Node puro, sin Electron, sin red):

1. **Nombres:** saneado, tope de 64, colisión resuelta con sufijo, mapeo inverso estable.
2. **Permisos:** `levelFor` con override exacto, override `mcp__srv__*`, y `confirm` por
   defecto para un MCP desconocido; `describeAction`/`summarizeArgs` con nombre `mcp__*`.
3. **Catálogo:** `allToolDefs()` incluye las dinámicas y `toolDefs` sigue siendo el
   catálogo nativo con su tabla de niveles intacta.
4. **Protocolo:** troceado de líneas (dos mensajes en un chunk, mensaje partido,
   banner ignorado), emparejado de respuestas por id fuera de orden, paginación de
   `tools/list`, error JSON-RPC, `isError: true`, timeout y proceso muerto.
5. **Integración stdio real:** un servidor MCP de prueba en `test/fixtures/`
   (~60 líneas, sin dependencias) que el test arranca de verdad: initialize →
   tools/list → tools/call → cierre limpio, comprobando que no queda proceso vivo.
6. **HTTP:** contra un `http.createServer` local (loopback): cabeceras, `Mcp-Session-Id`,
   respuesta JSON y respuesta SSE.
7. **`scripts/ui-check.js`:** la pestaña MCP existe, el formulario abre y guardar un
   servidor inválido muestra el error.

No se prueba contra servidores MCP de terceros: la suite no puede depender de la red
ni de paquetes npm instalados en la máquina.

## Compatibilidad

- Un `config.json` sin la clave `mcp` arranca con `{ enabled: true, servers: [] }`:
  cero cambios para quien no use MCP.
- Ninguna herramienta nativa cambia de nombre, de nivel ni de comportamiento.
- Sin MCP configurado, `allToolDefs()` devuelve exactamente el catálogo de hoy.
