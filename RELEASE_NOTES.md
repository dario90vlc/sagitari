# SAGITARI 1.0.1 / v1.0.1

Segunda versión pública: el navegador del agente se reescribe por completo, el dictado por voz funciona de verdad y se elimina el límite de pasos.
Second public release: the agent's browser engine is fully rebuilt, voice dictation actually works, and the step limit is gone.

## Descargas / Downloads

| Archivo / File | Descripción / Description |
|---|---|
| `SAGITARI-Setup-1.0.1.exe` | **Instalador / Installer** (NSIS): accesos directos y desinstalador / shortcuts and uninstaller |
| `SAGITARI-Portable-1.0.1.exe` | **Portable**: un solo ejecutable, sin instalación / single executable, no install |
| `Source code (zip / tar.gz)` | Código fuente / Source code |

> Windows SmartScreen puede avisar en la primera ejecución (binario sin firmar) / may warn on first run (unsigned binary): *Más información → Ejecutar de todas formas / More info → Run anyway*.

## Novedades / What's new

### 🌐 Navegador reescrito / Browser engine rebuilt
- **Una sola ventana, cero duplicados / One window, zero duplicates:** `launch` reutiliza la sesión activa o reconecta a una instancia viva; solo abre un navegador nuevo si no existe ninguno / `launch` reuses the live session or reconnects; a new browser only spawns when none exists.
- **Gestión real de pestañas / Real tab management:** `tabs`, `new_tab`, `select_tab` (por número o texto), `close_tab`, con pestaña activa que puede inspeccionarse con `screenshot` o `content` / with an active tab you can inspect via `screenshot` or `content`.
- **Interacción precisa / Precise interaction:** clic por texto visible con coincidencia exacta → prefijo → contiene / click by visible text (exact → prefix → contains); `type` limpia el campo y puede enviar con Enter / clears the field and can submit with Enter; `navigate` espera a que la página cargue / waits for page load; nueva acción `wait` / new `wait` action; capturas de página completa / full-page screenshots.
- **Perfil persistente / Persistent profile:** los inicios de sesión sobreviven al reinicio (perfil dedicado en `%APPDATA%\SagitariAI\browser-profile`) / logins survive restarts.

### 🎙️ Dictado funcional / Working voice dictation
- Motor moderno de Windows (WinRT) con detección de privacidad y respaldo clásico / modern Windows engine (WinRT) with privacy detection and classic fallback.
- UTF-8 forzado: los acentos ya no se corrompen / forced UTF-8: accents no longer corrupt.
- Tiempos ajustados: no corta el inicio de las frases; los fragmentos se acumulan, nunca se autoenvían / tuned timeouts: sentence starts are never cut; segments accumulate, never auto-send.
- Avisos útiles: si el motor clásico está activo o el micrófono no recibe audio / helpful toasts: classic-engine notice and no-audio detection.

### ♾️ Sin límite de pasos / No more step limit
- El agente trabaja hasta completar la tarea o hasta que pulses Detener (que ahora mata también los comandos en ejecución) / the agent works until the task is done or you press Stop (which now also kills running tools).

### ⚡ Mejoras / Improvements
- **Selector de modo en el chat:** ACT / PLAN / THINK con un clic en el compositor + atajo `Alt+M` / one-click mode switcher in the chat composer + `Alt+M` shortcut.
- Skills: importación deduplicada desde GitHub y activación con `/` en el chat / deduplicated GitHub import and `/` activation in chat.
- Búsqueda de archivos endurecida: regex inválidas ya no rompen la herramienta; límite de 20.000 archivos por escaneo / hardened file search: invalid regexes no longer crash it; 20k-file scan cap.
- Sin chats fantasma en el historial / no more ghost "Nueva conversación" entries.
- Documentación bilingüe (README en español e inglés) / bilingual docs (Spanish & English READMEs).

## Verificación / Verify (SHA-256)

```
4fb8f9344410c951fdb7ad8878020c83c4abd3f5428657dd693b1def44432855  SAGITARI-Setup-1.0.1.exe
406d8f84b80bea5be0f49cae9ac2f502cee51107d5bd104f5d747274cb6596c1  SAGITARI-Portable-1.0.1.exe
```

## Requisitos / Requirements

- Windows 10/11 (x64)
- Para dictado por voz: micrófono configurado como predeterminado; para máxima precisión activa el reconocimiento de voz en línea (Configuración → Privacidad → Voz) / for dictation: a default microphone; for best accuracy enable online speech recognition (Settings → Privacy → Speech).
