# SAGITARI 1.0.0 — primera versión pública / first public release

Asistente agéntico de IA para Windows con control total del PC: chat, voz, navegador y automatización real del sistema.
Agentic AI assistant for Windows with full PC control: chat, voice, browser and real system automation.

## Descargas / Downloads

| Archivo / File | Descripción / Description |
|---|---|
| `SAGITARI-Setup-1.0.0.exe` | **Instalador / Installer** (NSIS): accesos directos y desinstalador / shortcuts and uninstaller |
| `SAGITARI-Portable-1.0.0.exe` | **Portable**: un solo ejecutable / single executable, no install |
| `Source code (zip / tar.gz)` | Código fuente / Source code |

> Windows SmartScreen puede avisar en la primera ejecución (binario sin firmar) / may warn on first run (unsigned binary): *Más información → Ejecutar de todas formas / More info → Run anyway*.

## Novedades / What's new

- **Multi-proveedor / Multi-provider:** OpenRouter, Ollama (local, sin API key / no API key), Groq, OpenAI, LM Studio, OpenCode Go o endpoint personalizado / or custom endpoint — detección automática de modelos / automatic model detection.
- **Control total del PC / Full PC control:** terminal, archivos, apps, portapapeles, notificaciones, capturas que el modelo "ve" / screenshots the model "sees", multimedia y ventanas / media and windows.
- **Navegador real / Real browser:** Chrome/Edge vía DevTools Protocol (navegar, clic, escribir, leer, capturar / navigate, click, type, read, capture).
- **Skills estilo SKILL.md:** índice compacto en el prompt + importación desde cualquier repo de GitHub (ej. `anthropics/skills`), activación por `/` en el chat / compact prompt index + import from any GitHub repo, activation via `/` in chat.
- **Espacio de trabajo / Workspace** configurable: rutas relativas y comandos resuelven en tu carpeta de trabajo / relative paths and commands resolve in your working folder.
- **Glow interno de energía / Inner energy glow** (violeta ↔ turquesa / violet ↔ turquoise) que reacciona al pensar, trabajar y hablar / reacting to thinking, working and speaking.
- **Historial de conversaciones** / **Conversation history**, memoria persistente / persistent memory y modos Think / Plan / Act.
- **Chat + voz / Chat + voice:** dictado (motores de voz de Windows) y respuestas TTS / dictation (Windows speech engines) and TTS replies.

## Verificación / Verify (SHA-256)

```
2129b13d6d39d1841d0d602e577f0e493423d1a620b4078cd2217eac569dfa04  SAGITARI-Setup-1.0.0.exe
1f6b6326068d9e76c1268246f33ff2d0d85f06e0e1eaf4f36fbf449804a0b867  SAGITARI-Portable-1.0.0.exe
```

## Requisitos / Requirements

- Windows 10/11 (x64)
- Para dictado por voz: reconocimiento de voz en línea activado en Windows y buen micrófono predeterminado (opcional)
- For voice dictation: online speech recognition enabled in Windows and a good default microphone (optional)
