<div align="center">

<img src="docs/header.png" alt="SAGITARI" width="100%">

# SAGITARI

**Un asistente agéntico de IA que vive en tu escritorio — y ejecuta de verdad.**

Control total de tu PC con Windows desde una interfaz holográfica: chat, voz, navegador y automatización real del sistema.

![Platform](https://img.shields.io/badge/platform-Windows_10%2F11-0078D6?style=flat-square&logo=windows11&logoColor=white)
![Release](https://img.shields.io/github/v/release/dario90vlc/sagitari?style=flat-square&label=release&color=00E5FF)
![Downloads](https://img.shields.io/github/downloads/dario90vlc/sagitari/total?style=flat-square&label=downloads&color=37F5A8)
![License](https://img.shields.io/badge/license-MIT-7C3AED?style=flat-square)
![Electron](https://img.shields.io/badge/Electron-44-47848F?style=flat-square&logo=electron&logoColor=white)

[English](./README.md) · **Español**

</div>

---

<div align="center">
<img src="docs/shot-chat.png" alt="Vista de chat de SAGITARI" width="86%">
</div>

> Escribe una petición — o dila en voz alta. SAGITARI planifica, usa la terminal, lee y escribe
> archivos, maneja Chrome/Edge y te reporta, con un glow de energía que ilumina el marco mientras trabaja.

## Capturas

<table>
  <tr>
    <td width="50%"><img src="docs/shot-home.png" alt="Inicio"></td>
    <td width="50%"><img src="docs/shot-agents.png" alt="Agentes"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Inicio</b> — punto de partida con tu espacio de trabajo</sub></td>
    <td align="center"><sub><b>Agentes</b> — telemetría en vivo de cada ejecución</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/shot-tools.png" alt="Herramientas"></td>
    <td width="50%"><img src="docs/shot-skills.png" alt="Skills"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Herramientas</b> — todo lo que el agente puede tocar</sub></td>
    <td align="center"><sub><b>Skills</b> — packs SKILL.md importables</sub></td>
  </tr>
</table>

## Por qué SAGITARI

La mayoría de asistentes de IA de escritorio se quedan en la burbuja del chat. SAGITARI está
construido como un **agente con manos**:

- **Ejecuta, no solo sugiere** — comandos de terminal, operaciones con archivos, apertura de
  apps, automatización del navegador y tareas del sistema se ejecutan de verdad, con cada paso
  visible en la interfaz.
- **Trae tu propio modelo** — cualquier endpoint compatible con OpenAI: nube (OpenRouter, Groq,
  OpenAI…) o 100% local (Ollama, LM Studio). Tus claves nunca salen de tu máquina.
- **Cuesta lo que debe, y no más** — las skills se cargan bajo demanda, y el pack *Ponytail*
  mantiene las respuestas compactas y enfocadas a ingeniería.
- **Parece lo que es** — una interfaz holográfica hecha a mano, sin frameworks, sin bloat:
  Electron + JS vanilla y una única dependencia en runtime.

## Características

**Inteligencia**

- **Multi-proveedor (compatible OpenAI):** OpenCode Go, OpenRouter, Ollama, LM Studio, Groq,
  OpenAI o cualquier endpoint personalizado. Pegas tu API key — se guarda localmente y los
  modelos se detectan automáticamente. Con Ollama ni siquiera necesitas clave (local).
- **Modos Think / Plan / Act** — razonamiento profundo, planificar y luego ejecutar, o acción
  directa. Se cambian con un clic desde el compositor del chat (o `Alt+M`).
- **Motor de skills (formato SKILL.md):** packs de instrucciones especializadas que el agente
  carga bajo demanda — el prompt solo lleva el índice, así el coste en tokens es mínimo.
  Importa cualquier repo de GitHub con `SKILL.md` (ej. `anthropics/skills` → 20 skills
  verificadas) y fuerza una desde el chat escribiendo `/`.
- **Memoria persistente** inyectada en el contexto entre conversaciones.

**Control**

- **Acceso total al PC:** terminal, archivos, abrir apps y URLs, portapapeles, notificaciones,
  multimedia y gestión de ventanas.
- **Automatización real del navegador:** controla Chrome/Edge vía DevTools Protocol (WebSocket
  puro, sin Puppeteer) — navegar, hacer clic por texto visible, escribir, leer contenido,
  capturar pantallas, gestionar pestañas. Una ventana, perfil persistente, tus logins se conservan.
- **Capturas de pantalla que el modelo ve de verdad** para tareas visuales.

**Interfaz**

- **UI holográfica** hecha a mano en HTML/CSS vanilla — sin frameworks de interfaz.
- **Glow reactivo:** el marco se ilumina (mezcla violeta ↔ turquesa) mientras el agente
  piensa, trabaja o habla.
- **Voz en ambos sentidos:** dicta con los motores de voz de Windows, escucha las respuestas
  en voz alta (TTS).
- **Historial de conversaciones** separadas, y una vista de Agentes en vivo que muestra cada
  paso de cada ejecución.

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
3. Escribe o dicta tu primera petición. Con Ollama no necesitas API key (local).

**Atajos:** `Alt+Espacio` muestra/oculta el panel · `Alt+Shift+S` trae al frente ·
`Ctrl+Shift+G` pulso de glow · `Alt+M` cicla el modo del agente · `/` en el campo abre la paleta de skills.

## Compilar desde fuente

```bash
git clone https://github.com/dario90vlc/sagitari.git
cd sagitari
npm install

npm start              # modo desarrollo
npm run dist           # instalador NSIS + portable en dist/
npm run dist:installer # solo instalador
npm run dist:portable  # solo portable
```

Requisitos: Node.js 18+ y Windows 10/11.

## Estructura del proyecto

```
sagitari/
├── main/           # proceso Electron: ventanas, IPC, voz, proveedores
│   ├── main.js
│   ├── preload.js
│   ├── providers.js
│   └── voice.ps1   # dictado (motores de voz de Windows)
├── agent/          # cerebro del agente
│   ├── agent.js    # loop streaming + tool calling, sin límite de pasos
│   ├── tools.js    # definiciones de herramientas
│   ├── executors.js
│   ├── skills.js   # motor de skills (SKILL.md)
│   └── browser.js  # Chrome/Edge vía CDP (sin puppeteer)
├── renderer/       # UI holográfica
│   ├── index.html / app.js / styles.css
│   └── assets/     # logo, iconos
├── skills-starter/ # skills incluidas de serie
├── scripts/        # utilidades de diagnóstico y captura
└── docs/           # assets del README
```

## Privacidad y seguridad

- La configuración y las API keys se guardan en `%APPDATA%\SagitariAI\` — **solo local**, nunca
  salen de tu máquina. Las claves van directamente de tus ajustes a tu proveedor.
- El dictado usa los reconocedores de voz de Windows; activa el reconocimiento de voz en línea
  (Configuración → Privacidad y seguridad → Voz) y elige un buen micrófono para máxima precisión.
- El agente del navegador usa su propio perfil persistente; ciérralo o desactiva la herramienta
  para apagarlo.
- El renderer corre con `contextIsolation` activado y `nodeIntegration` desactivado.

## Licencia

[MIT](LICENSE)
