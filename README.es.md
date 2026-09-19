<div align="center">

<img src="docs/header.png" alt="SAGITARI" width="100%">

# SAGITARI

### Tu agente de IA para escritorio — con manos.

**Pide algo en lenguaje natural. SAGITARI planifica, actúa y te informa en tu PC Windows.**

[![Versión](https://img.shields.io/github/v/release/dario90vlc/sagitari?style=for-the-badge&color=00E5FF&label=última)](https://github.com/dario90vlc/sagitari/releases)
[![Descargas](https://img.shields.io/github/downloads/dario90vlc/sagitari/total?style=for-the-badge&color=37F5A8&label=descargas)](https://github.com/dario90vlc/sagitari/releases)
[![Plataforma](https://img.shields.io/badge/Windows-10%20%2F%2011-0078D6?style=for-the-badge&logo=windows11&logoColor=white)](https://github.com/dario90vlc/sagitari/releases)
[![Licencia](https://img.shields.io/badge/licencia-MIT-7C3AED?style=for-the-badge)](LICENSE)

[Descarga](#descarga) · [Características](#qué-puede-hacer) · [Seguridad](#seguridad-primero) · [Compilar](#compilar-desde-el-código) · [English](./README.md)

</div>

---

## ¿Por qué SAGITARI?

La mayoría de asistentes de IA de escritorio se quedan en el chat. SAGITARI está hecho para **terminar el trabajo**: puede usar tu terminal, trabajar con archivos, controlar Chrome o Edge, abrir aplicaciones, gestionar ventanas y mostrarte cada paso.

Es local-first por diseño. Tú eliges el modelo y el proveedor —en la nube o local— mientras la configuración, las API keys, las conversaciones, los logs, la memoria y los perfiles del navegador permanecen en tu equipo.

> **Lenguaje natural dentro. Trabajo real fuera.**

## Descarga

La opción recomendada es el instalador de Windows:

| Paquete | Descripción |
|---|---|
| [**SAGITARI-Setup-3.3.1.exe**](https://github.com/dario90vlc/sagitari/releases/download/v3.3.1/SAGITARI-Setup-3.3.1.exe) | Instalador con accesos directos y desinstalador |
| [**SAGITARI-Portable-3.3.1.exe**](https://github.com/dario90vlc/sagitari/releases/download/v3.3.1/SAGITARI-Portable-3.3.1.exe) | Ejecutable único, sin instalación |
| [**Notas de la versión**](https://github.com/dario90vlc/sagitari/releases/tag/v3.3.1) | Cambios, correcciones de seguridad y hashes SHA-256 |

> **Windows SmartScreen:** los binarios no tienen firma digital actualmente, por lo que Windows puede mostrar un aviso la primera vez. Pulsa *Más información → Ejecutar de todas formas* si confías en la descarga. Comprueba el hash SHA-256 publicado en las notas de la release.

> **Motores de voz:** la voz neuronal local (Piper) y el dictado local de alta precisión (Whisper) **no** van dentro del instalador —se descargan a petición desde Ajustes, en total unos 270 MB— así que la descarga sigue siendo ligera y el modo voz funciona igualmente con los motores de Windows mientras no los instales.

## Qué puede hacer

### Un agente que ejecuta

- **Terminal y archivos** — inspecciona, crea, edita y organiza tu espacio de trabajo.
- **Acciones de escritorio** — abre aplicaciones y URLs, gestiona ventanas, portapapeles, notificaciones y multimedia.
- **Navegador 2** — maneja Chrome o Edge como una persona: inventario con el **nombre accesible** de cada control (aunque sea un botón de icono), dentro de **componentes web e iframes**, clics que se vuelven a localizar por su huella y avisan si algo los tapa, esperas de verdad (`wait_for`), consola y errores de red (`logs`), diálogos, subida de archivos, atajos de teclado, listas y casillas, historial y descargas en una carpeta conocida.
- **Trabajo en paralelo** — las órdenes de un mismo mensaje se ejecutan a la vez con **bloqueo por recurso**: el navegador es uno solo, la escritura en disco va en cola y Detener mata todo lo que esté en vuelo.
- **Visión y adjuntos** — adjunta imágenes, código, documentos y ficheros de texto; las imágenes pueden enviarse a modelos con visión.
- **Código con red** — sabe cómo se comprueban **tu** proyecto (tests, compilación, lint) y comprueba la **sintaxis** de cada archivo al escribirlo: el error vuelve al instante, no tres pasos después. `apply_patch` hace varias ediciones en varios archivos de una vez (o entran todas o no entra ninguna) y, antes de darte algo por hecho, un **agente de revisión** lee el cambio del turno y busca lo que está mal (contratos rotos, casos límite, restos del nombre viejo). Se apaga en Ajustes ▸ Delegación y verificación.
- **Mapa del proyecto** — en proyectos grandes indexa archivos y símbolos (`repo_map`, `find_symbol`) en vez de leerlos uno a uno, así no se pierde en 100.000 líneas ni se queda en cuatro ediciones locales.

### Inteligencia flexible

- **Tu modelo, tus reglas** — OpenCode Go, OpenRouter, OpenAI, Groq, Anthropic, Ollama, LM Studio o cualquier endpoint compatible.
- **Think / Plan / Act** — razona en profundidad, prepara un plan antes de actuar o ejecuta directamente.
- **Skills** — importa packs especializados `SKILL.md` y carga sus instrucciones bajo demanda.
- **Servidores MCP** — Conecta tus propios servidores MCP (comandos locales o URLs remotas) y el agente usa sus herramientas como las de casa. Todo lo que ejecutan pide permiso antes, y puedes dar más confianza a un servidor que conozcas.
- **Memoria y hábitos** — conserva contexto útil entre conversaciones, siempre en local.
- **Fallback y recuperación** — cambio automático de modelo, tareas en segundo plano, checkpoints, pausa/reanudación y recuperación tras interrupciones. Si el proveedor acepta la conexión pero deja de enviar datos, el turno se corta solo (límite configurable en Ajustes › Seguridad) y el error se explica en el chat. El modelo elegido en Ajustes manda: el router no lo cambia por otro en silencio.

### Una interfaz que muestra el trabajo

- Interfaz holográfica creada con HTML, CSS y JavaScript vanilla.
- Glow reactivo en el marco mientras el agente piensa, trabaja, escucha o habla.
- Seis paletas de acento y controles de color e intensidad del glow en tiempo real.
- Conversaciones separadas, telemetría de agentes, logs locales estructurados y métricas opcionales para desarrolladores.
- Entrada por voz mediante el reconocimiento de Windows y salida por texto a voz.
- **Razonamiento visible (opcional)**: los modelos que razonan (Claude, la serie o y GPT-5, DeepSeek R1…) enseñan su proceso en un bloque plegable sobre la respuesta; se lee en vivo mientras piensa, se pliega solo al empezar a contestar y nunca se lee en voz alta. Se activa en Ajustes ▸ Agente.
- **Modo voz**: pulsa el micrófono y habla; el asistente te oye, hace el trabajo y te contesta en voz alta. Manos libres: al callar, se envía; te enseña el texto mientras hablas y empieza a responder en voz alta en cuanto tiene la primera frase, sin esperar a terminar. Si hablas mientras responde, se calla y te escucha; y puedes detenerlo diciendo «para» o con el botón **Parar** del panel. Todo en tu equipo, con voz neuronal local (Piper) y dictado local de alta precisión (Whisper) instalables desde Ajustes. `Alt`+clic en el micrófono mantiene el dictado clásico al cuadro de texto.

## Seguridad primero

SAGITARI tiene acceso real a tu ordenador, por eso la seguridad forma parte del producto:

- **Permisos por herramienta** — las acciones seguras pueden ejecutarse automáticamente; las sensibles piden confirmación.
- **Herramientas MCP** — pasan por el mismo motor de permisos: confirmación por defecto, niveles por servidor y por herramienta, y sus credenciales se guardan cifradas como tus claves de API.
- **Confirmación obligatoria** para operaciones sensibles del navegador, como leer el portapapeles, ejecutar JavaScript o cambiar de perfil.
- **Guardarraíles** para pasos, llamadas, duración, tokens, coste, bucles y tareas bloqueadas.
- **Parada real** — detener una ejecución también cancela el proceso asociado cuando es posible.
- **Subagentes limitados** — cada especialista solo recibe las herramientas permitidas.
- **Datos locales** — sin cuentas ni telemetría; las API keys se guardan con el almacén seguro de Windows cuando está disponible.
- **Actualizaciones verificadas** — las descargas exigen el SHA-512 publicado y vuelven a comprobarlo antes de instalar.

## Inicio rápido

1. Instala SAGITARI o descarga la versión portable.
2. Abre **Ajustes** y elige un proveedor.
3. Introduce tu API key si es necesaria, detecta los modelos y activa uno.
4. Vuelve a **Chat** y pide algo real.

Atajos útiles:

| Atajo | Acción |
|---|---|
| `Alt+1…9` | Cambiar de sección |
| `Ctrl+Alt+S` | Mostrar u ocultar el panel |
| `Alt+Shift+S` | Traer SAGITARI al frente |
| `Ctrl+Shift+G` | Lanzar un pulso de glow |
| `Alt+M` | Ciclar ACT → PLAN → THINK |
| `/` en el chat | Abrir la paleta de skills |

## Capturas

<table>
  <tr>
    <td width="50%"><img src="docs/shot-chat.png" alt="Chat de SAGITARI"></td>
    <td width="50%"><img src="docs/shot-empty.png" alt="Chat vacío de SAGITARI"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Chat</b> — pide, adjunta y ejecuta</sub></td>
    <td align="center"><sub><b>Modos</b> — elige Act, Plan o Think</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/shot-agents.png" alt="Vista de agentes de SAGITARI"></td>
    <td width="50%"><img src="docs/shot-tools.png" alt="Vista de herramientas de SAGITARI"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Agentes</b> — sigue cada ejecución</sub></td>
    <td align="center"><sub><b>Herramientas</b> — entiende qué puede hacer el agente</sub></td>
  </tr>
</table>

## Compilar desde el código

Requisitos: **Windows 10/11** y **Node.js 20+**.

```bash
git clone https://github.com/dario90vlc/sagitari.git
cd sagitari
npm ci

npm start                 # ejecutar la app
npm test                  # tests unitarios y de integración
npm run smoke             # comprobar que Electron arranca
npm run uicheck           # probar el renderer en vivo
npm run dist              # crear instalador NSIS + portable
```

El workflow de release ejecuta la comprobación de sintaxis, tests, smoke, UI, compilación de los dos artefactos de Windows, verificación de archivos y generación de hashes SHA-256. El tag debe coincidir con la versión de `package.json`; para esta release es `v3.3.1`.

## Estructura del proyecto

```text
sagitari/
├── main/           Proceso principal de Electron, ventanas, IPC, voz y proveedores
├── agent/          Loop del agente, herramientas, seguridad, memoria, skills y navegador
├── renderer/       Interfaz HTML/CSS/JS vanilla
├── skills-starter/ Skills iniciales incluidas
├── scripts/        Diagnósticos, comprobaciones de UI y herramientas de assets
└── docs/           Capturas y recursos gráficos
```

## Privacidad

- La configuración, las API keys, conversaciones, logs, memoria y perfiles del navegador se guardan en `%APPDATA%\SagitariAI\`.
- Las claves van directamente desde la aplicación local al proveedor elegido.
- Con proveedores locales como Ollama puedes trabajar sin enviar datos a la nube.
- El renderer usa `contextIsolation`, desactiva la integración Node y se ejecuta en sandbox.

## Licencia

SAGITARI es software libre distribuido bajo la [licencia MIT](LICENSE).

<div align="center">

**Para quienes quieren un asistente que haga más que hablar.**

[⬆ Volver arriba](#sagitari)

</div>
