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
