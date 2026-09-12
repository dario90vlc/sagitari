# SAGITARI 2.2.0

Actualización de **calidad**: cierra los fallos que rompían la ejecución de tareas, añade
edición de archivos anclada, endurece el guardado de datos y pule la interfaz (estado real
en todo momento, accesibilidad y teclado).

Quality update: **fixes the failures that broke task execution**, adds anchored file editing,
hardens data persistence and polishes the interface (true state at all times, accessibility
and keyboard).

## Descargas / Downloads

| Archivo / File | Descripción / Description |
|---|---|
| `SAGITARI-Setup-2.2.0.exe` | **Instalador / Installer** (NSIS): accesos directos, desinstalador / shortcuts, uninstaller |
| `SAGITARI-Portable-2.2.0.exe` | **Portable**: un solo ejecutable, sin instalación / single executable, no install |
| `Source code (zip/tar.gz)` | Código fuente / Source code |

> Binario sin firmar: Windows SmartScreen puede avisar en la primera ejecución (*Más información → Ejecutar de todas formas*). / Unsigned binary: SmartScreen may warn on first run (*More info → Run anyway*).

## Correcciones críticas / Critical fixes

- **Denegar una acción ya no rompe la ejecución.** El camino de denegación de los permisos
  lanzaba un `ReferenceError` y abortaba el turno; ahora el modelo recibe la negativa y
  continúa por otra vía. / **Denying an action no longer breaks the run.** The permission
  deny path threw a `ReferenceError` and aborted the turn; the model now gets the denial and
  continues another way.
- **El dictado por voz arranca.** `voice.ps1` no aceptaba el parámetro que le enviaba la app,
  PowerShell abortaba el script y la app decía «ok»: el micrófono nunca se activaba. /
  **Voice dictation starts.** `voice.ps1` did not accept the parameter the app passed,
  PowerShell aborted the script and the app reported «ok»: the microphone never opened.
- **Cerrar el navegador ya no tumba la app.** El websocket de DevTools no tenía listener de
  error tras el handshake y una desconexión lanzaba una excepción no capturada en el proceso
  principal. / **Closing the browser no longer crashes the app.** The DevTools websocket had
  no error listener after the handshake and a disconnect threw an uncaught exception in the
  main process.
- **La memoria no se borra sola.** Un fallo de lectura (un simple EBUSY de Windows) se
  interpretaba como «no hay memoria» y el guardado siguiente la sobrescribía vacía: adiós a
  los recuerdos. Ahora se distinguen los casos, el archivo ilegible se pone en cuarentena y
  no se pisa. / **Memory can no longer wipe itself.** A read failure (a plain Windows EBUSY)
  was treated as «no memory» and the next save overwrote it with an empty store.
- **Cancelar una tarea se respeta.** El agente conservaba su copia del estado y la resucitaba
  como «en ejecución», así que al día siguiente se re-ejecutaba el trabajo ya hecho. /
  **Cancelling a task sticks.** The agent kept its own copy of the state and revived it as
  running, so on the next launch the work was re-executed.
- **Cerrar un archivo o conversación a mitad no deja basura corrupta.** Configuración,
  conversaciones, memoria, hábitos y checkpoints se escriben de forma atómica (`.tmp` +
  renombrado, con `.bak`). / **Interrupted writes no longer corrupt data.** Config,
  conversations, memory, habits and checkpoints are written atomically.

## Agente / Agent

- **`edit_file`: edición anclada.** Cambia un fragmento exacto en vez de reescribir el
  archivo entero, con aviso si el fragmento es ambiguo. / **`edit_file`: anchored editing.**
- **`read_file` por rangos** (`offset`/`limit`) con cabecera `[líneas A-B de N]` y rechazo de
  archivos enormes. / **`read_file` ranges** (`offset`/`limit`).
- **Presupuesto real en subagentes:** tokens, coste y número de llamadas se aplican y se
  suman al presupuesto global; antes una delegación podía multiplicar el gasto sin tope. /
  **Real subagent budgets**, charged to the global limit.
- **Historial siempre válido:** se descartan los pares `tool_call`/respuesta incompletos, que
  rompían la conversación con un error del proveedor. / **History always valid.**
- **Detener mata el árbol de procesos** (antes quedaban nietos huérfanos) y los acentos de
  `cmd.exe` ya no llegan corruptos al modelo. / **Stop kills the process tree**; `cmd.exe`
  accents are decoded correctly.

## Seguridad / Security

- Escrituras de configuración atómicas y errores de guardado **visibles** (antes todo
  confirmaba en falso). / Atomic config writes and **visible** save failures.
- `attachments:read` no puede leer el directorio de datos (donde viven las API keys). /
  `attachments:read` can no longer read the app data directory.
- Ventana con `sandbox`, navegación externa bloqueada y apertura de enlaces validada. /
  Window with `sandbox`, blocked external navigation, validated link opening.
- Sin inyección de shell en `open_app` ni en el lanzamiento del navegador (`spawn` sin shell).
  / No shell injection in `open_app` or browser launch.

## Interfaz / Interface

- **El compositor del chat ya no se sale de la ventana** al reducirla a su tamaño mínimo. /
  **The chat composer no longer falls off-screen** at the minimum window size.
- **Detener conserva la respuesta a medias** y cierra las tarjetas de herramienta que
  quedaban girando para siempre. / **Stop keeps the partial answer** and closes tool cards
  that used to spin forever.
- Un segundo Enter ya no deja el agente trabajando sin botón de Detener. / A second Enter no
  longer leaves the agent running with no Stop button.
- Botones «ir al final», píldora de estado y tira de adjuntos **se ocultan de verdad**. /
  Jump-to-bottom button, status pill and attachment strip **actually hide**.
- Los indicadores de actividad **pulsan** (faltaba el `@keyframes`), el contraste cumple AA y
  se respeta `prefers-reduced-motion`. / Activity indicators **pulse**; AA contrast;
  `prefers-reduced-motion` respected.
- **Ajustes dice la verdad**: al abrir muestra lo guardado (antes el modo desarrollador se
  perdía en cada arranque), el buscador encuentra Apariencia, y guardar/activar un proveedor
  inválido muestra el error en vez de «guardado». / **Settings tells the truth.**
- **Acciones destructivas con confirmación** (conversación, memoria, skill, tarea, hábitos,
  proveedor) y respondibles con teclado. / **Destructive actions require confirmation**.
- Atajos: `Alt+0` ya no deja la app en blanco y `Alt+1…9` / `Alt+M` no se disparan mientras
  escribes. / Shortcuts fixed.
- Historial y Tareas operables con teclado; foco visible; estado del chat anunciado a
  lectores de pantalla. / Keyboard-operable lists, visible focus, announced chat state.

## Verificación / Verification

- **122 tests en verde** (`npm test`) y **25 comprobaciones sobre la app real**
  (`npm run uicheck`), incluidas regresiones del tamaño mínimo de ventana, del atributo
  `hidden`, de los atajos y de los indicadores de actividad. / **122 unit tests green** and
  **25 real-app UI checks**, including regressions for minimum window size, `hidden`,
  shortcuts and activity indicators.
- SHA-256 de los ejecutables calculado automáticamente por el workflow de CI al publicar. /
  Executable SHA-256 hashes computed automatically by the CI workflow on release.

## Requisitos / Requirements

- Windows 10/11 · Proveedor de IA compatible (OpenCode Go, OpenRouter, Groq, OpenAI,
  Anthropic, Ollama local, LM Studio…) · Node.js 18+ solo para compilar desde fuente.
