# Auditoría de SAGITARI — 17 de octubre de 2026

**Alcance:** revisión de código de `main/`, `agent/`, `renderer/`, `scripts/`, `test/`
(90 archivos de runtime, ~33.300 líneas propias) más la verificación ejecutada sobre el
árbol en `main` (commit `01e282a`, versión 5.0.0, árbol limpio).

**Método:** lectura dirigida de las superficies de riesgo (ejecución de comandos,
confinamiento de rutas, motor de permisos, IPC, automatización de navegador, descarga de
skills, actualizador, redacción de logs) + ejecución de la batería de comprobaciones que ya
trae el proyecto. Cada hallazgo lleva archivo:línea y el fragmento que lo evidencia. Lo que
se comprobó y salió bien se dice también, para que el informe no insinúe problemas que no existen.

**Fuera de alcance (no medido aquí):** pruebas manuales con la interfaz viva
(`npm run uicheck`, `npm run navcheck`), comportamiento bajo carga real y revisión del
instalador firmado.

---

## 1. Verificación ejecutada

| Comprobación | Comando | Resultado |
| --- | --- | --- |
| Lint (ESLint 9, config propia) | `npm run lint` | **0 errores** |
| Pruebas unitarias | `npm test` | **450 en verde** |
| Pruebas de renderer (jsdom) | `npm run test:renderer` | **737 en verde** (49 archivos) |
| Contraste WCAG 2.1 AA | `npm run contraste` | **0 de 54 pares por debajo de 4,5:1** |
| Dependencias | `npm audit` | 12 avisos: 3 altos + 9 moderados, **todos en el toolchain de desarrollo/compilación** |

El único dependency de runtime es `ws`, y no aparece en ningún aviso. Lo vulnerable viene
de `electron-builder`, `eslint` y sus dependencias transitivas (`undici`, `brace-expansion`,
`http-cache-semantics`, `global-agent`, `fast-uri`…). **No se distribuye con la app**, así
que el riesgo para el usuario final es bajo; conviene actualizarlas por higiene, no por
incidente.

---

## 2. Resumen de hallazgos

| # | Severidad | Área | Hallazgo |
| --- | --- | --- | --- |
| 1 | **Alta** | Renderer | Los eventos de una conversación se pintan en la pestaña activa: falta el enrutado por `convId` |
| 2 | **Alta** | Agente | Un `run_command` que falla se cuenta como éxito y **desactiva la puerta de verificación de cierre** |
| 3 | **Alta** | Agente | Un subagente cortado por tope de pasos se reporta como `OK`; el de verificación marca el turno como verificado |
| 4 | Media | Navegador | CDP expuesto por TCP en localhost con un perfil persistente que guarda las sesiones del usuario |
| 5 | Media | Navegador/ciclo de vida | Chrome puede quedar huérfano si el lanzamiento falla o el cierre no responde |
| 6 | Media | Guardarraíles | El gasto de los subagentes se avisa después, no se corta; topes contados de forma inconsistente |
| 7 | Media | Aislamiento | El aislamiento por árbol git solo mira `write_file`/`edit_file`/`apply_patch` |
| 8 | Baja | Red | `web_fetch`: ventana TOCTOU entre la resolución DNS validada y la petición real |
| 9 | Baja | Tareas | `checkpoints.remove()` devuelve `ok:true` aunque falle el borrado |
| 10 | Baja | Procesos | `arboles.js` mata `git` con `child.kill()` en vez de `killTree` |
| 11 | Baja | Renderer | Cadenas `.then()` sobre promesas IPC sin `.catch()` (mitigado por el hook global) |
| 12 | Baja | Electron | No se valida el remitente IPC ni hay `setPermissionRequestHandler` |


## 2.1 Estado tras el arreglo (mismo 17 de octubre)

Los tres hallazgos **Alta** quedaron corregidos sobre `main`, cada uno con su prueba (la
prueba falla si se quita el arreglo). Verificación del árbol ya corregido:

| Comprobación | Comando | Resultado |
| --- | --- | --- |
| Lint (ESLint 9, config propia) | `npm run lint` | **0 errores** |
| Pruebas unitarias | `npm test` | **455 en verde** (+5 sobre la tabla de arriba) |
| Pruebas de renderer (jsdom) | `npm run test:renderer` | **743 en verde** (+6; 50 archivos) |
| Contraste WCAG 2.1 AA | `npm run contraste` | **0 de 54 pares por debajo de 4,5:1** |

| # | Qué se cambió |
| --- | --- |
| 1 | `renderer/20-app.js` desvía el evento a `eventoDeOtraPestana` cuando trae `convId` distinto del hilo a la vista. Las confirmaciones y los avisos **no** se desvían: no son de una conversación y su turno espera la respuesta. Pruebas: `test/renderer/chat-eventos.test.js`. |
| 2 | `run_command` devuelve `{ text, failed }` con `failed: r.code !== 0` (`agent/executors.js`) y `agent.js` honra el `failed` explícito del ejecutor. El texto que ve el modelo no cambia. Prueba en `test/40-agente.js` (dos escrituras + `exit 1` ⇒ el turno pide la vuelta de verificación). |
| 3 | El bucle entrega el corte junto al texto (`p.onFinal(texto, { cortado, motivo })`) y `parseSubagentResult(texto, corte)` degrada a `PARTIAL` el `OK` que venía por defecto —nunca un `STATUS` explícito—. Una verificación solo cuenta si cierra en `OK`. Cubre la delegación y los compañeros de Equipo. |

Los hallazgos **4–7** (Media) quedaron corregidos en el segundo pase (§2.2); los **8–12**
(Baja) siguen abiertos tal y como se describen.


## 2.2 Estado tras el segundo pase (Media, 17 de octubre)

Los cuatro hallazgos **Media** quedaron corregidos sobre `main`, con prueba cada uno (la
prueba falla si se quita el arreglo) y validación extremo a extremo donde aplica:

| Comprobación | Comando | Resultado |
| --- | --- | --- |
| Lint | `npm run lint` | **0 errores** |
| Pruebas unitarias | `npm test` | **456 en verde** |
| Pruebas de renderer | `npm run test:renderer` | **743 en verde** (50 archivos) |
| Contraste WCAG 2.1 AA | `npm run contraste` | **0 de 54 pares por debajo de 4,5:1** |
| Navegador real | `npm run navcheck` | **0 fallos** (antes siempre se saltaba: `file://` rechazado por `navigate()`) |

| # | Qué se cambió |
| --- | --- |
| 4 | `agent/browser.js`: migración a `--remote-debugging-pipe` (sin puerto TCP). `send()` escribe con terminador NUL al fd 3 y lee mensajes del fd 4; `pages()` usa `Target.getTargets`. El huérfano ya no se adopta: se cierra por su WebSocket antes de lanzar. `scripts/navegador-check.js` sirve la página por HTTP para que el check deje de saltarse. |
| 5 | `launch()` mata el proceso recién creado si no responde (`_matarArbol`, inyectable para pruebas) y `cerrarYsalir()` llama a `browser.kill()` de respaldo tras `Browser.close`. Prueba en `test/30-sistema.js`. |
| 6 | `guardrails.absorb()` anota el tope rebasado (`_budgetOver`) y `checkStep()` detiene el turno en el siguiente paso; `team_spawn` consulta `checkDelegation()` (antes solo `delegate`); el tope de compañeros cuenta los **vivos**, no el histórico. Prueba en `test/40-agente.js`. |
| 7 | `subagents.escribeProyecto(spec)`: un agente del usuario con `run_command` también se aísla (puede escribir sin declararlo); los integrados con `run_command` (verificador, revisor) siguen leyendo el proyecto real. Usado en los dos sitios que crean árbol. Prueba en `test/40-agente.js`. |

Los hallazgos **8–12** (Baja) Los hallazgos **8-12** (Baja) quedaron corregidos en el tercer pase (ver seccion 2.3).


## 2.3 Estado tras el tercer pase (Baja, 17 de octubre)

Los cinco hallazgos **Baja** quedaron corregidos sobre `main`, con prueba o validacion
donde aplica:

| Comprobacion | Comando | Resultado |
| --- | --- | --- |
| Lint | `npm run lint` | **0 errores** |
| Pruebas unitarias | `npm test` | **456 en verde** |
| Pruebas de renderer | `npm run test:renderer` | **743 en verde** (50 archivos) |
| Contraste WCAG 2.1 AA | `npm run contraste` | **0 de 54 pares por debajo de 4,5:1** |
| Navegador real | `npm run navcheck` | **0 fallos** |

| # | Que se cambio |
| --- | --- |
| 8 | `agent/web.js`: `hostPermitido` devuelve la IP validada y `traer` conecta a esa IP fijada (dispatcher de undici con `connect` propio), cerrando la ventana TOCTOU. Prueba en `test/40-agente.js`. |
| 9 | `agent/checkpoints.js`: `remove()` acumula los fallos de `fs.rmSync` y devuelve `ok: false` si no se pudo borrar ninguno. |
| 10 | `agent/arboles.js`: el timeout mata el arbol con `killTree` (de `proc.js`) en vez de `child.kill()`. |
| 11 | `renderer/10-chat.js`, `renderer/20-app.js`, `renderer/30-ajustes.js`: las cadenas `.then()` sobre IPC llevan `.catch(...)` con aviso. |
| 12 | `main/main.js`: validacion del remitente en todos los `ipcMain.handle` y `session.defaultSession.setPermissionRequestHandler` denegando por defecto. |

Con esto, los **12 hallazgos** del informe (3 Alta, 4 Media, 5 Baja) quedan cerrados.


## 3. Hallazgos en detalle

### 1 · Alta — Los eventos de otra conversación se pintan en la pestaña activa

`renderer/20-app.js:464` registra el **único** manejador de eventos del renderer:

```js
window.sagitari.onAgentEvent((ev) => {
  if (ev.bg) { ... return; }                 // solo separa las tareas en segundo plano
  if (/^team_/.test(String(ev.type || ''))) { ... return; }
  switch (ev.type) { ... }                   // escribe en rtActual()
```

El proceso principal emite **cada** evento del chat con su conversación
(`main/main.js:476`: `const out = isBackground ? { ...e, bg: true } : { ...e, convId };`) y
la interfaz tiene una función escrita justo para esto —`renderer/10-chat.js:369
eventoDeOtraPestana(ev)`, que sí lee `ev.convId`—, **exportada en `10-chat.js:15` pero no
invocada en ningún sitio** (solo hay dos apariciones del nombre: la definición y el
comentario de export). Entre las líneas 534 y 805 del manejador no hay ninguna comprobación
de `ev.convId`.

Con varias conversaciones abiertas y dos turnos vivos a la vez (que es exactamente lo que
`main/runtimes.js` permite), los `delta` de A se concatenan en la burbuja de B
(`20-app.js:543 b._stream += ev.text`), `busy = ev.busy` marca B como trabajando y el
`assistant_done` de A cierra el turno de B.

**Repro:** en la conversación A envía un mensaje; mientras trabaja, cambia a B y envía otro
(cambiar de pestaña no detiene nada). La respuesta de A termina pintándose en B.

**Arreglo:** una línea al principio del manejador, antes del `switch`:

```js
if (ev.convId && ev.convId !== hiloActual()) return eventoDeOtraPestana(ev);
```

(los `team_*` ya se enrutan por `ev.convId` en `40-vistas.js`, así que la comprobación debe
ir después del bloque `bg` y sin estorbar a los `team_*`).

**Cobertura:** no hay ninguna prueba que cubra esta ruta en `test/renderer/`; por eso pasa
en verde. Conviene añadir una.

---

### 2 · Alta — Un comando que falla se cuenta como éxito y desactiva la puerta de verificación

`executors.js:843` devuelve el resultado de `run_command` **sin** el prefijo `Error` aunque
el código de salida no sea 0:

```js
return `exit=${r.code}\nSTDOUT:\n${clip(r.stdout)}\nSTDERR:\n${clip(r.stderr, 3000)}`;
```

Y en el bucle, el fallo se deduce solo del texto (`agent/agent.js:1865`):

```js
return { action: 'ok', text, images, failed: typeof text === 'string' && text.startsWith('Error'), args, confirmed };
```

Con `failed === false`, el turno apunta el comando como bueno (`agent.js:1461-1472`):
`_cmds++`, `_lastCmdSeq = _toolSeq` y `_lastCmd = …comando…`. Eso hace que:

- `_needsVerification` (`agent.js:2182`) devuelva `false` con «ya se comprobó ejecutando»;
- `_chequeoCierre` (`agent.js:1975-1978`) marque `_cierreAuto = true` y **no vuelva a
  ejecutar la comprobación del proyecto** si el modelo ya lanzó ese mismo `npm test`… aunque
  hubiera fallado.

Efecto: escribir código, lanzar la suite, verla en rojo y poder cerrar el turno como
«verificado», con el `runlog` y el checkpoint diciendo `success: true`. El modelo sí ve el
`exit=1` en el resultado (no se le oculta), pero la garantía de cierre —una de las promesas
del producto— queda a merced de que el modelo decida seguir.

**Arreglo:** propagar el fallo de forma explícita, p. ej. devolver también `{ failed: r.code !== 0 }`
desde el ejecutor (o prefijar con `Error:` cuando `r.code !== 0`), y usarlo en `agent.js:1857-1865`
en lugar de inspeccionar el texto.

---

### 3 · Alta — Un subagente cortado se reporta como `OK` y puede marcar el turno como verificado

Cuando un subagente llega al tope de pasos, el bucle hace `break` (`agent/agent.js:1135`) y
entrega el **último** mensaje del asistente (`agent.js:1637-1640`), que en un corte suele ser
un preámbulo sin bloque `STATUS`. El parser cae entonces al valor por defecto
(`agent/subagents.js:722-727`):

```js
const status = ['OK', 'PARTIAL', 'FAILED'].includes(statusWord) ? statusWord
  : /error|no pude|no se pudo|falló|fallo|imposible|denegad/i.test(t) ? 'FAILED' : 'OK';
```

Y en la delegación (`agent/agent.js:2395`):

```js
if (spec.key === 'verification' && parsed.status !== 'FAILED') this._verified = true;
```

`_verified = true` desactiva la puerta de cierre (`agent.js:2181`). Es decir: **delegar en el
subagente `verification`, que se quede sin pasos, y cerrar el turno como verificado**. Lo
mismo si el subagente se aborta y entrega `finalText` vacío.

El mismo defecto hace lo contrario en el otro sentido: un informe correcto que mencione la
palabra «error» en sus detalles se etiqueta `FAILED`.

**Arreglo:** que un corte por tope/aborto devuelva `status: 'PARTIAL'` explícito (no el
último texto), y que `_verified` exija `parsed.status === 'OK'` con evidencia, no «no FAILED».

---

### 4 · Media — El protocolo de depuración de Chrome por TCP, con perfil persistente

`agent/browser.js:828-834` lanza el navegador así:

```js
this.port = 9223 + Math.floor(Math.random() * 500);
const args = [ `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.profileDir}`, ... ];
```

El puerto queda a la escucha en `127.0.0.1` y el perfil es persistente (guarda las sesiones
y cookies del usuario, de forma deliberada). Cualquier proceso local puede alcanzar ese
endpoint CDP y controlar un navegador con las sesiones abiertas del usuario. Chrome mitiga
el vector «página web» con la comprobación del `Host`/`Origin`, pero es un mecanismo
conocido como frágil y aquí no hay ninguna capa propia que lo tape.

**Arreglo recomendado:** usar `--remote-debugging-pipe` en vez de un puerto TCP: el CDP viaja
por los descriptores 3 y 4 (`stdio: ['ignore','pipe','pipe','pipe','pipe']`) y no hay
superficie de red que exponer. Es un cambio acotado a `launch()`/`connect()` de `browser.js`.

---

### 5 · Media — Chrome huérfano si el lanzamiento falla o el cierre no responde

`agent/browser.js:856-871` guarda el PID pero, si el puerto no llega a responder, **devuelve
error sin matar el proceso**:

```js
const child = spawn(exe, args, { windowsHide: true, stdio: 'ignore' });
this.browserPid = child.pid;
...
if (!ok) return 'Error: el navegador no respondió al puerto de depuración.';
```

Y en el cierre, `main/main.js:1051` solo pide `Browser.close` **si hay websocket**:

```js
if (browser.ws) browser.send('Browser.close').catch(() => {});
```

`Browser.kill()` (que hace `taskkill /PID /T /F`, `browser.js:882-895`) no se llama nunca
desde el cierre. Si el lanzamiento falló (`ws === null`) o Chrome no atiende la orden, queda
una ventana y un proceso vivos con el perfil de la app tras cerrar SAGITARI. El resto de
procesos hijos del proyecto sí se limpian con `killTree` (`executors.js:154`, `git.js:89`,
`mcp-transport.js:329`): aquí es la única ruta que no lo hace.

**Arreglo:** en el `!ok` de `launch()`, matar el proceso recién creado antes de devolver el
error; y en `cerrarYsalir()` añadir un `browser.kill()` de respaldo tras el `Browser.close`
(con un margen corto).

---

### 6 · Media — El presupuesto de los subagentes se avisa, no se corta, y los topes se cuentan distinto según el camino

`agent/agent.js:2328-2337`: al terminar una delegación se absorbe su gasto, pero un exceso
solo emite un `status`; el bucle no se detiene. Como varias delegaciones del mismo mensaje
corren en paralelo (hasta 4) y `maxDelegations` es 8, el gasto puede rebasar el tope del
usuario varias veces antes de que el siguiente `addTokens` del padre lo note. El modo Equipo
sí vigila su presupuesto a mitad de vuelta (`equipo.revisar()`); la ruta `delegate` no.

Además, la contabilidad es incoherente entre los dos caminos:

- `checkDelegation()` (`guardrails.js:353`, tope `maxDelegations`) solo se consulta en la ruta
  `delegate` (`agent.js:1880`); `team_spawn` (`agent.js:2563`) no lo toca.
- El tope de compañeros compara `miembros.size` (`equipo.js:271`), que nunca decrece: es
  «4 por turno», no «4 vivos a la vez» como dice el texto que ve el usuario.

No es una fuga (los topes existen y son más restrictivos de lo que parecen), pero el
comportamiento no coincide con lo documentado.

**Arreglo:** que `absorb()` con exceso detenga el bucle como hace Equipo; unificar el cupo de
subagentes y compañeros en el mismo contador; llevar los compañeros vivos en un `Set` aparte
del histórico.

---

### 7 · Media — El aislamiento por árbol git no contempla `run_command`

`agent/agent.js:2215`:

```js
const escribeElArbol = ['write_file', 'edit_file', 'apply_patch'].some((t) => spec.allowTools.includes(t));
```

`run_command` puede modificar archivos (redirecciones, `robocopy`, `git checkout`, un script)
y no está en la lista. Un agente definido por el usuario con `tools: [run_command]` (permitido
por el techo de `subagents.js:349`) escribe entonces directamente en el árbol del usuario
mientras otro subagente aislado ve una copia y luego fusiona: justo el conflicto semántico
que `arboles.js` existe para evitar. Los integrados con `run_command` son de solo lectura por
diseño, así que el hueco real aparece con agentes propios.

**Arreglo:** incluir `run_command` en `escribeElArbol` (o exigir que un árbol con
`run_command` no se fusione a ciegas).

---

### 8 · Baja — `web_fetch`: ventana TOCTOU entre la resolución validada y la petición

`agent/web.js:100-115` resuelve el nombre y comprueba **todas** las direcciones; después
`web.js:271` hace el `fetch` por nombre, y `fetch` vuelve a resolver. Entre las dos
resoluciones cabe un DNS rebinding (TTL bajo) que devuelva una IP privada en la segunda. La
comprobación de redirecciones sí está bien hecha (cada salto se revalida).

**Arreglo:** conectar a la IP ya validada y enviar el `Host` del nombre (o fijar la
resolución con un `lookup` propio en el `fetch`).

---

### 9 · Baja — `checkpoints.remove()` informa éxito aunque el borrado falle

`agent/checkpoints.js:362-367` recorre los estados con `try { fs.rmSync(...) } catch {}` y
devuelve `{ ok: true }` siempre. `TaskManager.remove` confía en ese `ok` (`tasks.js:211-213`)
y la UI dice «Tarea eliminada» aunque el archivo siguiera bloqueado. Basta acumular los
fallos y devolver `ok: false` si todos fallan.

---

### 10 · Baja — `arboles.js` mata `git` con `child.kill()` en vez de `killTree`

`agent/arboles.js:93-98` usa `child.kill()` en el timeout, a diferencia de `executors.js`,
`git.js` y `mcp-transport.js`, que usan `killTree` (`proc.js`). En Windows, un `git` que haya
lanzado ayudantes puede dejar nietos vivos hasta que el timeout expire. Poco probable en
operaciones locales, pero es la única ruta de `spawn` que no mata el árbol.

---

### 11 · Baja — Cadenas `.then()` sobre promesas IPC sin `.catch()`

`renderer/10-chat.js:214, 529, 535`, `renderer/30-ajustes.js:56`, `renderer/20-app.js:1358`.
Un rechazo no queda silencioso (lo recoge `window.addEventListener('unhandledrejection', …)`,
`20-app.js:486`), pero deja la vista en el estado previo. Añadir `.catch(...)` con un aviso
sería más honesto que confiar en el manejador global.

---

### 12 · Baja — Defensa en profundidad en Electron

El endurecimiento base está bien puesto (`main/ventana.js:91-97`: `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`; CSP con `object-src 'none'`, `base-uri 'self'`,
`frame-ancestors 'none'`; `will-navigate` y `setWindowOpenHandler` restringidos; `openExternal`
solo http(s) en `main/ipc-misc.js:32-34`). Faltan dos capas que hoy no son explotables pero
cuestan poco:

- **Validar el remitente** en los `ipcMain.handle` (`event.senderFrame`/`event.sender`), para
  que un futuro XSS no tenga a mano las 70 y pico llamadas del puente.
- **`session.setPermissionRequestHandler`** denegando por defecto (cámara, micrófono,
  geolocalización…). El modo voz se retiró y no hay contenido remoto, así que hoy no se pide
  nada; fijarlo cierra la puerta a que aparezca sin querer.

---

## 4. Lo que se revisó y está bien (para que no se insinúe lo contrario)

- **Saneado del markdown del modelo** (`renderer/10-chat.js:660-788`): lista blanca de
  etiquetas y atributos, parseo en documento inerte, y URLs restringidas a `data:`/`http(s):`
  con `target=_blank` + `rel=noopener`. Los `innerHTML` que llevan datos externos pasan por
  `esc()` (`10-chat.js:656`, escapa también las comillas). No se encontró un solo punto sin
  escapar con datos del modelo, de una skill, de un archivo o de una respuesta IPC.
- **Confinamiento de rutas** (`agent/executors.js:23-113`): bloqueo del directorio de datos
  (comparando ruta normalizada **y** camino real, con `duda` ⇒ denegar), de las carpetas del
  sistema y de la raíz de unidad; `read_file`/`view_image` con topes de tamaño; `edit_file`
  que se niega a corromper archivos no-UTF-8.
- **Escrituras atómicas**: `writeJsonAtomic` (config, conversaciones) y `escribirAtomico` +
  `apply_patch` todo-o-nada con restauración desde pre-imagen.
- **Clasificación de comandos** (`agent/comandos.js`): tres escalones, prohibidos sin
  confirmación posible, sensibles siempre confirmados, y una lista blanca que solo aplica a
  órdenes simples (una orden encadenada deja de ser «inocua»). Aplicada en tres sitios:
  `guardrails.decide`, el ejecutor de `run_command` y los hooks del usuario.
- **Inyección de shell en `open_app`**: metacaracteres de cmd rechazados (`executors.js:1115`).
- **Redacción de secretos en el log** (`agent/runlog.js:102-254`): por clave, por patrón
  (sk-, gh*_, Bearer, JWT…) y por tamaño, más enmascarado del texto libre en campos sensibles
  del navegador y el portapapeles. `runlog` y `crash.log` rotan con tope.
- **Filtro SSRF de `web_fetch`** (`agent/web.js:38-115`): revisa el literal del host, todas
  las direcciones resueltas y cada redirección; lo no verificable se bloquea.
- **Skill importada** (`agent/skills.js:199-226`): `safeSkillDir` valida el id contra `..`,
  separadores, NUL y puntos finales de Windows, y comprueba que el destino queda dentro del
  almacén. El cuerpo de una skill de terceros se entrega como datos delimitados, no como órdenes.
- **Ciclo de vida del proceso** (`main/main.js:1014-1057`): cierre en dos fases que espera de
  verdad a bandeja, tareas, agentes, MCP, navegador y logs; recuperación del renderer caído;
  liberación de confirmaciones pendientes al detener (`agent.js:767-779, 355-379`).
- **Fallback de modelo sin doble efecto**: solo se reintenta la llamada al modelo; la
  ejecución de herramientas ocurre después (`agent.js:2874` y `1213`).
- **Contraste**: 0 de 54 pares por debajo de 4,5:1 (medido, no declarado).

---

## 5. Prioridad sugerida

1. **#1** (una línea en el renderer) — es el defecto más visible para el usuario y el más barato de arreglar.
2. **#2 y #3** — son los que convierten fallos reales en cierres «verdes»; tocan la promesa de verificación.
3. **#4 y #5** — endurecimiento del navegador (pipe en vez de puerto) y limpieza de procesos.
4. **#6 y #7** — coherencia de topes y aislamiento.
5. **#8–#12** — higiene; se pueden agrupar en una pasada.
6. Actualizar el toolchain de desarrollo para bajar los avisos de `npm audit`.
