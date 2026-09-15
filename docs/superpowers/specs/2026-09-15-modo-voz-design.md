# Modo voz en SAGITARI — diseño

Fecha: 2026-09-15 · Estado: aprobado en diseño (las cuatro secciones se revisaron con el
usuario, con maquetas para el orbe), pendiente de plan de implementación.

## Objetivo

Que pedirle algo a SAGITARI hablando sea una forma de usarlo tan completa como escribir:
pulsar el micrófono abre el **modo voz**, con un **orbe que late con la voz**, y el
asistente **oye, hace y contesta hablando** con las mismas manos en el PC que el chat de
texto —mismas herramientas, mismos permisos, mismos guardarraíles, misma conversación—.
Y todo **local**: ni la voz ni el texto salen del equipo.

## Decisiones ya tomadas

| Decisión | Elección | Motivo |
|---|---|---|
| Red | **Todo local.** Los motores neuronales se descargan una vez y corren en el equipo | Elección explícita del dueño: nada de la voz sale del PC |
| Interacción | **Manos libres continuo**: hablas, el silencio cierra la frase, se envía, responde hablando y vuelve a escuchar | Elegido por el usuario entre tres modos; es lo que hace que se sienta un asistente |
| Superficie | Superposición sobre el área del chat (no una sección del sidebar) | El modo voz es algo que se abre, no un sitio al que se navega |
| Micrófono | El botón **abre el modo voz**; `Alt`+clic conserva el dictado clásico al compositor | No se pierde lo que ya funcionaba para escribir un prompt largo con correcciones |
| Motor de escuchar | **Whisper local** (`whisper-cli.exe` + `ggml-small-q5_1.bin`), con vista previa por modelo pequeño; **respaldo**: motor de Windows | Medido: RTF 0,14–0,38 en CPU (más rápido que tiempo real) |
| Motor de hablar | **Piper local** (voces `es_ES`/`es_MX`); **respaldo**: mejor voz local de Windows | Medido: RTF 0,05 y calidad natural frente a la voz robótica instalada |
| Captura de audio | **En el renderer** (`getUserMedia` → PCM 16 kHz) y el PCM va al proceso principal | Una sola tubería: da nivel real al orbe y alimenta a Whisper |
| Fin de frase | **VAD por energía en el proceso principal** | Testeable desde Node puro, sin navegador ni micrófono |
| Reproducción de la voz | **En el renderer** (WebAudio), frase a frase | Cortar al interrumpir es inmediato y el orbe late con la voz del asistente |
| Orbe | **Malla de puntos**, 19×19, con una cara por estado | Elegido por el usuario viendo las tres maquetas animadas |
| Empaquetado | Binarios y modelos **fuera del instalador**, descarga a petición desde Ajustes | El instalador no pasa de ~90 MB a ~400 MB |

## No objetivos

- **Nada de nube** en ejecución: ni voces en línea ni reconocimiento en línea.
- **Sin palabra clave** («Sagitari, …») en esta entrega.
- **Sin escucha permanente**: el micrófono vive solo mientras el modo voz está abierto.
- **Sin resaltado palabra por palabra** al hablar: Piper no da tiempos por palabra, así
  que se resalta **por frase** (exacto) en vez de fingir precisión.
- **Sin historial paralelo**: el modo voz escribe en la misma conversación.
- **Sin motores dentro del instalador**: se descargan a petición y se pueden borrar.

## Evidencia medida en este equipo (Windows 11 Pro 26200, Ryzen 5 5600)

| Qué | Medida | Lectura |
|---|---|---|
| Piper `es_ES-davefx-medium` | RTF **0,055** (0,39 s para 7,1 s de audio) | Habla más rápido de lo que dura: se puede sintetizar por frase sin esperas |
| Piper `es_MX-claude-high` | RTF **0,049** (0,45 s para 9,1 s) | Alternativa de timbre distinto |
| Whisper `small-q5_1` (voz humana, 49,4 s) | RTF **0,14** (7,0 s de cómputo) | Entiende voz humana de sobra para conversar |
| Whisper sobre voz sintética | Casi literal | Reconocer es más fácil con voz natural que con voz robótica |
| Errores vistos | Nombres propios («Soneja» → «Zoneja»), URLs deletreadas | Por eso el texto queda visible y editable y se puede interrumpir |
| Voces locales de Windows | SAPI: solo *Helena Desktop* (es-ES). Almacén moderno: Pablo, Laura, Helena. **Ninguna neuronal** | Explica que hoy suene a robot y por qué hace falta Piper |
| Reconocimiento local de Windows | SAPI 8.0 es-ES; el motor moderno reporta **0 idiomas offline** | Fuera de la nube, el motor moderno no sirve: de ahí Whisper |
| Nivel de audio del motor de Windows | 8 muestras en 3 s (~2,7/s) | Insuficiente para el orbe: el nivel sale del renderer |
| Micrófonos del equipo | Tres entradas: Blue Snowball, cámara Creative y **NVIDIA Broadcast**; el predeterminado sí entrega voz | El aviso sobre NVIDIA Broadcast que ya existe en el código sigue siendo pertinente |

Artefactos de la prueba (desechables, en `.superpowers/sdd/2026-09-15-modo-voz/spike/`):
los binarios y modelos **no** se versionan.

## Arquitectura

```
renderer/voice-mode.js ── estado, transcripción, pasos, confirmaciones
        │                    ▲
        │ eventos normalizados│ nivel (60/s)
        ▼                    │
   orb.js (malla de puntos, canvas 2D)
        │
        │ getUserMedia → PCM 16 kHz
        ▼
main/voice/manager.js ── punto ÚNICO de entrada de eventos
        ├── vad.js        fin de frase, umbral, pre-roll
        ├── stt-whisper.js ──► whisper-cli.exe  (sidecar residente, 10 min de caducidad)
        ├── stt-windows.js ──► voice.ps1        (respaldo: WinRT + SAPI)
        ├── tts-piper.js   ──► piper.exe        (residente mientras el modo está abierto)
        └── tts-windows.js ──► voz del sistema  (respaldo)
        │
        └── audio de cada frase ──► renderer (WebAudio) ──► altavoces

agente: SIN CAMBIOS. El texto final entra por el mismo `chat:send` de siempre.
```

**Regla de oro: el modo voz no tiene camino propio al agente.** Un `final` con texto se
envía por el mismo sitio que el botón Enviar del chat, así que hereda herramientas,
permisos, guardarraíles, memoria, checkpoints y conversación sin duplicar nada. Si eso no
se cumple, el modo voz no se implementa.

## Contrato de eventos (la costura que lo hace testeable)

Un solo formato, por el que entran **tanto** los motores reales **como** los eventos
sintéticos del banco de pruebas:

```js
{ type: 'state',  state: 'escuchando'|'oyendo'|'pensando'|'hablando'|'confirmando'|'error' }
{ type: 'level',  value: 0..1 }            // solo para el orbe (no viaja a ningún motor)
{ type: 'partial',text }                   // vista previa (modelo pequeño, orientativa)
{ type: 'final',  text, confidence }       // frase cerrada: esto es lo que se envía
{ type: 'notice', text }                   // aviso corto que sí se dice en voz alta
{ type: 'error',  text, fix }              // qué pasa y qué hacer, nunca en silencio
```

## Componentes

### `main/voice/manager.js` (nuevo)

Dueño del estado y del punto único de entrada. Sin Electron dentro (recibe `emit` y el
directorio de datos), para poder probarlo desde Node puro.

```js
class VoiceManager {
  constructor({ emit, dataDir, log })   // emit = enviar evento al renderer
  open(settings)                        // abre el modo: captura, motor, VAD
  close()                               // corta audio y voz, suelta motores
  ingest(event)                         // ← ÚNICO punto de entrada
  say(text)                             // trocea en frases y las va sintetizando
  stopSpeaking()                        // barge-in: corta y descarta la cola
  engines()                             // qué motores están disponibles y su estado
}
```

### `main/voice/vad.js` (nuevo)

Energía por tramas de 20 ms sobre el PCM; umbral = suelo de ruido + margen, con
calibración en los primeros 300 ms de cada apertura. Cierra la frase tras **800 ms** de
silencio (configurable), con **pre-roll de 400 ms** para no cortar el arranque de la
palabra, tope de frase de 30 s y descarte de frases con menos de 300 ms de voz real.

### `main/voice/stt-whisper.js` y `stt-windows.js`

Mismo contrato: `start(lang)`, `push(pcm)`, `stop()`, y capacidades declaradas
(`{ partials, confidence, timings }`). Whisper escribe el PCM a un WAV temporal y llama a
`whisper-cli.exe`; la **vista previa** usa un modelo pequeño cada ~800 ms sobre el audio
acumulado y el **texto definitivo** lo da `small` al cerrar la frase.

`stt-windows.js` conserva `voice.ps1` como respaldo, y arregla lo que hoy está roto ahí:
`main.js:1042` fuerza `-NoWinrt` (el motor moderno está capado) y **la confianza de cada
resultado se ignora** aunque el dato llega.

### `main/voice/tts-piper.js` y `tts-windows.js`

Piper residente mientras el modo está abierto; se le manda **frase a frase** según llega
el texto del modelo, y el WAV resultante se reproduce en el renderer. Respaldo: la mejor
voz local (las modernas Pablo/Laura/Helena), y Ajustes dice **cuál está sonando**.

### `renderer/voice-mode.js` y `renderer/orb.js` (nuevos)

`orb.js` dibuja la malla y **no sabe nada** del resto: recibe `(nivel, estado, tiempo)` y
pinta. Reglas de dibujo ya validadas en las maquetas: lienzo **sin fondo propio**, halo
que **termina dentro del lienzo** (si llega al borde, se corta y se ve un cuadrado),
desvanecido suave de la malla en el borde, onda que viaja hacia fuera y remolino apagado
en el centro (si no, queda un hueco negro en medio), suavizado de nivel con ataque rápido
y caída lenta. Con `prefers-reduced-motion`, latido suave sin deformación. **El bucle se
apaga al cerrar el modo.**

### Cambios en lo existente

| Archivo | Cambio |
|---|---|
| `main/main.js` | Los handlers de voz pasan a delegar en `VoiceManager`; se quita el `-NoWinrt` fijo; permiso `media` concedido **solo a nuestra propia página**; IPC nuevo |
| `main/preload.js` | Puente del modo voz (`voiceModeOpen/Close`, `onVoiceEvent`, `ttsSay`, `ttsStop`, `voiceEngines`) |
| `renderer/index.html` | Marca del panel del modo voz; el botón del micro pasa a «Modo voz»; filas nuevas en Ajustes › Voz |
| `renderer/app.js` | El micro abre el modo voz (`Alt`+clic mantiene el dictado); el `final` entra por el mismo `sendFrom` del chat |
| `renderer/styles.css` | Estilos del panel, y `prefers-reduced-motion` |
| `main/voice.ps1` | Se deja de forzar el motor clásico; se lee la confianza; el protocolo actual se mantiene |
| `scripts/ui-check.js` | Comprobaciones del modo voz con eventos sintéticos (ver Pruebas) |
| `test/run.js` | VAD, filtro de alucinaciones, troceado en frases y contrato de motores |
| `agent/**` | **Sin cambios**: el agente no se entera de que existe el modo voz |

## Flujo de un turno

1. Clic en el micro → pide permiso de micrófono (solo la primera vez) → `Abriendo` →
   `Escuchando`. El orbe respira tenue.
2. Hablas → el VAD detecta voz → `Oyendo`, el orbe se abre contigo, y cada ~800 ms
   aparece la vista previa.
3. Callas 800 ms → se cierra la frase (con su pre-roll) → `Pensando` → el texto va al
   agente **por el mismo camino del chat**.
4. Mientras trabaja: el orbe hace la onda del estado `Pensando` y la franja de pasos
   muestra las herramientas reales (leída/tool, hecha/fallo).
5. Llega la respuesta → `Hablando`: se trocea en frases, Piper las sintetiza según caen y
   el renderer las reproduce; **la frase que suena se resalta** en el texto.
6. Al terminar de hablar → `Escuchando` otra vez. Si hablas mientras habla, se corta al
   instante y se te oye (`Oyendo`), conservando los 400 ms previos para no perder tu
   primera sílaba.
7. Salir: `Esc`, el botón, o decir «adiós». Se suelta el micrófono y se apagan motores.

## Estados y caras del orbe

| Estado | Orbe | En pantalla | Glow del marco |
|---|---|---|---|
| `escuchando` | Malla casi quieta, respiración tenue | «Escuchando» | `listen` |
| `oyendo` | Se abre con tu voz, punto a punto | Parcial + confirmado | `listen` |
| `pensando` | Onda que cruza a ritmo constante | Pasos del agente | `think` |
| `hablando` | Late con su voz, núcleo más claro | Frase resaltada | `speak` |
| `confirmando` | Quieta y grave, sin competición | Aviso grande, botones y voz | `think` |
| `error` | Tenue, sin movimiento | Qué pasa y qué hacer | — |

## Errores y casos límite

| Caso | Qué hace |
|---|---|
| Permiso de micrófono denegado | `error` con el camino: `ms-settings:privacy-microphone` |
| Sin micrófono o dispositivo mudo | `error` y el aviso de micrófono predeterminado (incluido el caso NVIDIA Broadcast, que ya está documentado en el código) |
| Sin motores descargados | Se usa el respaldo de Windows y Ajustes lo dice |
| Frase con confianza baja | Se envía igual (manos libres) pero el texto se marca y queda **editable** |
| Ruido o silencio que Whisper transcribe como texto | **Lista negra** de alucinaciones conocidas **y** regla de energía: sin voz real en el audio, no hay frase |
| Frase larguísima | Tope de 30 s: se cierra y se envía en vez de crecer sin límite |
| Interrupción mientras habla | Corte inmediato (<150 ms), cola descartada, estado `oyendo` con pre-roll |
| Falla la síntesis | El texto sigue en pantalla: una respuesta no se pierde por un fallo de voz |
| Se cierra la app | Se sueltan micrófono y sidecars (sin huérfanos, como ya se hace hoy) |
| Arranque automatizado | **Nunca habla** (regla ya implementada y vigilada por ui-check) |

## Permisos y seguridad

- Permiso `media` concedido **solo a nuestra propia página**; cualquier otro origen, denegado.
- El micrófono **solo** está abierto con el modo voz abierto, y se ve en pantalla.
- El PCM vive en memoria y en un WAV temporal que se borra tras transcribir.
- Nada de audio ni texto sale del equipo: los motores son locales.

## Descarga de motores y empaquetado

Manifiesto `main/voice/engines.json` con url, tamaño, `sha256` y licencia por artefacto;
descarga con progreso a `dataDir/engines/`, **verificación de tamaño y hash antes de usar**,
y borrado desde Ajustes. Nada de esto entra en el instalador.

| Artefacto | Tamaño | Licencia |
|---|---|---|
| `whisper-blas-bin-x64` (whisper.cpp) | 20,4 MB | MIT |
| Modelo `ggml-small-q5_1.bin` | 181,3 MB | MIT |
| Modelo pequeño para la vista previa (`base-q5_1`) | ~57 MB | MIT |
| `piper_windows_amd64` | 21,4 MB | MIT |
| Voz `es_ES-davefx-medium` | 60,3 MB | CC-BY (por voz, se anota en el manifiesto) |
| Voz `es_MX-claude-high` | 60,2 MB | CC-BY (por voz) |

## Pruebas

**Unitarias (`test/run.js`)**: VAD (cierre por silencio, pre-roll, descarte por energía),
filtro de alucinaciones, troceado en frases (con decimales y abreviaturas de por medio),
y el contrato de motores (un motor de mentira que declara capacidades distintas).

**Sobre la app viva (`scripts/ui-check.js`)**, inyectando voz sintética por el punto único:
el panel abre y cierra con `Esc`; el orbe cambia de cara con cada estado; un `final` con
texto **llega al agente por el mismo camino** (se comprueba en la petición que recibe el
modelo de mentira, como ya se hace con el catálogo); la confirmación se contesta por voz;
la lista negra filtra; y **un arranque automatizado sigue sin sacar voz por los altavoces**.

**Humo de motores**: con los motores descargados, sintetizar un texto fijo y transcribir un
WAV fijo; sin ellos, se saltan (no rompen la suite ni la CI).

## Fases

**Fase 1 — la experiencia, con los motores de Windows.** Panel del modo voz, orbe (malla de
puntos, una cara por estado), bucle manos libres, barge-in, confirmaciones por voz,
transcripción visible y editable, y las pruebas anteriores. Aquí ya se arregla lo que hoy
está roto en el respaldo: `-NoWinrt` capado y confianza ignorada.

**Fase 2 — los motores neuronales locales.** Contrato de motores con descarga opt-in,
Piper residente y Whisper con vista previa por modelo pequeño, ajustes de voz reales
(`voiceLang` deja de ignorarse), y el humo de motores.

Cada fase lleva **su propio plan de implementación**: la fase 1 se planifica y se ejecuta
entera antes de planificar la fase 2, para no arrastrar decisiones tomadas sin el modo voz
ya funcionando en la mano.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| La descarga es grande (181 MB el modelo) | A petición, con tamaño y progreso; sin ella, el modo voz funciona con el respaldo |
| Whisper falla nombres propios | Texto visible y editable, interrupción, y la evaluación honesta en la interfaz |
| CPU ocupada transcribiendo | Modelo pequeño para la vista previa, `small` solo al cerrar frase, y caducidad del sidecar |
| Dos capturas del micrófono (motor de Windows + renderer) | El nivel del orbe sale del renderer; si el dispositivo se resiste, el nivel del motor (SAPI) actúa de respaldo |
| Maquetas bonitas, app fea | El orbe de la app reutiliza **las mismas reglas de dibujo** validadas en las maquetas |
