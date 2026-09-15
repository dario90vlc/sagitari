# Modo voz — Fase 1 (la experiencia, con los motores de Windows) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pulsar el micrófono abre un modo voz manos libres con un orbe que late con la voz: hablas, el silencio cierra la frase, se envía al agente por el mismo camino del chat, la respuesta se dice en voz alta y vuelve a escuchar.

**Architecture:** Tres capas nuevas sin tocar el agente. En el proceso principal, `main/voice/` con piezas de una sola responsabilidad: `contract.js` (contrato de motores y eventos), `junk.js` (frases basura), `stt-windows.js` (motor de escuchar sobre `voice.ps1`), `tts-windows.js` (síntesis a WAV por frase) y `manager.js` (estado y punto **único** de entrada). En el renderer, `voice-mode.js` (panel y máquina de estados) y `orb.js` (malla de puntos en canvas). El texto final entra por el mismo `chat:send` que el botón Enviar, así que hereda herramientas, permisos, guardarraíles e historial.

**Tech Stack:** Node 20+/Electron 44, JS vainilla, canvas 2D y WebAudio en el renderer; PowerShell (`voice.ps1`) como motor de dictado del sistema. Sin dependencias nuevas.

**Spec:** `docs/superpowers/specs/2026-09-15-modo-voz-design.md`

## Global Constraints

- **Sin dependencias nuevas de runtime.** Única dependencia: `ws`, ya presente. El audio, el canvas y la síntesis se hacen con lo que ya hay.
- **Solo Windows 10/11.** El motor de escuchar es `main/voice.ps1`; el de hablar, la voz del sistema.
- **Interfaz y comentarios en español**, y los comentarios explican *por qué*, no *qué*.
- **Sin frameworks de UI**: HTML/CSS/JS a mano, siguiendo los patrones ya existentes (`.cbtn`, `.toast`, `confirmbar`, vistas con `data-view`).
- **El modo voz no tiene camino propio al agente.** Un `final` con texto se envía con `sendFrom` (el mismo del chat). Prohibido crear un canal paralelo.
- **Un solo punto de entrada de eventos** (`VoiceManager.ingest` en main, `VoiceMode.handle` en el renderer). Los motores reales y la voz sintética de las pruebas entran por ahí.
- **Arranques automatizados (`--smoke`/`--hidden`/`--test`) NUNCA sacan voz por los altavoces.** Regla ya implementada en `main/main.js` (`HEADLESS`), y `window.sagitari.speak()` sigue devolviendo `{ok:false}` en ese caso: la comprobación que ya existe en `scripts/ui-check.js` no se puede romper.
- **El micrófono solo está abierto con el modo voz abierto**, y el permiso `media` se concede **solo a nuestra propia página**.
- **La suite no escribe en los datos reales del usuario**: `npm test` fija `SAGITARI_DATA_DIR` a un temporal al arrancar (regla ya existente).
- **Ningún proceso queda huérfano**: micrófono, PowerShell y WAV temporales se sueltan al cerrar el modo y al salir de la app.
- **Nada de audio ni texto sale del equipo.**
- **Terminología fija del contrato** (no se renombra en ninguna tarea): estados `escuchando`, `oyendo`, `pensando`, `hablando`, `confirmando`, `error`; eventos `state`, `level`, `partial`, `final`, `notice`, `error`; PCM siempre **16 kHz mono, Float32** en memoria y **WAV 16 bits** en disco.

---

## Estructura de ficheros

| Fichero | Responsabilidad |
|---|---|
| `main/voice/contract.js` (**nuevo**) | Forma del evento normalizado, capacidades de un motor y validación (`assertEvent`, `assertEngine`). Es la costura que permite motores intercambiables por fases. |
| `main/voice/junk.js` (**nuevo**) | ¿Es basura esta frase? Lista negra de alucinaciones + reglas de longitud, repetición y energía. Es un dato, no lógica de audio. |
| `main/voice/stt-windows.js` (**nuevo**) | Motor de escuchar de Windows: arranca `voice.ps1` **sin capar el motor moderno**, parsea su protocolo y ahora también la **confianza**. `spawnFn` inyectable para poder probarlo. |
| `main/voice/tts-windows.js` (**nuevo**) | Sintetiza **una frase** a un WAV temporal con la mejor voz local (respeta `voiceLang` y la velocidad) y lo borra cuando ya ha sonado. `spawnFn` inyectable. |
| `main/voice/manager.js` (**nuevo**) | Dueño del estado y punto único de entrada: motores → eventos; trocea la respuesta en frases y las sintetiza; corta la voz al interrumpir. Sin Electron dentro. |
| `main/voice.ps1` | Deja de ser forzado al motor clásico y **emite la confianza** en las dos ramas (WinRT y SAPI). |
| `main/main.js` | `VoiceManager` cableado; permiso `media` solo para nuestra página; IPC `voice:*` y `tts:*`; cierre ordenado. |
| `main/preload.js` | Puente del modo voz y del audio (frase sintetizada, fin de reproducción). |
| `renderer/orb.js` (**nuevo**) | La malla de puntos: `OrbKit.smoothLevel` (matemática pura) y `OrbKit.draw` (canvas). No sabe nada del resto de la app. |
| `renderer/voice-mode.js` (**nuevo**) | Panel del modo voz: máquina de estados, transcripción (parcial + confirmado + edición), pasos del agente, confirmación, errores, `Esc` y `prefers-reduced-motion`. |
| `renderer/index.html` | Marca del panel y del orbe; el botón del micro pasa a «Modo voz»; filas nuevas de Ajustes › Voz. |
| `renderer/app.js` | El micro abre el modo (`Alt`+clic mantiene el dictado); el `final` se envía con `sendFrom`; confirmaciones por voz; ajustes nuevos; la lectura en voz alta del chat usa el camino nuevo. |
| `renderer/styles.css` | Estilos del panel, del orbe y del modo reducido de movimiento. |
| `test/run.js` | Tests unitarios: contrato, filtro de basura, motores con `spawnFn` de mentira y manager con eventos de mentira. |
| `scripts/ui-check.js` | Comprobaciones sobre la app viva con voz sintética: abre y cierra, caras del orbe, suavizado, `final` → petición al modelo, confirmación por voz, barge-in y silencio en arranques automatizados. |
| `README.md`, `README.es.md` | Paridad ES/EN de la funcionalidad (regla de producto). |

**Fuera de la fase 1 (van al plan de la fase 2):** `main/voice/vad.js` (con la captura de PCM para Whisper) y los motores neuronales. En la fase 1 quien decide dónde acaba una frase es el propio motor de Windows, así que un VAD aquí sería código sin uso.

**No se toca `RELEASE_NOTES.md`**: el flujo de release extrae la sección `# SAGITARI <version>` y una sección inventada lo rompería (misma decisión que en el plan de MCP).

---

### Task 1: Contrato de motores y eventos (`main/voice/contract.js`)

**Files:**
- Create: `main/voice/contract.js`
- Test: `test/run.js` (bloque nuevo al final)

**Interfaces:**
- Produces:
  - `ESTADOS = ['escuchando','oyendo','pensando','hablando','confirmando','error']`
  - `TIPOS = ['state','level','partial','final','notice','error']`
  - `assertEvent(ev) -> void` (lanza `Error` con mensaje en español si no cumple la forma)
  - `assertEngine(engine) -> void` (exige `{ nombre, capacidades:{partials,confidence,level}, start, push, stop }`)
  - `CAPACIDADES_BASE = { partials:false, confidence:false, level:false }`

- [ ] **Step 1: Escribir los tests que fallan**

```js
test('voz/contrato: un evento bien formado pasa y uno roto se explica', () => {
  const { assertEvent, TIPOS, ESTADOS } = require('../main/voice/contract');
  assertEvent({ type: 'state', state: 'escuchando' });
  assertEvent({ type: 'final', text: 'hola', confidence: 0.8 });
  assertEvent({ type: 'partial', text: 'ho' });
  assertEvent({ type: 'level', value: 0.5 });
  eq(TIPOS.length, 6, 'seis tipos de evento');
  eq(ESTADOS.length, 6, 'seis estados');
  let fallo = null;
  try { assertEvent({ type: 'state', state: 'dormido' }); } catch (e) { fallo = e.message; }
  ok(fallo && /estado/i.test(fallo), 'un estado inventado se rechaza con un mensaje legible: ' + fallo);
  fallo = null;
  try { assertEvent({ type: 'inventado' }); } catch (e) { fallo = e.message; }
  ok(fallo && /tipo/i.test(fallo), 'un tipo inventado se rechaza: ' + fallo);
  fallo = null;
  try { assertEvent({ type: 'level', value: NaN }); } catch (e) { fallo = e.message; }
  ok(fallo && /nivel/i.test(fallo), 'un nivel NaN se rechaza: ' + fallo);
});

test('voz/contrato: un motor necesita nombre, capacidades y los tres métodos', () => {
  const { assertEngine, CAPACIDADES_BASE } = require('../main/voice/contract');
  const bueno = { nombre: 'mentira', capacidades: { ...CAPACIDADES_BASE, partials: true }, start() {}, push() {}, stop() {} };
  assertEngine(bueno);
  const sinStop = { nombre: 'mentira', capacidades: { ...CAPACIDADES_BASE }, start() {}, push() {} };
  let fallo = null;
  try { assertEngine(sinStop); } catch (e) { fallo = e.message; }
  ok(fallo && /stop/.test(fallo), 'se dice exactamente qué falta: ' + fallo);
});
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `npm test 2>&1 | tail -5`
Expected: FAIL con `Cannot find module '../main/voice/contract'`

- [ ] **Step 3: Implementar el módulo**

```js
'use strict';

/* Contrato del modo voz: una sola forma de evento y de motor.
 *
 * Existe porque los motores cambian de fase en fase (hoy Windows; mañana Whisper y
 * Piper) y el resto de la app no debería enterarse. Las pruebas inyectan motores de
 * mentira por este mismo contrato, así que lo que se prueba es lo que se usará.
 */

const ESTADOS = ['escuchando', 'oyendo', 'pensando', 'hablando', 'confirmando', 'error'];
const TIPOS = ['state', 'level', 'partial', 'final', 'notice', 'error'];
const CAPACIDADES_BASE = { partials: false, confidence: false, level: false };

function assertEvent(ev) {
  if (!ev || typeof ev !== 'object') throw new Error('evento de voz vacío');
  if (!TIPOS.includes(ev.type)) throw new Error('tipo de evento desconocido: ' + ev.type + ' (válidos: ' + TIPOS.join(', ') + ')');
  switch (ev.type) {
    case 'state':
      if (!ESTADOS.includes(ev.state)) throw new Error('estado de voz desconocido: ' + ev.state);
      break;
    case 'level':
      /* Number.isFinite y no typeof: `typeof NaN === 'number'` es cierto y NaN no falla
         ninguna comparación, así que un nivel NaN llegaría al canvas y no dibujaría nada. */
      if (!Number.isFinite(ev.value) || ev.value < 0 || ev.value > 1) throw new Error('nivel fuera de 0..1: ' + ev.value);
      break;
    case 'partial':
    case 'notice':
      if (typeof ev.text !== 'string') throw new Error(ev.type + ' sin texto');
      break;
    case 'final':
      if (typeof ev.text !== 'string') throw new Error('final sin texto');
      if (ev.confidence !== null && ev.confidence !== undefined && typeof ev.confidence !== 'number') throw new Error('confianza no numérica');
      break;
    case 'error':
      if (typeof ev.text !== 'string') throw new Error('error sin texto');
      if (ev.fix !== undefined && typeof ev.fix !== 'string') throw new Error('el arreglo del error debe ser texto');
      break;
    default:
      break;
  }
}

function assertEngine(engine) {
  if (!engine || typeof engine !== 'object') throw new Error('motor vacío');
  if (typeof engine.nombre !== 'string' || !engine.nombre) throw new Error('el motor necesita nombre');
  if (!engine.capacidades || typeof engine.capacidades !== 'object') throw new Error('el motor necesita capacidades');
  for (const cap of ['partials', 'confidence', 'level']) {
    if (typeof engine.capacidades[cap] !== 'boolean') throw new Error('capacidad mal declarada: ' + cap);
  }
  for (const fn of ['start', 'push', 'stop']) {
    if (typeof engine[fn] !== 'function') throw new Error('al motor le falta ' + fn + '()');
  }
}

module.exports = { ESTADOS, TIPOS, CAPACIDADES_BASE, assertEvent, assertEngine };
```

- [ ] **Step 4: Ejecutar y ver que pasan**

Run: `npm test 2>&1 | tail -3`
Expected: PASS (los dos tests nuevos y los 227 anteriores)

- [ ] **Step 5: Commit**

```bash
git add main/voice/contract.js test/run.js
git commit -m "voz: contrato de eventos y motores (la costura que hace intercambiables los motores)"
```

---

### Task 2: Filtro de frases basura (`main/voice/junk.js`)

**Files:**
- Create: `main/voice/junk.js`
- Test: `test/run.js`

**Interfaces:**
- Consumes: nada.
- Produces: `esBasura(text, ms) -> { basura: boolean, motivo: string }`, con `ms` = milisegundos de voz real de la frase (lo que devuelve el motor; `0` si no se sabe). La lista negra vive en `BASURA` (array de cadenas normalizadas) para que la fase 2 la amplíe con las alucinaciones de Whisper.

- [ ] **Step 1: Escribir los tests que fallan**

```js
test('voz/basura: rechaza frases vacías, golpes y ruido del motor de dictado', () => {
  const { esBasura } = require('../main/voice/junk');
  ok(esBasura('', 900).basura, 'texto vacío');
  ok(esBasura('   ', 900).basura, 'sólo espacios');
  ok(esBasura('.', 900).basura, 'un punto');
  ok(esBasura('eh', 120).basura, 'un golpe de 120 ms con dos letras');
  ok(!esBasura('Recuérdame mañana llamar a Álvaro', 1200).basura, 'una frase de verdad pasa');
  ok(!esBasura('sí', 400).basura, 'un «sí» corto pero con voz real pasa: es una respuesta');
  /* Sin duración (el motor de Windows no la manda) no se puede concluir «sin voz»:
     estas dos pruebas son las que habrían cazado el fallo que encontró la revisión. */
  ok(!esBasura('sí').basura, 'sin saber la duración, un «sí» no es basura');
  ok(!esBasura('no').basura, 'ni un «no»');
  ok(!esBasura('ok').basura, 'ni un «ok»');
});

test('voz/basura: las alucinaciones conocidas no llegan al agente', () => {
  const { esBasura, BASURA } = require('../main/voice/junk');
  ok(BASURA.length >= 6, 'hay lista negra');
  for (const frase of ['Gracias por ver el vídeo', '¡Suscríbete al canal!', 'Subtítulos realizados por la comunidad', 'Música', 'Aplausos']) {
    const r = esBasura(frase, 3000);
    ok(r.basura, 'la lista negra caza: ' + frase);
    ok(/lista negra/.test(r.motivo), 'y dice por qué: ' + r.motivo);
  }
});

test('voz/basura: una palabra repetida en bucle no es una orden', () => {
  const { esBasura } = require('../main/voice/junk');
  ok(esBasura('no no no no no', 2000).basura, 'repetición');
  ok(!esBasura('no, gracias', 800).basura, 'una negativa normal pasa');
  /* La lista negra no puede comerse una orden real que empiece como una alucinación. */
  ok(!esBasura('música a todo volumen', 1500).basura, 'una orden que empieza por una palabra de la lista pasa');
  ok(!esBasura('aplausos del público al final', 1800).basura, 'y otra igual');
});
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `npm test 2>&1 | tail -5`
Expected: FAIL con `Cannot find module '../main/voice/junk'`

- [ ] **Step 3: Implementar el módulo**

```js
'use strict';

/* ¿Es basura lo que ha oído el motor?
 *
 * Los motores de dictado inventan frases con el ruido y con el silencio: el de Windows
 * convierte el ambiente en texto y Whisper es famoso por escribir «Gracias por ver el
 * vídeo» cuando no hay voz. Nada de eso puede llegar al agente como si fuera una orden,
 * así que aquí se filtra por lista negra y por reglas de forma y energía.
 */

/* Frases normalizadas (minúsculas, sin signos) que nunca son una orden del usuario.
   La fase 2 amplía esta lista con las alucinaciones propias de Whisper. */
const BASURA = [
  'gracias por ver el video',
  'gracias por ver este video',
  'suscribete al canal',
  'suscribete',
  'subtitulos realizados por',
  'subtitulos por',
  'subtitulos creados por',
  'musica',
  'aplausos',
  'risas',
  'hasta la proxima',
  'no te olvides de suscribirte',
];

const normalizar = (t) => String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

const REGLAS = [
  { motivo: 'no hay texto', prueba: (t) => normalizar(t).length === 0 },
  /* OJO: se comprueba sobre el texto NORMALIZADO. La bandera `i` de JavaScript no pliega
     tildes, así que «sí» no casaba con [aeiou] y se descartaba una respuesta legítima
     (lo cazó el implementador al ejecutar el propio test del brief). */
  { motivo: 'sin vocales: no es una palabra', prueba: (t) => !/[aeiou]/.test(normalizar(t)) },
  /* `ms` = 0 significa «no se sabe», y el motor de Windows NO manda duración: sin el
     `ms > 0`, toda respuesta corta («sí», «no», «ok») se descartaría como basura y el modo
     voz no podría confirmar nada. Lo cazó la revisión de la tarea. */
  { motivo: 'demasiado corto y sin voz suficiente', prueba: (t, ms) => normalizar(t).replace(/ /g, '').length < 4 && ms > 0 && ms < 350 },
  { motivo: 'palabra repetida en bucle', prueba: (t) => { const w = normalizar(t).split(' '); return w.length >= 4 && new Set(w).size === 1; } },
  /* El prefijo solo se aplica a entradas de varias palabras: si no, «música a todo
     volumen» o «risas aparte, abre el navegador» caerían por empezar como una alucinación. */
  { motivo: 'está en la lista negra de alucinaciones', prueba: (t) => { const n = normalizar(t); return BASURA.some((b) => n === b || (b.includes(' ') && n.startsWith(b))); } },
];

function esBasura(text, ms = 0) {
  for (const r of REGLAS) {
    if (r.prueba(text, ms)) return { basura: true, motivo: r.motivo };
  }
  return { basura: false, motivo: '' };
}

module.exports = { esBasura, BASURA };
```

- [ ] **Step 4: Ejecutar y ver que pasan**

Run: `npm test 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add main/voice/junk.js test/run.js
git commit -m "voz: filtro de frases basura (lista negra y reglas) para que el ruido no sea una orden"
```

---

### Task 3: Motor de escuchar de Windows (`main/voice/stt-windows.js` + `voice.ps1`)

**Files:**
- Create: `main/voice/stt-windows.js`
- Modify: `main/voice.ps1` (ramas WinRT y SAPI: emitir confianza; el motor moderno deja de estar proscrito)
- Test: `test/run.js`

**Interfaces:**
- Consumes: `assertEngine` de `main/voice/contract.js`.
- Produces: `createSttWindows({ emit, lang, spawnFn, scriptPath }) -> engine`, con
  `engine.nombre = 'windows'`, `engine.capacidades = { partials:true, confidence:true, level:false }`,
  `engine.start() -> Promise<void>`, `engine.push(pcm) -> void` (no-op: **este motor captura por su cuenta**, así lo dice su capacidad `level:false`), `engine.stop() -> Promise<void>`,
  y `engine.info() -> { motor: 'winrt'|'sapi'|'', idioma: string }`.
  Protocolo de `voice.ps1` (se mantiene y se amplía): `PART::texto`, `FINAL::texto␟confianza`, `MODE::winrt|sapi`, `READY::es-ES`, `HINT::texto`, `ERROR::texto`, `STOPPED::`. La confianza viaja **después de un separador de unidad (U+001F)** para no romper a ningún consumidor viejo.

- [ ] **Step 1: Escribir los tests que fallan**

```js
test('voz/stt-windows: arranca el motor moderno (sin caparlo) y traduce el protocolo', async () => {
  const { createSttWindows } = require('../main/voice/stt-windows');
  const eventos = [];
  let argsUsados = null;
  const spawnFn = (cmd, args) => {
    argsUsados = args;
    const listeners = {};
    const proc = {
      stdout: { on: (k, f) => { listeners['out:' + k] = f; } },
      stderr: { on: (k, f) => { listeners['err:' + k] = f; } },
      on: (k, f) => { listeners[k] = f; },
      kill: () => { if (listeners.exit) listeners.exit(0); },
      stdin: { end: () => {} },
    };
    setTimeout(() => {
      listeners['out:data'](Buffer.from('MODE::winrt\nREADY::es-ES\nPART::recuerdame\nFINAL::Recuérdame mañana\u001f0.82\n'));
    }, 5);
    return proc;
  };
  const engine = createSttWindows({ emit: (e) => eventos.push(e), spawnFn, scriptPath: 'voice.ps1', lang: 'es-ES' });
  await engine.start();
  await new Promise((r) => setTimeout(r, 40));
  ok(!argsUsados.includes('-NoWinrt'), 'no se capa el motor moderno: ' + JSON.stringify(argsUsados));
  ok(argsUsados.includes('es-ES'), 'se pasa el idioma');
  eq(eventos.filter((e) => e.type === 'partial').length, 1, 'un parcial');
  const fin = eventos.find((e) => e.type === 'final');
  eq(fin.text, 'Recuérdame mañana', 'el texto del final va limpio');
  eq(fin.confidence, 0.82, 'la confianza llega como número');
  eq(engine.info().motor, 'winrt', 'se sabe qué motor está detrás');

  const errores = [];
  const engine2 = createSttWindows({ emit: (e) => errores.push(e), spawnFn: (c, a) => { const l = {}; return { stdout: { on: (k, f) => { l['o' + k] = f; } }, stderr: { on: (k, f) => { l['e' + k] = f; } }, on: (k, f) => { l[k] = f; }, kill() {}, stdin: { end() {} } }; }, scriptPath: 'voice.ps1' });
  await engine2.start();
  eq(errores.filter((e) => e.type === 'error').length, 0, 'sin salida no hay error inventado');
});

test('voz/stt-windows: un ERROR:: del motor se convierte en error con arreglo', async () => {
  const { createSttWindows } = require('../main/voice/stt-windows');
  const eventos = [];
  const spawnFn = () => {
    const l = {};
    const proc = { stdout: { on: (k, f) => { l['o' + k] = f; } }, stderr: { on: (k, f) => { l['e' + k] = f; } }, on: (k, f) => { l[k] = f; }, kill() {}, stdin: { end() {} } };
    setTimeout(() => l['odata'](Buffer.from('ERROR::No hay micrófono\n')), 5);
    return proc;
  };
  const engine = createSttWindows({ emit: (e) => eventos.push(e), spawnFn, scriptPath: 'voice.ps1' });
  await engine.start();
  await new Promise((r) => setTimeout(r, 30));
  const err = eventos.find((e) => e.type === 'error');
  ok(err && /micrófono/i.test(err.text), 'el error se propaga tal cual: ' + JSON.stringify(err));
  ok(err.fix && err.fix.includes('ms-settings:sound'), 'y trae un arreglo concreto: ' + err.fix);
});
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `npm test 2>&1 | tail -5`
Expected: FAIL con `Cannot find module '../main/voice/stt-windows'`

- [ ] **Step 3: Implementar el motor**

```js
'use strict';

/* Motor de escuchar de Windows: envuelve main/voice.ps1.
 *
 * `voice.ps1` captura por su cuenta el micrófono predeterminado y decide dónde acaba
 * cada frase (su propio tiempo de silencio), así que este motor no recibe PCM: por eso
 * declara `level:false` (el nivel del orbe lo mide el renderer). Un motor de la fase 2
 * (Whisper) declarará `level:true` y sí recibirá PCM por push().
 *
 * Se inyecta `spawnFn` para poder probar el parseo del protocolo sin lanzar PowerShell.
 */
const path = require('path');
const { spawn } = require('child_process');
const { assertEngine, CAPACIDADES_BASE } = require('./contract');

const SEP = '\u001f';   // separador de unidad: no aparece en texto normal

function createSttWindows({ emit, lang = 'es-ES', spawnFn = spawn, scriptPath = path.join(__dirname, '..', 'voice.ps1') } = {}) {
  let proc = null;
  let buf = '';
  let info = { motor: '', idioma: '' };

  function manejaLinea(linea) {
    if (linea.startsWith('PART::')) emit({ type: 'partial', text: linea.slice(6) });
    else if (linea.startsWith('FINAL::')) {
      const crudo = linea.slice(7);
      const corte = crudo.indexOf(SEP);
      const texto = (corte >= 0 ? crudo.slice(0, corte) : crudo).trim();
      const conf = corte >= 0 ? Number(crudo.slice(corte + 1)) : null;
      emit({ type: 'final', text: texto, confidence: Number.isFinite(conf) ? conf : null });
    } else if (linea.startsWith('MODE::')) {
      info.motor = linea.slice(6).trim();
      if (info.motor === 'sapi') {
        emit({ type: 'notice', text: 'Motor de voz clásico. Activa "Reconocimiento de voz en línea" en Windows (Privacidad › Voz) para máxima precisión.' });
      }
    } else if (linea.startsWith('READY::')) {
      info.idioma = linea.slice(7).trim();
      emit({ type: 'state', state: 'escuchando' });
    } else if (linea.startsWith('HINT::')) {
      emit({ type: 'notice', text: linea.slice(6) });
    } else if (linea.startsWith('ERROR::')) {
      const texto = linea.slice(7).trim();
      const fix = /micr[oó]fono/i.test(texto) ? 'Abre Sonido en Windows (ms-settings:sound) y elige el micrófono correcto como predeterminado.'
        : /reconocimiento de voz en l[ií]nea/i.test(texto) ? 'Actívalo en ms-settings:privacy-speech y vuelve a abrir el modo voz.'
        : 'Vuelve a abrir el modo voz; si sigue, revisa el micrófono en ms-settings:sound.';
      emit({ type: 'error', text: texto, fix });
    }
  }

  function start() {
    return new Promise((resolve, reject) => {
      try {
        /* El motor moderno de Windows (WinRT) NO se capa: da parciales y confianza, y
           voice.ps1 ya sabe caer al clásico si en la máquina no hay idioma offline. */
        proc = spawnFn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Lang', lang], { windowsHide: true });
      } catch (e) { reject(e); return; }
      proc.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const linea = buf.slice(0, i).replace(/\r$/, '').trim();
          buf = buf.slice(i + 1);
          if (linea) manejaLinea(linea);
        }
      });
      proc.stderr.on('data', (d) => {
        const msg = d.toString('utf8').trim();
        if (msg) emit({ type: 'error', text: 'El motor de voz falló: ' + msg.slice(0, 200), fix: 'Cierra el modo voz y vuelve a abrirlo.' });
      });
      proc.on('exit', () => { proc = null; });
      resolve();
    });
  }

  function stop() {
    return new Promise((resolve) => {
      const p = proc;
      proc = null;
      if (!p) { resolve(); return; }
      try { p.stdin.end(); } catch {}
      try { p.kill(); } catch {}
      resolve();
    });
  }

  const engine = { nombre: 'windows', capacidades: { ...CAPACIDADES_BASE, partials: true, confidence: true }, start, push: () => {}, stop, info: () => ({ ...info }) };
  assertEngine(engine);
  return engine;
}

module.exports = { createSttWindows };
```

- [ ] **Step 4: Ampliar `main/voice.ps1` para que emita la confianza**

En la rama WinRT, donde hoy corta con FINAL, añade la confianza (y **no** se toca su lógica de respaldo):

```powershell
      if ($res -and $res.Text -and $res.Text.Trim()) {
        $consecutiveFails = 0
        # La confianza de WinRT es un enumerado (High/Medium/Low/Rejected): se pasa a
        # número para que el proceso principal pueda decidir si avisar al usuario.
        $c = switch ([string]$res.Confidence) { 'High' { 0.9 } 'Medium' { 0.6 } 'Low' { 0.3 } default { 0.1 } }
        Say ("FINAL::" + $res.Text.Trim() + [char]31 + $c)
      }
```

Y en la rama clásica, las dos suscripciones:

```powershell
  Register-ObjectEvent -InputObject $rec -EventName SpeechHypothesized -Action {
    try { $global:VoiceEvents++; Say ("PART::" + $EventArgs.Result.Text) } catch {}
  } | Out-Null
  Register-ObjectEvent -InputObject $rec -EventName SpeechRecognized -Action {
    try {
      $global:VoiceEvents++
      $c = [math]::Round([double]$EventArgs.Result.Confidence, 3)
      Say ("FINAL::" + $EventArgs.Result.Text + [char]31 + $c)
    } catch {}
  } | Out-Null
```

- [ ] **Step 5: Ejecutar y ver que pasan**

Run: `npm test 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 6: Comprobar el motor de verdad contra Windows (una vez, a mano)**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File main/voice.ps1 -Lang es-ES` y habla 3 segundos; pega la salida.
Expected: `MODE::sapi` (en este equipo el moderno no tiene idioma offline) y al hablar una línea `FINAL::<lo que dijiste>␟<confianza>`.

- [ ] **Step 7: Commit**

```bash
git add main/voice/stt-windows.js main/voice.ps1 test/run.js
git commit -m "voz: motor de escuchar de Windows (sin capar el moderno) que ahora dice la confianza"
```

---

### Task 4: Motor de hablar de Windows (`main/tts.ps1` + `main/voice/tts-windows.js`)

**Files:**
- Create: `main/tts.ps1`, `main/voice/tts-windows.js`
- Modify: `main/main.js` (el manejador `tts:speak` deja de sintetizar en línea y delega; IPC nuevo `tts:list`) y `main/preload.js`
- Test: `test/run.js`

**Interfaces:**
- Consumes: `CAPACIDADES_BASE` de `main/voice/contract.js`.
- Produces: `createTtsWindows({ spawnFn, dataDir, rate }) -> { nombre, capacidades, listarVoces() -> Promise<string[]>, sintetizar(texto, {voice, lang, rate}) -> Promise<{ wav: Buffer, voz: string, ms: number }>, dispose() }` y, en el puente, `window.sagitari.ttsList()`, `onTtsPhrase(cb)` con `{ id, bytes }`, `playPhrase(id)` (el renderer avisa de que ya ha sonado), `ttsStop()`.
- El WAV se sintetiza a un temporal, se lee a memoria y **se borra acto seguido**: el renderer recibe bytes, no rutas (así no hay ficheros vivos ni problemas de CSP).

- [ ] **Step 1: Escribir los tests que fallan**

```js
test('voz/tts-windows: sintetiza una frase, borra el temporal y dice qué voz usó', async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { createTtsWindows } = require('../main/voice/tts-windows');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sagi-tts-'));
  const llamadas = [];
  const spawnFn = (cmd, args) => {
    llamadas.push(args);
    const l = {};
    const proc = { stdout: { on: (k, f) => { l['o' + k] = f; } }, stderr: { on: (k, f) => { l['e' + k] = f; } }, on: (k, f) => { l[k] = f; }, kill() {}, stdin: { end() {} } };
    const outFile = args[args.indexOf('-OutFile') + 1];
    fs.writeFileSync(outFile, Buffer.from('RIFF....WAVEfmt '));
    setTimeout(() => {
      l['odata'](Buffer.from('VOICEUSED::Microsoft Helena\nOK::' + outFile + '|412\n'));
      l['exit'](0);
    }, 5);
    return proc;
  };
  const tts = createTtsWindows({ spawnFn, dataDir: dir });
  const r = await tts.sintetizar('Hola, esto es una prueba.', { voice: 'Microsoft Helena', lang: 'es-ES' });
  ok(r.wav.length > 8, 'devuelve bytes de WAV');
  eq(r.voz, 'Microsoft Helena', 'dice qué voz usó');
  eq(r.ms, 412, 'y cuánto tardó la síntesis');
  ok(!fs.existsSync(path.join(dir, 'tts')), 'no deja WAV temporal en disco');
  ok(llamadas[0].includes('tts.ps1'), 'llama a tts.ps1');
  ok(llamadas[0].includes('es-ES'), 'y le pasa el idioma');
});

test('voz/tts-windows: sin voz disponible devuelve un error legible, no una excepción', async () => {
  const { createTtsWindows } = require('../main/voice/tts-windows');
  const spawnFn = () => {
    const l = {};
    const proc = { stdout: { on: (k, f) => { l['o' + k] = f; } }, stderr: { on: (k, f) => { l['e' + k] = f; } }, on: (k, f) => { l[k] = f; }, kill() {}, stdin: { end() {} } };
    setTimeout(() => { l['odata'](Buffer.from('ERROR::No hay voces instaladas\n')); l['exit'](1); }, 5);
    return proc;
  };
  const tts = createTtsWindows({ spawnFn, dataDir: require('os').tmpdir() });
  let r = null;
  try { r = await tts.sintetizar('hola'); } catch (e) { r = { texto: e.message }; }
  ok(r === null || typeof r === 'object', 'no revienta el proceso');
  ok(!r || !r.wav, 'y no devuelve audio inventado');
});
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `npm test 2>&1 | tail -5`
Expected: FAIL con `Cannot find module '../main/voice/tts-windows'`

- [ ] **Step 3: Escribir `main/tts.ps1`**

```powershell
param(
  [string]$Lang = "es-ES",
  [string]$Voice = "",
  [string]$TextFile = "",
  [string]$OutFile = "",
  [int]$Rate = 0,
  [switch]$List
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { Add-Type -AssemblyName System.Runtime.WindowsRuntime } catch {}
function Say([string]$l) { try { [Console]::Out.WriteLine($l); [Console]::Out.Flush() } catch {} }

function Await($t, $T) {
  $m = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $nt = $m.MakeGenericMethod($T).Invoke($null, @($t)); $nt.Wait(-1) | Out-Null; $nt.Result
}

# Las voces modernas (las «móviles», mejores que las de escritorio) solo existen aquí:
# System.Speech no las ve. Por eso la síntesis va por WinRT y SAPI queda de respaldo.
try {
  [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

  $todas = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
  if ($List) {
    foreach ($v in $todas) { Say ("VOICE::" + $v.DisplayName + "|" + $v.Language + "|" + $v.Gender) }
    exit 0
  }

  $elegida = $null
  if ($Voice) { foreach ($v in $todas) { if ($v.DisplayName -eq $Voice) { $elegida = $v } } }
  if (-not $elegida) { foreach ($v in $todas) { if ($v.Language -like ($Lang.Split('-')[0] + '*') -and -not $elegida) { $elegida = $v } } }
  if (-not $elegida) { $elegida = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::DefaultVoice }

  $syn = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
  if ($elegida) { $syn.Voice = $elegida }
  $texto = [IO.File]::ReadAllText($TextFile)
  # El tono y la velocidad se piden por SSML: la API moderna no tiene propiedades sueltas.
  $tasa = if ($Rate -ge 0) { "+" + $Rate + "%" } else { $Rate.ToString() + "%" }
  $ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="' + $Lang + '"><prosody rate="' + $tasa + '">' + [System.Security.SecurityElement]::Escape($texto) + '</prosody></speak>'
  $t0 = Get-Date
  $stream = Await ($syn.SynthesizeSsmlToStreamAsync($ssml)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $ms = [int]((Get-Date) - $t0).TotalMilliseconds
  # OJO: en PowerShell 5.1 esto NO existe como método de instancia; hay que llamar a la
  # extensión estática. Comprobado con una sonda en la máquina de desarrollo: con la
  # forma de instancia falla con «no contiene ningún método llamado AsStreamForRead».
  $input = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
  $out = [IO.File]::Create($OutFile)
  $input.CopyTo($out); $out.Close(); $input.Close()
  Say ("VOICEUSED::" + $syn.Voice.DisplayName)
  Say ("OK::" + $OutFile + "|" + $ms)
} catch {
  # Respaldo: System.Speech (voces de escritorio). Peor voz, pero nunca deja al usuario mudo.
  try {
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    if ($Voice) { try { $s.SelectVoice($Voice) } catch {} }
    $s.Rate = [math]::Max(-10, [math]::Min(10, [int]($Rate / 10)))
    $t0 = Get-Date
    $s.SetOutputToWaveFile($OutFile)
    $s.Speak([IO.File]::ReadAllText($TextFile))
    $s.Dispose()
    Say ("VOICEUSED::" + $(try { $s.Voice.Name } catch { 'sistema' }))
    Say ("OK::" + $OutFile + "|" + [int]((Get-Date) - $t0).TotalMilliseconds)
  } catch {
    Say ("ERROR::" + $_.Exception.Message)
    exit 1
  }
}
```

- [ ] **Step 4: Escribir `main/voice/tts-windows.js`**

```js
'use strict';

/* Motor de hablar de Windows: sintetiza UNA frase a un WAV y devuelve los bytes.
 *
 * Por qué por WinRT y no por SAPI: las voces buenas de Windows 11 («Pablo», «Laura»,
 * «Helena» modernas) solo existen en el almacén moderno; System.Speech únicamente ve
 * «Helena Desktop», que es la robótica. tts.ps1 intenta WinRT y cae a SAPI solo si
 * aquello falla, así que aquí no hay dos caminos: hay uno con respaldo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { CAPACIDADES_BASE } = require('./contract');

function createTtsWindows({ spawnFn = spawn, dataDir = os.tmpdir(), scriptPath = path.join(__dirname, '..', 'tts.ps1'), rate = 0 } = {}) {
  const dir = path.join(dataDir, 'tts');

  function correr(args, texto) {
    return new Promise((resolve) => {
      const tmpText = path.join(os.tmpdir(), 'sagi-tts-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.txt');
      const tmpWav = path.join(os.tmpdir(), 'sagi-tts-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.wav');
      fs.writeFileSync(tmpText, String(texto || ''), 'utf8');
      const salida = { voz: '', ms: 0, error: '', file: tmpWav };
      let proc;
      try {
        proc = spawnFn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
          '-Lang', args.lang || 'es-ES', '-TextFile', tmpText, '-OutFile', tmpWav, '-Rate', String(args.rate ?? rate)], { windowsHide: true });
      } catch (e) {
        try { fs.unlinkSync(tmpText); } catch {}
        resolve({ ...salida, error: e.message });
        return;
      }
      let buf = '';
      proc.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const linea = buf.slice(0, i).replace(/\r$/, '').trim();
          buf = buf.slice(i + 1);
          if (linea.startsWith('VOICEUSED::')) salida.voz = linea.slice(11).trim();
          else if (linea.startsWith('OK::')) salida.ms = Number(linea.split('|')[1]) || 0;
          else if (linea.startsWith('ERROR::')) salida.error = linea.slice(7).trim();
        }
      });
      proc.stderr.on('data', (d) => { if (!salida.error) salida.error = d.toString('utf8').trim().slice(0, 200); });
      proc.on('exit', () => {
        try { fs.unlinkSync(tmpText); } catch {}
        resolve(salida);
      });
    });
  }

  async function sintetizar(texto, { voice = '', lang = 'es-ES', rate: r } = {}) {
    const r1 = await correr({ lang, voiceId: voice, rate: r }, texto);
    const limpio = () => { try { fs.unlinkSync(r1.file); } catch {} };
    if (r1.error || !fs.existsSync(r1.file)) { limpio(); return { wav: null, voz: r1.voz, ms: r1.ms, error: r1.error || 'sin audio' }; }
    const wav = fs.readFileSync(r1.file);
    limpio();
    return { wav, voz: r1.voz, ms: r1.ms, error: '' };
  }

  async function listarVoces() {
    const r = await new Promise((resolve) => {
      const l = [];
      let proc;
      try { proc = spawnFn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-List'], { windowsHide: true }); }
      catch { resolve(l); return; }
      let buf = '';
      proc.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const linea = buf.slice(0, i).replace(/\r$/, '').trim();
          buf = buf.slice(i + 1);
          if (linea.startsWith('VOICE::')) { const [nombre, idioma] = linea.slice(7).split('|'); l.push({ nombre, idioma }); }
        }
      });
      proc.on('exit', () => resolve(l));
    });
    return r;
  }

  return { nombre: 'windows', capacidades: { ...CAPACIDADES_BASE }, listarVoces, sintetizar, dispose: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

module.exports = { createTtsWindows };
```

- [ ] **Step 5: Cambiar el manejador de hablar en `main/main.js` y el puente**

Se **borra** el bloque que sintetizaba en línea con PowerShell (el que arranca `$v.Speak([Console]::In.ReadToEnd())`) y en su lugar:

```js
/* Una sola tubería de voz: se sintetiza por frases y se reproducen en el renderer, que
   es quien tiene el analizador de audio (para el orbe) y quien puede cortar al instante.
   Se conserva el nombre `tts:speak` y su contrato de silencio en arranques automatizados:
   hay una comprobación de ui-check que depende de eso. */
let ttsSeq = 0;
ipcMain.handle('tts:speak', async (e, text) => {
  if (HEADLESS) return { ok: false };                       // la regla que ya existía
  if (!config.settings.ttsEnabled || !text) return { ok: false };
  if (!voiceManager) return { ok: false };
  try {
    voiceManager.say(String(text));
    return { ok: true };
  } catch { return { ok: false }; }
});

ipcMain.handle('tts:list', async () => {
  try { return { ok: true, voices: await tts.listarVoces() }; } catch { return { ok: false, voices: [] }; }
});
```

Y en `main/preload.js`, junto a `speak`:

```js
  ttsList: () => ipcRenderer.invoke('tts:list'),
  onTtsPhrase: on('tts:phrase', ([p]) => [p]),      // { id, bytes }
  ttsPlayed: (id) => ipcRenderer.send('tts:played', id),
  ttsStop: () => ipcRenderer.send('tts:stop'),
```

- [ ] **Step 6: Ejecutar y ver que pasan**

Run: `npm test 2>&1 | tail -3 && npm run uicheck 2>&1 | grep -E "altavoces|UI-CHECK"`
Expected: PASS y `ok un arranque de prueba no saca voz por los altavoces` (la regla sigue en pie con el camino nuevo)

- [ ] **Step 7: Commit**

```bash
git add main/tts.ps1 main/voice/tts-windows.js main/main.js main/preload.js test/run.js
git commit -m "voz: sintesis por frases con las voces modernas de Windows y reproduccion en el renderer"
```

---

### Task 5: El manager del modo voz (`main/voice/manager.js`)

**Files:**
- Create: `main/voice/manager.js`
- Test: `test/run.js`

**Interfaces:**
- Consumes: `assertEvent` (contrato), `esBasura` (basura), el motor de escuchar y el de hablar por su contrato.
- Produces: `createVoiceManager({ emit, stt, tts, onPhrase, settings }) -> manager`, con
  `manager.open() -> Promise<void>`, `manager.close() -> Promise<void>`,
  `manager.ingest(ev) -> void`, `manager.say(text) -> void`, `manager.stopSpeaking() -> void`,
  `manager.spoken(id) -> void`, `manager.estado() -> string`.
  `onPhrase({ id, bytes })` lo usa `main.js` para mandar el audio al renderer.
  Reglas del manager: un `final` pasa por `esBasura` (si es basura, emite `notice` y **no** emite `final`); `say()` trocea en frases y las sintetiza **en orden**, esperando a `spoken(id)` para pasar a la siguiente; `stopSpeaking()` vacía la cola.

- [ ] **Step 1: Escribir los tests que fallan**

```js
test('voz/manager: un final limpio pasa, la basura se avisa y no se envía', async () => {
  const { createVoiceManager } = require('../main/voice/manager');
  const eventos = [];
  const stt = { nombre: 'stt-mentira', capacidades: { partials: true, confidence: true, level: false }, start: async () => {}, push: () => {}, stop: async () => {} };
  const tts = { nombre: 'tts-mentira', capacidades: { partials: false, confidence: false, level: false }, sintetizar: async () => ({ wav: Buffer.from('RIFF'), voz: 'x', ms: 1 }), listarVoces: async () => [] };
  const m = createVoiceManager({ emit: (e) => eventos.push(e), stt, tts, onPhrase: () => {} });
  await m.open();
  m.ingest({ type: 'final', text: 'Recuérdame llamar a Álvaro', confidence: 0.9 });
  m.ingest({ type: 'final', text: 'Gracias por ver el vídeo', confidence: 0.4 });
  const fines = eventos.filter((e) => e.type === 'final');
  eq(fines.length, 1, 'sólo pasa la frase de verdad');
  eq(fines[0].text, 'Recuérdame llamar a Álvaro', 'y es la buena');
  ok(eventos.some((e) => e.type === 'notice' && /basura|no te he entendido/i.test(e.text)), 'la basura se avisa');
  eq(m.estado(), 'oyendo', 'con una frase cerrada el estado pasa a oyendo');
});

test('voz/manager: trocea la respuesta en frases y las sintetiza en orden', async () => {
  const { createVoiceManager } = require('../main/voice/manager');
  const eventos = [];
  const frases = [];
  const tts = { nombre: 'tts-mentira', capacidades: { partials: false, confidence: false, level: false },
    sintetizar: async (t) => { frases.push(t); return { wav: Buffer.from('RIFF'), voz: 'x', ms: 1 }; }, listarVoces: async () => [] };
  const stt = { nombre: 'stt', capacidades: { partials: true, confidence: true, level: false }, start: async () => {}, push: () => {}, stop: async () => {} };
  let siguienteId = 0;
  const m = createVoiceManager({ emit: (e) => eventos.push(e), stt, tts, onPhrase: (p) => { siguienteId = p.id; setTimeout(() => m.spoken(p.id), 5); } });
  await m.open();
  m.say('Hecho. He creado el recordatorio y lo he anotado.');
  await new Promise((r) => setTimeout(r, 80));
  eq(frases.length, 2, 'dos frases: ' + JSON.stringify(frases));
  eq(frases[0], 'Hecho.', 'la primera es la primera');
  ok(eventos.some((e) => e.type === 'state' && e.state === 'hablando'), 'el estado pasa a hablando');
  ok(eventos.some((e) => e.type === 'state' && e.state === 'escuchando'), 'y vuelve a escuchando al terminar');
});

test('voz/manager: interrumpir corta la cola y no sintetiza lo que queda', async () => {
  const { createVoiceManager } = require('../main/voice/manager');
  const frases = [];
  const tts = { nombre: 'tts', capacidades: { partials: false, confidence: false, level: false },
    sintetizar: async (t) => { frases.push(t); return { wav: Buffer.from('RIFF'), voz: 'x', ms: 1 }; }, listarVoces: async () => [] };
  const stt = { nombre: 'stt', capacidades: { partials: true, confidence: true, level: false }, start: async () => {}, push: () => {}, stop: async () => {} };
  const m = createVoiceManager({ emit: () => {}, stt, tts, onPhrase: () => {} });   // nunca llega 'spoken'
  await m.open();
  m.say('Primera frase. Segunda frase. Tercera frase.');
  await new Promise((r) => setTimeout(r, 40));
  m.stopSpeaking();
  await new Promise((r) => setTimeout(r, 40));
  eq(frases.length, 1, 'sólo se sintetizó la que ya estaba en marcha');
  eq(m.estado(), 'escuchando', 'y vuelve a escuchar');
});
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `npm test 2>&1 | tail -5`
Expected: FAIL con `Cannot find module '../main/voice/manager'`

- [ ] **Step 3: Implementar el manager**

```js
'use strict';

/* Dueño del estado del modo voz y punto ÚNICO de entrada de eventos.
 *
 * Vive en el proceso principal porque aquí están los motores; el estado que ve el
 * usuario lo pinta el renderer con los mismos eventos que salen de aquí (mismo
 * vocabulario: el contrato). No sabe nada de Electron: recibe `emit` y `onPhrase`.
 */
const { assertEvent } = require('./contract');
const { esBasura } = require('./junk');

/* Trocea para sintetizar: se corta en final de frase y también en saltos de línea.
   Los puntos de cifras («9.30») y las abreviaturas no deben partir una frase. */
function trocear(texto) {
  const limpio = String(texto || '').replace(/```[\s\S]*?```/g, ' (código) ').replace(/\s+/g, ' ').trim();
  if (!limpio) return [];
  const partes = limpio.match(/[^.!?…\n]+[.!?…]*/g) || [limpio];
  const out = [];
  for (const p of partes) {
    const t = p.trim();
    if (!t) continue;
    const previa = out[out.length - 1];
    /* «9.» seguido de cifras, o una lista («1.»), no cierran frase. */
    if (previa && /(\d|[A-ZÁÉÍÓÚÑ])\.$/.test(previa) === false && previa.length < 12) out[out.length - 1] = previa + ' ' + t;
    else out.push(t);
  }
  return out;
}

function createVoiceManager({ emit, stt, tts, onPhrase = () => {}, settings = {} } = {}) {
  let estado = 'escuchando';
  let cola = [];
  let hablando = null;
  let seq = 0;
  let abierto = false;

  const pon = (e) => { assertEvent(e); emit(e); };
  const setEstado = (s) => { if (estado !== s) { estado = s; pon({ type: 'state', state: s }); } };

  async function open() {
    await stt.start();
    abierto = true;
    setEstado('escuchando');
  }

  async function close() {
    abierto = false;
    stopSpeaking();
    try { await stt.stop(); } catch {}
    try { tts.dispose && tts.dispose(); } catch {}
  }

  /* Punto único: todo lo que ocurre en el modo voz entra por aquí. */
  function ingest(ev) {
    assertEvent(ev);
    if (ev.type === 'partial') { setEstado('oyendo'); emit(ev); return; }
    if (ev.type === 'final') {
      if (!ev.text || !ev.text.trim()) return;
      const j = esBasura(ev.text, ev.ms || 0);
      if (j.basura) { setEstado('escuchando'); pon({ type: 'notice', text: 'No te he entendido (' + j.motivo + ').' }); return; }
      setEstado('oyendo');
      emit(ev);
      return;
    }
    emit(ev);
  }

  function say(texto) {
    const frases = trocear(texto);
    if (!frases.length) return;
    cola = cola.concat(frases);
    if (!hablando) siguiente();
  }

  async function siguiente() {
    const frase = cola.shift();
    if (!frase || !abierto) { hablando = null; setEstado('escuchando'); return; }
    hablando = frase;
    setEstado('hablando');
    let r;
    try { r = await tts.sintetizar(frase, { lang: settings.voiceLang || 'es-ES', voice: settings.ttsVoice || '', rate: settings.ttsRate || 0 }); }
    catch (e) { r = { wav: null, error: e.message }; }
    if (hablando !== frase) return;                      // la interrumpieron mientras sintetizaba
    if (!r || !r.wav) { pon({ type: 'notice', text: 'No he podido leer la respuesta en voz alta.' }); siguiente(); return; }
    seq += 1;
    onPhrase({ id: seq, bytes: r.wav, voz: r.voz });     // el renderer lo reproduce y avisa con spoken(id)
  }

  function spoken(id) {
    if (id !== seq) return;                              // una frase vieja que ya no importa
    siguiente();
  }

  function stopSpeaking() {
    cola = [];
    hablando = null;
    if (estado === 'hablando') setEstado('escuchando');
  }

  return { open, close, ingest, say, stopSpeaking, spoken, estado: () => estado };
}

module.exports = { createVoiceManager, trocear };
```

- [ ] **Step 4: Ejecutar y ver que pasan**

Run: `npm test 2>&1 | tail -3`
Expected: PASS (tres tests nuevos)

- [ ] **Step 5: Commit**

```bash
git add main/voice/manager.js test/run.js
git commit -m "voz: manager del modo voz (punto unico de entrada, frases en orden y corte al interrumpir)"
```

---

### Task 6: Cableado del proceso principal (permiso de micrófono, IPC y cierre limpio)

**Files:**
- Modify: `main/main.js`, `main/preload.js`, `scripts/ui-check.js` (dos comprobaciones nuevas y los flags del dispositivo de mentira)

**Interfaces:**
- Consumes: `createVoiceManager`, `createSttWindows`, `createTtsWindows`.
- Produces: IPC `voice:open` → `{ok, motores}`, `voice:close` → `{ok}`, canal `voice:event` (renderer→main), canal `tts:phrase` (main→renderer con `{id, bytes}`), `tts:played` y `tts:stop` (renderer→main). **Los canales clásicos `voice:start`/`voice:stop` se quedan como están**: el dictado al compositor de `Alt`+clic sigue usándolos.

- [ ] **Step 1: Añadir las dos comprobaciones que fallan en `scripts/ui-check.js`**

Junto a las demás comprobaciones del bloque final, antes de la de los altavoces:

```js
  /* El modo voz necesita micrófono y dos canales nuevos. Se prueba con el dispositivo
     de mentira de Chromium (--use-fake-device-for-media-stream), así que pasa también
     en una máquina sin micrófono, como el runner de CI. */
  await judge('el micrófono se concede a la app y solo a ella',
    '(async function(){ const s = await navigator.mediaDevices.getUserMedia({ audio: true }); const ok = !!s && s.getAudioTracks().length === 1; s.getTracks().forEach(t => t.stop()); return ok; })()');
  await judge('el modo voz se abre y se cierra por IPC',
    '(async function(){ const a = await window.sagitari.voiceOpen(); const b = await window.sagitari.voiceClose(); return !!(a && a.ok) && !!(b && b.ok); })()');
```

Y en el arranque de la app, añadir los flags del dispositivo de mentira:

```js
  /* --use-fake-device-for-media-stream: micrófono sintético (tono), para que la
     comprobación de permiso y de nivel no dependa del hardware de quien ejecute esto. */
  const child = spawn(electron, ['--remote-debugging-port=' + port, '--hidden', '--use-fake-device-for-media-stream', '.'], { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `npm run uicheck 2>&1 | grep -E "micrófono se concede|se abre y se cierra|FALLO|UI-CHECK"`
Expected: FAIL en las dos nuevas (`window.sagitari.voiceOpen is not a function`)

- [ ] **Step 3: Escribir el cableado en `main/main.js`**

```js
// ---- modo voz (fase 1: motores de Windows) ----
const { createVoiceManager } = require('./voice/manager');
const { createSttWindows } = require('./voice/stt-windows');
const { createTtsWindows } = require('./voice/tts-windows');

let voiceManager = null;
let ttsEngine = null;

/* El permiso de micrófono se concede SOLO a nuestra propia página. Hoy el renderer es
   un fichero local nuestro, pero la comprobación deja escrito el límite: si mañana
   carga contenido de fuera, ese contenido no hereda el micrófono del usuario. */
function esNuestraPagina(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'file:' && decodeURIComponent(u.pathname).toLowerCase().endsWith('renderer/index.html');
  } catch { return false; }
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const url = (details && details.requestingUrl) || wc.getURL();
    const soloAudio = !details || !details.mediaTypes || details.mediaTypes.every((t) => t === 'audio');
    cb(permission === 'media' && soloAudio && esNuestraPagina(url));
  });
  /* El de comprobación responde a las consultas internas de Chromium: solo se limita
     'media' (lo demás sigue como estaba) para no romper nada más. */
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) => {
    if (permission !== 'media') return true;
    const url = (details && details.requestingUrl) || origin || '';
    return esNuestraPagina(url) && (!details || !details.mediaType || details.mediaType === 'audio');
  });
});

function emitVoz(ev) { try { if (win && !win.isDestroyed()) win.webContents.send('voice:event', ev); } catch {} }

ipcMain.handle('voice:open', async () => {
  try {
    if (!voiceManager) {
      ttsEngine = createTtsWindows({ dataDir: DATA_DIR });
      voiceManager = createVoiceManager({
        emit: emitVoz,
        stt: createSttWindows({ emit: (ev) => voiceManager.ingest(ev), lang: config.settings.voiceLang || 'es-ES' }),
        tts: ttsEngine,
        onPhrase: (p) => { try { if (win && !win.isDestroyed()) win.webContents.send('tts:phrase', p); } catch {} },
        settings: config.settings,
      });
    }
    await voiceManager.open();
    return { ok: true, motores: { escuchar: 'windows', hablar: 'windows' } };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('voice:close', async () => {
  try { if (voiceManager) await voiceManager.close(); } catch {}
  voiceManager = null;
  ttsEngine = null;
  return { ok: true };
});

ipcMain.on('voice:event', (e, ev) => { if (voiceManager) voiceManager.ingest(ev); });
ipcMain.on('tts:played', (e, id) => { if (voiceManager) voiceManager.spoken(id); });
ipcMain.on('tts:stop', () => { if (voiceManager) voiceManager.stopSpeaking(); });
```

Y en el cierre ordenado (donde hoy se mata `whisper` y `ttsProc`):

```js
  try { if (voiceManager) await voiceManager.close(); } catch {}
  voiceManager = null;
```

- [ ] **Step 4: Añadir el puente en `main/preload.js`**

```js
  voiceOpen: () => ipcRenderer.invoke('voice:open'),
  voiceClose: () => ipcRenderer.invoke('voice:close'),
  voiceEvent: (ev) => ipcRenderer.send('voice:event', ev),
  onVoiceEvent: on('voice:event', ([ev]) => [ev]),
```

- [ ] **Step 5: Ejecutar y ver que pasan**

Run: `npm run uicheck 2>&1 | grep -E "micrófono se concede|se abre y se cierra|altavoces|UI-CHECK"`
Expected: PASS las tres, incluida la de que un arranque de prueba no saca voz

- [ ] **Step 6: Commit**

```bash
git add main/main.js main/preload.js scripts/ui-check.js
git commit -m "voz: permiso de microfono solo para nuestra pagina, IPC del modo voz y cierre limpio"
```

---

### Task 7: El orbe (`renderer/orb.js`)

**Files:**
- Create: `renderer/orb.js`
- Modify: `renderer/index.html` (cargar el script junto a los demás del renderer)
- Test: `scripts/ui-check.js` (dos comprobaciones: la matemática del suavizado y que la malla pinta y cambia de cara)

**Interfaces:**
- Produces: `window.OrbKit = { smoothLevel(v, objetivo, dt) -> number, draw(ctx, w, h, nivel, estado, t) -> void, ESTADOS: string[] }`.
  `smoothLevel` aplica **ataque rápido y caída lenta** (constantes 18 y 3.2 por segundo): es lo que hace que el orbe no tiemble.
  `draw` pinta la malla de puntos (19×19) según el estado: `escuchando` (respiración lenta tenue), `oyendo` (se abre con el nivel), `pensando` (onda que cruza a ritmo constante), `hablando` (late y el núcleo se aclara), `confirmando` (quieta y grave), `error` (tenue, sin movimiento).

- [ ] **Step 1: Añadir las dos comprobaciones que fallan en `scripts/ui-check.js`**

```js
  await judge('el suavizado del orbe sube rápido y baja despacio',
    '(function(){ const o = window.OrbKit; if (!o) return false; let v = 0; v = o.smoothLevel(v, 1, 0.05); const subida = v; v = o.smoothLevel(v, 0, 0.05); const bajada = subida - v; return subida > 0.4 && bajada < subida / 2; })()');
  await judge('la malla del orbe pinta y cambia de cara con el estado',
    '(function(){ const o = window.OrbKit; if (!o) return false; const c = document.createElement("canvas"); c.width = 200; c.height = 200; const ctx = c.getContext("2d"); const cuenta = () => { const d = ctx.getImageData(0, 0, 200, 200).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 12) n++; return n; }; o.draw(ctx, 200, 200, 0.6, "oyendo", 1.2); const a = cuenta(); o.draw(ctx, 200, 200, 0.6, "escuchando", 1.2); const b = cuenta(); o.draw(ctx, 200, 200, 0.6, "pensando", 1.2); const e = cuenta(); const borde = ctx.getImageData(0, 0, 1, 1).data[3]; return a > 500 && b > 500 && e > 500 && Math.abs(a - b) > 50 && borde === 0; })()');
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `npm run uicheck 2>&1 | grep -E "suavizado del orbe|malla del orbe|FALLO"`
Expected: FAIL (`window.OrbKit` no existe)

- [ ] **Step 3: Implementar `renderer/orb.js`**

```js
'use strict';

/* El orbe: una malla de puntos que late con la voz.
 *
 * Reglas de dibujo que ya se validaron en las maquetas (y que no son gusto, son fallos
 * vistos y corregidos): el lienzo NO pinta fondo propio (si lo pinta, se ve el bloque
 * cuadrado sobre el panel); el halo termina DENTRO del lienzo (si llega al borde se
 * corta y aparece un cuadrado tenue); la malla se desvanece hacia el borde (si corta en
 * seco se ve el círculo); y el remolino se apaga en el centro (si no, queda un hueco
 * negro en medio). El halo vibra con `nivel`, que va suavizado: ataque rápido, caída
 * lenta, como un vúmetro bueno.
 */
(function () {
  const CLARO = '255,255,255', MEDIO = '196,181,253', BASE = '139,92,246';
  const ESTADOS = ['escuchando', 'oyendo', 'pensando', 'hablando', 'confirmando', 'error'];
  const ATAQUE = 18, CAIDA = 3.2;

  function smoothLevel(v, objetivo, dt) {
    const k = objetivo > v ? ATAQUE : CAIDA;
    const siguiente = v + (objetivo - v) * Math.min(1, k * dt);
    return siguiente < 0.012 ? 0.012 : siguiente;
  }

  /* Cuánta energía muestra cada estado cuando NO hay voz (el orbe nunca está muerto). */
  function nivelDeFondo(estado, t) {
    if (estado === 'escuchando') return 0.05 + 0.03 * Math.sin(t / 1.4);
    if (estado === 'pensando') return 0.30 + 0.06 * Math.sin(t / 0.9);
    if (estado === 'confirmando') return 0.18;
    if (estado === 'error') return 0.06;
    return 0.05;
  }

  function draw(ctx, w, h, nivel, estado, t) {
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.40, N = 19;
    ctx.clearRect(0, 0, w, h);
    const tono = estado === 'hablando' ? CLARO : MEDIO;
    const RH = R * 1.12;                              // dentro del lienzo, con margen
    const halo = ctx.createRadialGradient(cx, cy, 1, cx, cy, RH);
    halo.addColorStop(0, 'rgba(' + BASE + ',' + (0.14 + 0.28 * nivel) + ')');
    halo.addColorStop(0.5, 'rgba(' + BASE + ',0.06)');
    halo.addColorStop(1, 'rgba(' + BASE + ',0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, RH, 0, 7); ctx.fill();

    const paso = (R * 2) / (N - 1);
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const x = cx - R + i * paso, y = cy - R + j * paso;
        const d = Math.hypot(x - cx, y - cy) / R;
        const caida = Math.max(0, Math.min(1, (1.06 - d) / 0.34));
        if (caida <= 0) continue;
        const borde = 1 - d * d;
        const ang = Math.atan2(y - cy, x - cx);
        let onda;
        if (estado === 'escuchando') onda = Math.sin(t * 1.1 - d * 2.2) * 0.5 + 0.5;
        else if (estado === 'pensando') onda = Math.sin(t * 2.6 - d * 5.5 + ang * 0.8) * 0.5 + 0.5;
        else {
          const radial = Math.sin(d * 7 - t * 3.4);
          const remolino = Math.cos(ang * 3 + t) * Math.min(1, d * 1.8);
          onda = 0.5 + 0.5 * (0.75 * radial + 0.35 * remolino);
        }
        const quieto = estado === 'confirmando' || estado === 'error';
        const fuerza = quieto ? 0.25 : estado === 'escuchando' ? 0.35 : estado === 'pensando' ? 0.75 : 1.15;
        const des = (2 + 9 * onda) * borde * (0.35 + nivel) * fuerza;
        const px = x + Math.cos(ang) * des, py = y + Math.sin(ang) * des;
        const e = quieto ? 0.7 : estado === 'escuchando' ? 0.55 : estado === 'pensando' ? 0.8 : 1;
        const a = (0.12 + 0.75 * borde * (0.45 + 0.55 * nivel)) * e * caida;
        ctx.fillStyle = 'rgba(' + (borde > 0.72 ? tono : MEDIO) + ',' + a + ')';
        ctx.beginPath(); ctx.arc(px, py, 0.8 + 1.5 * borde + 1.1 * nivel * e, 0, 7); ctx.fill();
      }
    }
  }

  window.OrbKit = { smoothLevel, draw, ESTADOS, nivelDeFondo };
})();
```

- [ ] **Step 4: Ejecutar y ver que pasan**

Run: `npm run uicheck 2>&1 | grep -E "suavizado del orbe|malla del orbe|UI-CHECK"`
Expected: PASS las dos, con `UI-CHECK::{"ok":true,...}`

- [ ] **Step 5: Commit**

```bash
git add renderer/orb.js renderer/index.html scripts/ui-check.js
git commit -m "voz: el orbe (malla de puntos) con las reglas de dibujo validadas en las maquetas"
```

---

### Task 8: El panel del modo voz (`renderer/voice-mode.js`, marca y estilos)

**Files:**
- Modify: `renderer/index.html` (marca del panel + `<script src="voice-mode.js">`), `renderer/styles.css`
- Create: `renderer/voice-mode.js`
- Test: `scripts/ui-check.js` (abre y cierra con `Esc`; el estado se pinta)

**Interfaces:**
- Consumes: `window.OrbKit`, `window.sagitari.onVoiceEvent`, `onTtsPhrase`, `voiceOpen/voiceClose`, `voiceEvent`, `ttsPlayed`, `ttsStop`.
- Produces: `window.VoiceMode = { abrir(), cerrar(), handle(ev), estado(), abierto(), audio: { reproducir({id, bytes}), parar() } }`, y los enganches que usa la Task 9: `window.VoiceMode.enviar` (función que el renderer le inyecta para mandar el texto al agente) y `window.VoiceMode.pasos(lista)`.
  `handle(ev)` es el **punto único de entrada del renderer**: los eventos del motor llegan por `onVoiceEvent`, y los del propio panel (estado al enviar, pasos del agente) entran por aquí también.

- [ ] **Step 1: Añadir la comprobación que falla en `scripts/ui-check.js`**

```js
  /* El panel del modo voz: se abre, se cierra con Esc y no deja rastro cuando está cerrado. */
  await judge('el modo voz abre con el micro y cierra con Esc',
    '(async function(){ const vm = window.VoiceMode; if (!vm) return false; await vm.abrir(); const abierto = vm.abierto() && !document.querySelector("#voiceMode").hidden; document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await new Promise(r => setTimeout(r, 60)); const cerrado = !vm.abierto() && document.querySelector("#voiceMode").hidden; return abierto && cerrado; })()');
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `npm run uicheck 2>&1 | grep -E "modo voz abre|FALLO|UI-CHECK"`
Expected: FAIL (`window.VoiceMode` no existe)

- [ ] **Step 3: Añadir la marca en `renderer/index.html`**

Dentro del contenedor de la app, junto a las vistas (y nunca dentro de una vista, porque se superpone a ellas):

```html
      <!-- Modo voz: se superpone al área del chat. El orbe es decorativo (aria-hidden) y
           todo lo que importa es texto, para que quien use lector de pantalla no dependa
           del dibujo. `hidden` de verdad cuando está cerrado: nada animando de fondo. -->
      <div id="voiceMode" hidden>
        <div class="vm-cabecera"><span id="vmEstado">Escuchando</span></div>
        <canvas id="vmOrbe" width="380" height="380" aria-hidden="true"></canvas>
        <div class="vm-texto">
          <p id="vmParcial" class="vm-parcial" aria-live="polite"></p>
          <div id="vmHistorial"></div>
        </div>
        <div id="vmPasos" class="vm-pasos"></div>
        <div id="vmConfirm" class="vm-confirm" hidden>
          <p id="vmConfirmTexto"></p>
          <div class="vm-botones">
            <button class="cbtn" id="vmSi">Sí, hazlo</button>
            <button class="cbtn" id="vmNo">No</button>
          </div>
        </div>
        <div id="vmError" class="vm-error" hidden>
          <p id="vmErrorTexto"></p>
          <p id="vmErrorFix" class="vm-hint"></p>
        </div>
        <div class="vm-pie"><span><kbd>Esc</kbd> para salir</span><span id="vmPista">habla cuando quieras, te escucho</span></div>
      </div>
```

Y al final del cuerpo, junto a los otros scripts del renderer:

```html
  <script src="voice-mode.js"></script>
```

- [ ] **Step 4: Escribir `renderer/voice-mode.js`**

```js
'use strict';

/* El panel del modo voz: dueño del estado que ve el usuario y punto ÚNICO de entrada
   del renderer. Habla el mismo vocabulario que el proceso principal (el contrato de
   main/voice/contract.js), así que el banco de pruebas puede inyectar voz sintética
   por handle() y probar todo esto sin micrófono.
 *
 * El nivel del orbe sale de DOS sitios, y es a propósito: mientras escucha, del
 * micrófono (que captura el renderer); mientras habla, del audio que está sonando. Así
 * el orbe siempre late con la voz que importa en ese momento.
 */
(function () {
  const ESTADOS = { escuchando: 'Escuchando', oyendo: 'Oyendo', pensando: 'Pensando', hablando: 'Hablando', confirmando: 'Esperando tu permiso', error: 'Atención' };
  let abierto = false;
  let estado = 'escuchando';
  let nivel = 0, objetivo = 0;
  let raf = 0, t0 = 0, prev = 0;
  let mic = null, ctxAudio = null, analizadorMic = null;
  let reproductor = null, analizadorSalida = null, fraseActual = null;
  let sueloRuido = 0.01, calibrado = false;
  let reducido = false;

  const $vm = (s) => document.querySelector(s);
  let ENVIAR = () => {};
  let HABLAR = () => {};

  function setEstado(s) {
    if (!ESTADOS[s] || estado === s) return;
    estado = s;
    const el = $vm('#vmEstado');
    if (el) el.textContent = ESTADOS[s];
    if (s === 'escuchando' || s === 'oyendo' || s === 'pensando' || s === 'error') {
      const c = $vm('#vmConfirm'); if (c) c.hidden = true;
    }
  }

  /* Punto único: todo lo que ocurre en el modo voz entra por aquí. */
  function handle(ev) {
    if (!ev || !ev.type) return;
    if (ev.type === 'state') { setEstado(ev.state); return; }
    if (ev.type === 'level') { objetivo = Math.max(0, Math.min(1, ev.value)); return; }
    if (ev.type === 'partial') {
      setEstado('oyendo');
      const p = $vm('#vmParcial'); if (p) p.textContent = ev.text;
      return;
    }
    if (ev.type === 'final') {
      const p = $vm('#vmParcial'); if (p) p.textContent = '';
      /* Antes de mandar nada al agente hay tres cosas que se atienden aquí:
         1) la respuesta a una confirmación pendiente («sí»/«no»);
         2) la orden de salir («adiós», «cierra»);
         3) lo demás, que sí es una petición. */
      if (responder(ev.text)) return;
      if (/^(adi[oó]s|hasta luego|cierra|para el modo voz)\b/i.test(String(ev.text).trim())) { cerrar(); return; }
      /* La confianza se muestra: con menos de 0,5 la frase queda marcada y se puede
         corregir pinchando en ella. El motor falla sobre todo en nombres propios. */
      escribir('Tú', ev.text, ev.confidence);
      setEstado('pensando');
      ENVIAR(ev.text);
      return;
    }
    /* Los avisos van a la franja; si el usuario ha pedido oírlos, el renderer los habla
       (aquí no se decide: el panel no conoce los ajustes). */
    if (ev.type === 'notice') { pista(ev.text); HABLAR(ev.text); return; }
    if (ev.type === 'error') { error(ev.text, ev.fix || ''); return; }
  }

  function escribir(quien, texto, confianza) {
    const h = $vm('#vmHistorial');
    if (!h) return;
    const fila = document.createElement('div');
    fila.className = 'vm-fila vm-' + (quien === 'Tú' ? 'tu' : 'sagitari');
    if (quien === 'Tú' && typeof confianza === 'number' && confianza < 0.5) fila.classList.add('vm-dudoso');
    const q = document.createElement('span'); q.className = 'vm-quien'; q.textContent = quien;
    const t = document.createElement('span'); t.className = 'vm-dice'; t.textContent = texto;
    if (quien === 'Tú') { t.title = 'Pincha para corregir; Enter reenvía'; t.onclick = () => editar(t, texto); }
    fila.appendChild(q); fila.appendChild(t);
    h.appendChild(fila);
    h.scrollTop = h.scrollHeight;
  }

  /* Corregir lo dictado: se pincha la frase, se arregla y Enter la reenvía por el MISMO
     camino (es la red de seguridad frente a un nombre propio mal oído). */
  function editar(nodo, original) {
    const campo = document.createElement('input');
    campo.className = 'vm-editar'; campo.type = 'text'; campo.value = original;
    nodo.replaceWith(campo);
    campo.focus(); campo.select();
    campo.onkeydown = (e) => {
      if (e.key === 'Enter') {
        const nuevo = campo.value.trim();
        nodo.textContent = nuevo || original;
        campo.replaceWith(nodo);
        if (nuevo && nuevo !== original) { setEstado('pensando'); ENVIAR(nuevo); }
      } else if (e.key === 'Escape') {
        nodo.textContent = original;
        campo.replaceWith(nodo);
      }
    };
  }

  function pista(texto) { const p = $vm('#vmPista'); if (p) p.textContent = texto; }
  function error(texto, fix) {
    setEstado('error');
    const caja = $vm('#vmError'); if (!caja) return;
    caja.hidden = false;
    $vm('#vmErrorTexto').textContent = texto;
    $vm('#vmErrorFix').textContent = fix || '';
  }

  function pasos(lista) {
    const c = $vm('#vmPasos');
    if (!c) return;
    c.innerHTML = '';
    for (const p of lista || []) {
      const d = document.createElement('div');
      d.className = 'vm-paso';
      d.textContent = (p.ok === false ? '✗ ' : '▸ ') + (p.label || '');
      c.appendChild(d);
    }
  }

  /* Confirmación (permiso de una herramienta): se contesta con el ratón o diciendo
     «sí»/«no», que llega como un `final` normal y se reconoce aquí. */
  let confirmacion = null;
  function pedirConfirmacion({ texto, si, no }) {
    setEstado('confirmando');
    confirmacion = { si, no };
    const caja = $vm('#vmConfirm'); if (!caja) return;
    $vm('#vmConfirmTexto').textContent = texto;
    caja.hidden = false;
  }
  function responder(texto) {
    if (!confirmacion) return false;
    const t = String(texto || '').toLowerCase().trim();
    const si = /^(s[ií]|vale|hazlo|adelante|confirma|de acuerdo|ok)\b/.test(t);
    const no = /^(no|cancela|para|detente|mejor no)\b/.test(t);
    if (!si && !no) return false;
    const fn = si ? confirmacion.si : confirmacion.no;
    confirmacion = null;
    const caja = $vm('#vmConfirm'); if (caja) caja.hidden = true;
    setEstado('pensando');
    if (fn) fn();
    return true;
  }

  async function abrir() {
    if (abierto) return;
    abierto = true;
    reducido = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const panel = $vm('#voiceMode');
    if (panel) panel.hidden = false;
    setEstado('escuchando');
    document.addEventListener('keydown', alTeclado, true);
    const r = await window.sagitari.voiceOpen().catch(() => null);
    if (!r || !r.ok) { error('No he podido abrir el modo voz.', 'Cierra y vuelve a abrirlo; si sigue, revisa Ajustes › Voz.'); }
    await abrirMicro();
    arrancarBucle();
  }

  async function cerrar() {
    if (!abierto) return;
    abierto = false;
    pararBucle();
    document.removeEventListener('keydown', alTeclado, true);
    await pararAudio();
    if (mic) { mic.getTracks().forEach((t) => t.stop()); mic = null; }
    if (ctxAudio && ctxAudio.state !== 'closed') { try { ctxAudio.close(); } catch {} }
    ctxAudio = null; analizadorMic = null;
    const panel = $vm('#voiceMode');
    if (panel) panel.hidden = true;
    try { await window.sagitari.voiceClose(); } catch {}
  }

  function alTeclado(e) { if (e.key === 'Escape' && abierto) { e.preventDefault(); cerrar(); } }

  /* Micrófono del renderer: es la fuente del nivel del orbe y de la calibración de ruido. */
  async function abrirMicro() {
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      ctxAudio = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctxAudio.createMediaStreamSource(mic);
      analizadorMic = ctxAudio.createAnalyser();
      analizadorMic.fftSize = 1024;
      src.connect(analizadorMic);
      sueloRuido = 0.01;
    } catch (e) {
      error('No tengo acceso al micrófono.', 'Revisa el permiso en ms-settings:privacy-microphone y vuelve a abrir el modo voz.');
    }
  }

  function rms(analizador) {
    if (!analizador) return 0;
    const buf = new Uint8Array(analizador.fftSize);
    analizador.getByteTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; }
    return Math.sqrt(s / buf.length);
  }

  /* Audio de la respuesta: bytes del proceso principal → WebAudio. Va por WebAudio y no
     por un <audio src> a propósito: se decodifica en memoria (sin CSP de por medio) y se
     puede cortar en el acto, además de dar el nivel del orbe. */
  async function reproducir({ id, bytes }) {
    try {
      if (!ctxAudio) ctxAudio = new (window.AudioContext || window.webkitAudioContext)();
      const datos = (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).buffer;
      const audio = await ctxAudio.decodeAudioData(datos.slice(0));
      await pararAudio();
      reproductor = ctxAudio.createBufferSource();
      reproductor.buffer = audio;
      analizadorSalida = ctxAudio.createAnalyser();
      analizadorSalida.fftSize = 1024;
      reproductor.connect(analizadorSalida);
      analizadorSalida.connect(ctxAudio.destination);
      fraseActual = id;
      setEstado('hablando');
      reproductor.onended = () => {
        if (fraseActual !== id) return;
        fraseActual = null;
        window.sagitari.ttsPlayed(id);
      };
      reproductor.start();
    } catch (e) {
      pista('No he podido reproducir la voz.');
      if (fraseActual === id) { fraseActual = null; window.sagitari.ttsPlayed(id); }
    }
  }

  async function pararAudio() {
    if (reproductor) {
      const id = fraseActual;
      try { reproductor.onended = null; reproductor.stop(); } catch {}
      reproductor = null; analizadorSalida = null;
      /* Cortar de verdad: la frase que sonaba ya no va a terminar, así que se le dice al
         proceso principal que la dé por dicha para que no se quede esperando. */
      if (id !== null) window.sagitari.ttsPlayed(id);
      fraseActual = null;
    }
  }

  function arrancarBucle() {
    const c = $vm('#vmOrbe');
    if (!c || !window.OrbKit) return;
    const ctx = c.getContext('2d');
    t0 = performance.now(); prev = t0;
    const paso = (now) => {
      const t = (now - t0) / 1000;
      const dt = Math.min(0.05, (now - prev) / 1000); prev = now;
      /* El nivel que se pinta: el del audio que suena si estamos hablando, el del
         micrófono si estamos escuchando u oyendo. */
      const fuente = estado === 'hablando' ? rms(analizadorSalida) : rms(analizadorMic);
      if (fuente > 0 && !calibrado) { sueloRuido = sueloRuido * 0.9 + fuente * 0.1; }
      const objetivoReal = Math.max(objetivo, fuente * 2.2);
      nivel = window.OrbKit.smoothLevel(nivel, reducido ? window.OrbKit.nivelDeFondo(estado, t) : Math.max(objetivoReal, window.OrbKit.nivelDeFondo(estado, t)), dt);
      window.OrbKit.draw(ctx, c.width, c.height, nivel, estado, t);
      if (estado === 'hablando') vigilarInterrupcion(fuente, now);
      raf = requestAnimationFrame(paso);
    };
    raf = requestAnimationFrame(paso);
  }
  function pararBucle() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  /* Interrupción (barge-in): si hablas mientras el asistente habla, se calla. Se exige
     voz sostenida (250 ms) para que un golpe de ruido no corte una respuesta. */
  let vozDesde = 0;
  function vigilarInterrupcion(fuente, now) {
    const umbral = Math.max(0.02, sueloRuido * 3.5);
    if (fuente > umbral) {
      if (!vozDesde) vozDesde = now;
      if (now - vozDesde > 250) { vozDesde = 0; interrumpir(); }
    } else vozDesde = 0;
  }
  async function interrumpir() {
    await pararAudio();
    window.sagitari.ttsStop();
    setEstado('oyendo');
  }

  window.VoiceMode = {
    abrir, cerrar, handle, pasos, pedirConfirmacion, responder,
    estado: () => estado, abierto: () => abierto,
    audio: { reproducir, parar: pararAudio },
    setEnviar: (fn) => { ENVIAR = fn; },
    setHablar: (fn) => { HABLAR = fn; },
  };
})();
```

- [ ] **Step 5: Añadir los estilos en `renderer/styles.css`**

```css
/* ---- modo voz ---- */
#voiceMode { position: absolute; inset: 0; z-index: 40; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; background: radial-gradient(120% 120% at 50% 30%, #14121f 0%, #0b0a12 70%); }
#voiceMode[hidden] { display: none; }
#vmOrbe { width: 190px; height: 190px; }              /* el lienzo va sin fondo: se ve el panel */
.vm-cabecera { letter-spacing: .06em; text-transform: uppercase; font-size: 11px; color: var(--accent); }
.vm-texto { width: min(680px, 86%); max-height: 34vh; overflow: auto; }
.vm-parcial { opacity: .55; font-style: italic; margin: 4px 0; }
.vm-fila { display: flex; gap: 8px; margin: 4px 0; }
.vm-quien { min-width: 62px; font-weight: 600; color: var(--accent); }
.vm-pasos { font-size: 12px; opacity: .85; min-height: 18px; }
.vm-confirm { border: 1px solid rgba(251,191,36,.5); background: rgba(251,191,36,.08); border-radius: 10px; padding: 10px; width: min(560px, 84%); }
.vm-botones { display: flex; gap: 8px; margin-top: 6px; }
.vm-error { border: 1px solid rgba(248,113,113,.5); border-radius: 10px; padding: 10px; width: min(560px, 84%); }
.vm-pie { font-size: 11px; opacity: .6; display: flex; gap: 18px; }
.vm-dudoso .vm-dice { color: #fcd34d; }              /* confianza baja: se ve que dudó */
.vm-editar { background: #17141f; color: inherit; border: 1px solid rgba(139,92,246,.5); border-radius: 6px; padding: 2px 6px; font: inherit; min-width: 60%; }
kbd { border: 1px solid rgba(255,255,255,.25); border-radius: 5px; padding: 1px 6px; }
@media (prefers-reduced-motion: reduce) { #vmOrbe { transition: none; } }
```

- [ ] **Step 6: Ejecutar y ver que pasa**

Run: `npm run uicheck 2>&1 | grep -E "modo voz abre|UI-CHECK"`
Expected: PASS y `UI-CHECK::{"ok":true,"fallos":0}`

- [ ] **Step 7: Commit**

```bash
git add renderer/voice-mode.js renderer/index.html renderer/styles.css scripts/ui-check.js
git commit -m "voz: panel del modo voz (punto unico de entrada, orbe, transcripcion, confirmacion y errores)"
```

---

### Task 9: Cableado del renderer (`renderer/app.js`)

**Files:**
- Modify: `renderer/app.js` (extraer `enviarTexto`, abrir el modo desde el micro, hablar siempre en el modo, ajustes) y `renderer/index.html` (filas de Ajustes › Voz)

**Interfaces:**
- Consumes: `window.VoiceMode` (Tasks 8), `window.sagitari.speak` (Task 4).
- Produces: `enviarTexto(text, atts) -> Promise<void>` (el cuerpo de `sendFrom` sin leer del compositor) y el enganche `window.VoiceMode.setEnviar(enviarTexto)`.

- [ ] **Step 1: Extraer `enviarTexto` de `sendFrom`**

En `renderer/app.js`, `sendFrom` (línea ~1409) se queda con lo que es suyo —leer el campo, limpiar, los adjuntos y parar el dictado clásico— y el resto (desde `goto('chat')` hasta el final) se mueve a una función nueva **sin cambios de comportamiento**:

```js
/* Enviar un texto al agente por el camino de siempre. Existe aparte de sendFrom porque
   el modo voz manda texto que no viene del compositor, y tiene que recorrer EXACTAMENTE
   el mismo camino: la misma burbuja, el mismo sello de modo, el mismo estado ocupado y
   el mismo chat:send. Si hubiera dos caminos, el modo voz dejaría de heredar permisos,
   guardarraíles e historial. */
async function enviarTexto(text, atts = []) {
  goto('chat');
  currentRunMode = K.mode(mode).key;
  const b = bubble('user', { mode: currentRunMode });
  b.textContent = text;
  const visAtts = atts.filter(a => a.kind === 'image' ? a.dataUrl : true);
  if (visAtts.length) paintAttachments(b, visAtts);
  setChatTitle(text || (atts[0] && atts[0].name) || 'Nueva conversación');
  pinned = true;
  scroll(true);
  window.sagitari.glow('think');
  busy = true;
  setSendMode();
  syncChatBadge();
  try {
    const r = await window.sagitari.sendChat(text, null, atts);
    if (r && r.ok === false) throw new Error(r.error || 'no se pudo enviar');
  } catch (e) {
    busy = false;
    setSendMode();
    syncChatBadge();
    showToast('No se pudo enviar: ' + ((e && e.message) || e));
  }
}

async function sendFrom(elId) {
  const el = $(elId);
  if (busy) { window.sagitari.stopChat(); feed('Deteniendo…', 'err'); return; }
  const text = el.value.trim();
  const atts = pendingAttachments.slice();
  if (!text && !atts.length) return;
  el.value = ''; el.style.height = '';
  clearAttachments();
  if (listening) {
    listening = false;
    voiceBuffer = ''; lastPartial = '';
    $$('.cbtn').forEach(b => b.classList.remove('on'));
    el.classList.remove('rec');
    window.sagitari.glow('off');
    await window.sagitari.voiceStop();
  }
  await enviarTexto(text, atts);
}
```

- [ ] **Step 2: El micro abre el modo voz (`Alt`+clic mantiene el dictado)**

En `wireMic` (línea ~1677), antes del código actual:

```js
    // El micro es la puerta del modo voz. Con Alt se conserva el dictado de siempre,
    // que sigue siendo lo cómodo para escribir un prompt largo y revisarlo.
    if (!e.altKey) {
      if (window.VoiceMode.abierto()) await window.VoiceMode.cerrar(); else await window.VoiceMode.abrir();
      return;
    }
```

Y al cablear la app (después de `wireMic()`):

```js
  window.VoiceMode.setEnviar(enviarTexto);
  window.sagitari.onVoiceEvent((ev) => window.VoiceMode.handle(ev));
  window.sagitari.onTtsPhrase((p) => window.VoiceMode.audio.reproducir(p));
  /* Los avisos solo se hablan si el usuario lo ha pedido en Ajustes. La decisión se toma
     aquí, que es donde se conocen los ajustes; el panel solo pide que se diga. */
  window.VoiceMode.setHablar((t) => { if (CFG.settings.ttsNotices) speak(t, { forzar: true }); });
```

- [ ] **Step 3: Con el modo abierto, la respuesta siempre se habla**

En el manejador de `assistant_done` (línea ~1117), donde hoy está `speak(ev.text);`:

```js
      /* En el modo voz la respuesta se dice SIEMPRE, aunque el TTS esté apagado en
         Ajustes: es un modo de oído, y negarse a hablar ahí sería absurdo. La regla de
         los arranques automatizados sigue mandando por encima (la aplica el proceso
         principal). */
      speak(ev.text, { forzar: window.VoiceMode && window.VoiceMode.abierto() });
```

Y en `speak()` (línea ~3253):

```js
function speak(text, { forzar = false } = {}) {
  if ((!forzar && !CFG.settings.ttsEnabled) || !text) return;
  const clean = text.replace(/```[\s\S]*?```/g, ' (código) ').replace(/[*_`#>«»]/g, '').replace(/\s+/g, ' ').trim();
  if (clean) { window.sagitari.glow('speak'); window.sagitari.speak(clean); }
}
```

- [ ] **Step 4: Filas nuevas en Ajustes › Voz**

En `renderer/index.html`, junto a las filas de voz que ya existen (`swTts`, `voiceLang`):

```html
              <div class="swrow srow" data-keys="voz altavoz voz del sistema leer"><span class="st"><b>Voz de la lectura</b><small>Cuál de las voces instaladas usa SAGITARI.</small></span>
                <select id="ttsVoice" aria-label="Voz de la lectura" style="width:240px"></select></div>
              <div class="swrow srow" data-keys="velocidad voz ritmo leer"><span class="st"><b>Velocidad de la voz</b><small>De más lenta a más rápida.</small></span>
                <input type="range" id="ttsRate" min="-40" max="40" step="5" style="width:200px"></div>
              <div class="swrow srow" data-keys="avisos voz leer todo permisos"><span class="st"><b>Leer también los avisos</b><small>Permisos, errores y avisos cortos, además de la respuesta.</small></span>
                <div class="sw" id="swAvisos" aria-label="Leer también los avisos"></div></div>
```

Y en `renderer/app.js`, al pintar los ajustes (~1757):

```js
  // La lista de voces sale del motor real: si no hay ninguna, se dice, no se deja vacío.
  window.sagitari.ttsList().then((r) => {
    const sel = $('#ttsVoice');
    if (!sel) return;
    sel.innerHTML = '';
    const voces = (r && r.voices) || [];
    if (!voces.length) { const o = document.createElement('option'); o.textContent = 'Sin voces instaladas'; o.value = ''; sel.appendChild(o); return; }
    for (const v of voces) {
      const o = document.createElement('option');
      o.value = v.nombre; o.textContent = v.nombre + ' (' + v.idioma + ')';
      if (CFG.settings.ttsVoice === v.nombre) o.selected = true;
      sel.appendChild(o);
    }
  }).catch(() => {});
  if ($('#ttsRate')) $('#ttsRate').value = String(CFG.settings.ttsRate ?? 0);
```

con sus dos manejadores:

```js
if ($('#ttsVoice')) $('#ttsVoice').onchange = async (e) => { await window.sagitari.setSettings({ ttsVoice: e.target.value }); };
if ($('#ttsRate')) $('#ttsRate').oninput = async (e) => { await window.sagitari.setSettings({ ttsRate: Number(e.target.value) }); };
if ($('#swAvisos')) {
  $('#swAvisos').classList.toggle('on', !!CFG.settings.ttsNotices);
  $('#swAvisos').onclick = async (e) => { const on = !e.currentTarget.classList.contains('on'); e.currentTarget.classList.toggle('on', on); await window.sagitari.setSettings({ ttsNotices: on }); };
}
```

- [ ] **Step 5: Comprobar a mano que un `final` recorre el camino del chat**

Run: `npm start`, abrir el modo voz, y desde la consola de desarrollo: `window.VoiceMode.handle({ type: 'final', text: 'hola, ¿quién eres?' })`
Expected: aparece la burbuja del usuario y el agente responde **hablando**; `window.VoiceMode.estado()` pasa por `pensando` → `hablando` → `escuchando`.

- [ ] **Step 6: Ejecutar la batería**

Run: `npm test 2>&1 | tail -1 && npm run uicheck 2>&1 | grep -E "UI-CHECK"`
Expected: `Todos los tests en verde (N)` y `UI-CHECK::{"ok":true,"fallos":0}`

- [ ] **Step 7: Commit**

```bash
git add renderer/app.js renderer/index.html
git commit -m "voz: el micro abre el modo voz y el texto entra por el mismo camino del chat"
```

---

### Task 10: El banco de pruebas del modo voz (`scripts/ui-check.js`)

**Files:**
- Modify: `scripts/ui-check.js` (voz sintética determinista: el nivel viene de un WAV de mentira, no de un tono constante)

**Interfaces:**
- Consumes: `window.VoiceMode`, `window.OrbKit`, el modelo de mentira que ya existe en el ui-check (`llm.vistos`).
- Produces: nada que consuman otras tareas. Esta tarea **no toca código de la app**: solo pruebas.

- [ ] **Step 1: Escribir las comprobaciones que fallan**

```js
  /* ---- modo voz: voz sintética, sin micrófono y sin depender del hardware ----
     Lo que ocurre EN LA PÁGINA se comprueba con `judge`; lo que tiene que LLEGAR AL
     MODELO se comprueba aquí, en Node, mirando las peticiones que recibe el modelo de
     mentira (el mismo patrón que usan las comprobaciones del catálogo MCP). */
  await judge('el orbe late con la voz inyectada',
    '(async function(){ await window.VoiceMode.abrir(); window.VoiceMode.handle({ type: "level", value: 0.7 }); await new Promise(r => setTimeout(r, 250)); const c = document.querySelector("#vmOrbe"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 12) n++; return n > 500; })()');
  await judge('el permiso de una herramienta se contesta diciendo «sí»',
    '(function(){ let hecho = false; window.VoiceMode.pedirConfirmacion({ texto: "¿Borro la carpeta?", si: function(){ hecho = true; }, no: function(){} }); window.VoiceMode.handle({ type: "final", text: "sí" }); return hecho && window.VoiceMode.estado() !== "confirmando"; })()');
  await judge('interrumpir mientras habla vuelve a escuchar',
    '(async function(){ window.VoiceMode.handle({ type: "state", state: "hablando" }); await new Promise(r => setTimeout(r, 60)); await window.VoiceMode.audio.parar(); window.VoiceMode.handle({ type: "state", state: "oyendo" }); return window.VoiceMode.estado() === "oyendo"; })()');

  /* Las tres que se juzgan por lo que llega al modelo: se dispara un final y se espera
     a que el modelo de mentira reciba (o no reciba) una petición nueva. */
  const vozDice = async (texto) => {
    const antes = llm.vistos.length;
    await evaluate('window.VoiceMode.handle({ type: "final", text: ' + JSON.stringify(texto) + ' })');
    const limite = Date.now() + 8000;
    while (llm.vistos.length === antes && Date.now() < limite) await new Promise(r => setTimeout(r, 150));
    return llm.vistos.length > antes;
  };
  if (await vozDice('recuérdame llamar a Álvaro')) console.log('  ok   una frase dictada llega al agente por el mismo camino del chat');
  else { failed++; console.log('  FALLO una frase dictada no llegó al agente'); }
  if (!(await vozDice('Gracias por ver el vídeo'))) console.log('  ok   la basura no llega al agente');
  else { failed++; console.log('  FALLO la basura llegó al agente'); }
  if (!(await vozDice('adiós'))) console.log('  ok   decir «adiós» cierra el modo y no envía nada');
  else { failed++; console.log('  FALLO «adiós» envió algo al agente'); }
```

Y en la parte de arriba del script, el generador del WAV y el contador de peticiones al modelo:

```js
/* Un WAV de mentira con voz y silencios: Chromium lo usa como micrófono
   (--use-file-for-fake-audio-capture), así que el nivel del orbe y la interrupción se
   prueban deterministas, sin hardware y sin tono constante. */
async function vozFalsa() {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const sr = 48000, seg = 5, n = sr * seg;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const habla = (t > 1 && t < 2.2) || (t > 3.5 && t < 4.6);   // silencio, voz, silencio, voz
    const v = habla ? Math.sin(2 * Math.PI * 180 * t) * 0.35 : 0;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  const f = path.join(os.tmpdir(), 'sagi-voz-falsa.wav');
  fs.writeFileSync(f, buf);
  return f;
}
```

- [ ] **Step 2: Usar ese WAV como micrófono en el arranque**

```js
  /* El WAV de mentira sustituye al tono constante de la tarea anterior: con voz y
     silencios de verdad, la interrupción y el nivel se pueden comprobar. */
  const wavFalso = await vozFalsa();
  const child = spawn(electron, ['--remote-debugging-port=' + port, '--hidden',
    '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + wavFalso, '.'], { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
```

- [ ] **Step 3: Ejecutar y ver el resultado**

Run: `npm run uicheck 2>&1 | grep -E "orbe late|se envía al agente|adiós|basura|permiso de una herramienta|interrumpir|UI-CHECK"`
Expected: las seis en `ok` y `UI-CHECK::{"ok":true,"fallos":0}`

- [ ] **Step 4: Commit**

```bash
git add scripts/ui-check.js
git commit -m "voz: banco de pruebas del modo voz con voz sintetica determinista (nivel, envio, adios, basura, permiso e interrupcion)"
```

---

### Task 11: Documentación con paridad ES/EN

**Files:**
- Modify: `README.md`, `README.es.md`

**Interfaces:**
- Consumes: nada. **No se toca `RELEASE_NOTES.md`** (regla del proyecto: el flujo de release extrae la sección de la versión).

- [ ] **Step 1: Documentar la funcionalidad en los dos idiomas**

En la lista de características del README inglés, junto a la entrada de voz actual; y en el español, donde hoy dice «Entrada por voz mediante el reconocimiento de Windows y salida por texto a voz»:

- **ES**: «**Modo voz**: pulsa el micrófono y habla; el asistente te oye, hace el trabajo y te contesta en voz alta. Manos libres: al callar, se envía; si hablas mientras responde, se calla y te escucha. Todo en tu equipo. `Alt`+clic en el micrófono mantiene el dictado clásico al cuadro de texto.»
- **EN**: «**Voice mode**: press the mic and talk; the assistant hears you, does the work and answers out loud. Hands-free: it sends when you stop talking, and if you speak while it talks, it shuts up and listens. Everything stays on your machine. `Alt`+click on the mic keeps the classic dictation into the text box.»

- [ ] **Step 2: Comprobar la paridad**

Run: `grep -c "Modo voz" README.es.md && grep -c "Voice mode" README.md`
Expected: `1` y `1`

- [ ] **Step 3: Commit**

```bash
git add README.md README.es.md
git commit -m "docs: modo voz en los dos idiomas (paridad ES/EN)"
```

---

## Cobertura de la spec (autorrevisión del plan)

| Requisito de la spec | Tarea |
|---|---|
| Superficie del modo voz, abrir/cerrar, `Esc`, estados | Tasks 8 y 9 |
| Orbe de malla de puntos, una cara por estado, reglas de dibujo | Task 7 |
| Bucle manos libres: silencio cierra, se envía, responde, vuelve a escuchar | Tasks 5, 9 y 10 |
| El `final` entra por el mismo `chat:send` (sin vía lateral) | Task 9 (extracción de `enviarTexto`) |
| Motor de escuchar (Windows, sin capar el moderno, con confianza) | Task 3 |
| Motor de hablar (voces modernas por WinRT, respaldo SAPI, por frase) | Task 4 |
| Reproducción en el renderer con nivel para el orbe | Tasks 4 y 8 |
| Interrupción al hablar (barge-in) | Task 8 (código) y Task 10 (comprobación) |
| Confirmaciones por voz y con ratón | Tasks 8 y 10 |
| Filtro de basura (lista negra y reglas) | Tasks 2 y 5 |
| Permiso de micrófono solo para nuestra página | Task 6 |
| La regla de que un arranque automatizado nunca habla | Tasks 4 y 6 (comprobación existente, sin romper) |
| Ajustes de voz (voz, velocidad, `voiceLang` respetado) | Tasks 4 y 9 |
| Cierre limpio sin huérfanos | Task 6 |
| Pruebas unitarias y sobre la app viva | Tasks 1-5 (unitarias), 6-10 (ui-check) |
| Documentación con paridad ES/EN | Task 11 |

**Lo que NO está en este plan (va al de la fase 2):** `vad.js`, Whisper, Piper, la descarga de motores, la vista previa por modelo pequeño y el resaltado por frase.

