# SAGITARI 2.2.2

**Minor fixes / Correcciones menores:** el icono de SAGITARI ya se ve correctamente en la barra
de tareas de Windows. / **Minor fixes:** SAGITARI's icon now shows correctly in the Windows
taskbar.

## Descargas / Downloads

| Archivo / File | Descripción / Description |
|---|---|
| `SAGITARI-Setup-2.2.2.exe` | **Instalador / Installer** (NSIS): accesos directos, desinstalador / shortcuts, uninstaller |
| `SAGITARI-Portable-2.2.2.exe` | **Portable**: un solo ejecutable, sin instalación / single executable, no install |
| `Source code (zip/tar.gz)` | Código fuente / Source code |

> Binario sin firmar: Windows SmartScreen puede avisar en la primera ejecución (*Más información → Ejecutar de todas formas*). / Unsigned binary: SmartScreen may warn on first run (*More info → Run anyway*).

## Correcciones / Fixes

- **Icono de la barra de tareas.** SAGITARI identifica su ventana con el mismo *AppUserModelID*
  (`com.sagitari.app`) que usa el instalador, desde el arranque y también al ejecutar desde el
  código fuente. Antes, en desarrollo, Windows tomaba el proceso por `electron.exe` y mostraba
  el logo de Electron en lugar del de la app. / **Taskbar icon.** SAGITARI now identifies its
  window with the same *AppUserModelID* (`com.sagitari.app`) used by the installer, from
  startup and also when running from source. Previously, in development, Windows took the
  process for `electron.exe` and showed Electron's logo instead of the app's.
- **Tamaños pequeños del icono en formato clásico.** Los tamaños 64, 48, 32 y 16 px vuelven a
  guardarse como BMP dentro del `.ico` en vez de PNG comprimido. El shell de Windows no pinta
  las entradas PNG por debajo de 256 px, así que la barra de tareas y el explorador caían al
  icono genérico. El dibujo es idéntico, pixel a pixel; solo cambia el formato de esas
  entradas. / **Small icon sizes in classic format.** The 64, 48, 32 and 16 px sizes are stored
  as BMP inside the `.ico` again instead of compressed PNG. The Windows shell does not render
  PNG entries below 256 px, so the taskbar and Explorer fell back to a generic icon. The
  artwork is identical, pixel for pixel; only the storage format of those entries changed.

Ambas correcciones vienen incluidas en el instalador, en el portable y al arrancar desde el
código fuente. / Both fixes are included in the installer, the portable build and when running
from source.

## Actualizaciones / Updates

El actualizador integrado sigue disponible: comprueba si hay una versión nueva, avisa sin
interrumpir, verifica la descarga con **SHA-512** y solo instala cuando tú lo pides. Si tienes
la 2.2.0 o la 2.2.1, esta versión te llega con el aviso habitual. / The in-app updater is still
there: it checks for a new version, notifies discreetly, verifies the download with
**SHA-512** and installs only when you ask it to. If you are on 2.2.0 or 2.2.1, this version
reaches you through the usual notice.

## Verificación / Verification

- `npm test`: **145 tests en verde** / **145 tests passing**.
- `node --check main/main.js`: sintaxis correcta / syntax valid.
- Instalador NSIS y portable compilados desde el mismo código fuente; los tamaños pequeños del
  `.ico` verificados pixel a pixel contra el icono anterior (idénticos). / NSIS installer and
  portable built from the same source; the `.ico` small sizes verified pixel by pixel against
  the previous icon (identical).
- SHA-256 de los ejecutables calculado automáticamente por el workflow de CI al publicar. /
  Executable SHA-256 hashes computed automatically by the CI workflow when publishing.

## Correcciones posteriores a 2.2.2 / Post-2.2.2 fixes

> Todavía **no** incluidas en ningún binario publicado: están en el código fuente y entrarán en
> la próxima versión. / **Not** yet part of any published binary: they live in the source tree
> and will ship with the next version.

**Seguridad / Security**

- Los ids de skill se validan resolviendo la ruta: `deleteSkill('..')` podía borrar todo el
  directorio de datos (claves de API y conversaciones incluidas). / Skill ids are validated by
  resolving the path: `deleteSkill('..')` could wipe the whole data directory (API keys and
  conversations included).
- `open_url` solo abre `http(s)`: en Windows `shell.openExternal` invoca el manejador del
  sistema, así que `file://` o `ms-msdt:` abrían cualquier cosa sin confirmación. / `open_url`
  only opens `http(s)`: on Windows `shell.openExternal` invokes the OS handler, so `file://` or
  `ms-msdt:` would open anything without asking.
- Leer el portapapeles y ejecutar JS en la página piden confirmación siempre, y un subagente ya
  no puede usar herramientas fuera de su lista. / Reading the clipboard and running JS in the
  page always ask first, and a subagent can no longer use tools outside its list.
- Los triggers de una skill importada se tratan como texto, no como expresión regular (un
  patrón remoto podía congelar la app). / Triggers from an imported skill are treated as plain
  text, not as a regular expression (a remote pattern could freeze the app).
- El actualizador **descarta** cualquier descarga sin firma SHA-512 publicada y vuelve a
  comprobar el hash justo antes de ejecutar el instalador. / The updater **discards** any
  download without a published SHA-512 and re-checks the hash right before running the
  installer.

**Corrección / Correctness**

- Pausar durante el stream guarda el punto de control (antes la tarea quedaba interrumpida y se
  perdía la reanudación). / Pausing mid-stream saves the checkpoint (previously the task was
  marked interrupted and resumption was lost).
- El panel de salud por modelo muestra el coste real (publicaba siempre 0,0000). / The per-model
  health panel shows the real cost (it always published 0.0000).
- Esperar tu decisión en una tarjeta de confirmación ya no agota el límite de duración. /
  Waiting for your answer on a confirmation card no longer eats the duration limit.
- Argumentos JSON inválidos devuelven un error en vez de ejecutar la herramienta con `{}`. /
  Invalid JSON arguments return an error instead of running the tool with `{}`.
- El navegador se recupera tras un cierre brusco de SAGITARI (lee el puerto que dejó Chrome en
  el perfil) y una descarga atascada se corta sola. / The browser recovers after a hard exit
  (it reads the port Chrome left in the profile) and a stalled download now times out.

**Interfaz / Interface**

- Las confirmaciones ya no se quedan colgadas ni se pisan entre tareas en background. /
  Confirmations no longer hang or overwrite each other across background tasks.
- Los puntos de estado (tareas falladas, salud del modelo) vuelven a verse: faltaba su regla
  CSS. / Status dots (failed tasks, model health) are visible again: their CSS rule was missing.
- La búsqueda de Ajustes cuenta solo el panel visible, el plan no reinicia su progreso al
  repintarse y un fallo de IPC muestra un aviso en vez de una burbuja roja. / Settings search
  only counts the visible panel, the plan no longer resets its progress when repainted, and an
  IPC failure shows a notice instead of a red bubble.

## Requisitos / Requirements

- Windows 10/11 · Proveedor de IA compatible (OpenCode Go, OpenRouter, Groq, OpenAI,
  Anthropic, Ollama local, LM Studio…) · Node.js 20+ solo para compilar desde fuente.
