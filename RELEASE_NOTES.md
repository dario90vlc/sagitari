# SAGITARI 1.0.0 — primera versión pública

Asistente agéntico de IA para Windows con control total del PC: chat, voz, navegador y automatización real del sistema.

## Descargas

| Archivo | Descripción |
|---|---|
| `SAGITARI-Setup-1.0.0.exe` | **Instalador** (NSIS): instalación con accesos directos y desinstalador |
| `SAGITARI-Portable-1.0.0.exe` | **Portable**: un solo ejecutable, sin instalación |
| `Source code (zip / tar.gz)` | Código fuente |

> Windows SmartScreen puede avisar en la primera ejecución (binario sin firmar): *Más información → Ejecutar de todas formas*.

## Novedades

- **Multi-proveedor**: OpenRouter, Ollama (local, sin API key), Groq, OpenAI, LM Studio, OpenCode Go o endpoint personalizado — detección automática de modelos.
- **Control total del PC**: terminal, archivos, apps, portapapeles, notificaciones, capturas que el modelo "ve", multimedia y ventanas.
- **Navegador real**: Chrome/Edge vía DevTools Protocol (navegar, clic, escribir, leer, capturar).
- **Skills estilo SKILL.md**: motor con índice compacto en prompt + importación desde cualquier repo de GitHub (ej. `anthropics/skills`), activación por `/` en el chat.
- **Espacio de trabajo** configurable: rutas relativas y comandos resuelven en tu carpeta de trabajo.
- **Glow interno de energía** (violeta ↔ turquesa) que reacciona al pensar, trabajar y hablar.
- **Historial de conversaciones**, memoria persistente y modos Think / Plan / Act.
- **Chat + voz**: dictado offline de Windows y respuestas TTS.

## Verificación (SHA-256)

```
2129b13d6d39d1841d0d602e577f0e493423d1a620b4078cd2217eac569dfa04  SAGITARI-Setup-1.0.0.exe
1f6b6326068d9e76c1268246f33ff2d0d85f06e0e1eaf4f36fbf449804a0b867  SAGITARI-Portable-1.0.0.exe
```

## Requisitos

- Windows 10/11 (x64)
- Para dictado por voz: paquete de voz español instalado en Windows (opcional)
