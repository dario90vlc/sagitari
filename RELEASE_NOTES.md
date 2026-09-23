# SAGITARI 4.0.0

**El aura ya no late: rueda.** El glow se rediseña al estilo Apple Intelligence: filo nítido de 1px que reparte los 6 tonos del espectro, tres halos con su tono —y uno con núcleo blanco— que ruedan por el borde (el color gira cada 22s y el alcance respira cada 8s, con las propiedades registradas para que la interpolación sea continua y no a saltos), y cada estado del agente distinguiéndose por el NIVEL de luz del marco en vez de por un ritmo propio: pensar, trabajar, escuchar y hablar se leen de un vistazo. Añade la cáustica del compositor (luz arriba-izquierda, sombra abajo-derecha), el slider de vidrio ultra claro ↔ tintado con sus etiquetas sin pisarse, el reloj, las puertas numeradas y el scope de torre en vivo del estado vacío, y el logotipo muerto del rebranding fuera del instalador (−1,4 MB). / **The aura no longer beats: it rolls.** The glow is redesigned in the Apple Intelligence style: a sharp 1px edge carrying the 6 spectrum hues, three tonal halos —one with a white core— rolling along the border (the hue rotates every 22s and the reach breathes every 8s, with registered properties so the interpolation is continuous instead of stepped), and each agent state told apart by the frame's light LEVEL instead of its own rhythm: thinking, working, listening and speaking are readable at a glance. Plus the composer's caustic (light top-left, shadow bottom-right), the ultra-light ↔ tinted glass slider whose labels no longer collide, the clock, numbered gates and live tower scope of the empty state, and the dead rebranding logo out of the installer (−1.4 MB).

**Tus claves quedan fuera del alcance del agente.** El directorio de datos de la app (claves API, conversaciones, memoria) ya no se lee ni se escribe desde las herramientas, y un `run_command` con `cwd` fuera del espacio de trabajo se rechaza en vez de lanzarse — ni `C:\Windows` ni la carpeta de configuración. Los hooks que escribes tú pasan la misma barrera de comandos destructivos que la terminal, el navegador solo abre `http(s)` (`file://` leería el disco fuera del confinamiento), y el ayudante que instala la nueva versión se sella con una huella SHA-256 que se recomprueba justo antes de disparar la tarea — el `.ps1` vive en `%TEMP%`, donde otro proceso podría tocarlo. Y las skills importadas de repos ajenos llegan como CONTENIDO de terceros delimitado, no como órdenes: si piden algo que no pediste, se avisa y no se hace. / **Your keys are now out of the agent's reach.** The app's data directory (API keys, conversations, memory) is no longer read or written by tools, and a `run_command` whose `cwd` falls outside the workspace is rejected instead of launched — neither `C:\Windows` nor the config folder. Hooks you write pass the same destructive-command barrier as the terminal, the browser only opens `http(s)` (`file://` would read disk outside the confinement), and the helper that installs the new version is sealed with a SHA-256 fingerprint re-checked right before the task fires — the `.ps1` lives in `%TEMP%`, where another process could touch it. And skills imported from third-party repos arrive as delimited third-party CONTENT, not as orders: if they ask for something you never asked for, you are told and nothing runs.

**La voz local se adelanta mientras escribes.** La síntesis y la reproducción se solapan —la frase siguiente se prepara mientras suena la actual—, la voz sharvard pasa a ser la por defecto, el modelo local baja a turbo-q5_0 (más rápido con calidad suficiente) y la cola de habla se hace adaptativa, sin esperas fijas. / **The local voice keeps ahead while you type.** Synthesis and playback now overlap —the next sentence is prepared while the current one plays—, sharvard becomes the default voice, the local model drops to turbo-q5_0 (faster at sufficient quality), and the speech queue becomes adaptive, with no fixed waits.

**Por dentro, sin cambios a la vista:** `main.js` se trocea en doce routers `ipc-*`, el renderer en cuatro scripts (`10-chat`, `20-voz`, `30-ajustes`, `40-vistas`) y la suite de tests en cuatro bloques; el mapa del proyecto y la búsqueda comparten ya un único recorrido del árbol. / **Inside, with nothing changed on screen:** `main.js` is split into twelve `ipc-*` routers, the renderer into four scripts (`10-chat`, `20-voz`, `30-ajustes`, `40-vistas`), and the test suite into four blocks; the project map and search now share a single tree walk.

# SAGITARI 3.3.5

**La respuesta ya no se vuelve corta al terminar.** Antes toda la narración del turno se acumulaba en un bloque que al cerrar se tiraba y se sustituía por el último párrafo —una respuesta larga se convertía en tres líneas—. Ahora cada tramo de explicación queda congelado encima de la herramienta que viene después, en orden cronológico como en las grandes herramientas agénticas, y el historial guarda la historia completa (con tope): reabrir la conversación enseña lo mismo que se vio en vivo. La lectura por voz y el modo Plan no cambian. / **Answers no longer shrink when the turn ends.** All of the turn's narration used to pile into one block that was thrown away at close and replaced with the last paragraph —a long answer turned into three lines—. Now each explanation sits frozen above the tool that follows it, in chronological order like the big agentic tools, and the history keeps the whole story (capped): reopening the conversation shows what you saw live. Voice reading and Plan mode are unchanged.

**Rebranding: icono, sidebar y cabecera nuevos.** Nueva marca en la ventana, la barra de tareas, la bandeja, el instalador y los avatares del chat; el sidebar lleva el logo completo en una sola pieza; y el README estrena cabecera. / **Rebrand: new icon, sidebar and header.** New mark on the window, taskbar, tray, installer and chat avatars; the sidebar carries the full logo in one piece; and the README has a new header.

# SAGITARI 3.3.4

**El actualizador ya no depende de sobrevivir al cierre.** El diseño anterior (un proceso desligado que sostenía al asistente) pasaba 3/3 en el laboratorio pero moría en máquinas reales al cerrarse la app: cuatro intentos medidos en un diario de usuario, en dos versiones distintas, todos con el asistente muerto tras su primera línea. Ahora la instalación la ejecuta el Programador de tareas de Windows —un servicio del sistema, no un hijo de la app—, así que cerrar SAGITARI (o que lo tumbe el antivirus) ya no puede matarla. Además el diario escribe un latido cada 10 segundos mientras espera, para que el próximo fallo diga cuándo murió en vez de quedarse mudo, y la tarea de un solo uso se autoborra al terminar. Si el programador no está disponible, se intenta la vía clásica como plan B. / **The updater no longer depends on surviving the shutdown.** The previous design (a detached process holding the helper) passed 3/3 in the lab but died on real machines when the app closed: four attempts measured in a user's log, across two versions, all with the helper dead after its first line. The installation is now run by the Windows Task Scheduler —a system service, not a child of the app— so closing SAGITARI (or the antivirus killing it) can no longer take it down. The log also writes a heartbeat every 10 seconds while waiting, so the next failure will say when it died instead of going silent, and the one-shot task deletes itself when done. If the scheduler is unavailable, the classic path is attempted as plan B.

# SAGITARI 3.3.3

**El diario ya no apunta tus secretos.** Todo lo que hacía el agente se guardaba tal cual en el registro local: si escribía una contraseña, pegaba una clave o el portapapeles llevaba un código, quedaba en disco en claro. Ahora cada evento se redacta antes de guardarse (claves y tokens se tachan, los textos largos se recortan) y la memoria de hábitos recibe la misma versión ya limpia. Lo que nunca se guardó no hay que perseguirlo después. / **The log no longer records your secrets.** Everything the agent did was stored verbatim in the local log: a typed password, a pasted key or a clipboard code stayed on disk in clear text. Every event is now redacted before it is written (keys and tokens blacked out, long texts trimmed) and the habits memory receives the same already-clean version. What was never stored never needs chasing.

**Los comandos disfrazados también piden permiso.** El vigilante de comandos frenaba lo obvio (formatear, borrar la raíz), pero un PowerShell ofuscado en base64 (`-enc`), una descarga con `DownloadString` o `Invoke-WebRequest`, o un `mshta`/`rundll32` con URL pasaban sin preguntar. Esas vías ahora se clasifican como sensibles y exigen tu confirmación aunque la terminal esté en modo automático. / **Disguised commands now ask first too.** The command watchdog stopped the obvious (formatting, wiping the drive root), but an obfuscated base64 PowerShell (`-enc`), a `DownloadString` or `Invoke-WebRequest` download, or an `mshta`/`rundll32` with a URL slipped through silently. Those paths are now classified as sensitive and require your confirmation even with the terminal in automatic mode.

**Instalar y las skills piden un «sí, lo sé».** Los binarios siguen sin firma digital, así que instalar pedía lo mismo con prueba SHA-512 que sin ella: ahora el primer clic te avisa y solo el segundo instala (vale también para reintentar). Y las skills de GitHub —que son órdenes que el agente obedecerá— primero te enseñan lo que traen y solo se instalan si confirmas; además se comprueba que lo descargado sea exactamente el contenido publicado (hash git-blob). De propina: las imágenes de tus chats se guardan en miniatura (las conversaciones ya no engordan megabytes), la carpeta de trabajo rechaza rutas del sistema y la detección de modelos aguanta endpoints maliciosos sin romperse. / **Installing and skills now need an explicit “yes, I know”.** The binaries are still unsigned, so installing asked the same with or without SHA-512 proof: now the first click warns you and only the second one installs (retries included). And GitHub skills —orders your agent will obey— first show you what they bring and only install on confirmation; on top of that, downloads are checked to be exactly the published content (git-blob hash). As a bonus: chat images are stored as thumbnails (conversations no longer swell by megabytes), the workspace rejects system paths, and model detection survives malicious endpoints unbroken.

# SAGITARI 3.3.2

**El actualizador, esta vez con la causa medida.** La explicación que dio la 3.3.1 («Windows
mata todo el árbol de procesos de la app») era **incorrecta**, y por eso el fallo seguía
ahí. Medido con un Electron de verdad, lanzando el mismo asistente de cuatro formas:
`powershell.exe` **directo** arranca y **muere con la app** (es el diario que veíais:
«asistente iniciado» y nada más); `powershell.exe` **desligado ni arranca**; y en cambio un
**`cmd.exe` que lo sostiene, desligado, sobrevive**. Eso es ahora el lanzamiento, y es la
diferencia entre cerrar la app y que la versión nueva esté al abrirla. Además, la prueba de
regresión anterior **no podía detectar este fallo** (usaba un Node como padre, y ahí el
diseño roto también pasa): ahora usa un Electron real y ejecuta un control con el diseño
que falló, exigiendo que NO instale — un test que no puede fallar por lo que dice guardar
no guarda nada. / **The updater, this time with the cause measured.** The explanation given
in 3.3.1 (“Windows kills the whole process tree of the app”) was **wrong**, which is why
the bug was still there. Measured with a real Electron, launching the same helper in four
ways: a **direct** `powershell.exe` starts and **dies with the app** (that is the log you
saw: “asistente iniciado” and nothing else); a **detached** `powershell.exe` does not even
start; while a **`cmd.exe` holding it, detached, survives**. That is the launch now, and it
is the difference between the app closing and the new version being there when you open
it. On top of that, the previous regression test **could not detect this bug** (it used a
Node process as the parent, and the broken design passes there too): it now uses a real
Electron and runs a control with the design that failed, requiring it to NOT install — a
test that cannot fail for what it claims to guard guards nothing.

**Si tienes instalada la 3.3.0 o anterior, necesitas instalarla UNA vez a mano** (descarga
el Setup y ejecútalo): esas versiones lanzaban el asistente de la forma que fallaba y no
pueden repararse a sí mismas —ese es justo el fallo—. A partir de ahí, las siguientes se
instalan solas. / **If you have 3.3.0 or older installed, you need to install it ONCE by
hand** (download the Setup and run it): those versions launched the helper the failing way
and cannot repair themselves — that is the very bug. From then on, later versions install
themselves.

**El chat recuerda su trabajo.** Al cerrar la app y volver a abrirla, el hilo repintaba
solo las burbujas de texto: las tarjetas de herramienta, el razonamiento y sus tiempos
desaparecían de la vista, y una respuesta se quedaba sin saber cómo se había llegado a
ella. Ahora el turno se guarda ENTERO —herramientas con sus argumentos, resultado y
duración, el razonamiento y su resumen— y al reabrir la conversación se reconstruye el
mismo bloque plegable, con su recuento y sus fallos. Lo que no llegó a terminar se dice
tal cual, en vez de pintarle un check verde que nunca ocurrió. / **The chat remembers its
work.** On closing and reopening the app, the thread only repainted the text bubbles: the
tool cards, the reasoning and their timings vanished, leaving an answer with no trace of
how it was reached. The turn is now stored WHOLE — tools with their arguments, result and
duration, plus the reasoning and its summary — and reopening the conversation rebuilds the
same collapsible block, with its count and its failures. Whatever did not finish is said
as such, instead of being given a green check that never happened.

**Respuestas que se entienden.** El agente tenía instrucciones que empujaban al telegrama
(«respuestas breves», «minimiza explicaciones», «1-3 líneas»), y el resultado eran cosas
como «divisor corregido de /2|9 a /7|9» o un «Revisado: sin hallazgos» a secas. Ahora el
prompt le pide lo contrario: la respuesta final es lo único que lees de todo su trabajo,
se escribe para quien no ha visto las herramientas, con frases enteras (nada de siglas
inventadas para ahorrar caracteres) y en este orden: qué hizo, qué cambió con los datos
concretos, cómo lo comprobó y qué queda pendiente. Y cuando el turno se corta —por
estancamiento, por bucle, por límite— ya no deja un «(detenido: sin progreso)» sin
explicación: dice qué pasó y qué puedes hacer. / **Answers you can actually read.** The
agent had instructions pushing it towards telegraphic replies (“keep answers short”,
“minimise explanations”, “1-3 lines”), which produced things like “divisor fixed from
/2|9 to /7|9” or a bare “Reviewed: nothing found”. The prompt now asks for the opposite:
the final answer is all you see of its work, it is written for someone who has not seen
the tools, in whole sentences (no invented abbreviations to save characters), in this
order: what it did, what changed with the concrete details, how it checked, and what is
still pending. And when a turn cuts off — stall, loop, limit — it no longer leaves an
unexplained “(stopped: no progress)”: it says what happened and what you can do.

# SAGITARI 3.3.1

**El actualizador instala de verdad.** «Cerrar e instalar» cerraba la app y no pasaba
nada: aparecía una ventana de consola, se cerraba y la versión seguía siendo la misma. La
causa no era un comando mal escrito, sino algo más de fondo: **Windows mata todo el árbol
de procesos de la app cuando se cierra**, así que el asistente que debía esperar a que
SAGITARI desapareciera moría con ella justo antes de poder instalar nada. Se ve en su
propio diario: escribía su primera línea y ahí se acababa. Ahora la instalación la pide a
Windows, que crea al asistente **fuera del árbol de la app** (y por eso sí la sobrevive),
y SAGITARI ya no se cierra hasta tener la prueba de que ese asistente está vivo y
trabajando. Si no lo consigue, no se cierra: te lo dice y te deja reintentarlo o
instalarlo a mano. / **The updater actually installs.** “Close and install” closed the app
and nothing happened: a console window appeared, closed, and the version was still the
same. The cause was not a mistyped command but something deeper: **Windows kills the whole
process tree of the app when it closes**, so the helper that was supposed to wait for
SAGITARI to disappear died with it, right before it could install anything. It is visible
in its own log: it wrote its first line and that was it. Now the installation is requested
from Windows, which creates the helper **outside the app's process tree** (and that is why
it does survive it), and SAGITARI no longer closes until it has proof that the helper is
alive and working. If it can't, it does not close: it tells you and lets you retry or
install by hand.

**Si tienes la versión instalada anterior a esta, necesitas instalarla UNA vez a mano**
(descarga el Setup y ejecútalo). El actualizador roto vivía dentro de las versiones
anteriores y no puede repararse a sí mismo —ese es justo el fallo—; a partir de esta, las
siguientes se instalarán solas. / **If your installed version is older than this one, you
need to install it ONCE by hand** (download the Setup and run it). The broken updater
lived inside the earlier versions and cannot repair itself —that is the very bug—; from
this one on, later versions will install themselves.

Además, el diario del asistente recoge ahora el **código de salida del instalador** y si la
app seguía viva al lanzarlo, y la app vuelve a abrirse sola al terminar la actualización
(antes se cerraba y el usuario creía que no había pasado nada… aunque hubiera pasado). /
On top of that, the helper's log now records the **installer's exit code** and whether the
app was still running when it launched it, and the app reopens by itself when the update
finishes (it used to close and the user thought nothing had happened — even when it had).

## Novedades / What's new

- **La instalación sobrevive al cierre de la app.** El archivo que la app ejecuta ahora es
  un puente que le pide a Windows (WMI) crear al asistente fuera de su árbol de procesos;
  el asistente espera a que SAGITARI desaparezca y lanza el Setup en silencio. Está medido
  con la app real: antes no se ejecutaba **3 de 3 veces**; ahora sí **3 de 3**, y el
  asistente vive en unos 2,3 s. / **The installation survives the app closing.** What the
  app runs now is a bridge that asks Windows (WMI) to create the helper outside its own
  process tree; the helper waits for SAGITARI to disappear and launches the Setup silently.
  Measured with the real app: it used to fail to run **3 out of 3 times**; now it succeeds
  **3 out of 3**, with the helper alive in about 2.3 seconds.
- **La app no se cierra sin pruebas.** Antes de cerrarte la ventana se espera a que el
  asistente deje su rastro en el diario; si no lo consigue (sin PowerShell, WMI bloqueado,
  política del equipo), la app NO se cierra y te lo dice, en vez de dejarte con la ventana
  cerrada y nada instalado. / **The app does not close without proof.** Before your window
  closes, it waits for the helper to leave its trace in the log; if it can't (no PowerShell,
  WMI blocked, machine policy), the app does NOT close and tells you, instead of leaving you
  with a closed window and nothing installed.
- **El diario del asistente dice más.** Código de salida del instalador, si la app seguía
  viva al lanzarlo y el rastro completo de cada intento, en
  `%TEMP%\sagitari-update\instalar.log`. Si algo vuelve a fallar, ahí está el porqué. /
  **The helper's log says more.** Installer exit code, whether the app was still running when
  it launched it, and the full trace of every attempt, in `%TEMP%\sagitari-update\instalar.log`.
  If something fails again, the reason is there.

# SAGITARI 3.3.0

**Los subagentes que escriben dejan de pisarse.** Cuando SAGITARI reparte un trabajo grande
entre sus especialistas, los que escriben código trabajan ahora cada uno en su **propio árbol
de git** —con tu proyecto tal y como lo tienes, incluidos los cambios sin guardar— y al terminar
sus cambios vuelven al proyecto **como un parche que se comprueba antes de aplicarse**. Si algo
no encaja, no se aplica nada, se te dice por qué y el árbol queda ahí para mirarlo: nunca un
proyecto a medias. Y de paso, **lo que destruiría tu equipo ya no se ejecuta**: formatear una
unidad, gestionar particiones, borrar dentro de Windows o la raíz de un disco no son una
pregunta que puedas contestar que sí, y lo delicado (push forzado, publicar un paquete,
instalar en el equipo, borrados recursivos, el registro, tareas programadas, descargar y
ejecutar) pregunta siempre, aunque tengas la terminal en automático. / **Writing subagents stop
stepping on each other.** When SAGITARI splits a big job across its specialists, the ones that
write code each work now in their **own git worktree** —with your project exactly as you have
it, unsaved changes included— and when they finish their work comes back to the project **as a
patch that is checked before it is applied**. If it does not fit, nothing is applied, you are
told why, and the worktree stays put so you can look at it: never a half-changed project. And
along the way, **what would destroy your machine no longer runs**: formatting a drive, managing
partitions, deleting inside Windows or the root of a disk are not a question you can answer yes
to, and the delicate stuff (force-push, publishing a package, installing system-wide, recursive
deletes, the registry, scheduled tasks, download-and-run) always asks, even with the terminal
set to automatic.

Y la tercera es la que más vas a notar en el día a día: un anclaje de edición que solo fallaba
por la **sangría** ya no es un callejón sin salida. SAGITARI te enseña el bloque exacto que hay
en el archivo, con sus números de línea, y arregla el cambio **reajustando la sangría** en lugar
de destruirla. / And the third one is the one you will notice most day to day: an edit anchor
that only failed because of **indentation** is no longer a dead end. SAGITARI shows you the
exact block that is in the file, with its line numbers, and fixes the change **by readjusting
the indentation** instead of destroying it.

## Novedades / What's new

- **Aislar a los subagentes que escriben.** Cada especialista que escribe código (`coding`,
  `file`) trabaja en un árbol de trabajo de git propio: ve el proyecto entero —con tus cambios
  sin guardar y tus archivos nuevos—, escribe donde quiera y al cerrar vuelve un parche que se
  comprueba con `git apply --check` **antes** de tocar nada. Si entra, los archivos quedan como
  cualquier otro cambio del turno: **se pueden deshacer**. Si no entra, no se aplica nada y se
  te dice por qué y dónde quedó el árbol. Se apaga en Ajustes ▸ Agente, y sin git (o sin
  commits) funciona como siempre. / **Isolate writing subagents.** Every code-writing
  specialist (`coding`, `file`) works in its own git worktree: it sees the whole project —your
  unsaved changes and your new files included—, writes wherever it wants, and on finish a patch
  comes back that is checked with `git apply --check` **before** anything is touched. If it
  applies, the files are like any other change of the turn: **they can be undone**. If it does
  not, nothing is applied and you are told why and where the worktree stayed. It can be turned
  off in Settings ▸ Agent, and without git (or without commits) it works as always.
- **Los comandos se juzgan por lo que hacen, no por quién los pide.** Antes `run_command` tenía
  un único nivel de riesgo: el de la herramienta entera, así que poner «Terminal» en automático
  —o aprobar una vez un comando— autorizaba por igual `git status` y `format C:`. Ahora hay
  tres escalones: lo que solo lee no molesta; lo sensible pide confirmación **siempre** (push
  forzado, `git reset --hard`, publicar, instalar en el equipo, borrados recursivos, el
  registro, servicios y tareas programadas, usuarios, cortafuegos, apagar el equipo, descargar
  y ejecutar); y lo que destruye el sistema **no se ejecuta**, ni con tu permiso. / **Commands
  are judged by what they do, not by who asks.** `run_command` used to have a single risk level:
  the whole tool's, so setting “Terminal” to automatic —or approving one command once—
  authorised `git status` and `format C:` alike. There are now three tiers: read-only commands
  do not bother you; sensitive ones always ask (force-push, `git reset --hard`, publishing,
  installing system-wide, recursive deletes, the registry, services and scheduled tasks, users,
  firewall, powering the machine off, download-and-run); and what destroys the system does not
  run at all, not even with your permission.
- **La sangría ya no mata una edición.** Un anclaje que no coincidía al carácter devuelve un
  «¿Querías esto?» con el bloque real numerado, el texto exacto para copiar y una salida de una
  sola llamada (`tolerar_espacios`), que reajusta la sangría al archivo **línea a línea** (los
  tabuladores cuentan como tabuladores, no como un carácter). Con varias coincidencias no elige
  por su cuenta: te dice en cuántos sitios aparece. Nunca aplica una suposición en silencio. /
  **Indentation no longer kills an edit.** An anchor that did not match to the character now
  returns a “Did you mean this?” with the real block numbered, the exact text to copy and a
  one-call way out (`tolerar_espacios`) that readjusts the indentation to the file **line by
  line** (tabs count as tabs, not as one character). With several matches it does not choose on
  its own: it tells you how many places it found. It never applies a guess silently.

# SAGITARI 3.2.3

**El navegador por fin se puede manejar con su ventana detrás de la app.** Es el caso normal
—trabajas en SAGITARI y el navegador hace lo suyo por debajo— y era justo donde se rompía:
Windows le avisa a Chromium de que su ventana está tapada, Chromium la congela para ahorrar
batería y, a partir de ahí, cada clic y cada tipeo se quedaban esperando hasta morir con un
«CDP timeout» a los 30 segundos, sin decir por qué. Ahora el navegador se lanza con la
configuración que usa cualquier automatización profesional y ninguna espera interna puede
quedarse sin cerrar. / **The browser can finally be driven with its window behind the app.**
That is the normal case —you work in SAGITARI while the browser does its job underneath— and
it was exactly where it broke: Windows tells Chromium its window is covered, Chromium freezes
it to save power, and from then on every click and keystroke waited until it died with a “CDP
timeout” after 30 seconds, saying nothing about why. The browser now launches with the same
settings any professional automation uses, and no internal wait can hang forever.

Y el resto es lo que convierte a SAGITARI en un agente en el que se puede confiar para trabajar
de verdad: **puedes deshacer lo que hizo** (por turno o por archivo), **lee las reglas de tu
proyecto** si tienes un `SAGITARI.md` o un `AGENTS.md`, **ejecuta tus comandos** cuando escribo y
antes de cerrar el turno, **los errores de tu proyecto vuelven solos** tras cada escritura, y hay
un **banco de tareas** para medir al agente con números en vez de con sensaciones. / And the
rest is what turns SAGITARI into an agent you can trust with real work: **undo what it did**
(per turn or per file), it **follows your project's rules** when you have a `SAGITARI.md` or
`AGENTS.md`, it **runs your commands** on every write and before the turn closes, **your
project's errors come back on their own** after each write, and there is a **task bench** to
measure the agent with numbers instead of with feelings.

## Novedades / What's new

- **Deshacer, de verdad.** El trabajo del turno se puede revertir entero o archivo por archivo
  (`Deshacer` aparece en el chat en cuanto hay algo que deshacer). El agente ya guardaba cómo
  estaba cada archivo antes de tocarlo para poder revisar el cambio; ahora eso se usa también
  para devolverlo a como estaba, avisando de lo que NO se puede restaurar. / **Undo, for real.**
  A turn's work can be reverted as a whole or file by file (`Undo` appears in the chat as soon
  as there is something to undo). The agent already kept a copy of every file before touching
  it in order to review the change; now that is used to put it back, warning about what cannot
  be restored.
- **Las reglas de tu proyecto mandan.** Un `SAGITARI.md` o `AGENTS.md` en la raíz (o en
  `.sagitari/`) se lee SIEMPRE, antes de tocar nada, y también lo leen los subagentes. En
  Ajustes ▸ Agente se ve qué archivos se están leyendo (y se crea la plantilla con un botón);
  en tu carpeta de datos puedes tener un `AGENTS.md` tuyo, válido para todos los proyectos. /
  **Your project's rules win.** A `SAGITARI.md` or `AGENTS.md` at the root (or in `.sagitari/`)
  is read ALWAYS, before touching anything, and the subagents read it too. Settings ▸ Agent
  shows which files are being read (and creates the template with one button); your data folder
  can hold your own `AGENTS.md`, valid for every project.
- **Tus comandos, enganchados al agente (hooks).** Un comando tras cada escritura (formatear,
  `lint --fix`, lo que quieras: `{{file}}`, `{{files}}`, `{{dir}}` con las rutas ya entre
  comillas) y otro antes de cerrar el turno. Si el de cierre falla, el turno **no** cierra: el
  agente lee la salida y lo arregla, igual que con tus pruebas. / **Your commands, hooked into
  the agent.** One command after every write (format, `lint --fix`, whatever: `{{file}}`,
  `{{files}}`, `{{dir}}` with paths already quoted) and another before the turn closes. If the
  closing one fails, the turn does **not** close: the agent reads the output and fixes it, just
  like with your tests.
- **El agente se comprueba a sí mismo con tu proyecto.** Tras cada archivo escrito se pasan los
  comprobadores de TU proyecto (ESLint, Ruff, Flake8, Mypy…) sobre las líneas que ha cambiado y
  el fallo vuelve en el mismo paso; lo que ya estaba mal en el archivo no se le exige. Al cerrar,
  se ejecutan tus pruebas (o tu compilación) y, si fallan, el turno no termina hasta arreglarlas
  (con tope de intentos, ajustable). / **The agent checks itself against your project.** After
  every file written, YOUR project's checkers (ESLint, Ruff, Flake8, Mypy…) run over the lines it
  changed and the failure comes back in the same step; what was already wrong in the file is not
  demanded of it. On close, your tests (or your build) run and, if they fail, the turn does not
  end until they are fixed (with an adjustable retry cap).
- **Búsqueda híbrida (`search_code`).** Coincidencia exacta con ripgrep cuando está en el equipo
  (y un barrido propio cuando no) **más** un ranking por relevancia calculado en local, sin claves
  ni servicios. Sirve para las dos preguntas de siempre: «dónde se usa esto» y «dónde está lo que
  decide X», aunque no sepas cómo se llama. / **Hybrid search (`search_code`).** Exact matching
  with ripgrep when it is on the machine (with its own sweep when it is not) **plus** a relevance
  ranking computed locally, with no keys and no services. It answers both classic questions:
  “where is this used” and “where is whatever decides X”, even when you do not know its name.
- **El contexto tiene presupuesto.** Se mide lo que se manda (mensajes y las definiciones de las
  22 herramientas, que son miles de tokens que nadie cuenta) y, cuando ya no cabe, se sueltan del
  envío los bloques más antiguos —el historial y la conversación no se tocan— avisando en el chat.
  Además, la caché de prompt del proveedor se aprovecha por defecto (se puede apagar). /
  **Context has a budget.** What is sent is measured (messages plus the definitions of the 22
  tools, which are thousands of tokens nobody counts) and, when it no longer fits, the oldest
  blocks are dropped from the request —history and conversation are untouched— with a notice in
  the chat. On top of that, the provider's prompt cache is used by default (it can be turned off).
- **Banco de tareas (`npm run banco`).** Tres tareas con punto de partida, objetivo y criterio
  objetivo de éxito (las pruebas del propio proyecto de la tarea), y un informe con pasos, tokens,
  tiempo y coste. Compara con una línea base y **falla** si algo que pasaba ya no pasa: cambiar un
  prompt, una skill o la orquestación deja de ser una apuesta. / **Task bench (`npm run banco`).**
  Three tasks with a starting point, a goal and an objective success criterion (the task's own
  project tests), plus a report with steps, tokens, time and cost. It compares against a baseline
  and **fails** if something that used to pass no longer does: changing a prompt, a skill or the
  orchestration stops being a gamble.

## Interfaz / Interface

- **El razonamiento se puede leer de un vistazo.** Mientras el modelo piensa, la cabecera cuenta
  el tiempo en vivo; al plegarse queda un **resumen de una línea** de lo que estaba pensando, y
  abierto dice cuánto pensó y cuántas líneas. / **Reasoning is readable at a glance.** While the
  model thinks, the header counts time live; once collapsed it leaves a **one-line summary** of
  what it was thinking, and when opened it reports how long it thought and how many lines.
- **Las tarjetas de herramientas informan solas.** El tiempo corre mientras trabajan (un comando
  largo ya no parece colgado), un **fallo se lee en la propia cabecera** sin desplegar la tarjeta,
  y el resultado dice cuántas líneas trae antes de abrirlo. / **Tool cards report on their own.**
  The timer runs while they work (a long command no longer looks stuck), a **failure is readable in
  the header itself** without expanding the card, and the result says how many lines it carries
  before you open it.
- **El icono de la app es el de SAGITARI**, también en la barra de tareas. Comprobado en los
  binarios publicados: llevan los seis tamaños del icono de la app (16 a 256), no el de Electron.
  En desarrollo el proceso es `electron.exe`, así que ahí puede verse el de Electron: es del
  binario, no de la app. / **The app icon is SAGITARI's**, including in the taskbar. Verified on the
  published binaries: they carry all six sizes of the app icon (16 to 256), not Electron's. In
  development the process is `electron.exe`, so Electron's icon may show there: it belongs to the
  binary, not the app.

## Correcciones / Fixes

- **El navegador se cuelga 30 s por acción cuando su ventana no está delante.** Dos causas, las
  dos corregidas: una espera de pintado basada en `requestAnimationFrame` sin tope (Chromium no da
  frames a una ventana oculta, así que la promesa no se resolvía nunca) y el congelado por oclusión
  de Windows. Se arregla con los flags de automatización (`--disable-backgrounding-occluded-windows`,
  `--disable-renderer-backgrounding`, `--disable-background-timer-throttling`,
  `--disable-features=CalculateNativeWinOcclusion`) y con esperas que siempre cierran. La batería
  contra un Chrome real pasa entera en el escenario que antes fallaba. / **The browser hangs 30 s
  per action when its window is not in front.** Two causes, both fixed: a paint wait built on
  `requestAnimationFrame` with no cap (Chromium gives no frames to an occluded window, so the
  promise never resolved) and Windows' occlusion freezing. Fixed with the standard automation flags
  and with waits that always close. The suite against a real Chrome now passes fully in the
  scenario that used to fail.
- **El ciclo «prueba → falla → arreglo → repito» repetía de verdad.** El contador de intentos
  nacía sin inicializar (`undefined++` es `NaN`, y `NaN >= tope` siempre es falso), así que el tope
  no existía y la comprobación no se repetía tras un arreglo: el turno se cerraba creyendo que
  estaba comprobado. / **The “test → fail → fix → retry” cycle really retries.** The attempt counter
  was born uninitialised, so the cap did not exist and the check was not repeated after a fix.
- **Las reglas de un proyecto no entran dos veces.** En Windows `SAGITARI.md` y `sagitari.md` son el
  mismo archivo: ahora se deduplica por ruta real (antes el texto iba duplicado al prompt). / **A
  project's rules do not enter twice.** On Windows `SAGITARI.md` and `sagitari.md` are the same file:
  it is now deduplicated by real path.
- **La búsqueda exacta ya no se queda muda.** Sin ruta explícita, y con la entrada estándar siendo
  un tubo, ripgrep esperaba a que se cerrara en vez de buscar; y fuera de un repositorio de git no
  aplicaba el `.gitignore`, así que devolvía lo que el usuario tiene mandado ignorar. / **Exact
  search is no longer mute.** Without an explicit path, and with standard input being a pipe,
  ripgrep waited for it to close instead of searching; and outside a git repository it did not apply
  `.gitignore`.
- **`latest.yml` firmaba solo el instalador** (arreglado en la 3.2.2 y con verificación propia en
  el CI desde entonces). / **`latest.yml` only signed the installer** (fixed in 3.2.2, with its own
  CI verification since then).

---

# SAGITARI 3.2.2

**El portable ya puede actualizarse solo.** La app verifica cada descarga contra la firma
publicada en la release, y ese manifiesto (`latest.yml`) solo llevaba la firma del **instalador**:
quien usaba el portable descargaba los 110 MB y los veía desaparecer con un «no se pudo verificar la
descarga», sin manera de avanzar. Ahora la release publica la firma de **los dos** binarios, y el
CI **se niega a publicar** si alguno se queda sin firmar, así que no puede repetirse. / **The
portable can update itself now.** The app verifies every download against the signature published in
the release, and that manifest (`latest.yml`) only carried the **installer's** signature: portable
users downloaded 110 MB and watched them vanish with a “the download could not be verified”, with no
way forward. The release now publishes the signature of **both** binaries, and CI **refuses to
publish** if any of them is unsigned, so it cannot happen again.

> **Si vienes de la 3.1.1 o de cualquier versión anterior y usas la edición INSTALADA, este salto
> hay que hacerlo a mano UNA vez** —descarga el instalador de esta página y ejecútalo—, porque
> esas versiones llevan el lanzador del instalador roto (corregido en la 3.2.1). Si usas el
> **portable**, no hace falta: descarga el portable nuevo y sustitúyelo. / **If you are on 3.1.1 or
> any earlier version and you use the INSTALLED edition, you have to take this step by hand ONCE**
> —download the installer from this page and run it— because those versions carry the broken
> installer launcher (fixed in 3.2.1). If you use the **portable**, you do not need to: download
> the new portable and replace it.

## Correcciones / Fixes

- **La release firma todos sus binarios, no solo el instalador.** El `latest.yml` que genera
  electron-builder describe únicamente el Setup, así que el portable no tenía ninguna firma contra
  la que compararse y la app lo descartaba por seguridad —correctamente, pero sin salida—. El
  workflow ahora completa el manifiesto con la firma sha512 de **cada** `.exe` del `dist/` antes de
  publicar, y usa para ello **el mismo lector que la app** (`main/updater.js`): lo que se publica es
  exactamente lo que la app va a ver. / **The release signs all its binaries, not just the
  installer.** The `latest.yml` electron-builder generates only describes the Setup, so the portable
  had no signature to compare against and the app discarded it for safety —correctly, but with no
  way out—. The workflow now completes the manifest with the sha512 of **every** `.exe` in `dist/`
  before publishing, using **the same reader as the app** (`main/updater.js`): what is published is
  exactly what the app will look at.
- **Y no se publica a medias: el CI lo comprueba.** Antes de subir nada, el workflow verifica que
  cada binario tenga su firma en el manifiesto **y que esa firma sea la del binario** (no la de
  otro); si algo falla, la release no sale. Es el mismo gate que hoy habría parado la 3.2.1. /
  **And nothing ships half-signed: CI checks it.** Before uploading anything, the workflow verifies
  that every binary has its signature in the manifest **and that the signature is that binary's**
  (not another one's); if anything fails, the release does not go out. It is the same gate that
  would have stopped 3.2.1 today.
- **Cuando algo no se puede verificar, la app lo dice de verdad.** El aviso era «la release no
  publica latest.yml» aunque el manifiesto existiera: ahora distingue si falta el manifiesto, si no
  se pudo leer o si la release no firma **ese** archivo (con su nombre), y añade el enlace de la
  release para instalarlo a mano, así que el usuario nunca se queda en un «no se pudo descargar» sin
  saber qué hacer. / **When something cannot be verified, the app now says the truth.** The message
  used to be “the release does not publish latest.yml” even when the manifest existed: it now
  distinguishes whether the manifest is missing, could not be read, or does not sign **that** file
  (naming it), and adds the release link to install it by hand, so the user is never left with a
  “could not download” and nothing to do.

## Cómo viene probado / How it is tested

- **335 pruebas en verde**, dos nuevas: el manifiesto se completa de verdad en una carpeta de
  prueba (firma correcta de cada binario, el hash superior sigue siendo el del Setup, idempotente y
  corrige una firma equivocada) y el gate del CI **falla** si un binario se queda sin firma —la
  regresión exacta de la 3.2.1—. / **335 tests green**, two new: the manifest is really completed in
  a test folder (each binary's correct signature, the top-level hash still the Setup's, idempotent,
  and it fixes a wrong signature) and the CI gate **fails** when a binary is left unsigned —the exact
  3.2.1 regression—.
- Y el texto que ve el usuario cuando una descarga no se puede verificar, con sus cuatro casos. /
  And the message the user sees when a download cannot be verified, with its four cases.

# SAGITARI 3.2.1

**La actualización ya se instala de verdad.** Hasta ahora, pulsar **Cerrar e instalar** cerraba la
app, abría una ventana de terminal, la cerraba y no instalaba nada: al volver a abrir seguías en la
versión vieja. El motivo era una única orden de `cmd.exe` que **no llegaba a lanzar el instalador
nunca** —comprobado con un señuelo, que jamás se ejecutaba—, así que lo único que se veía era la
ventana de consola de un proceso «separado» en Windows. Ahora el instalador lo arranca un
**asistente oculto** que espera a que no quede ninguna instancia de la app y luego actualiza en
silencio, sin ventanas de por medio; y si una instalación se queda a medias, **el siguiente arranque
te lo cuenta y te deja reintentarla**. / **Updates actually install now.** Until now, pressing
**Close and install** closed the app, opened a terminal window, closed it, and installed nothing: on
reopening you were still on the old version. The cause was a single `cmd.exe` command that **never
reached the installer at all** —verified with a decoy, which was never executed—, so all you saw was
the console window of a “detached” process on Windows. The installer is now launched by a **hidden
helper** that waits until no instance of the app is left and then updates silently, with no windows
in between; and if an installation is left half-done, **the next launch tells you and lets you retry**.

> **Si vienes de la 3.2.0 o de cualquier versión anterior, este salto hay que hacerlo a mano UNA
> vez** —descarga el instalador de esta página y ejecútalo—, porque esas versiones llevan el
> lanzamiento roto y no pueden instalarse solas la corrección. A partir de ahí, el actualizador de
> la app ya funciona. / **If you are on 3.2.0 or any earlier version, you have to take this step by
> hand ONCE** —download the installer from this page and run it— because those versions carry the
> broken launcher and cannot install the fix on their own. From then on, the in-app updater works.

## Correcciones / Fixes

- **«Cerrar e instalar» ya no se queda en nada.** El instalador lo lanza un guion de PowerShell
  **oculto** que viaja en `-EncodedCommand` (base64 de UTF-16LE), así que la ruta del instalador es
  texto y no una línea de órdenes que analizar: una ruta con espacios, `&`, `/` o `%` deja de ser un
  problema, y se acabó la ventana de terminal. El asistente deja su diario en
  `%TEMP%\sagitari-update\instalar.log`. / **“Close and install” no longer does nothing.** The
  installer is launched by a **hidden** PowerShell script that travels in `-EncodedCommand`
  (UTF-16LE base64), so the installer path is text rather than a command line to be parsed: a path
  with spaces, `&`, `/` or `%` is no longer a problem, and the terminal window is gone. The helper
  keeps its log in `%TEMP%\sagitari-update\instalar.log`.
- **Se espera a que la app esté cerrada de verdad, no un margen adivinado.** El asistente espera
  (hasta 90 s, sondeo cada 400 ms) a que no quede ninguna instancia de SAGITARI y da 1,2 s de gracia
  al disco antes de lanzar el Setup con `/S --updated`. Sin esto, el instalador —que decide si hay
  una app en ejecución mirando su proceso PADRE, que era SAGITARI.exe— se saltaba su comprobación y
  se quedaba a medias con los ficheros en uso. / **It waits for the app to be really closed, not for
  a guessed margin.** The helper waits (up to 90 s, polling every 400 ms) until no SAGITARI instance
  is left and gives the disk a 1.2 s grace period before launching the Setup with `/S --updated`.
  Without it, the installer —which decides whether an app is running by looking at its PARENT
  process, which was SAGITARI.exe— skipped its check and stopped halfway with the files in use.
- **La app no se cierra si el asistente no puede arrancar.** Antes de cerrarse se comprueba que el
  ayudante sigue vivo: si muere en el primer segundo (sin PowerShell, o bloqueado por política), la
  app **sigue abierta** y te dice por qué, en vez de dejarte cerrado y sin nada instalado. / **The
  app no longer closes if the helper cannot start.** Before quitting, the app checks that the helper
  is alive: if it dies within the first second (no PowerShell, or blocked by policy), the app **stays
  open** and tells you why, instead of closing on you with nothing installed.
- **Una instalación a medias deja de ser invisible.** Como para instalar hay que cerrar la app, en
  el momento del fallo no hay a quién contárselo: el intento se anota en disco y el arranque
  siguiente, si sigues en la versión vieja, te avisa con un aviso discreto, deja el punto en Ajustes
  y ofrece **Reintentar la instalación** en **Ajustes ▸ Acerca de** (vuelve a comprobar el SHA-512
  publicado antes de relanzarla). Si el archivo descargado ya no está, la tarjeta invita a
  descargarla otra vez en vez de ofrecer un fantasma. / **A half-done installation is no longer
  invisible.** Since installing requires closing the app, at the moment of failure there is nobody
  to tell: the attempt is written to disk and, on the next launch, if you are still on the old
  version, you get an unobtrusive notice, a dot in Settings, and a **Retry the installation** button
  in **Settings ▸ About** (it re-checks the published SHA-512 before relaunching). If the downloaded
  file is gone, the card invites you to download it again instead of offering a ghost.

## Cómo viene probado / How it is tested

- El lanzamiento real se prueba **ejecutando el asistente de verdad** contra un señuelo, que ahora
  sí recibe `/S --updated` y deja su diario: el fallo original queda cubierto para que no vuelva.
  Con el guion y su escapado, el estado pendiente y sus cuatro casos, **333 pruebas en verde**. /
  The real launch is tested by **running the actual helper** against a decoy, which now does receive
  `/S --updated` and writes its log: the original failure is covered so it cannot come back. With
  the script and its escaping, the pending state and its four cases, **333 tests green**.
- En la interfaz, dos comprobaciones nuevas: la tarjeta de Ajustes pinta una instalación a medias
  con su botón **Reintentar la instalación**, y si el archivo ya no está invita a descargarla. /
  In the UI, two new checks: the Settings card renders a half-done installation with its **Retry the
  installation** button, and if the file is gone it invites you to download it again.

# SAGITARI 3.2.0

**SAGITARI deja de trabajar «a ciegas»: ahora maneja el navegador como una persona, revisa lo
que escribe y reparte el trabajo en paralelo.** Esta versión es la de la fiabilidad. El
**navegador** pasa a la versión 2 —nombres accesibles en lugar de texto invisible, componentes
web e iframes, clics que no caen donde no deben, esperas de verdad, consola y errores de red,
diálogos, subida de archivos y atajos de teclado—, el agente **comprueba el código al
escribirlo** y **un revisor lee el cambio** antes de dártelo por hecho, y las órdenes de un
mismo mensaje se ejecutan **a la vez** con un bloqueo por recurso (el navegador es uno solo, la
escritura va en cola) para que las tareas largas dejen de durar la suma de sus pasos. Y todo
eso en la interfaz: razonamiento visible opcional, tablero del equipo en vivo, separador de día
y tarjetas de herramienta que dicen qué pasó. / **SAGITARI stops working blind: it now drives
the browser like a person, reviews what it writes, and spreads work in parallel.** This is the
reliability release. The **browser** moves to v2 —accessible names instead of invisible text,
web components and iframes, clicks that never land in the wrong place, real waits, console and
network errors, dialogs, file uploads and keyboard shortcuts—, the agent **checks code as it
writes it** and **a reviewer reads the change** before handing it to you, and the orders inside
one message run **at the same time** behind a per-resource lock (there is only one browser; disk
writes queue up) so long tasks stop taking the sum of their steps. All of it visible in the UI:
optional reasoning, a live team board, a day separator, and tool cards that say what happened.

## Navegador 2 / Browser v2

- **El inventario dice el nombre REAL de cada control.** Antes se usaba el texto del elemento:
  un botón de icono salía con nombre vacío y el agente pulsaba por coordenadas a ciegas. Ahora
  se calcula el nombre accesible (`aria-label`, `aria-labelledby`, `<label for>`, `alt`,
  `title`, `placeholder`, `data-testid`, `value` de un submit), con su rol, su estado
  (deshabilitado, marcado, valor actual, obligatorio) y su `data-testid`, que es la forma en
  que las webs hechas para automatizar se identifican. / **The inventory reports the REAL name
  of every control.** It used to use the element's text, so an icon-only button came out with an
  empty name and the agent clicked by coordinates, blind. Now the accessible name is computed
  (`aria-label`, `aria-labelledby`, `<label for>`, `alt`, `title`, `placeholder`,
  `data-testid`, submit `value`), together with its role, its state (disabled, checked, current
  value, required) and its `data-testid`, which is how automation-friendly sites identify
  themselves.
- **Componentes web e iframes del mismo origen.** Shadow DOM y marcos eran invisibles: media
  interfaz moderna (editores, reproductores, formularios embebidos) no existía para el agente.
  Ahora se recorren, y cada elemento dice en qué marco está. / **Web components and same-origin
  iframes.** Shadow DOM and frames were invisible: much of the modern web (editors, players,
  embedded forms) simply did not exist for the agent. Now they are walked, and each element
  says which frame it lives in.
- **Los clics ya no caen donde no deben.** Antes de pulsar se vuelve a localizar el elemento
  **por su huella** (no por la posición que tenía), se comprueba que ha dejado de moverse y que
  **nadie lo tapa**; si algo lo tapa, el error dice QUÉ lo tapa, y si de verdad hay que pulsarlo
  (un aviso de cookies pegado encima), `force` lo hace. Lo que está por debajo del pliegue se
  marca como «fuera de pantalla» y se trae a la vista al clicar, en vez de obligar al modelo a
  adivinar el scroll. / **Clicks no longer land in the wrong place.** Before pressing, the
  element is located again **by its fingerprint** (not by the position it had), it is checked
  that it stopped moving and that **nothing covers it**; if something does, the error says WHAT
  covers it, and if it truly must be pressed (a cookie banner stuck on top), `force` does it.
  Anything below the fold is flagged as “off screen” and scrolled into view when clicked,
  instead of forcing the model to guess the scroll.
- **Esperar sin dormir.** `wait_for` espera a que aparezca un texto, un selector, un título o
  una URL —o a que desaparezca algo—, con tiempo límite, y si no llega explica en qué estado
  quedó la página en vez de seguir como si nada. / **Waiting without sleeping.** `wait_for`
  waits for a text, selector, title or URL to appear —or for something to disappear—, with a
  deadline, and if it never comes it explains the state the page was left in instead of carrying
  on as if nothing had happened.
- **Se puede depurar la web que el propio agente abre.** `logs` devuelve la consola, las
  excepciones, las peticiones que fallaron (404/500) y las descargas; los diálogos de la página
  (`alert`, `confirm`, `prompt`) se detectan, se avisan en el resultado y se contestan con
  `dialog` en vez de dejar la página pausada y el turno colgado. / **You can debug the site the
  agent itself opens.** `logs` returns console output, exceptions, failed requests (404/500) and
  downloads; page dialogs (`alert`, `confirm`, `prompt`) are detected, announced in the result
  and answered with `dialog` instead of leaving the page paused and the turn hanging.
- **Actuar como una persona.** `select` (opción por valor, texto o posición), `check` para
  casillas, `hover` para menús, `hotkey` para atajos (`Ctrl+Shift+T`, `Alt+ArrowLeft`…), `upload`
  para subir archivos, `back`/`forward`/`reload` sobre el historial real, captura de un elemento
  concreto y descargas guardadas en una carpeta conocida que se dice en el resultado. `type`
  escribe tecla a tecla en textos cortos (las webs que validan al escribir no ven el pegado) y
  **devuelve lo que quedó escrito**: si el sitio recortó por `maxlength` o una máscara, lo dices
  tú y no lo descubre tres pasos después. / **Acting like a person.** `select` (option by value,
  text or position), `check` for boxes, `hover` for menus, `hotkey` for shortcuts
  (`Ctrl+Shift+T`, `Alt+ArrowLeft`…), `upload` for files, `back`/`forward`/`reload` on the real
  history, screenshots of a single element, and downloads saved to a known folder that is
  reported in the result. `type` types key by key for short texts (sites that validate as you
  type never see a paste) and **returns what ended up in the field**: if the site trimmed it via
  `maxlength` or a mask, you hear it right away instead of three steps later.
- **Subir un archivo y aceptar un diálogo piden permiso siempre.** Lo primero manda datos tuyos
  a una web y lo segundo puede confirmar algo destructivo: ninguna de las dos se hace sin
  preguntar. / **Uploading a file and accepting a dialog always ask for permission.** The first
  sends your data to a website and the second can confirm something destructive: neither happens
  without asking.

## Trabajo en paralelo y por recursos / Parallel work and resource locks

- **Las órdenes de un mismo mensaje se ejecutan a la vez.** Si el modelo pide tres lecturas, dos
  investigaciones o un comando y una captura, ya no van una detrás de otra: salen en paralelo
  (hasta 3 por defecto, ajustable de 1 a 4 en Ajustes ▸ Delegación y verificación) y los
  resultados vuelven al modelo en el orden que pidió. / **Orders in the same message run
  together.** If the model asks for three reads, two investigations or a command plus a
  screenshot, they no longer run one after another: they go in parallel (3 by default, adjustable
  from 1 to 4 in Settings ▸ Delegation and verification) and results come back to the model in
  the order it asked.
- **Bloqueo por recurso, para que el paralelismo no rompa nada.** Hay cosas que no se pueden
  compartir: el navegador es **una sola instancia** (dos clics a la vez se pisan la pestaña y el
  inventario de elementos), la **escritura** en disco va en cola y la **terminal** admite dos
  comandos a la vez. Lo que no choca no espera: leer un archivo no bloquea a quien escribe. Y el
  orden de adquisición es canónico, así que no hay interbloqueos. / **Per-resource locks, so
  parallelism breaks nothing.** Some things cannot be shared: there is only **one browser
  instance** (two clicks at once trip over the active tab and the element inventory), **disk
  writes** queue up, and the **terminal** takes two commands at once. What does not collide does
  not wait: reading a file never blocks whoever is writing. Acquisition order is canonical, so
  there are no deadlocks.
- **Detener mata TODO lo que esté en vuelo.** Antes solo alcanzaba a la herramienta actual;
  ahora mueren las que estén corriendo a la vez y también los subagentes en paralelo. Y lo que
  aún esperaba su turno de recurso **ya no se ejecuta después de la parada** (el semáforo no
  sabe nada del abort: hasta dos clics encolados detrás del navegador salían con la app ya
  detenida). / **Stop kills EVERYTHING in flight.** It used to reach only the current tool; now
  it takes down the ones running side by side and the parallel subagents too. And whatever was
  still waiting for its resource turn **no longer runs after the stop** (the semaphore knows
  nothing about the abort: up to two clicks queued behind the browser used to go off with the
  app already stopped).

## El código sale con red / Code ships with a safety net

- **Sabe cómo se comprueba TU proyecto.** Detecta con qué se ejecutan los tests, la compilación
  y el lint (Node con su gestor por fichero de bloqueo, Python, Rust, Go, .NET…) y lo pone en el
  prompt, del orquestador y de cada subagente; solo nombra los comandos que existen. / **It knows
  how YOUR project is verified.** It detects what runs tests, builds and lint (Node with its
  lockfile package manager, Python, Rust, Go, .NET…) and puts it in the prompt, for the
  orchestrator and for every subagent; it only names commands that exist.
- **La sintaxis se comprueba al escribir.** Cada archivo escrito o editado se valida al
  instante: si no compila, el error vuelve en el mismo paso —cuando el modelo aún tiene el
  contexto— y la tarjeta se marca en rojo en vez de dar el cambio por bueno. / **Syntax is
  checked as it writes.** Every written or edited file is validated immediately: if it does not
  compile, the error comes back in the same step —while the model still has the context— and the
  card turns red instead of calling the change done.
- **Un revisor lee el cambio antes de cerrar.** El turno guarda el diff de lo modificado
  (también lo que tocaron los subagentes), y antes de dártelo por hecho un agente de revisión
  busca contratos rotos, casos límite y restos del nombre viejo; el hallazgo bloqueante se
  arregla en ese mismo turno. Va en la **misma ronda** que la verificación del resultado, para
  que dos comprobaciones cuesten una vuelta y no dos. Se apaga en Ajustes ▸ Delegación y
  verificación. / **A reviewer reads the change before closing.** The turn keeps the diff of
  everything modified (including what subagents touched), and before handing it to you a review
  agent looks for broken contracts, missed edge cases and leftovers of the old name; a blocking
  finding is fixed in that same turn. It rides in the **same round** as result verification, so
  two checks cost one extra round instead of two. Turn it off in Settings ▸ Delegation and
  verification.
- **Ediciones de varios archivos, atómicas.** `apply_patch` comprueba todos los anclajes y solo
  entonces escribe: o entran todos los archivos o no entra ninguno (antes, un refactor de cinco
  archivos podía dejar el proyecto a medias). / **Multi-file edits, atomic.** `apply_patch`
  checks every anchor and only then writes: either all files go in or none does (before, a
  five-file refactor could leave the project half-done).
- **Mapa del proyecto para no leer a ciegas.** `repo_map` y `find_symbol` indexan archivos y
  símbolos (sin `node_modules`, binarios ni archivos enormes): «¿qué hay aquí?» y «¿dónde se
  define X?» se responden sin abrir nada. / **Project map instead of blind reading.**
  `repo_map` and `find_symbol` index files and symbols (no `node_modules`, binaries or huge
  files): “what is in here?” and “where is X defined?” are answered without opening anything.

## Agente, equipo e interfaz / Agent, team and UI

- **Razonamiento visible (opcional).** Los modelos que razonan enseñan su proceso en un bloque
  plegable sobre la respuesta; se lee en vivo, se pliega al empezar a contestar, **nunca se lee
  en voz alta** y no ensucia al copiar. Ajustes ▸ Agente. / **Optional visible reasoning.**
  Reasoning models show their process in a collapsible block above the answer; it streams live,
  folds when the answer starts, is **never read out loud** and stays out of copied text.
  Settings ▸ Agent.
- **Tablero del equipo en el chat.** Cada delegación se ve **en vivo** con su subtarea y su
  criterio, se resuelve con OK, «a medias» o fallo, y al acabar queda su tarjeta con resultado,
  detalles, evidencia y duración. / **Live team board in the chat.** Every delegation is visible
  **while it runs**, with its subtask and success criterion, resolves to OK, partial or failed,
  and leaves a card with result, details, evidence and duration.
- **Skills dentro de cada agente.** Cada subagente recibe el índice de las skills de su
  especialidad y las carga solo cuando le hacen falta; su método de trabajo y lo que debe
  entregar ya no son genéricos. / **Skills inside every agent.** Each subagent gets the index of
  the skills for its specialty and loads them only when needed; its working method and its
  deliverable are no longer generic.
- **La interfaz dice qué pasó.** Separador de día real (no una marca entre cada pregunta y su
  respuesta), cabecera del grupo de herramientas con cuántas van en curso y si algo falló, y
  plegado automático del detalle al llegar la respuesta. / **The UI says what happened.** A real
  day separator (not a stamp between every question and its answer), a tool-group header showing
  how many are running and whether anything failed, and automatic folding of the details once
  the answer arrives.

## Coste y estabilidad / Cost and stability

- **Menos lecturas y menos tokens por turno.** El índice de skills y el mapa del proyecto se
  sirven de memoria (invalidados al escribir) en vez de releerse del disco en cada paso, y
  `use_skill` no vuelve a mandar el cuerpo entero de una skill ya cargada en el turno. / **Fewer
  reads and fewer tokens per turn.** The skills index and the project map are served from memory
  (invalidated on write) instead of being re-read from disk at every step, and `use_skill` no
  longer resends the full body of a skill already loaded in the turn.
- **Prompt pensado para la caché.** Lo estable (identidad, reglas, proyecto, mapa) va primero y
  lo volátil (memoria, hábitos, skills sugeridas) al final, para que el prefijo se reutilice en
  proveedores con caché de prompt. / **Cache-friendly prompt.** Stable content (identity, rules,
  project, map) goes first and volatile content (memory, habits, suggested skills) last, so the
  prefix is reused on providers with prompt caching.
- **Un subagente ya no muere por un fallo del proveedor.** Hereda la cadena de modelos: si el
  primero devuelve un 500, sigue con el siguiente en vez de tirar treinta pasos de trabajo. / **A
  subagent no longer dies on a provider hiccup.** It inherits the model chain: if the first one
  returns a 500, it moves to the next instead of throwing away thirty steps of work.
- **Frenos explícitos.** Tope de subagentes por turno (configurable, con aviso claro y sin cortar
  la tarea), tope de llamadas, detección de bucle y de estancamiento, y un resumen rodante que
  conserva lo importante de hilos largos en vez de cortar el principio en seco. / **Explicit
  brakes.** A per-turn subagent cap (configurable, clearly announced, never cutting the task),
  a tool-call cap, loop and stall detection, and a rolling summary that keeps what matters from
  long threads instead of cutting the beginning off.

## Comprobado antes de publicar / Verified before publishing

- **330 tests unitarios**, la comprobación de interfaz sobre la app viva (iconos, cableado,
  navegación, delegación, razonamiento, revisión del cambio) y el arranque real de la app. / **330
  unit tests**, the UI check against the live app (icons, wiring, navigation, delegation,
  reasoning, change review) and a real app launch.
- **Y el navegador, contra un navegador de verdad**: 29 comprobaciones en un Chrome real con una
  página de prueba que incluye componentes web, iframes, un botón tapado, uno fuera de pantalla,
  un `confirm()` y errores de consola —`npm run navcheck`—. / **And the browser tool, against a
  real browser**: 29 checks in a real Chrome with a test page that includes web components,
  iframes, a covered button, an off-screen one, a `confirm()` and console errors — `npm run
  navcheck`.
# SAGITARI 3.1.1

**La voz vuelve a funcionar en la app instalada y en el portable.** En la 3.1.0, los guiones
que dan voz y oído a la app (`tts.ps1` y `voice.ps1`) se empaquetaban dentro del archivo `.asar`
y Windows no sabe leer ahí: PowerShell rechazaba la ruta con «El argumento … no existe», así que
la app no podía leer nada en voz alta ni arrancar el dictado. Solo pasaba en las versiones
compiladas —en desarrollo no hay asar—, que es justo donde no se veía. / **Voice works again in
the installed app and in the portable.** In 3.1.0 the scripts that give the app its voice and
hearing (`tts.ps1` and `voice.ps1`) were packed inside the `.asar` archive, and Windows cannot
read there: PowerShell rejected the path with “The argument … does not exist”, so the app could
not read anything out loud nor start dictation. It only happened in the built versions —in
development there is no asar—, which is exactly where it went unnoticed.

## Correcciones / Fixes

- **Los guiones de voz salen del asar y el motor resuelve siempre una ruta real.** Los `.ps1`
  se empaquetan desempaquetados (`asarUnpack`) y, si por lo que sea no hay copia desempaquetada,
  el contenido se deja en caché en una ruta real antes de entregársela a PowerShell. Cubre los
  dos guiones —hablar y dictar— y también el dictado clásico de la app, que apuntaba al mismo
  sitio. / **The voice scripts now live outside the asar and the engine always resolves a real
  path.** The `.ps1` files ship unpacked (`asarUnpack`) and, should there be no unpacked copy,
  the content is cached at a real path before handing it to PowerShell. This covers both
  scripts —speaking and dictation— and also the app's classic dictation, which pointed to the
  same place.
- **Los servidores MCP locales funcionan sin tener Node.js instalado.** Un servidor con
  `"command": "node"` —lo que traen los ajustes importados de otros clientes— moría con un
  «spawn node ENOENT» en cualquier equipo sin Node. Ahora se usa el Node del equipo si existe
  y, si no, el que la propia app lleva dentro; y si el comando es `npx`/`npm`, que sí necesitan
  una instalación real, se dice qué falta y cómo resolverlo en vez de fallar dentro de cmd.exe.
  / **Local MCP servers work without Node.js installed.** A server with `"command": "node"`
  —what imported settings from other clients contain— died with a “spawn node ENOENT” on any
  machine without Node. Now the machine's Node is used when it exists and otherwise the one
  the app itself carries; and if the command is `npx`/`npm`, which do need a real install, the
  app says what is missing and how to fix it instead of failing inside cmd.exe.

# SAGITARI 3.1.0

**Habla con SAGITARI y conecta tus propios servidores MCP.** Esta versión trae dos capacidades
grandes y una tanda de correcciones de fondo. El **modo voz** convierte el micrófono en una
forma completa de usar la app: hablas, el asistente hace el trabajo en tu PC y te contesta en
voz alta, con voz neuronal local y dictado local de alta precisión que se instalan a petición
(nada de tu voz sale del equipo). Y la **integración de MCP** deja que añadas tus propios
servidores —comandos locales o URLs remotas— para que el agente use sus herramientas como las
de casa: mismo catálogo, mismas confirmaciones, mismos guardarraíles. / **Talk to SAGITARI and
plug in your own MCP servers.** This version brings two big capabilities plus a round of
deep fixes. **Voice mode** turns the microphone into a complete way of using the app: you
speak, the assistant does the work on your PC and answers out loud, with a local neural voice
and high-accuracy local dictation installed on demand (none of your voice leaves the machine).
And **MCP integration** lets you add your own servers —local commands or remote URLs— so the
agent uses their tools like its own: same catalog, same confirmations, same guardrails.

## Modo voz / Voice mode

- **Manos libres de verdad.** Pulsar el micrófono abre el modo voz: hablas, el silencio cierra
  la frase, se envía al agente y la respuesta se dice en voz alta. Mientras responde, el orbe
  late con su voz; si hablas encima, se calla al instante y te escucha, sin perder tu primera
  sílaba. / **Real hands-free.** Pressing the mic opens voice mode: you talk, silence closes the
  sentence, it is sent to the agent and the answer is spoken out loud. While it answers, the
  orb pulses with its voice; if you talk over it, it shuts up instantly and listens, without
  losing your first syllable.
- **Empieza a hablar en cuanto tiene la primera frase.** La respuesta se lee por frases según
  el modelo la va escribiendo, no al terminar el turno: en una tarea con herramientas eso son
  decenas de segundos de espera que ya no existen. Y puedes **pararlo** diciendo «para» o con
  el botón **Parar** del panel. / **It starts speaking as soon as it has the first sentence.**
  The reply is read sentence by sentence as the model writes it, not at the end of the turn:
  on a task that uses tools that used to be tens of seconds of waiting. And you can **stop it**
  by saying “para” or with the panel's **Parar** button.
- **Voz neuronal local (Piper), sin depender de la voz de Windows.** Se instala desde Ajustes
  (≈80 MB, descarga única) y suena a persona, 100% offline. Cuando está instalada manda ella;
  si no, la app usa la mejor voz del sistema avisando de cuál está sonando. / **Local neural
  voice (Piper), no dependency on the Windows voice.** Installed from Settings (≈80 MB, one-off
  download) and it sounds like a person, 100% offline. Once installed it takes over; otherwise
  the app uses the best system voice and tells you which one is playing.
- **Dictado local de alta precisión (Whisper).** Transcripción en español 100% local y sin
  internet, con **texto en vivo mientras hablas** y el modelo que de verdad entiende (≈190 MB,
  a petición). El reconocimiento de Windows sigue de respaldo, y si su motor moderno arranca
  sordo —cambio de micrófono, filtros de audio— la app lo detecta y cambia al clásico sola. /
  **High-accuracy local dictation (Whisper).** 100% local, offline Spanish transcription with
  **live text while you speak** and the model that actually understands you (≈190 MB, on
  demand). Windows speech recognition stays as fallback, and if its modern engine starts up
  deaf —changed microphone, audio filters— the app notices and switches to the classic one by
  itself.
- **La transcripción se ve y se corrige.** Cada frase queda en pantalla con su nivel de
  confianza; si el motor oyó mal un nombre propio, la tocas, la arreglas y Enter la reenvía por
  el mismo camino. / **The transcript is visible and editable.** Every sentence stays on screen
  with its confidence level; if the engine got a proper noun wrong, you tap it, fix it and Enter
  sends it again through the same path.
- **Los permisos se contestan hablando.** Cuando el agente pide permiso para una acción
  sensible, el aviso sale en el panel y se contesta con «sí» o «no» (o con los botones): las dos
  puertas acaban en la misma decisión. / **Permissions are answered by voice.** When the agent
  asks for permission for a sensitive action, the request shows up in the panel and is answered
  with “sí” or “no” (or with the buttons): both doors lead to the same decision.
- **El modo voz no tiene camino propio al agente.** Lo que dictas entra por el MISMO envío del
  chat, así que hereda herramientas, permisos, guardarraíles, memoria e historial. El micrófono
  solo vive con el modo abierto, y el permiso de micrófono se concede solo a la página de la
  app. Nada de audio ni de texto sale del equipo. / **Voice mode has no path of its own to the
  agent.** What you dictate goes through the SAME chat send, so it inherits tools, permissions,
  guardrails, memory and history. The microphone only lives while the mode is open, and the mic
  permission is granted only to the app's own page. No audio or text leaves your machine.

## Servidores MCP / MCP servers

- **Cliente MCP propio, sin dependencias nuevas.** Transporte `stdio` (procesos locales) y HTTP
  remoto con streaming y SSE, con validación de URL, sesión y errores legibles. / **Own MCP
  client, no new dependencies.** `stdio` transport (local processes) and remote HTTP with
  streaming and SSE, with URL validation, session handling and readable errors.
- **Las herramientas MCP son herramientas de casa.** Aparecen en el catálogo como las nativas
  (`mcp__servidor__herramienta`), con su tarjeta de confirmación, su resultado en el registro y
  su coste de pasos igual que cualquier otra. No hay vía lateral: si el motor de permisos no la
  ve, no se ejecuta. / **MCP tools are first-class tools.** They show up in the catalog like the
  native ones (`mcp__server__tool`), with their confirmation card, their result in the log and
  their step cost like any other. There is no side door: if the permission engine does not see
  it, it does not run.
- **Permiso explícito por defecto, con niveles.** Cada llamada pide confirmación salvo que tú
  subas la confianza de un servidor o de una herramienta concreta, y el interruptor global
  apaga también las herramientas que se le ofrecen al modelo. / **Explicit permission by
  default, with levels.** Every call asks for confirmation unless you raise the trust for a
  server or a specific tool, and the global switch also removes those tools from the model's
  catalog.
- **Ajustes › MCP:** lista con el estado de cada servidor, formulario guiado, botón **Probar**
  (conecta y lista sus herramientas de verdad), registro por servidor, importar/exportar el
  bloque `mcpServers` de otros clientes y reconexión al reencender. / **Settings › MCP:** list
  with each server's state, guided form, **Test** button (really connects and lists its tools),
  per-server log, import/export of the `mcpServers` block from other clients and reconnect on
  re-enable.
- **Credenciales cifradas con DPAPI**, como las claves de API, y **Detener** corta una llamada
  MCP en vuelo. / **Credentials encrypted with DPAPI**, like API keys, and **Stop** cancels an
  in-flight MCP call.

## Correcciones y dureza / Fixes and hardening

- **Un guardarraíl podía inutilizar la sesión** y una lectura SSE incompleta tiraba respuestas
  enteras: ambos corregidos, con la confirmación de clics por índice y el estado compartido del
  navegador arreglados. / **A guardrail could make the session unusable** and an incomplete SSE
  read dropped whole answers: both fixed, along with click confirmation by index and the shared
  browser state.
- **No se pierden conversaciones ni claves** al cerrar el turno o la app, y el sistema de
  adjuntos es un módulo probado. / **Conversations and keys are no longer lost** when a turn or
  the app closes, and attachments are now a tested module.
- **El modelo que eliges manda.** El router ya no rellena por categoría en silencio, y un
  proveedor que acepta la conexión pero deja de enviar datos corta el turno solo con un error
  legible y un botón **Reintentar**. / **The model you choose wins.** The router no longer fills
  in by category behind your back, and a provider that accepts the connection but stops sending
  data cuts the turn off by itself with a readable error and a **Retry** button.
- **El navegador espera a que la página cargue de verdad** (se habilita el dominio `Page` y se
  espera al compromiso de la navegación), en vez de dar por cargada una página a medias. /
  **The browser waits for the page to actually load** (the `Page` domain is enabled and it waits
  for the navigation commit) instead of calling a half-loaded page ready.
- **Verificación más honesta:** la suite de tests es determinista y no toca tus datos reales, la
  comprobación de interfaz tiene límite de tiempo y el smoke test da un veredicto real. 268
  comprobaciones unitarias más la comprobación sobre la app viva pasan antes de publicar. /
  **More honest verification:** the test suite is deterministic and never touches your real data,
  the UI check has a deadline and the smoke test gives a real verdict. 268 unit checks plus the
  live-app check pass before publishing.

## Descargas / Downloads

| Archivo / File | Descripción / Description |
|---|---|
| `SAGITARI-Setup-3.1.0.exe` | **Instalador / Installer** (NSIS): accesos directos, desinstalador / shortcuts, uninstaller |
| `SAGITARI-Portable-3.1.0.exe` | **Portable**: un solo ejecutable, sin instalación / single executable, no install |
| `Source code (zip/tar.gz)` | Código fuente / Source code |

> Binario sin firmar: Windows SmartScreen puede avisar en la primera ejecución (*Más información → Ejecutar de todas formas*). La app te dice si la actualización que descarga está firmada o no. Los motores de voz y de dictado locales **no** van dentro del instalador: se descargan a petición desde Ajustes y se pueden borrar. / Unsigned binary: SmartScreen may warn on first run (*More info → Run anyway*). The app tells you whether the update it downloads is signed. The local voice and dictation engines are **not** bundled in the installer: they are downloaded on demand from Settings and can be removed.

# SAGITARI 3.0.1

**El router respeta tu modelo elegido y los proveedores mudos no cuelgan el chat.** La cadena de
fallback reelegía modelo por categoría en cada turno: con mimo-v2.5 seleccionado, una petición
«simple» viajaba a deepseek-flash y los fallos de ese modelo parecían «este modelo no funciona».
Y un proveedor que aceptaba la conexión sin enviar datos dejaba el turno «ocupado» para siempre,
ignorando todo lo que escribieras después. Ahora el modelo de Ajustes manda (el router solo rellena
cuando no hay elección explícita), el silencio del proveedor se corta solo a los ~2 min con error
legible y botón «Reintentar», y las tareas largas quedan recuperables si el modelo deja de mandar
datos. / **The router respects your chosen model and silent providers no longer hang the chat.**
The fallback chain re-picked a model per task category on every turn: with mimo-v2.5 selected, a
"simple" request went to deepseek-flash and that model's failures looked like "this model doesn't
work". And a provider that accepted the connection without sending data left the turn "busy"
forever, ignoring everything you typed next. The Settings model now wins (the router only fills in
when there is no explicit choice), provider silence cuts itself off after ~2 min with a readable
error and a Retry button, and long tasks stay recoverable if the model stops sending data.

## Descargas / Downloads

| Archivo / File | Descripción / Description |
|---|---|
| `SAGITARI-Setup-3.0.1.exe` | **Instalador / Installer** (NSIS): accesos directos, desinstalador / shortcuts, uninstaller |
| `SAGITARI-Portable-3.0.1.exe` | **Portable**: un solo ejecutable, sin instalación / single executable, no install |
| `Source code (zip/tar.gz)` | Código fuente / Source code |

> Binario sin firmar: Windows SmartScreen puede avisar en la primera ejecución (*Más información → Ejecutar de todas formas*). La app te dice si la actualización que descarga está firmada o no. / Unsigned binary: SmartScreen may warn on first run (*More info → Run anyway*). The app tells you whether the update it downloads is signed.

# SAGITARI 3.0.0

**Glow del marco corregido:** el aura vuelve a renderizarse de forma consistente, con un halo suave, visible y sin bloquear la interacción de la ventana. También se corrige la muestra de color del glow en Ajustes. / **Frame glow fixed:** the aura now renders consistently with a soft, visible halo without blocking window interaction. The glow color preview in Settings is fixed too.

**Seguridad y fiabilidad / Security and reliability:** se cierran dos vías que podían costar
caro (el borrado del directorio de datos desde una skill y la instalación de una actualización
sin verificar) y se corrigen los fallos que hacían perder trabajo: la pausa que no guardaba el
punto de control, el coste por modelo que siempre marcaba cero, las confirmaciones que se
quedaban colgadas y el navegador que quedaba inservible tras un cierre brusco. / **Security and
reliability:** two potentially expensive holes are closed (wiping the data directory from a
skill, and installing an unverified update) and the bugs that lost work are fixed: pause not
saving its checkpoint, per-model cost always reading zero, confirmations hanging and the
browser becoming unusable after a hard exit.

## Descargas / Downloads

| Archivo / File | Descripción / Description |
|---|---|
| `SAGITARI-Setup-3.0.0.exe` | **Instalador / Installer** (NSIS): accesos directos, desinstalador / shortcuts, uninstaller |
| `SAGITARI-Portable-3.0.0.exe` | **Portable**: un solo ejecutable, sin instalación / single executable, no install |
| `Source code (zip/tar.gz)` | Código fuente / Source code |

> Binario sin firmar: Windows SmartScreen puede avisar en la primera ejecución (*Más información → Ejecutar de todas formas*). La app te dice si la actualización que descarga está firmada o no. / Unsigned binary: SmartScreen may warn on first run (*More info → Run anyway*). The app tells you whether the update it downloads is signed.

## Seguridad / Security

- **Los ids de skill se validan resolviendo la ruta.** `deleteSkill('..')` podía resolver a la
  carpeta de datos y borrarla entera: configuración, claves de API y conversaciones incluidas. /
  **Skill ids are validated by resolving the path.** `deleteSkill('..')` could resolve to the
  data folder and wipe it whole: settings, API keys and conversations included.
- **`open_url` solo abre `http(s)`.** En Windows `shell.openExternal` invoca el manejador del
  sistema, así que `file://`, `ms-msdt:` o `javascript:` abrían cualquier cosa sin que lo vieras. /
  **`open_url` only opens `http(s)`.** On Windows `shell.openExternal` invokes the OS handler, so
  `file://`, `ms-msdt:` or `javascript:` could open anything without you seeing it.
- **Leer el portapapeles, ejecutar JS en la página y cambiar de perfil de navegador piden
  confirmación** aunque su herramienta esté configurada como automática. / **Reading the
  clipboard, running JS in the page and switching browser profiles always ask first**, even if
  their tool is set to run automatically.
- **Un subagente no puede usar herramientas fuera de su lista**, y una herramienta inventada por
  el modelo ya no llega a pedirte permiso. / **A subagent cannot use tools outside its list**,
  and a made-up tool no longer reaches you as a permission request.
- **Los triggers de una skill importada se tratan como texto, no como expresión regular**: un
  patrón remoto podía congelar la app en cada mensaje. / **Triggers from an imported skill are
  plain text, not a regular expression**: a remote pattern could freeze the app on every message.
- **El actualizador descarta cualquier descarga sin firma SHA-512 publicada** y vuelve a
  comprobar el hash justo antes de ejecutar el instalador. Además te dice si el binario tiene
  firma digital y quién lo firma. / **The updater discards any download without a published
  SHA-512** and re-checks the hash right before running the installer. It also tells you whether
  the binary is digitally signed and by whom.
- **Las claves de API se guardan cifradas** con el almacén del sistema (DPAPI en Windows). Un
  `config.json` copiado o sincronizado ya no expone tus credenciales. / **API keys are stored
  encrypted** with the system keychain (DPAPI on Windows). A copied or synced `config.json` no
  longer exposes your credentials.

## Correcciones / Fixes

- **Si el proveedor deja de enviar datos, el turno se corta solo y te lo dice.** Antes, un modelo
  que aceptaba la conexión y no mandaba nada dejaba el chat «ocupado» para siempre: lo que
  escribías después se ignoraba con «SAGITARI está ocupado» y había que adivinar que tocaba
  pulsar Detener. Ahora hay un límite de silencio configurable (Ajustes › Seguridad › «Sin
  respuesta del modelo») y, si una tarea larga atraviesa un hueco sin datos, el guardarraíl la
  detiene y queda recuperable en Tareas. / **If the provider stops sending data, the turn cuts
  itself off and tells you.** A model that accepted the connection and then went silent used to
  leave the chat "busy" forever: anything you typed next was ignored with "SAGITARI está ocupado"
  and you had to guess that Stop was the way out. There is now a configurable silence limit
  (Settings › Security › "No answer from the model"), and a long task crossing a data gap is
  stopped by the guardrail and stays recoverable in Tasks.
- **El router ya no cambia tu modelo elegido por otro en silencio.** La cadena de fallback
  reelegía modelo por categoría en cada turno: con p. ej. mimo-v2.5 seleccionado, una petición
  «simple» viajaba a deepseek-flash (coincidía con el patrón de modelos rápidos) y los fallos de
  ese modelo parecían «este modelo no funciona». Ahora el modelo elegido en Ajustes manda y el
  router solo rellena cuando no hay elección explícita. / **The router no longer swaps your
  chosen model silently.** The fallback chain re-picked a model per task category on every turn:
  with e.g. mimo-v2.5 selected, a "simple" request went to deepseek-flash (it matched the
  fast-model pattern) and that model's failures looked like "this model doesn't work". The model
  chosen in Settings now wins; the router only fills in when there is no explicit choice.
- **La firma digital del binario se informa aunque abras la app desde PowerShell 7.** Windows
  PowerShell 5.1 heredaba de ahí su lista de módulos, dejaba de encontrar
  `Get-AuthenticodeSignature` y la firma se informaba como «no se pudo consultar», justo el dato
  que te dice si lo que vas a instalar está firmado. / **The binary's digital signature is
  reported even if you open the app from PowerShell 7.** Windows PowerShell 5.1 inherited that
  process's module list, could no longer find `Get-AuthenticodeSignature` and reported the
  signature as "couldn't check" — the very fact that tells you whether what you are about to
  install is signed.
- **Pausar durante la respuesta guarda el punto de control.** Antes la tarea quedaba marcada como
  interrumpida y se perdía la reanudación. / **Pausing mid-answer saves the checkpoint.** The task
  used to be marked as interrupted and resumption was lost.
- **El panel de salud por modelo muestra el coste real**, que siempre aparecía como 0,0000. / **The
  per-model health panel shows the real cost**, which always read 0.0000.
- **Esperar tu decisión en una tarjeta de confirmación ya no agota el límite de duración**, y las
  confirmaciones de varias tareas en segundo plano se atienden en cola en vez de pisarse. / **Waiting
  for your answer on a confirmation card no longer eats the duration limit**, and confirmations
  from several background tasks queue up instead of overwriting each other.
- **Una confirmación ya no puede quedarse colgada** al repintarse la vista: la promesa se resuelve
  siempre. / **A confirmation can no longer hang** when the view is repainted: the promise always
  resolves.
- **Los argumentos ilegibles de una herramienta devuelven un error** en vez de ejecutarla con
  valores vacíos. / **Unreadable tool arguments return an error** instead of running the tool with
  empty values.
- **El navegador se recupera tras un cierre brusco de la app** (lee el puerto que dejó Chrome en
  el perfil) y ya no puede matar por error un proceso ajeno al cambiar de perfil. / **The browser
  recovers after a hard exit** (it reads the port Chrome left in the profile) and can no longer
  kill an unrelated process by mistake when switching profiles.
- **El botón Detener cancela también los procesos** de abrir aplicaciones, gestión de ventanas y
  multimedia, no solo los comandos de terminal. / **The Stop button also cancels** app-launching,
  window-management and media processes, not just terminal commands.
- **La carpeta de logs respeta sus topes**: dos fallos en la rotación (nombres repetidos y poda
  prematura) dejaban ficheros creciendo sin control. / **The logs folder respects its limits**: two
  rotation bugs (repeated names and premature pruning) let files grow unbounded.
- **Los puntos de estado vuelven a verse** (tareas falladas y salud del modelo), la búsqueda de
  Ajustes cuenta solo el panel visible, el plan no reinicia su progreso al repintarse y un fallo
  interno muestra un aviso en vez de una burbuja roja en el chat. / **Status dots are visible
  again** (failed tasks and model health), settings search only counts the visible panel, the plan
  no longer resets its progress when repainted, and an internal failure shows a notice instead of
  a red bubble in the chat.

## Actualizaciones / Updates

El actualizador integrado comprueba si hay versión nueva, avisa sin interrumpir, verifica la
descarga con **SHA-512** y, desde esta versión, **rechaza el archivo si la release no publica esa
firma** en lugar de instalarlo sin comprobar nada. También informa del estado de la firma digital
del binario y solo instala cuando tú lo pides. / The in-app updater checks for a new version,
notifies discreetly, verifies the download with **SHA-512** and, from this version on, **rejects
the file if the release does not publish that signature** instead of installing it unchecked. It
also reports the binary's digital signature status and installs only when you ask it to.

## Verificación / Verification

- `npm test`: **163 tests en verde** / **163 tests passing**, con regresiones para cada corrección de esta versión. / with regressions for every fix in this release.
- `npm run smoke`: la app arranca de verdad / the app really starts.
- `npm run uicheck`: 28 comprobaciones sobre la interfaz viva (iconos, cableado, navegación, modo,
  tamaño mínimo) — y ahora corre en la CI antes de publicar. / 28 checks against the live UI
  (icons, wiring, navigation, mode, minimum size) — and it now runs in CI before publishing.
- `node --check` de todos los módulos, y el tag de la release debe coincidir con la versión de
  `package.json` o el workflow aborta. / `node --check` on every module, and the release tag must
  match the `package.json` version or the workflow aborts.
- SHA-256 de los ejecutables calculado automáticamente por el workflow de CI al publicar. /
  Executable SHA-256 hashes computed automatically by the CI workflow when publishing.

## Requisitos / Requirements

- Windows 10/11 · Proveedor de IA compatible (OpenCode Go, OpenRouter, Groq, OpenAI,
  Anthropic, Ollama local, LM Studio…) · Node.js 20+ solo para compilar desde fuente. /
  Windows 10/11 · Compatible AI provider (OpenCode Go, OpenRouter, Groq, OpenAI, Anthropic,
  local Ollama, LM Studio…) · Node.js 20+ only to build from source.
