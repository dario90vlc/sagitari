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
