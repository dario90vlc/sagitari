# SAGITARI 2.1.0

Versión mayor: **el agente completo**. Todo el roadmap 1.2 → 2.0 integrado: memoria avanzada,
checkpoints, tareas en segundo plano, subagentes, navegador con perfiles, marketplace de skills,
multi-proveedor con fallback, adjuntos y una interfaz renovada de principio a fin.

Major release: **the full agent**. The whole 1.2 → 2.0 roadmap integrated: advanced memory,
checkpoints, background tasks, subagents, browser profiles, skills marketplace, multi-provider
with fallback, file attachments and a UI rebuilt end to end.

## Descargas / Downloads

| Archivo / File | Descripción / Description |
|---|---|
| `SAGITARI-Setup-2.1.0.exe` | **Instalador / Installer** (NSIS): accesos directos, desinstalador / shortcuts, uninstaller |
| `SAGITARI-Portable-2.1.0.exe` | **Portable**: un solo ejecutable, sin instalación / single executable, no install |
| `Source code (zip/tar.gz)` | Código fuente / Source code |

> Binario sin firmar: Windows SmartScreen puede avisar en la primera ejecución (*Más información → Ejecutar de todas formas*). / Unsigned binary: SmartScreen may warn on first run (*More info → Run anyway*).

## Novedades / What's new

### Autonomía / Autonomy

- **Tareas en segundo plano / Background tasks** — Los trabajos largos siguen mientras sigues
  chateando: pausa, reanudación, cancelación y notificación al terminar. / Long jobs keep
  running while you keep chatting: pause, resume, cancel and completion notifications.
- **Subagentes especialistas / Specialist subagents** — El orquestador delega en agentes de
  investigación, navegador, código, ficheros o visión; cada uno con sus herramientas y
  permisos. / The orchestrator delegates to research, browser, coding, file or vision agents;
  each with its own tools and permissions.
- **Checkpoints y recuperación / Checkpoints & recovery** — Las tareas largas guardan su
  progreso: si la app se cierra o falla, se reanudan donde estaban y se muestra qué paso falló.
  / Long tasks save progress: after a crash or a closed window they resume where they left off
  and show which step failed.
- **Memoria avanzada / Advanced memory** — Memoria persistente con importancia, confianza,
  fechas de uso y búsqueda; más aprendizaje de hábitos del usuario. / Persistent memory with
  importance, confidence, usage dates and search; plus user-habit learning.

### Proveedores / Providers

- **8 proveedores / 8 providers** — OpenCode Go, Anthropic (Claude nativo), OpenAI, OpenRouter,
  Groq, Ollama, LM Studio y endpoints personalizados. Detección automática de modelos y
  fallback si un proveedor falla. / OpenCode Go, native Anthropic, OpenAI, OpenRouter, Groq,
  Ollama, LM Studio and custom endpoints. Automatic model detection and fallback when a
  provider fails.

### Navegador / Browser

- **Perfiles de navegador / Browser profiles** — Sesiones separadas (personal, trabajo,
  investigación…) con sus propias cookies y logins. / Separate sessions (personal, work,
  research…) each with its own cookies and logins.
- **Percepción visual / Visual perception** — DOM + accessibility tree + capturas que el modelo
  ve de verdad. / DOM + accessibility tree + screenshots the model actually sees.

### Skills

- **Marketplace / Marketplace** — Instala packs de skills desde repos de GitHub con un clic
  (p. ej. `anthropics/skills` → 20 skills verificadas). / Install skill packs from GitHub repos
  in one click (e.g. `anthropics/skills` → 20 verified skills).

### Interfaz / Interface

- **Chat renovado / Rebuilt chat** — Tarjetas de herramientas con resultado, duración y salida
  copiable; planes que se pintan y se marcan en vivo; distinción clara de modos ACT/PLAN/THINK
  con teñido completo de la interfaz. / Tool cards with result, duration and copyable output;
  live-rendered plan cards; clear ACT/PLAN/THINK mode distinction tinting the whole UI.
- **Adjuntos / Attachments** — Arrastra, pega o elige imágenes, código y documentos: las
  imágenes viajan como visión y los textos se extraen solos (30+ formatos, hasta 8 por
  mensaje). / Drag, paste or pick images, code and documents: images travel as vision parts and
  text is extracted automatically (30+ formats, up to 8 per message).
- **Glow personalizable / Customizable glow** — Resplandor suave y degradado que se ilumina al
  pensar, trabajar y hablar; 6 paletas de color para la interfaz y slider de intensidad,
  aplicados al vuelo. / Soft layered glow lighting up while thinking, working and speaking;
  6 UI palettes and an intensity slider, applied live.
- **Ajustes y sidebar renovados / New settings & sidebar** — Ajustes reorganizados por
  categorías con estados vacíos útiles; sidebar compactable con contadores en vivo. /
  Settings reorganized in categories with helpful empty states; collapsible sidebar with live
  badges.
- **Directo al chat / Straight to chat** — La app abre directamente en el chat: sin pantallas
  intermedias. / The app opens straight into the chat: no intermediate screens.

### Robustez / Robustness

- **Instancia única sensata / Sensible single instance** — Si SAGITARI ya está abierto, el
  segundo lanzamiento trae la ventana al frente en vez de morir en silencio. / If SAGITARI is
  already open, a second launch focuses the existing window instead of dying silently.
- **Fallos visibles / Visible failures** — Los errores del proceso principal y del renderer se
  registran en `logs\crash.log` y se muestran; nada muere en silencio. / Main-process and
  renderer errors are logged to `logs\crash.log` and surfaced; nothing dies silently.

## Verificación / Verification

- **93 tests en verde** (`npm test`) y **17 comprobaciones de interfaz** (`npm run uicheck`)
  sobre la app real. / **93 unit tests green** (`npm test`) and **17 real-app UI checks**
  (`npm run uicheck`).
- SHA-256 de los ejecutables calculado automáticamente por el workflow de CI al publicar. /
  Executable SHA-256 hashes computed automatically by the CI workflow on release.

## Requisitos / Requirements

- Windows 10/11 · Proveedor de IA compatible (OpenCode Go, OpenRouter, Groq, OpenAI, Anthropic,
  Ollama local, LM Studio…) · Node.js 18+ solo para compilar desde fuente.
- Windows 10/11 · Any compatible AI provider (OpenCode Go, OpenRouter, Groq, OpenAI, Anthropic,
  local Ollama, LM Studio…) · Node.js 18+ only to build from source.
