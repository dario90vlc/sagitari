# SAGITARI 3.2.0

**SAGITARI deja de trabajar «a ciegas»: ahora maneja el navegador como una persona, revisa lo
que escribe y reparte el trabajo en paralelo.** Esta versión es la de la fiabilidad. El
**navegador** pasa a la versión 2 —nombres accesibles en lugar de texto invisible, componentes
web e iframes, clics que no caen donde no deben, esperas de verdad, consola y errores de red,
diálogos, subida de archivos y atajos de teclado—, el agente **comprueba el código al
escribirlo** y **un revisor lee el cambio** antes de dártelo por hecho, y las órdenes de un
mismo mensaje se ejecutan **a la vez** con un bloqueo por recurso (el navegador es uno solo, la
escritura va en cola) para que las tareas largas dejen de durar la suma de sus pasos. Y todo
eso en la interfaz: razonamiento visible opcional, tablero del equipo en vivo, separador de día
y tarjetas de herramienta que dicen qué pasó. / **SAGITARI stops working blind: it now drives
the browser like a person, reviews what it writes, and spreads work in parallel.** This is the
reliability release. The **browser** moves to v2 —accessible names instead of invisible text,
web components and iframes, clicks that never land in the wrong place, real waits, console and
network errors, dialogs, file uploads and keyboard shortcuts—, the agent **checks code as it
writes it** and **a reviewer reads the change** before handing it to you, and the orders inside
one message run **at the same time** behind a per-resource lock (there is only one browser; disk
writes queue up) so long tasks stop taking the sum of their steps. All of it visible in the UI:
optional reasoning, a live team board, a day separator, and tool cards that say what happened.

## Navegador 2 / Browser v2

- **El inventario dice el nombre REAL de cada control.** Antes se usaba el texto del elemento:
  un botón de icono salía con nombre vacío y el agente pulsaba por coordenadas a ciegas. Ahora
  se calcula el nombre accesible (`aria-label`, `aria-labelledby`, `<label for>`, `alt`,
  `title`, `placeholder`, `data-testid`, `value` de un submit), con su rol, su estado
  (deshabilitado, marcado, valor actual, obligatorio) y su `data-testid`, que es la forma en
  que las webs hechas para automatizar se identifican. / **The inventory reports the REAL name
  of every control.** It used to use the element's text, so an icon-only button came out with an
  empty name and the agent clicked by coordinates, blind. Now the accessible name is computed
  (`aria-label`, `aria-labelledby`, `<label for>`, `alt`, `title`, `placeholder`,
  `data-testid`, submit `value`), together with its role, its state (disabled, checked, current
  value, required) and its `data-testid`, which is how automation-friendly sites identify
  themselves.
- **Componentes web e iframes del mismo origen.** Shadow DOM y marcos eran invisibles: media
  interfaz moderna (editores, reproductores, formularios embebidos) no existía para el agente.
  Ahora se recorren, y cada elemento dice en qué marco está. / **Web components and same-origin
  iframes.** Shadow DOM and frames were invisible: much of the modern web (editors, players,
  embedded forms) simply did not exist for the agent. Now they are walked, and each element
  says which frame it lives in.
- **Los clics ya no caen donde no deben.** Antes de pulsar se vuelve a localizar el elemento
  **por su huella** (no por la posición que tenía), se comprueba que ha dejado de moverse y que
  **nadie lo tapa**; si algo lo tapa, el error dice QUÉ lo tapa, y si de verdad hay que pulsarlo
  (un aviso de cookies pegado encima), `force` lo hace. Lo que está por debajo del pliegue se
  marca como «fuera de pantalla» y se trae a la vista al clicar, en vez de obligar al modelo a
  adivinar el scroll. / **Clicks no longer land in the wrong place.** Before pressing, the
  element is located again **by its fingerprint** (not by the position it had), it is checked
  that it stopped moving and that **nothing covers it**; if something does, the error says WHAT
  covers it, and if it truly must be pressed (a cookie banner stuck on top), `force` does it.
  Anything below the fold is flagged as “off screen” and scrolled into view when clicked,
  instead of forcing the model to guess the scroll.
- **Esperar sin dormir.** `wait_for` espera a que aparezca un texto, un selector, un título o
  una URL —o a que desaparezca algo—, con tiempo límite, y si no llega explica en qué estado
  quedó la página en vez de seguir como si nada. / **Waiting without sleeping.** `wait_for`
  waits for a text, selector, title or URL to appear —or for something to disappear—, with a
  deadline, and if it never comes it explains the state the page was left in instead of carrying
  on as if nothing had happened.
- **Se puede depurar la web que el propio agente abre.** `logs` devuelve la consola, las
  excepciones, las peticiones que fallaron (404/500) y las descargas; los diálogos de la página
  (`alert`, `confirm`, `prompt`) se detectan, se avisan en el resultado y se contestan con
  `dialog` en vez de dejar la página pausada y el turno colgado. / **You can debug the site the
  agent itself opens.** `logs` returns console output, exceptions, failed requests (404/500) and
  downloads; page dialogs (`alert`, `confirm`, `prompt`) are detected, announced in the result
  and answered with `dialog` instead of leaving the page paused and the turn hanging.
- **Actuar como una persona.** `select` (opción por valor, texto o posición), `check` para
  casillas, `hover` para menús, `hotkey` para atajos (`Ctrl+Shift+T`, `Alt+ArrowLeft`…), `upload`
  para subir archivos, `back`/`forward`/`reload` sobre el historial real, captura de un elemento
  concreto y descargas guardadas en una carpeta conocida que se dice en el resultado. `type`
  escribe tecla a tecla en textos cortos (las webs que validan al escribir no ven el pegado) y
  **devuelve lo que quedó escrito**: si el sitio recortó por `maxlength` o una máscara, lo dices
  tú y no lo descubre tres pasos después. / **Acting like a person.** `select` (option by value,
  text or position), `check` for boxes, `hover` for menus, `hotkey` for shortcuts
  (`Ctrl+Shift+T`, `Alt+ArrowLeft`…), `upload` for files, `back`/`forward`/`reload` on the real
  history, screenshots of a single element, and downloads saved to a known folder that is
  reported in the result. `type` types key by key for short texts (sites that validate as you
  type never see a paste) and **returns what ended up in the field**: if the site trimmed it via
  `maxlength` or a mask, you hear it right away instead of three steps later.
- **Subir un archivo y aceptar un diálogo piden permiso siempre.** Lo primero manda datos tuyos
  a una web y lo segundo puede confirmar algo destructivo: ninguna de las dos se hace sin
  preguntar. / **Uploading a file and accepting a dialog always ask for permission.** The first
  sends your data to a website and the second can confirm something destructive: neither happens
  without asking.

## Trabajo en paralelo y por recursos / Parallel work and resource locks

- **Las órdenes de un mismo mensaje se ejecutan a la vez.** Si el modelo pide tres lecturas, dos
  investigaciones o un comando y una captura, ya no van una detrás de otra: salen en paralelo
  (hasta 3 por defecto, ajustable de 1 a 4 en Ajustes ▸ Delegación y verificación) y los
  resultados vuelven al modelo en el orden que pidió. / **Orders in the same message run
  together.** If the model asks for three reads, two investigations or a command plus a
  screenshot, they no longer run one after another: they go in parallel (3 by default, adjustable
  from 1 to 4 in Settings ▸ Delegation and verification) and results come back to the model in
  the order it asked.
- **Bloqueo por recurso, para que el paralelismo no rompa nada.** Hay cosas que no se pueden
  compartir: el navegador es **una sola instancia** (dos clics a la vez se pisan la pestaña y el
  inventario de elementos), la **escritura** en disco va en cola y la **terminal** admite dos
  comandos a la vez. Lo que no choca no espera: leer un archivo no bloquea a quien escribe. Y el
  orden de adquisición es canónico, así que no hay interbloqueos. / **Per-resource locks, so
  parallelism breaks nothing.** Some things cannot be shared: there is only **one browser
  instance** (two clicks at once trip over the active tab and the element inventory), **disk
  writes** queue up, and the **terminal** takes two commands at once. What does not collide does
  not wait: reading a file never blocks whoever is writing. Acquisition order is canonical, so
  there are no deadlocks.
- **Detener mata TODO lo que esté en vuelo.** Antes solo alcanzaba a la herramienta actual;
  ahora mueren las que estén corriendo a la vez y también los subagentes en paralelo. Y lo que
  aún esperaba su turno de recurso **ya no se ejecuta después de la parada** (el semáforo no
  sabe nada del abort: hasta dos clics encolados detrás del navegador salían con la app ya
  detenida). / **Stop kills EVERYTHING in flight.** It used to reach only the current tool; now
  it takes down the ones running side by side and the parallel subagents too. And whatever was
  still waiting for its resource turn **no longer runs after the stop** (the semaphore knows
  nothing about the abort: up to two clicks queued behind the browser used to go off with the
  app already stopped).

## El código sale con red / Code ships with a safety net

- **Sabe cómo se comprueba TU proyecto.** Detecta con qué se ejecutan los tests, la compilación
  y el lint (Node con su gestor por fichero de bloqueo, Python, Rust, Go, .NET…) y lo pone en el
  prompt, del orquestador y de cada subagente; solo nombra los comandos que existen. / **It knows
  how YOUR project is verified.** It detects what runs tests, builds and lint (Node with its
  lockfile package manager, Python, Rust, Go, .NET…) and puts it in the prompt, for the
  orchestrator and for every subagent; it only names commands that exist.
- **La sintaxis se comprueba al escribir.** Cada archivo escrito o editado se valida al
  instante: si no compila, el error vuelve en el mismo paso —cuando el modelo aún tiene el
  contexto— y la tarjeta se marca en rojo en vez de dar el cambio por bueno. / **Syntax is
  checked as it writes.** Every written or edited file is validated immediately: if it does not
  compile, the error comes back in the same step —while the model still has the context— and the
  card turns red instead of calling the change done.
- **Un revisor lee el cambio antes de cerrar.** El turno guarda el diff de lo modificado
  (también lo que tocaron los subagentes), y antes de dártelo por hecho un agente de revisión
  busca contratos rotos, casos límite y restos del nombre viejo; el hallazgo bloqueante se
  arregla en ese mismo turno. Va en la **misma ronda** que la verificación del resultado, para
  que dos comprobaciones cuesten una vuelta y no dos. Se apaga en Ajustes ▸ Delegación y
  verificación. / **A reviewer reads the change before closing.** The turn keeps the diff of
  everything modified (including what subagents touched), and before handing it to you a review
  agent looks for broken contracts, missed edge cases and leftovers of the old name; a blocking
  finding is fixed in that same turn. It rides in the **same round** as result verification, so
  two checks cost one extra round instead of two. Turn it off in Settings ▸ Delegation and
  verification.
- **Ediciones de varios archivos, atómicas.** `apply_patch` comprueba todos los anclajes y solo
  entonces escribe: o entran todos los archivos o no entra ninguno (antes, un refactor de cinco
  archivos podía dejar el proyecto a medias). / **Multi-file edits, atomic.** `apply_patch`
  checks every anchor and only then writes: either all files go in or none does (before, a
  five-file refactor could leave the project half-done).
- **Mapa del proyecto para no leer a ciegas.** `repo_map` y `find_symbol` indexan archivos y
  símbolos (sin `node_modules`, binarios ni archivos enormes): «¿qué hay aquí?» y «¿dónde se
  define X?» se responden sin abrir nada. / **Project map instead of blind reading.**
  `repo_map` and `find_symbol` index files and symbols (no `node_modules`, binaries or huge
  files): “what is in here?” and “where is X defined?” are answered without opening anything.

## Agente, equipo e interfaz / Agent, team and UI

- **Razonamiento visible (opcional).** Los modelos que razonan enseñan su proceso en un bloque
  plegable sobre la respuesta; se lee en vivo, se pliega al empezar a contestar, **nunca se lee
  en voz alta** y no ensucia al copiar. Ajustes ▸ Agente. / **Optional visible reasoning.**
  Reasoning models show their process in a collapsible block above the answer; it streams live,
  folds when the answer starts, is **never read out loud** and stays out of copied text.
  Settings ▸ Agent.
- **Tablero del equipo en el chat.** Cada delegación se ve **en vivo** con su subtarea y su
  criterio, se resuelve con OK, «a medias» o fallo, y al acabar queda su tarjeta con resultado,
  detalles, evidencia y duración. / **Live team board in the chat.** Every delegation is visible
  **while it runs**, with its subtask and success criterion, resolves to OK, partial or failed,
  and leaves a card with result, details, evidence and duration.
- **Skills dentro de cada agente.** Cada subagente recibe el índice de las skills de su
  especialidad y las carga solo cuando le hacen falta; su método de trabajo y lo que debe
  entregar ya no son genéricos. / **Skills inside every agent.** Each subagent gets the index of
  the skills for its specialty and loads them only when needed; its working method and its
  deliverable are no longer generic.
- **La interfaz dice qué pasó.** Separador de día real (no una marca entre cada pregunta y su
  respuesta), cabecera del grupo de herramientas con cuántas van en curso y si algo falló, y
  plegado automático del detalle al llegar la respuesta. / **The UI says what happened.** A real
  day separator (not a stamp between every question and its answer), a tool-group header showing
  how many are running and whether anything failed, and automatic folding of the details once
  the answer arrives.

## Coste y estabilidad / Cost and stability

- **Menos lecturas y menos tokens por turno.** El índice de skills y el mapa del proyecto se
  sirven de memoria (invalidados al escribir) en vez de releerse del disco en cada paso, y
  `use_skill` no vuelve a mandar el cuerpo entero de una skill ya cargada en el turno. / **Fewer
  reads and fewer tokens per turn.** The skills index and the project map are served from memory
  (invalidated on write) instead of being re-read from disk at every step, and `use_skill` no
  longer resends the full body of a skill already loaded in the turn.
- **Prompt pensado para la caché.** Lo estable (identidad, reglas, proyecto, mapa) va primero y
  lo volátil (memoria, hábitos, skills sugeridas) al final, para que el prefijo se reutilice en
  proveedores con caché de prompt. / **Cache-friendly prompt.** Stable content (identity, rules,
  project, map) goes first and volatile content (memory, habits, suggested skills) last, so the
  prefix is reused on providers with prompt caching.
- **Un subagente ya no muere por un fallo del proveedor.** Hereda la cadena de modelos: si el
  primero devuelve un 500, sigue con el siguiente en vez de tirar treinta pasos de trabajo. / **A
  subagent no longer dies on a provider hiccup.** It inherits the model chain: if the first one
  returns a 500, it moves to the next instead of throwing away thirty steps of work.
- **Frenos explícitos.** Tope de subagentes por turno (configurable, con aviso claro y sin cortar
  la tarea), tope de llamadas, detección de bucle y de estancamiento, y un resumen rodante que
  conserva lo importante de hilos largos en vez de cortar el principio en seco. / **Explicit
  brakes.** A per-turn subagent cap (configurable, clearly announced, never cutting the task),
  a tool-call cap, loop and stall detection, and a rolling summary that keeps what matters from
  long threads instead of cutting the beginning off.

## Comprobado antes de publicar / Verified before publishing

- **330 tests unitarios**, la comprobación de interfaz sobre la app viva (iconos, cableado,
  navegación, delegación, razonamiento, revisión del cambio) y el arranque real de la app. / **330
  unit tests**, the UI check against the live app (icons, wiring, navigation, delegation,
  reasoning, change review) and a real app launch.
- **Y el navegador, contra un navegador de verdad**: 29 comprobaciones en un Chrome real con una
  página de prueba que incluye componentes web, iframes, un botón tapado, uno fuera de pantalla,
  un `confirm()` y errores de consola —`npm run navcheck`—. / **And the browser tool, against a
  real browser**: 29 checks in a real Chrome with a test page that includes web components,
  iframes, a covered button, an off-screen one, a `confirm()` and console errors — `npm run
  navcheck`.
# SAGITARI 3.1.1

**La voz vuelve a funcionar en la app instalada y en el portable.** En la 3.1.0, los guiones
que dan voz y oído a la app (`tts.ps1` y `voice.ps1`) se empaquetaban dentro del archivo `.asar`
y Windows no sabe leer ahí: PowerShell rechazaba la ruta con «El argumento … no existe», así que
la app no podía leer nada en voz alta ni arrancar el dictado. Solo pasaba en las versiones
compiladas —en desarrollo no hay asar—, que es justo donde no se veía. / **Voice works again in
the installed app and in the portable.** In 3.1.0 the scripts that give the app its voice and
hearing (`tts.ps1` and `voice.ps1`) were packed inside the `.asar` archive, and Windows cannot
read there: PowerShell rejected the path with “The argument … does not exist”, so the app could
not read anything out loud nor start dictation. It only happened in the built versions —in
development there is no asar—, which is exactly where it went unnoticed.

## Correcciones / Fixes

- **Los guiones de voz salen del asar y el motor resuelve siempre una ruta real.** Los `.ps1`
  se empaquetan desempaquetados (`asarUnpack`) y, si por lo que sea no hay copia desempaquetada,
  el contenido se deja en caché en una ruta real antes de entregársela a PowerShell. Cubre los
  dos guiones —hablar y dictar— y también el dictado clásico de la app, que apuntaba al mismo
  sitio. / **The voice scripts now live outside the asar and the engine always resolves a real
  path.** The `.ps1` files ship unpacked (`asarUnpack`) and, should there be no unpacked copy,
  the content is cached at a real path before handing it to PowerShell. This covers both
  scripts —speaking and dictation— and also the app's classic dictation, which pointed to the
  same place.
- **Los servidores MCP locales funcionan sin tener Node.js instalado.** Un servidor con
  `"command": "node"` —lo que traen los ajustes importados de otros clientes— moría con un
  «spawn node ENOENT» en cualquier equipo sin Node. Ahora se usa el Node del equipo si existe
  y, si no, el que la propia app lleva dentro; y si el comando es `npx`/`npm`, que sí necesitan
  una instalación real, se dice qué falta y cómo resolverlo en vez de fallar dentro de cmd.exe.
  / **Local MCP servers work without Node.js installed.** A server with `"command": "node"`
  —what imported settings from other clients contain— died with a “spawn node ENOENT” on any
  machine without Node. Now the machine's Node is used when it exists and otherwise the one
  the app itself carries; and if the command is `npx`/`npm`, which do need a real install, the
  app says what is missing and how to fix it instead of failing inside cmd.exe.

# SAGITARI 3.1.0

**Habla con SAGITARI y conecta tus propios servidores MCP.** Esta versión trae dos capacidades
grandes y una tanda de correcciones de fondo. El **modo voz** convierte el micrófono en una
forma completa de usar la app: hablas, el asistente hace el trabajo en tu PC y te contesta en
voz alta, con voz neuronal local y dictado local de alta precisión que se instalan a petición
(nada de tu voz sale del equipo). Y la **integración de MCP** deja que añadas tus propios
servidores —comandos locales o URLs remotas— para que el agente use sus herramientas como las
de casa: mismo catálogo, mismas confirmaciones, mismos guardarraíles. / **Talk to SAGITARI and
plug in your own MCP servers.** This version brings two big capabilities plus a round of
deep fixes. **Voice mode** turns the microphone into a complete way of using the app: you
speak, the assistant does the work on your PC and answers out loud, with a local neural voice
and high-accuracy local dictation installed on demand (none of your voice leaves the machine).
And **MCP integration** lets you add your own servers —local commands or remote URLs— so the
agent uses their tools like its own: same catalog, same confirmations, same guardrails.

## Modo voz / Voice mode

- **Manos libres de verdad.** Pulsar el micrófono abre el modo voz: hablas, el silencio cierra
  la frase, se envía al agente y la respuesta se dice en voz alta. Mientras responde, el orbe
  late con su voz; si hablas encima, se calla al instante y te escucha, sin perder tu primera
  sílaba. / **Real hands-free.** Pressing the mic opens voice mode: you talk, silence closes the
  sentence, it is sent to the agent and the answer is spoken out loud. While it answers, the
  orb pulses with its voice; if you talk over it, it shuts up instantly and listens, without
  losing your first syllable.
- **Empieza a hablar en cuanto tiene la primera frase.** La respuesta se lee por frases según
  el modelo la va escribiendo, no al terminar el turno: en una tarea con herramientas eso son
  decenas de segundos de espera que ya no existen. Y puedes **pararlo** diciendo «para» o con
  el botón **Parar** del panel. / **It starts speaking as soon as it has the first sentence.**
  The reply is read sentence by sentence as the model writes it, not at the end of the turn:
  on a task that uses tools that used to be tens of seconds of waiting. And you can **stop it**
  by saying “para” or with the panel's **Parar** button.
- **Voz neuronal local (Piper), sin depender de la voz de Windows.** Se instala desde Ajustes
  (≈80 MB, descarga única) y suena a persona, 100% offline. Cuando está instalada manda ella;
  si no, la app usa la mejor voz del sistema avisando de cuál está sonando. / **Local neural
  voice (Piper), no dependency on the Windows voice.** Installed from Settings (≈80 MB, one-off
  download) and it sounds like a person, 100% offline. Once installed it takes over; otherwise
  the app uses the best system voice and tells you which one is playing.
- **Dictado local de alta precisión (Whisper).** Transcripción en español 100% local y sin
  internet, con **texto en vivo mientras hablas** y el modelo que de verdad entiende (≈190 MB,
  a petición). El reconocimiento de Windows sigue de respaldo, y si su motor moderno arranca
  sordo —cambio de micrófono, filtros de audio— la app lo detecta y cambia al clásico sola. /
  **High-accuracy local dictation (Whisper).** 100% local, offline Spanish transcription with
  **live text while you speak** and the model that actually understands you (≈190 MB, on
  demand). Windows speech recognition stays as fallback, and if its modern engine starts up
  deaf —changed microphone, audio filters— the app notices and switches to the classic one by
  itself.
- **La transcripción se ve y se corrige.** Cada frase queda en pantalla con su nivel de
  confianza; si el motor oyó mal un nombre propio, la tocas, la arreglas y Enter la reenvía por
  el mismo camino. / **The transcript is visible and editable.** Every sentence stays on screen
  with its confidence level; if the engine got a proper noun wrong, you tap it, fix it and Enter
  sends it again through the same path.
- **Los permisos se contestan hablando.** Cuando el agente pide permiso para una acción
  sensible, el aviso sale en el panel y se contesta con «sí» o «no» (o con los botones): las dos
  puertas acaban en la misma decisión. / **Permissions are answered by voice.** When the agent
  asks for permission for a sensitive action, the request shows up in the panel and is answered
  with “sí” or “no” (or with the buttons): both doors lead to the same decision.
- **El modo voz no tiene camino propio al agente.** Lo que dictas entra por el MISMO envío del
  chat, así que hereda herramientas, permisos, guardarraíles, memoria e historial. El micrófono
  solo vive con el modo abierto, y el permiso de micrófono se concede solo a la página de la
  app. Nada de audio ni de texto sale del equipo. / **Voice mode has no path of its own to the
  agent.** What you dictate goes through the SAME chat send, so it inherits tools, permissions,
  guardrails, memory and history. The microphone only lives while the mode is open, and the mic
  permission is granted only to the app's own page. No audio or text leaves your machine.

## Servidores MCP / MCP servers

- **Cliente MCP propio, sin dependencias nuevas.** Transporte `stdio` (procesos locales) y HTTP
  remoto con streaming y SSE, con validación de URL, sesión y errores legibles. / **Own MCP
  client, no new dependencies.** `stdio` transport (local processes) and remote HTTP with
  streaming and SSE, with URL validation, session handling and readable errors.
- **Las herramientas MCP son herramientas de casa.** Aparecen en el catálogo como las nativas
  (`mcp__servidor__herramienta`), con su tarjeta de confirmación, su resultado en el registro y
  su coste de pasos igual que cualquier otra. No hay vía lateral: si el motor de permisos no la
  ve, no se ejecuta. / **MCP tools are first-class tools.** They show up in the catalog like the
  native ones (`mcp__server__tool`), with their confirmation card, their result in the log and
  their step cost like any other. There is no side door: if the permission engine does not see
  it, it does not run.
- **Permiso explícito por defecto, con niveles.** Cada llamada pide confirmación salvo que tú
  subas la confianza de un servidor o de una herramienta concreta, y el interruptor global
  apaga también las herramientas que se le ofrecen al modelo. / **Explicit permission by
  default, with levels.** Every call asks for confirmation unless you raise the trust for a
  server or a specific tool, and the global switch also removes those tools from the model's
  catalog.
- **Ajustes › MCP:** lista con el estado de cada servidor, formulario guiado, botón **Probar**
  (conecta y lista sus herramientas de verdad), registro por servidor, importar/exportar el
  bloque `mcpServers` de otros clientes y reconexión al reencender. / **Settings › MCP:** list
  with each server's state, guided form, **Test** button (really connects and lists its tools),
  per-server log, import/export of the `mcpServers` block from other clients and reconnect on
  re-enable.
- **Credenciales cifradas con DPAPI**, como las claves de API, y **Detener** corta una llamada
  MCP en vuelo. / **Credentials encrypted with DPAPI**, like API keys, and **Stop** cancels an
  in-flight MCP call.

## Correcciones y dureza / Fixes and hardening

- **Un guardarraíl podía inutilizar la sesión** y una lectura SSE incompleta tiraba respuestas
  enteras: ambos corregidos, con la confirmación de clics por índice y el estado compartido del
  navegador arreglados. / **A guardrail could make the session unusable** and an incomplete SSE
  read dropped whole answers: both fixed, along with click confirmation by index and the shared
  browser state.
- **No se pierden conversaciones ni claves** al cerrar el turno o la app, y el sistema de
  adjuntos es un módulo probado. / **Conversations and keys are no longer lost** when a turn or
  the app closes, and attachments are now a tested module.
- **El modelo que eliges manda.** El router ya no rellena por categoría en silencio, y un
  proveedor que acepta la conexión pero deja de enviar datos corta el turno solo con un error
  legible y un botón **Reintentar**. / **The model you choose wins.** The router no longer fills
  in by category behind your back, and a provider that accepts the connection but stops sending
  data cuts the turn off by itself with a readable error and a **Retry** button.
- **El navegador espera a que la página cargue de verdad** (se habilita el dominio `Page` y se
  espera al compromiso de la navegación), en vez de dar por cargada una página a medias. /
  **The browser waits for the page to actually load** (the `Page` domain is enabled and it waits
  for the navigation commit) instead of calling a half-loaded page ready.
- **Verificación más honesta:** la suite de tests es determinista y no toca tus datos reales, la
  comprobación de interfaz tiene límite de tiempo y el smoke test da un veredicto real. 268
  comprobaciones unitarias más la comprobación sobre la app viva pasan antes de publicar. /
  **More honest verification:** the test suite is deterministic and never touches your real data,
  the UI check has a deadline and the smoke test gives a real verdict. 268 unit checks plus the
  live-app check pass before publishing.

## Descargas / Downloads

| Archivo / File | Descripción / Description |
|---|---|
| `SAGITARI-Setup-3.1.0.exe` | **Instalador / Installer** (NSIS): accesos directos, desinstalador / shortcuts, uninstaller |
| `SAGITARI-Portable-3.1.0.exe` | **Portable**: un solo ejecutable, sin instalación / single executable, no install |
| `Source code (zip/tar.gz)` | Código fuente / Source code |

> Binario sin firmar: Windows SmartScreen puede avisar en la primera ejecución (*Más información → Ejecutar de todas formas*). La app te dice si la actualización que descarga está firmada o no. Los motores de voz y de dictado locales **no** van dentro del instalador: se descargan a petición desde Ajustes y se pueden borrar. / Unsigned binary: SmartScreen may warn on first run (*More info → Run anyway*). The app tells you whether the update it downloads is signed. The local voice and dictation engines are **not** bundled in the installer: they are downloaded on demand from Settings and can be removed.

# SAGITARI 3.0.1

**El router respeta tu modelo elegido y los proveedores mudos no cuelgan el chat.** La cadena de
fallback reelegía modelo por categoría en cada turno: con mimo-v2.5 seleccionado, una petición
«simple» viajaba a deepseek-flash y los fallos de ese modelo parecían «este modelo no funciona».
Y un proveedor que aceptaba la conexión sin enviar datos dejaba el turno «ocupado» para siempre,
ignorando todo lo que escribieras después. Ahora el modelo de Ajustes manda (el router solo rellena
cuando no hay elección explícita), el silencio del proveedor se corta solo a los ~2 min con error
legible y botón «Reintentar», y las tareas largas quedan recuperables si el modelo deja de mandar
datos. / **The router respects your chosen model and silent providers no longer hang the chat.**
The fallback chain re-picked a model per task category on every turn: with mimo-v2.5 selected, a
"simple" request went to deepseek-flash and that model's failures looked like "this model doesn't
work". And a provider that accepted the connection without sending data left the turn "busy"
forever, ignoring everything you typed next. The Settings model now wins (the router only fills in
when there is no explicit choice), provider silence cuts itself off after ~2 min with a readable
error and a Retry button, and long tasks stay recoverable if the model stops sending data.

## Descargas / Downloads

| Archivo / File | Descripción / Description |
|---|---|
| `SAGITARI-Setup-3.0.1.exe` | **Instalador / Installer** (NSIS): accesos directos, desinstalador / shortcuts, uninstaller |
| `SAGITARI-Portable-3.0.1.exe` | **Portable**: un solo ejecutable, sin instalación / single executable, no install |
| `Source code (zip/tar.gz)` | Código fuente / Source code |

> Binario sin firmar: Windows SmartScreen puede avisar en la primera ejecución (*Más información → Ejecutar de todas formas*). La app te dice si la actualización que descarga está firmada o no. / Unsigned binary: SmartScreen may warn on first run (*More info → Run anyway*). The app tells you whether the update it downloads is signed.

# SAGITARI 3.0.0

**Glow del marco corregido:** el aura vuelve a renderizarse de forma consistente, con un halo suave, visible y sin bloquear la interacción de la ventana. También se corrige la muestra de color del glow en Ajustes. / **Frame glow fixed:** the aura now renders consistently with a soft, visible halo without blocking window interaction. The glow color preview in Settings is fixed too.

**Seguridad y fiabilidad / Security and reliability:** se cierran dos vías que podían costar
caro (el borrado del directorio de datos desde una skill y la instalación de una actualización
sin verificar) y se corrigen los fallos que hacían perder trabajo: la pausa que no guardaba el
punto de control, el coste por modelo que siempre marcaba cero, las confirmaciones que se
quedaban colgadas y el navegador que quedaba inservible tras un cierre brusco. / **Security and
reliability:** two potentially expensive holes are closed (wiping the data directory from a
skill, and installing an unverified update) and the bugs that lost work are fixed: pause not
saving its checkpoint, per-model cost always reading zero, confirmations hanging and the
browser becoming unusable after a hard exit.

## Descargas / Downloads

| Archivo / File | Descripción / Description |
|---|---|
| `SAGITARI-Setup-3.0.0.exe` | **Instalador / Installer** (NSIS): accesos directos, desinstalador / shortcuts, uninstaller |
| `SAGITARI-Portable-3.0.0.exe` | **Portable**: un solo ejecutable, sin instalación / single executable, no install |
| `Source code (zip/tar.gz)` | Código fuente / Source code |

> Binario sin firmar: Windows SmartScreen puede avisar en la primera ejecución (*Más información → Ejecutar de todas formas*). La app te dice si la actualización que descarga está firmada o no. / Unsigned binary: SmartScreen may warn on first run (*More info → Run anyway*). The app tells you whether the update it downloads is signed.

## Seguridad / Security

- **Los ids de skill se validan resolviendo la ruta.** `deleteSkill('..')` podía resolver a la
  carpeta de datos y borrarla entera: configuración, claves de API y conversaciones incluidas. /
  **Skill ids are validated by resolving the path.** `deleteSkill('..')` could resolve to the
  data folder and wipe it whole: settings, API keys and conversations included.
- **`open_url` solo abre `http(s)`.** En Windows `shell.openExternal` invoca el manejador del
  sistema, así que `file://`, `ms-msdt:` o `javascript:` abrían cualquier cosa sin que lo vieras. /
  **`open_url` only opens `http(s)`.** On Windows `shell.openExternal` invokes the OS handler, so
  `file://`, `ms-msdt:` or `javascript:` could open anything without you seeing it.
- **Leer el portapapeles, ejecutar JS en la página y cambiar de perfil de navegador piden
  confirmación** aunque su herramienta esté configurada como automática. / **Reading the
  clipboard, running JS in the page and switching browser profiles always ask first**, even if
  their tool is set to run automatically.
- **Un subagente no puede usar herramientas fuera de su lista**, y una herramienta inventada por
  el modelo ya no llega a pedirte permiso. / **A subagent cannot use tools outside its list**,
  and a made-up tool no longer reaches you as a permission request.
- **Los triggers de una skill importada se tratan como texto, no como expresión regular**: un
  patrón remoto podía congelar la app en cada mensaje. / **Triggers from an imported skill are
  plain text, not a regular expression**: a remote pattern could freeze the app on every message.
- **El actualizador descarta cualquier descarga sin firma SHA-512 publicada** y vuelve a
  comprobar el hash justo antes de ejecutar el instalador. Además te dice si el binario tiene
  firma digital y quién lo firma. / **The updater discards any download without a published
  SHA-512** and re-checks the hash right before running the installer. It also tells you whether
  the binary is digitally signed and by whom.
- **Las claves de API se guardan cifradas** con el almacén del sistema (DPAPI en Windows). Un
  `config.json` copiado o sincronizado ya no expone tus credenciales. / **API keys are stored
  encrypted** with the system keychain (DPAPI on Windows). A copied or synced `config.json` no
  longer exposes your credentials.

## Correcciones / Fixes

- **Si el proveedor deja de enviar datos, el turno se corta solo y te lo dice.** Antes, un modelo
  que aceptaba la conexión y no mandaba nada dejaba el chat «ocupado» para siempre: lo que
  escribías después se ignoraba con «SAGITARI está ocupado» y había que adivinar que tocaba
  pulsar Detener. Ahora hay un límite de silencio configurable (Ajustes › Seguridad › «Sin
  respuesta del modelo») y, si una tarea larga atraviesa un hueco sin datos, el guardarraíl la
  detiene y queda recuperable en Tareas. / **If the provider stops sending data, the turn cuts
  itself off and tells you.** A model that accepted the connection and then went silent used to
  leave the chat "busy" forever: anything you typed next was ignored with "SAGITARI está ocupado"
  and you had to guess that Stop was the way out. There is now a configurable silence limit
  (Settings › Security › "No answer from the model"), and a long task crossing a data gap is
  stopped by the guardrail and stays recoverable in Tasks.
- **El router ya no cambia tu modelo elegido por otro en silencio.** La cadena de fallback
  reelegía modelo por categoría en cada turno: con p. ej. mimo-v2.5 seleccionado, una petición
  «simple» viajaba a deepseek-flash (coincidía con el patrón de modelos rápidos) y los fallos de
  ese modelo parecían «este modelo no funciona». Ahora el modelo elegido en Ajustes manda y el
  router solo rellena cuando no hay elección explícita. / **The router no longer swaps your
  chosen model silently.** The fallback chain re-picked a model per task category on every turn:
  with e.g. mimo-v2.5 selected, a "simple" request went to deepseek-flash (it matched the
  fast-model pattern) and that model's failures looked like "this model doesn't work". The model
  chosen in Settings now wins; the router only fills in when there is no explicit choice.
- **La firma digital del binario se informa aunque abras la app desde PowerShell 7.** Windows
  PowerShell 5.1 heredaba de ahí su lista de módulos, dejaba de encontrar
  `Get-AuthenticodeSignature` y la firma se informaba como «no se pudo consultar», justo el dato
  que te dice si lo que vas a instalar está firmado. / **The binary's digital signature is
  reported even if you open the app from PowerShell 7.** Windows PowerShell 5.1 inherited that
  process's module list, could no longer find `Get-AuthenticodeSignature` and reported the
  signature as "couldn't check" — the very fact that tells you whether what you are about to
  install is signed.
- **Pausar durante la respuesta guarda el punto de control.** Antes la tarea quedaba marcada como
  interrumpida y se perdía la reanudación. / **Pausing mid-answer saves the checkpoint.** The task
  used to be marked as interrupted and resumption was lost.
- **El panel de salud por modelo muestra el coste real**, que siempre aparecía como 0,0000. / **The
  per-model health panel shows the real cost**, which always read 0.0000.
- **Esperar tu decisión en una tarjeta de confirmación ya no agota el límite de duración**, y las
  confirmaciones de varias tareas en segundo plano se atienden en cola en vez de pisarse. / **Waiting
  for your answer on a confirmation card no longer eats the duration limit**, and confirmations
  from several background tasks queue up instead of overwriting each other.
- **Una confirmación ya no puede quedarse colgada** al repintarse la vista: la promesa se resuelve
  siempre. / **A confirmation can no longer hang** when the view is repainted: the promise always
  resolves.
- **Los argumentos ilegibles de una herramienta devuelven un error** en vez de ejecutarla con
  valores vacíos. / **Unreadable tool arguments return an error** instead of running the tool with
  empty values.
- **El navegador se recupera tras un cierre brusco de la app** (lee el puerto que dejó Chrome en
  el perfil) y ya no puede matar por error un proceso ajeno al cambiar de perfil. / **The browser
  recovers after a hard exit** (it reads the port Chrome left in the profile) and can no longer
  kill an unrelated process by mistake when switching profiles.
- **El botón Detener cancela también los procesos** de abrir aplicaciones, gestión de ventanas y
  multimedia, no solo los comandos de terminal. / **The Stop button also cancels** app-launching,
  window-management and media processes, not just terminal commands.
- **La carpeta de logs respeta sus topes**: dos fallos en la rotación (nombres repetidos y poda
  prematura) dejaban ficheros creciendo sin control. / **The logs folder respects its limits**: two
  rotation bugs (repeated names and premature pruning) let files grow unbounded.
- **Los puntos de estado vuelven a verse** (tareas falladas y salud del modelo), la búsqueda de
  Ajustes cuenta solo el panel visible, el plan no reinicia su progreso al repintarse y un fallo
  interno muestra un aviso en vez de una burbuja roja en el chat. / **Status dots are visible
  again** (failed tasks and model health), settings search only counts the visible panel, the plan
  no longer resets its progress when repainted, and an internal failure shows a notice instead of
  a red bubble in the chat.

## Actualizaciones / Updates

El actualizador integrado comprueba si hay versión nueva, avisa sin interrumpir, verifica la
descarga con **SHA-512** y, desde esta versión, **rechaza el archivo si la release no publica esa
firma** en lugar de instalarlo sin comprobar nada. También informa del estado de la firma digital
del binario y solo instala cuando tú lo pides. / The in-app updater checks for a new version,
notifies discreetly, verifies the download with **SHA-512** and, from this version on, **rejects
the file if the release does not publish that signature** instead of installing it unchecked. It
also reports the binary's digital signature status and installs only when you ask it to.

## Verificación / Verification

- `npm test`: **163 tests en verde** / **163 tests passing**, con regresiones para cada corrección de esta versión. / with regressions for every fix in this release.
- `npm run smoke`: la app arranca de verdad / the app really starts.
- `npm run uicheck`: 28 comprobaciones sobre la interfaz viva (iconos, cableado, navegación, modo,
  tamaño mínimo) — y ahora corre en la CI antes de publicar. / 28 checks against the live UI
  (icons, wiring, navigation, mode, minimum size) — and it now runs in CI before publishing.
- `node --check` de todos los módulos, y el tag de la release debe coincidir con la versión de
  `package.json` o el workflow aborta. / `node --check` on every module, and the release tag must
  match the `package.json` version or the workflow aborts.
- SHA-256 de los ejecutables calculado automáticamente por el workflow de CI al publicar. /
  Executable SHA-256 hashes computed automatically by the CI workflow when publishing.

## Requisitos / Requirements

- Windows 10/11 · Proveedor de IA compatible (OpenCode Go, OpenRouter, Groq, OpenAI,
  Anthropic, Ollama local, LM Studio…) · Node.js 20+ solo para compilar desde fuente. /
  Windows 10/11 · Compatible AI provider (OpenCode Go, OpenRouter, Groq, OpenAI, Anthropic,
  local Ollama, LM Studio…) · Node.js 20+ only to build from source.
