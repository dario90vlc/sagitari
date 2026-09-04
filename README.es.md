<div align="center">

<img src="docs/header.png" alt="SAGITARI" width="100%">

# SAGITARI

**Asistente agéntico de IA open-source que vive en tu escritorio**

Control total de tu PC con Windows desde una interfaz holográfica — chat, voz, navegador y automatización real del sistema.

`Windows 10/11` · `Electron` · `Multi-proveedor` · `Licencia MIT`

[English](./README.md) · **Español**

[Descargar](#instalación) · [Inicio rápido](#inicio-rápido) · [Skills](#skills) · [Compilar](#compilar-desde-fuente)

</div>

---

SAGITARI es un asistente tipo Jarvis que **ejecuta de verdad**: no solo conversa, usa terminal,
lee y escribe archivos, abre apps, controla Chrome/Edge, maneja multimedia y automatiza tareas —
todo desde un panel de control holográfico con glow de energía que reacciona cuando piensa y actúa.

## Características

- **Multi-proveedor (compatible OpenAI):** OpenCode Go, OpenRouter, Ollama, LM Studio, Groq,
  OpenAI o cualquier endpoint personalizado. Pegas tu API key, se guarda localmente y los modelos
  se detectan automáticamente.
- **Modos Think / Plan / Act** — razonado, planificado o directo.
- **Chat + voz:** escribe o habla (motores de voz de Windows) y SAGITARI responde en voz alta (TTS).
- **Glow interno de agente:** la energía del marco se enciende al responder (mezcla violeta ↔ turquesa)
  — piensa, trabaja y habla con luz propia.
- **Control total del PC:** terminal, archivos, abrir apps/URLs, portapapeles, notificaciones,
  capturas de pantalla que el modelo "ve", multimedia y ventanas.
- **Navegador real:** controla Chrome/Edge vía DevTools Protocol (navegar, clic, escribir, leer
  contenido, capturar pestañas) — sin Puppeteer, WebSocket puro.
- **Espacio de trabajo:** carpeta de trabajo fija (configurable en Ajustes o desde Proyectos);
  rutas relativas, archivos nuevos y comandos de terminal resuelven ahí por defecto.
- **Historial de conversaciones** separadas con memoria persistente inyectada en el contexto.
- **Vistas:** Inicio, Chat, Agentes (en vivo), Proyectos, Herramientas, Memoria, Skills y Ajustes.

## Skills

Instrucciones especializadas estilo **SKILL.md** (el formato de agent skills de GitHub) que el
agente carga solo cuando la tarea lo necesita — el prompt solo lleva el índice (nombre +
descripción), así el coste en tokens es mínimo.

- Incluye 5 de serie: `codigo`, `investigacion`, `diseno`, `automatizacion` y el pack **Ponytail**
  (desarrollo lazy-senior, revisión, auditoría y modo *caveman* de respuestas comprimidas).
- **Importar desde GitHub:** en la vista Skills, pega `owner/repo` (o `owner/repo/carpeta`) de
  cualquier repo con SKILL.md — ej. `anthropics/skills` (importa 20 skills verificadas).
- Crear/editar/activar/desactivar desde la UI o editando `%APPDATA%\SagitariAI\skills\`.
- El agente las aplica automáticamente cuando detecta la tarea, o tú puedes forzarlas desde el
  chat escribiendo `/` (paleta de skills con filtrado) — ej. `/investigacion compara RTX 5080 vs 4090`.

## Instalación

Descarga el artefacto que prefieras de la [página de releases](../../releases):

| Artefacto | Qué es |
|---|---|
| `SAGITARI-Setup-1.0.1.exe` | Instalador Windows (NSIS): accesos directos, desinstalador |
| `SAGITARI-Portable-1.0.1.exe` | Portable: un solo ejecutable, sin instalación |
| `Source code (zip)` | Código fuente |

> Windows SmartScreen puede avisar en la primera ejecución (binario sin firma). Pulsa
> *Más información → Ejecutar de todas formas*.

## Inicio rápido

1. Abre SAGITARI → **Ajustes** → elige un preset (OpenRouter, Ollama, Groq, OpenAI…).
2. Pega tu API key → **Detectar modelos** → elige uno → **Activar**.
3. Escribe o dicta tu primera petición. Con Ollama ni siquiera necesitas API key (local).

Atajos: **Alt+Espacio** muestra/oculta el panel · **Alt+Shift+S** trae al frente ·
**Ctrl+Shift+G** pulso de glow.

## Compilar desde fuente

```bash
git clone https://github.com/TU_USUARIO/sagitari.git
cd sagitari
npm install

npm start              # modo desarrollo
npm run dist           # instalador NSIS + portable en dist/
npm run dist:installer # solo instalador
npm run dist:portable  # solo portable
```

Requisitos: Node.js 18+ y Windows 10/11.

## Estructura

```
sagitari/
├── main/           # proceso Electron: ventanas, IPC, voz, proveedores
│   ├── main.js
│   ├── preload.js
│   ├── providers.js
│   └── voice.ps1   # dictado (motores de voz de Windows)
├── agent/          # cerebro del agente
│   ├── agent.js    # loop streaming + tool calling
│   ├── tools.js    # definiciones de herramientas
│   ├── executors.js
│   ├── skills.js   # motor de skills (SKILL.md)
│   └── browser.js  # Chrome/Edge vía CDP (sin puppeteer)
├── renderer/       # UI holográfica
│   ├── index.html / app.js / styles.css
│   └── assets/     # logo, iconos
├── skills-starter/ # skills incluidas de serie
└── docs/           # assets del README
```

## Notas

- Config y API keys se guardan en `%APPDATA%\SagitariAI\` — **solo local**, nunca salen de tu máquina.
- El dictado usa los reconocedores de voz de Windows; para máxima precisión activa el
  reconocimiento de voz en línea (Configuración → Privacidad y seguridad → Voz) y elige un buen
  micrófono predeterminado.
- Skills de comunidad desbloqueadas: cualquier repo con carpetas que contengan `SKILL.md` funciona.

## Licencia

[MIT](LICENSE)
