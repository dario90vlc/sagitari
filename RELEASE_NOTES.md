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

- `npm test`: **129 tests en verde** / **129 tests passing**.
- `node --check main/main.js`: sintaxis correcta / syntax valid.
- Instalador NSIS y portable compilados desde el mismo código fuente; los tamaños pequeños del
  `.ico` verificados pixel a pixel contra el icono anterior (idénticos). / NSIS installer and
  portable built from the same source; the `.ico` small sizes verified pixel by pixel against
  the previous icon (identical).
- SHA-256 de los ejecutables calculado automáticamente por el workflow de CI al publicar. /
  Executable SHA-256 hashes computed automatically by the CI workflow when publishing.

## Requisitos / Requirements

- Windows 10/11 · Proveedor de IA compatible (OpenCode Go, OpenRouter, Groq, OpenAI,
  Anthropic, Ollama local, LM Studio…) · Node.js 18+ solo para compilar desde fuente.
