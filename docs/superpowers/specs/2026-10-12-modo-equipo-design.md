# Modo EQUIPO — diseño (4.4)

Aprobado por el usuario el 2026-10-12, con tres decisiones: **compañeros vivos con buzón
real**, **modo EQUIPO junto a ACT/PLAN/THINK** y **4 compañeros + presupuesto con tope**.

## Qué es

Una orden escrita en modo EQUIPO se convierte en un **encargo de equipo**: el agente del
chat pasa a ser **líder**, trocea la orden, levanta hasta **4 compañeros** (los
especialistas del registro, de serie o de disco), los pone a trabajar **en paralelo** y
agrega los resultados. Los compañeros pueden **mandarse mensajes** entre ellos y al líder
(buzón asíncrono) y todos escriben en un **tablero compartido** que se ve en la interfaz.

Referencia de producto: el Team Mode de AionUi (Leader + Teammates, buzón asíncrono,
tablero compartido, permiso por miembro).

## Qué se reutiliza (no se reinventa)

| Pieza | Dónde | Uso |
|---|---|---|
| Registro de especialistas | `agent/subagents.js` | los compañeros, con `allowTools`/`maxSteps`/`method`/`deliver` |
| Creación del Agent del compañero | `agent/agent.js:2024` `_delegate` | copia sus piezas: `toolDefsFor`, `subagentSystemPrompt`, `buildSubagentBrief`, `parseSubagentResult` |
| Aislamiento de escritores | `agent/arboles.js` | un árbol por compañero que escribe (ya soporta N) |
| Semáforo por recurso | `agent/recursos.js` | navegador 1, disco 1, terminal 2… |
| Absorción de gasto | `guardrails.absorb` + `_uso` | el gasto de cada compañero cuenta para el turno y para el tope del equipo |
| Lista de tareas | `agent/todos.js` | forma de los ítems del tablero |
| Confirmaciones | `pendingConfirms` + `Agent.CONFIRM_ROUTES` | atribuir cada permiso a su miembro |
| Multi-conversación | `main/runtimes.js` | un hilo por conversación; el equipo vive dentro del suyo |

## Motor — `agent/equipo.js` (nuevo)

```js
crearEquipo({ lider, limite = 4, presupuestoUsd = 0, onEvento }) -> Equipo

Equipo = {
  miembros: Map<id, Miembro>,      // id: 'm1'…'mN'
  tablero: Item[],                 // { id, quien, que, estado, nota, ts }
  levantar(spec, { tarea, expect })  // crea el Agent del compañero y lo arranca (no espera)
  enviar(de, para, texto)            // al buzón del destinatario
  bandejaDe(id)                      // mensajes pendientes (y los vacía)
  estado(id)                         // 'trabajando' | 'esperando' | 'terminado' | 'fallo'
  esperar(ids, timeoutMs)            // resuelve cuando terminan o piden algo
  tableroApunta({ quien, que, estado, nota })
  cerrar(id, { resumen, evidencia })
  gasto()                            // { tokens, costUsd } sumando a los compañeros
}
```

`Miembro = { id, spec, agent, estado, tarea, expect, bandeja: [], resultado, arbol }`

**Buzón con entrega de verdad**
- A un compañero **en marcha**: el mensaje se le inyecta en su siguiente paso, igual que la
  lista de tareas viaja en el prompt (`_sincronizarTodos` es el patrón).
- A uno **parado**: se le arranca con el mensaje como nueva subtarea (mismo Agent, mismo
  árbol, mismo gasto).
- El líder puede **esperar** (`esperar`) sin bloquear a los demás compañeros.

**Tope**
- Máximo 4 compañeros vivos + el líder. Pedir el quinto devuelve un error accionable.
- `presupuestoUsd` (ajuste, 0 = sin tope propio): al superarlo el equipo **para a todos**,
  lo dice en el chat y deja el tablero como está. Se cuenta con el `absorb` que ya existe.

## Herramientas nuevas (`agent/tools.js`)

| Herramienta | Para quién | Riesgo | Qué hace |
|---|---|---|---|
| `team_spawn({ agent, task, expect })` | líder | safe | levanta un compañero y devuelve `{ id, estado }` **sin esperar** |
| `team_send({ to, text })` | líder y compañeros | safe | entrega un mensaje al buzón de otro (`to`: id o `lider`/`todos`) |
| `team_wait({ ids?, timeoutMs? })` | líder | safe | espera a que terminen o pidan algo; devuelve estado y resultados |
| `team_board({ quien?, que?, estado?, nota? })` | líder y compañeros | safe | lee (sin argumentos) o apunta/actualiza un ítem |
| `team_done({ resumen, evidencia })` | compañeros | safe | cierra su encargo con evidencia |

`allowTools` de los compañeros NO incluye `team_spawn` (un compañero no levanta más gente):
el tope se queda en el líder.

## Modo EQUIPO

- Cuarto modo en `MODE_PROFILES` (`agent/agent.js`), con su color
  (`--mode-rgb` propio) y su sitio en el segmento del compositor. `Alt+M` cicla los cuatro.
- `main/ipc-modo.js` acepta `'equipo'`; el ajuste `mode` lo admite.
- En EQUIPO el líder recibe una guía de equipo en su prompt: descomponer, repartir con
  criterio, no repetir trabajo, agregar. El tablero es la fuente de verdad del progreso.

## Eventos (vocabulario fijo, viajan por `agent:event`)

```
{ type:'team_start',  miembros:[{ id, spec, name, emoji }] }
{ type:'team_member', id, spec, name, emoji, estado, tarea }
{ type:'team_message', de, para, texto, ts }        // de/para: id | 'lider'
{ type:'team_board',  items:[{ quien, que, estado, nota }] }
{ type:'team_done',   id, ok, resumen, evidencia }
{ type:'team_end',    ok, resumen, gasto:{ tokens, costUsd } }
```
Todo evento de un compañero viaja además con `subagent`/`member` para que el chat sepa de
quién es (la delegación ya usa `subagent` para lo mismo).

## Interfaz

- **Segmento del compositor**: cuatro modos (ACT · PLAN · THINK · EQUIPO), mismo componente.
- **Vista Equipo**: lista de miembros con su estado y su tarea; el **feed del buzón**
  (quién → quién, con hora); y el **tablero**. Se actualiza con los eventos de arriba.
- **Rail**: badge de **permisos pendientes por miembro** (un compañero puede estar
  esperando un permiso mientras otro trabaja).
- **Chat**: tarjeta de equipo (como la de delegación) con el reparto del líder y el
  resultado agregado; cada herramienta de un compañero se atribuye a su miembro.
- **Permisos**: cada confirmación dice de qué miembro es; la barra de confirmación y el
  badge usan el mismo origen.

## Fases (cada una verde antes de la siguiente)

1. **Motor** (`agent/equipo.js`, `agent/tools.js`, `agent/subagents.js`, `agent/agent.js`):
   compañeros vivos, buzón, tablero, topes, modo EQUIPO y atribución de permisos.
2. **Principal** (`main/main.js`, `main/ipc-modo.js`, `main/ipc-tareas.js`,
   `main/ipc-config.js`): modo admitido, ajuste de presupuesto, enrutado de `sec:resolve`
   a los miembros, `meta:get` con los topes del equipo.
3. **Interfaz** (`renderer/*`): cuarto modo, vista Equipo con feed y tablero, badge por
   miembro, tarjeta de equipo.
4. **Documentación y verificación**: `README` ES/EN, `PRODUCT.md`, `DESIGN.md`,
   `RELEASE_NOTES.md` 4.4.

## Riesgos y cómo se cubren

- **Factura**: N compañeros = N× gasto. Tope de 4 y presupuesto por equipo con corte real.
- **Escrituras concurrentes**: el equipo **exige** árbol aislado para quien escribe (ya es
  el defecto); sin git no hay aislamiento y se dice en vez de fingir.
- **Permisos confusos**: N diálogos a la vez. Cola con atribución por miembro y badge.
- **Bucles de mensajes entre compañeros**: tope de mensajes por miembro y por equipo,
  contados por el guardián de bucles que ya existe.

## Verificación

- `test/renderer/equipo.test.js` (puro, sin red): levantar/cerrar, buzón (en marcha y
  parado), tablero, tope de 4, corte por presupuesto, `team_send` a un id inexistente.
- Suite completa + `npm run uicheck` con la vista Equipo, el feed, el badge por miembro y
  el cuarto modo (sobre la app viva, con el proveedor de mentira del arnés).
- Un encargo real de equipo en el arnés (`uicheck`), comprobando que dos compañeros
  trabajan a la vez y se ven los dos.
