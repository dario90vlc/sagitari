# SAGITARI 1.1.0

Tercera versión pública: **seguridad del agente**. Permisos por herramienta con confirmación
visible, guardarraíles configurables con detección de bucles, tracking de tokens, logs
estructurados, tests y CI/CD automático.

Third public release: **agent safety**. Per-tool permissions with visible confirmation,
configurable guardrails with loop detection, token tracking, structured logs, tests and
automatic CI/CD.

## Descargas / Downloads

| Archivo / File | Descripción / Description |
|---|---|
| `SAGITARI-Setup-1.1.0.exe` | **Instalador / Installer** (NSIS): accesos directos, desinstalador / shortcuts, uninstaller |
| `SAGITARI-Portable-1.1.0.exe` | **Portable**: un solo ejecutable, sin instalación / single executable, no install |
| `Source code (zip/tar.gz)` | Código fuente / Source code |

> Binario sin firmar: Windows SmartScreen puede avisar en la primera ejecución (*Más información → Ejecutar de todas formas*). / Unsigned binary: SmartScreen may warn on first run (*More info → Run anyway*).

## Novedades / What's new

### Seguridad / Safety

- **Sistema de permisos / Permission system** — Cada herramienta tiene nivel de riesgo:
  *Seguro* (se ejecuta sola), *Confirmar* (tarjeta con la acción exacta y botones
  Permitir/Denegar) o *Bloqueado*. / Every tool has a risk level: *Safe* (auto-run),
  *Confirm* (a card shows the exact action with Allow/Deny) or *Blocked*. Terminal,
  escritura de archivos, navegador, abrir apps y gestión de ventanas piden confirmación por
  defecto / ask for confirmation by default.
- **Guardarraíles / Guardrails** — Límites configurables de pasos, llamadas a herramientas,
  duración y tokens (0 = sin límite). / Configurable limits for steps, tool calls, duration
  and tokens (0 = unlimited).
- **Detección de bucles / Loop detection** — Si el agente repite la misma acción sin avanzar,
  se detiene solo con un mensaje explicativo. / If the agent repeats the same action without
  progressing, it stops itself with an explanatory message.
- **Paro real / Real stop** — El botón Detener mata el comando en marcha, no solo el texto. / The Stop button kills the in-flight command, not just the text stream.

### Transparencia / Transparency

- **Modo desarrollador / Developer mode** — Métricas en vivo bajo el chat: modelo, tokens
  in/out, llamadas, latencia y límites activos. / Live metrics under the chat: model, tokens
  in/out, calls, latency and active limits.
- **Logs estructurados / Structured logs** — Cada sesión escribe un JSONL local en
  `%APPDATA%\SagitariAI\logs\` con cada herramienta, duración, éxito/error y tokens. / Each
  session writes a local JSONL under `%APPDATA%\SagitariAI\logs\` with every tool call,
  duration, success/error and tokens.

### Proyecto / Project

- **Tests unitarios / Unit tests** — `npm test`: 19 tests sobre permisos, límites, detección
  de bucles y parseo de skills. / 19 tests over permissions, limits, loop detection and
  skills parsing.
- **CI/CD en GitHub Actions** — Tests en cada push; al publicar un tag `v*` se compilan
  instalador y portable, se calculan los SHA-256 y se publica la release automáticamente. /
  Tests on every push; pushing a `v*` tag builds installer + portable, computes SHA-256 and
  publishes the release automatically.
- **Skills con metadatos / Skill metadata** — `version`, `author` y lista de herramientas
  autorizadas en el front-matter, visibles en la vista Skills. / `version`, `author` and an
  authorized-tools list in the front-matter, shown in the Skills view.

### También / Also

- Navegador reescrito: una sola ventana, gestión de pestañas, clic por texto visible, perfil
  persistente. / Browser engine rebuilt: one window, tab management, click by visible text,
  persistent profile.
- Dictado por voz funcional (motor WinRT de Windows + UTF-8). / Working voice dictation
  (Windows WinRT engine + UTF-8).
- Selector de modo ACT/PLAN/THINK dentro del chat (Alt+M). / ACT/PLAN/THINK mode switcher
  inside the chat (Alt+M).

## Verificación / Verification

Los hashes SHA-256 de ambos ejecutables están en el cuerpo de la release (calculados por el
workflow de CI). / SHA-256 hashes for both executables are in the release body (computed by
the CI workflow).

## Requisitos / Requirements

- Windows 10/11 · Proveedor de IA compatible con OpenAI (OpenRouter, Groq, OpenAI, Ollama
  local, LM Studio…) · Node.js 18+ solo para compilar desde fuente.
- Windows 10/11 · Any OpenAI-compatible AI provider (OpenRouter, Groq, OpenAI, local Ollama,
  LM Studio…) · Node.js 18+ only to build from source.
