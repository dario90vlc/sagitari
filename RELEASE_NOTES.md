# SAGITARI 2.2.1

Actualización breve: **la app ya se actualiza sola, con tu permiso**. Además, la página de
release ahora se publica con sus notas y sus hashes, sin editarla a mano.

Short update: **the app now updates itself, with your permission**. The release page is also
published with its notes and hashes, no more manual editing.

## Descargas / Downloads

| Archivo / File | Descripción / Description |
|---|---|
| `SAGITARI-Setup-2.2.1.exe` | **Instalador / Installer** (NSIS): accesos directos, desinstalador / shortcuts, uninstaller |
| `SAGITARI-Portable-2.2.1.exe` | **Portable**: un solo ejecutable, sin instalación / single executable, no install |
| `Source code (zip/tar.gz)` | Código fuente / Source code |

> Binario sin firmar: Windows SmartScreen puede avisar en la primera ejecución (*Más información → Ejecutar de todas formas*). / Unsigned binary: SmartScreen may warn on first run (*More info → Run anyway*).

## Novedades / What's new

**Actualizador dentro de la app / In-app updater**

- **Aviso discreto:** SAGITARI comprueba al arrancar si hay una versión nueva y, si la hay,
  muestra **un solo aviso** y un punto en *Ajustes*. Nada de ventanas que interrumpan y nada
  se descarga por su cuenta. / **Discreet notice:** a single toast and a dot on *Settings*.
- **Tú decides:** en *Ajustes → Acerca de* están tu versión instalada, el botón para buscar
  actualizaciones, la descarga con su progreso y el botón de instalar. / **Your call:**
  *Settings → About* holds your version, the check, the download progress and the install button.
- **Verificado antes de ejecutarse:** el instalador descargado se comprueba contra el
  **sha512** que publica el CI; si no coincide, se descarta. / **Checked before running:**
  the download is verified against the SHA-512 published by CI.
- **Según cómo la tengas / Depending on how you run it:**
  - *Instalada* → descarga el Setup, lo lanza en silencio y cierra la app para instalarse. /
    *Installed* → downloads the Setup, runs it silently and closes the app to install.
  - *Portable* → deja el nuevo portable **junto al que estás usando** y abre la carpeta (un
    portable no puede reemplazarse a sí mismo mientras corre). / *Portable* → puts the new one
    next to the current file and opens the folder.
  - *Desde el código fuente* → te avisa de que para actualizarte hay que compilar o usar el
    instalador. / *From source* → tells you to build or use the installer.

## Notas / Notes

- **Quien tenga la 2.2.0 tiene que actualizar a mano una última vez**, porque el actualizador
  llega justo en esta versión. A partir de aquí, los avisos ya llegan solos. / **Anyone on
  2.2.0 must update manually one last time**, since the updater ships in this version. From
  here on the notices arrive on their own.
- La página de cada release se genera ahora desde estas notas con el bloque **SHA-256** de los
  ejecutables, así que ya no hay que escribirla ni pegar hashes. / Each release page is now
  generated from these notes with the executables' **SHA-256** block.

## Verificación / Verification

- **129 tests en verde** (`npm test`) y **25 comprobaciones sobre la app real**
  (`npm run uicheck`), incluidas las del actualizador: comparación de versiones, elección del
  binario correcto, descarga con progreso y descarte de un archivo que no supera la
  verificación. / **129 unit tests green** and **25 real-app UI checks**, including the
  updater's own: version comparison, correct binary selection, download progress and
  discarding a file that fails verification.
- SHA-256 de los ejecutables calculado automáticamente por el workflow de CI al publicar. /
  Executable SHA-256 hashes computed automatically by the CI workflow on release.

## Requisitos / Requirements

- Windows 10/11 · Proveedor de IA compatible (OpenCode Go, OpenRouter, Groq, OpenAI,
  Anthropic, Ollama local, LM Studio…) · Node.js 18+ solo para compilar desde fuente.
