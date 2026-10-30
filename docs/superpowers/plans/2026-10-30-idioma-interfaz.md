# Idioma de la interfaz — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que todo lo que el usuario ve en pantalla pueda estar en español o en inglés, eligiendo el idioma por el de Windows con un selector en Ajustes.

**Architecture:** Dos núcleos gemelos (`agent/i18n.js` para el motor, `renderer/i18n.js` para la interfaz) con diccionarios `es`/`en` de claves planas y fallback en cascada. El idioma se resuelve una vez en `main` y llega al renderer por `additionalArguments`; el HTML se marca con `data-i18n` y una sola pasada lo rellena. Los mensajes dejan de leerse por su texto (códigos y banderas) antes de traducirlos.

**Tech Stack:** Node ≥20, Electron 44, jsdom (pruebas de renderer), sin dependencias nuevas.

**Spec:** `docs/superpowers/specs/2026-10-30-idioma-interfaz-design.md` (inglés) y `…-design.es.md` (español).

## Global Constraints

- **Ninguna dependencia nueva.**
- **Idioma por defecto sin Electron: `es`.** `resolverIdioma('auto', undefined)` → `'es'`, así las 1.437 pruebas actuales siguen valiendo.
- **Claves planas con área delante**: `ajustes.idioma.titulo`, `chat.detener`.
- **Fallback en cascada**: `en` → `es` → `⟦clave⟧`. Nunca vacío, nunca lanza.
- **Paridad de claves** en cada par de diccionarios; una prueba la exige.
- **Un mensaje es para leerlo, no para interpretarlo**: si hace falta saber qué pasó, va `code` o booleano.
- **Todo lo visible pasa por clave.** Fuera: prompt del sistema, descripciones de herramientas, cuerpos de skills, ficheros de log, texto de terceros.
- **Comentarios y textos en español**, como el resto del repo.
- **No se commitea hasta que el usuario lo autorice** (instrucción vigente de esta sesión). Los pasos «Commit» del plan se ejecutan cuando diga que sí.
- Comandos de prueba de una sola suite:
  `node -e "require('./test/47-idioma'); require('./test/comun').runAll()"`
  `node test/renderer/idioma.test.js`

## Estructura de ficheros

| Fichero | Responsabilidad |
|---|---|
| `agent/i18n.js` (nuevo) | resolución de idioma, registro de diccionarios, `t()`, `err()`, `claves()` |
| `agent/i18n/es.js`, `agent/i18n/en.js` (nuevos) | diccionario del motor: mensajes que llegan a pantalla |
| `renderer/i18n.js` (nuevo) | `I18N.t()`, `I18N.aplicarDOM()`, `I18N.idioma` |
| `renderer/i18n-es.js`, `renderer/i18n-en.js` (nuevos) | diccionario de la interfaz (`window.I18N_ES` / `window.I18N_EN`) |
| `test/47-idioma.js` (nuevo) + `test/run.js` | pruebas del núcleo y de la paridad |
| `test/renderer/idioma.test.js` (nuevo) | `aplicarDOM()` sobre el `index.html` real |
| `test/renderer/arnes-renderer.js:126` | añadir los tres scripts nuevos a la lista |
| `main/main.js`, `main/ventana.js`, `main/preload.js` | resolver el idioma y pasarlo al renderer |
| `main/ipc-config.js` | `uiLang` en la lista blanca, validado a `auto|es|en` |
| `renderer/index.html`, `renderer/30-ajustes.js` | fila «Idioma» y sus `data-i18n` |
| `main/ipc-cambios.js`, `renderer/10-chat.js`, `renderer/20-app.js`, `agent/agent.js` | los tres acoplamientos por texto |

---

### Task 1: Núcleo del motor

**Files:**
- Create: `agent/i18n.js`, `agent/i18n/es.js`, `agent/i18n/en.js`
- Create: `test/47-idioma.js`
- Modify: `test/run.js` (añadir `require('./47-idioma');` tras `46-publicacion`)

**Interfaces:**
- Produces: `resolverIdioma(uiLang, locale) -> 'es'|'en'`, `configurar(idioma)`, `idiomaActual() -> 'es'|'en'`, `t(clave, vars) -> string`, `err(clave, vars) -> string` (siempre `Error: …`), `claves(idioma) -> string[]`.

- [ ] **Step 1: Escribir la prueba que falla**

```js
// test/47-idioma.js
'use strict';
/* Idioma del motor: resolución, fallback y paridad de claves. El diccionario del motor
   solo lleva lo que puede acabar en pantalla (mensajes, motivos, estados). */
const { test, eq, ok } = require('./helpers');

test('idioma: resolverIdioma decide por el locale y respeta lo elegido', () => {
  const i18n = require('../agent/i18n');
  eq(i18n.resolverIdioma('auto', 'es-ES'), 'es', 'español de España');
  eq(i18n.resolverIdioma('auto', 'es-AR'), 'es', 'cualquier región española');
  eq(i18n.resolverIdioma('auto', 'en-GB'), 'en', 'inglés de Reino Unido');
  eq(i18n.resolverIdioma('auto', 'fr-FR'), 'en', 'cualquier otro idioma va a inglés');
  eq(i18n.resolverIdioma('auto', undefined), 'es', 'sin locale (pruebas) se queda en español');
  eq(i18n.resolverIdioma('en', 'es-ES'), 'en', 'lo elegido manda sobre el locale');
  eq(i18n.resolverIdioma('inventado', 'es-ES'), 'es', 'un valor inválido cae en auto');
});

test('idioma: t() interpola, cae al español y nunca queda vacío', () => {
  const i18n = require('../agent/i18n');
  i18n.configurar('es');
  eq(i18n.t('comun.error'), 'Error');
  i18n.configurar('en');
  ok(/Error/.test(i18n.t('comun.error')), 'el prefijo de error es el mismo en inglés');
  eq(i18n.t('no.existe.esta.clave'), '⟦no.existe.esta.clave⟧', 'una clave desconocida se ve, no se vacía');
});

test('idioma: los dos diccionarios del motor tienen exactamente las mismas claves', () => {
  const i18n = require('../agent/i18n');
  const es = i18n.claves('es').sort();
  const en = i18n.claves('en').sort();
  const soloEs = es.filter((k) => !en.includes(k));
  const soloEn = en.filter((k) => !es.includes(k));
  eq(soloEs.join(','), '', 'claves que faltan en inglés');
  eq(soloEn.join(','), '', 'claves que sobran en inglés');
  ok(es.length > 0, 'el diccionario no puede estar vacío');
});
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `node -e "require('./test/47-idioma'); require('./test/comun').runAll()"`
Expected: FAIL — `Cannot find module '../agent/i18n'`.

- [ ] **Step 3: Escribir el núcleo**

```js
// agent/i18n.js
'use strict';
/* Idioma del motor. Un solo sitio decide qué idioma se habla y traduce lo que puede
   acabar en pantalla. El renderer tiene su gemelo (renderer/i18n.js): son dos
   diccionarios distintos porque son dos procesos distintos, con las mismas reglas. */
const DICCIONARIOS = { es: require('./i18n/es'), en: require('./i18n/en') };
let activo = 'es';

/** 'es' | 'en' explícitos; 'auto' o cualquier cosa, por el locale del sistema.
    Sin locale (suite sin Electron) se queda en español. */
function resolverIdioma(uiLang, locale) {
  if (uiLang === 'es' || uiLang === 'en') return uiLang;
  const l = String(locale || '').trim();
  if (!l) return 'es';
  return /^es\b/i.test(l) ? 'es' : 'en';
}

function configurar(idioma) {
  activo = idioma === 'en' ? 'en' : 'es';
}
function idiomaActual() {
  return activo;
}

function t(clave, vars) {
  const texto = (DICCIONARIOS[activo] && DICCIONARIOS[activo][clave]) ?? DICCIONARIOS.es[clave] ?? '⟦' + clave + '⟧';
  return String(texto).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? String(vars[k]) : m));
}

/** Mensaje de error de herramienta: el prefijo es el MISMO en los dos idiomas porque el
    agente decide el fallo por él (`text.startsWith`). Si algún día se cambia, se rompe. */
function err(clave, vars) {
  return t('comun.error') + ': ' + t(clave, vars);
}

function claves(idioma) {
  return Object.keys(DICCIONARIOS[idioma] || {});
}

module.exports = { resolverIdioma, configurar, idiomaActual, t, err, claves };
```

```js
// agent/i18n/es.js
'use strict';
module.exports = {
  'comun.error': 'Error',
  'comun.cancelado': 'Cancelado por el usuario',
  'comun.detenido': 'Ejecución detenida',
};
```

```js
// agent/i18n/en.js
'use strict';
module.exports = {
  'comun.error': 'Error',
  'comun.cancelado': 'Cancelled by the user',
  'comun.detenido': 'Run stopped',
};
```

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `node -e "require('./test/47-idioma'); require('./test/comun').runAll()"`
Expected: PASS (3 pruebas).

- [ ] **Step 5: Enganchar la suite**

Modify `test/run.js`: añadir `require('./47-idioma');` después de `require('./46-publicacion');`.

Run: `npm test`
Expected: verde (564 o más).

- [ ] **Step 6: Commit**

```bash
git add agent/i18n.js agent/i18n/es.js agent/i18n/en.js test/47-idioma.js test/run.js
git commit -m "feat(idioma): núcleo del motor con diccionarios es/en y paridad comprobada"
```

---

### Task 2: Núcleo del renderer y pasada del DOM

**Files:**
- Create: `renderer/i18n.js`, `renderer/i18n-es.js`, `renderer/i18n-en.js`
- Modify: `renderer/index.html` (tres `<script>` antes de `10-chat.js`)
- Modify: `test/renderer/arnes-renderer.js:126` (los tres scripts en la lista)
- Create: `test/renderer/idioma.test.js`

**Interfaces:**
- Produces: `window.I18N = { t(clave, vars), idioma, aplicarDOM(raiz?), claves(idioma) }`.
- Consumes: `window.sagitari.idioma` (Task 3 lo rellena; si falta, `es`).

- [ ] **Step 1: Escribir la prueba que falla**

```js
// test/renderer/idioma.test.js
'use strict';
/* La pasada del DOM: marca → texto. Se prueba contra el index.html REAL, que es el que
   se rompe si una clave no existe o si el atributo se escribe mal. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

let pasaron = 0;
let fallaron = 0;
function check(nombre, fn) {
  try {
    fn();
    pasaron++;
    console.log('  ok   ' + nombre);
  } catch (e) {
    fallaron++;
    console.log('  FAIL ' + nombre + ' — ' + e.message);
  }
}
const eq = (a, b, msg) => {
  if (a !== b) throw new Error((msg || '') + ' esperado ' + JSON.stringify(b) + ', obtenido ' + JSON.stringify(a));
};

const RAIZ = path.join(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(RAIZ, 'renderer', 'index.html'), 'utf8');

check('idioma: aplicarDOM rellena texto y atributos, y no toca lo que no lleva marca', () => {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(fs.readFileSync(path.join(RAIZ, 'renderer', 'i18n-es.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(RAIZ, 'renderer', 'i18n-en.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(RAIZ, 'renderer', 'i18n.js'), 'utf8'));
  const el = w.document.createElement('span');
  el.setAttribute('data-i18n', 'prueba.texto');
  w.document.body.appendChild(el);
  const ph = w.document.createElement('input');
  ph.setAttribute('data-i18n-ph', 'prueba.ph');
  w.document.body.appendChild(ph);
  w.I18N.aplicarDOM();
  eq(el.textContent, 'Hola', 'el texto sale del diccionario');
  eq(ph.getAttribute('placeholder'), 'Escribe aquí', 'y el atributo también');
});

check('idioma: con inglés el mismo marcado queda en inglés', () => {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only' });
  const w = dom.window;
  w.sagitari = { idioma: 'en' };
  w.eval(fs.readFileSync(path.join(RAIZ, 'renderer', 'i18n-es.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(RAIZ, 'renderer', 'i18n-en.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(RAIZ, 'renderer', 'i18n.js'), 'utf8'));
  const el = w.document.createElement('span');
  el.setAttribute('data-i18n', 'prueba.texto');
  w.document.body.appendChild(el);
  w.I18N.aplicarDOM();
  eq(el.textContent, 'Hello', 'se pinta el inglés');
});

console.log('\n' + pasaron + ' pasaron, ' + fallaron + ' fallaron');
process.exit(fallaron ? 1 : 0);
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `node test/renderer/idioma.test.js`
Expected: FAIL — `ENOENT` de `renderer/i18n-es.js`.

- [ ] **Step 3: Escribir el núcleo del renderer**

```js
// renderer/i18n.js
(function () {
  'use strict';
  /* Gemelo de agent/i18n.js para la interfaz. Los diccionarios se cargan ANTES que este
     fichero (index.html) como globales, porque el renderer no usa módulos. */
  const ES = window.I18N_ES || {};
  const EN = window.I18N_EN || {};
  const idioma = (window.sagitari && window.sagitari.idioma) === 'en' ? 'en' : 'es';
  const TABLA = idioma === 'en' ? EN : ES;

  function t(clave, vars) {
    const texto = TABLA[clave] ?? ES[clave] ?? '⟦' + clave + '⟧';
    return String(texto).replace(/\{(\w+)\}/g, function (m, k) {
      return vars && vars[k] !== undefined ? String(vars[k]) : m;
    });
  }

  /* Una sola pasada sobre el marcado. Idempotente: volver a llamarla no cambia nada. */
  function aplicarDOM(raiz) {
    const doc = raiz || document;
    doc.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    doc.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
    });
    doc.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    doc.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
  }

  window.I18N = { t: t, idioma: idioma, aplicarDOM: aplicarDOM, claves: function (i) { return Object.keys(i === 'en' ? EN : ES); } };
})();
```

```js
// renderer/i18n-es.js
window.I18N_ES = {
  'prueba.texto': 'Hola',
  'prueba.ph': 'Escribe aquí',
};
```

```js
// renderer/i18n-en.js
window.I18N_EN = {
  'prueba.texto': 'Hello',
  'prueba.ph': 'Type here',
};
```

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `node test/renderer/idioma.test.js`
Expected: PASS (2 pruebas).

- [ ] **Step 5: Enganchar los scripts en la app y en el arnés**

En `renderer/index.html`, antes de `<script src="10-chat.js">`:

```html
    <script src="i18n-es.js"></script>
    <script src="i18n-en.js"></script>
    <script src="i18n.js"></script>
```

En `test/renderer/arnes-renderer.js:126`, al principio de la lista:

```js
  const scripts = [
    'i18n-es.js',
    'i18n-en.js',
    'i18n.js',
    'icons.js',
    'marked.min.js',
    'chatkit.js',
    '10-chat.js',
    '20-app.js',
    '30-ajustes.js',
    'ajustes-util.js',
    'memoria-ui.js',
    '40-vistas.js',
  ];
```

Y en el arranque del renderer (`renderer/20-app.js`, donde ya se inicializa la vista) añadir **una** llamada:

```js
if (window.I18N) I18N.aplicarDOM();
```

Run: `node test/renderer/idioma.test.js && npm run test:renderer`
Expected: verde (875 + 2).

- [ ] **Step 6: Commit**

```bash
git add renderer/i18n.js renderer/i18n-es.js renderer/i18n-en.js renderer/index.html test/renderer/arnes-renderer.js test/renderer/idioma.test.js renderer/20-app.js
git commit -m "feat(idioma): núcleo del renderer, diccionarios es/en y pasada del DOM"
```

---

### Task 3: Resolver el idioma y pasarlo al renderer

**Files:**
- Modify: `main/main.js` (resolver al arrancar), `main/ventana.js` (additionalArguments), `main/preload.js` (exponer `idioma`)
- Modify: `test/47-idioma.js` (prueba del paso por argv)

**Interfaces:**
- Consumes: `resolverIdioma`, `configurar` (Task 1).
- Produces: `window.sagitari.idioma -> 'es'|'en'` en el renderer.

- [ ] **Step 1: Escribir la prueba que falla**

Añadir a `test/47-idioma.js`:

```js
test('idioma: el renderer lee el idioma de argv (canal único, sin IPC)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'preload.js'), 'utf8');
  ok(/--sag-idioma=/.test(src), 'el preload tiene que leer el argumento');
  ok(/idioma:/.test(src), 'y exponerlo como idioma');
  const ventana = fs.readFileSync(path.join(__dirname, '..', 'main', 'ventana.js'), 'utf8');
  ok(/additionalArguments:\s*\[/.test(ventana), 'la ventana tiene que pasar el argumento');
});
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `node -e "require('./test/47-idioma'); require('./test/comun').runAll()"`
Expected: FAIL — `el preload tiene que leer el argumento`.

- [ ] **Step 3: Implementar**

En `main/preload.js`, junto a las demás constantes del principio:

```js
/* Idioma resuelto por main y pasado como argumento del renderer: sin canal IPC nuevo y
   disponible antes de que el renderer cargue (window.sagitari.idioma). */
const idioma = (process.argv.find((a) => a.startsWith('--sag-idioma=')) || '').split('=')[1] === 'en' ? 'en' : 'es';
```

Y en el objeto de `contextBridge.exposeInMainWorld('sagitari', { … })`, añadir:

```js
  idioma,
```

En `main/ventana.js`, dentro de `webPreferences`:

```js
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        additionalArguments: ['--sag-idioma=' + (idioma === 'en' ? 'en' : 'es')],
      },
```

y recibir `idioma` en la firma del factory:

```js
function crearVentana({ HIDDEN, DEV, INDEX_HTML, getAgent, getConfig, saveConfig, onListo = null, idioma = 'es' }) {
```

En `main/main.js`, antes de crear la ventana:

```js
const i18n = require('../agent/i18n');
const idiomaActivo = i18n.resolverIdioma(config.settings && config.settings.uiLang, app.getLocale());
i18n.configurar(idiomaActivo);
```

y pasar `idioma: idiomaActivo` a `crearVentana({ … })`.

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `node -e "require('./test/47-idioma'); require('./test/comun').runAll()"`
Expected: PASS (4 pruebas).

- [ ] **Step 5: Commit**

```bash
git add main/main.js main/ventana.js main/preload.js test/47-idioma.js
git commit -m "feat(idioma): se resuelve al arrancar y llega al renderer por argv"
```

---

### Task 4: Selector en Ajustes

**Files:**
- Modify: `main/ipc-config.js` (lista blanca + validación)
- Modify: `renderer/index.html` (fila «Idioma» al principio de Apariencia)
- Modify: `renderer/30-ajustes.js` (pintar el valor y guardarlo)
- Modify: `test/43-sistema-hardening.js` (prueba del canal)

**Interfaces:**
- Consumes: `I18N.t` (Task 2), `settings:set` existente.
- Produces: `config.settings.uiLang ∈ {'auto','es','en'}`.

- [ ] **Step 1: Escribir la prueba que falla**

```js
// test/43-sistema-hardening.js (al final)
test('idioma: settings:set solo acepta auto, es o en', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'main', 'ipc-config.js'), 'utf8');
  ok(src.includes("'uiLang'"), 'uiLang tiene que estar en la lista blanca');
  ok(/\[.auto.,\s*.es.,\s*.en.\]/.test(src), 'y validarse contra los tres valores');
});
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `node -e "require('./test/43-sistema-hardening'); require('./test/comun').runAll()"`
Expected: FAIL — `uiLang tiene que estar en la lista blanca`.

- [ ] **Step 3: Implementar**

`main/ipc-config.js`, en la lista blanca (junto a `uiSkin`):

```js
    'uiLang',
```

y en la validación, junto a la de `uiSkin`:

```js
    /* Idioma de la interfaz: solo los tres que existen. Un valor inventado dejaría la
       app sin idioma hasta el siguiente arranque, así que se descarta. */
    if ('uiLang' in clean && !['auto', 'es', 'en'].includes(clean.uiLang)) delete clean.uiLang;
```

`renderer/index.html`, al principio del panel de Apariencia (antes de la fila del glow, ~línea 920):

```html
                  <div class="themerow block" data-keys="idioma language idioma interfaz">
                    <span class="mt"
                      ><b data-i18n="ajustes.idioma.titulo">Idioma de la interfaz</b><br /><small class="md" data-i18n="ajustes.idioma.nota"
                        >Se aplica al reiniciar SAGITARI.</small
                      ></span
                    >
                    <select id="uiLang" aria-label="Idioma de la interfaz">
                      <option value="auto" data-i18n="ajustes.idioma.auto">Automático (el de Windows)</option>
                      <option value="es">Español</option>
                      <option value="en">English</option>
                    </select>
                  </div>
```

`renderer/30-ajustes.js`, junto a `$('#uiSkin').value = …`:

```js
if ($('#uiLang')) $('#uiLang').value = CFG.settings.uiLang || 'auto';
```

y junto al handler de `#uiSkin`:

```js
if ($('#uiLang'))
  $('#uiLang').onchange = async (e) => {
    const valor = ['auto', 'es', 'en'].includes(e.target.value) ? e.target.value : 'auto';
    const anterior = CFG.settings.uiLang || 'auto';
    CFG.settings.uiLang = valor;
    const r = await window.sagitari.setSettings({ uiLang: valor });
    if (r && r.saveError) {
      CFG.settings.uiLang = anterior;
      e.target.value = anterior;
      showToast(I18N.t('ajustes.idioma.error'));
      return;
    }
    showToast(I18N.t('ajustes.idioma.guardado'));
  };
```

Diccionarios (los dos ficheros, mismas claves):

```js
  'ajustes.idioma.titulo': 'Idioma de la interfaz',
  'ajustes.idioma.nota': 'Se aplica al reiniciar SAGITARI.',
  'ajustes.idioma.auto': 'Automático (el de Windows)',
  'ajustes.idioma.guardado': 'Idioma guardado: se aplica al reiniciar',
  'ajustes.idioma.error': 'No se pudo guardar el idioma',
```

```js
  'ajustes.idioma.titulo': 'Interface language',
  'ajustes.idioma.nota': 'Applies when SAGITARI restarts.',
  'ajustes.idioma.auto': 'Automatic (Windows language)',
  'ajustes.idioma.guardado': 'Language saved: applies on restart',
  'ajustes.idioma.error': 'The language could not be saved',
```

- [ ] **Step 4: Ejecutar y ver que pasa**

Run: `node -e "require('./test/43-sistema-hardening'); require('./test/comun').runAll()" && npm run test:renderer`
Expected: verde.

- [ ] **Step 5: Commit**

```bash
git add main/ipc-config.js renderer/index.html renderer/30-ajustes.js renderer/i18n-es.js renderer/i18n-en.js test/43-sistema-hardening.js
git commit -m "feat(idioma): selector en Ajustes con uiLang validado"
```

---

### Task 5: Los mensajes dejan de leerse por su texto

**Files:**
- Modify: `main/ipc-cambios.js:38` (código `sin_cambios`)
- Modify: `renderer/10-chat.js:2185` (mirar `code`)
- Modify: `renderer/20-app.js:515` (mirar `ev.ok`)
- Modify: `agent/agent.js:2050` (prefijo desde el diccionario)
- Modify: `test/43-sistema-hardening.js`, `test/40-agente.js`

**Interfaces:**
- Consumes: `i18n.err` (Task 1).
- Produces: `cambios:deshacer -> { ok:false, code:'sin_cambios', error }`.

- [ ] **Step 1: Escribir las pruebas que fallan**

```js
// test/43-sistema-hardening.js
test('deshacer: el «no hay nada que deshacer» viaja como código, no como texto', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'main', 'ipc-cambios.js'), 'utf8');
  ok(/code:\s*'sin_cambios'/.test(src), 'el motor tiene que devolver el código');
  const chat = fs.readFileSync(require('path').join(__dirname, '..', 'renderer', '10-chat.js'), 'utf8');
  ok(!/no hay ningún cambio/.test(chat), 'el renderer no puede mirar el texto del error');
  ok(/code === 'sin_cambios'/.test(chat), 'tiene que mirar el código');
});

test('aviso: el color del registro usa el ok del evento, no el texto del resultado', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'renderer', '20-app.js'), 'utf8');
  ok(!/startsWith\('Error'\)/.test(src), 'nada de decidir por el prefijo del texto');
});
```

```js
// test/40-agente.js
test('idioma: el prefijo de error de las herramientas es el mismo en los dos idiomas', () => {
  const i18n = require('../agent/i18n');
  for (const idioma of ['es', 'en']) {
    i18n.configurar(idioma);
    ok(i18n.err('comun.detenido').startsWith('Error: '), 'prefijo estable en ' + idioma);
  }
  i18n.configurar('es');
});
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `node -e "require('./test/43-sistema-hardening'); require('./test/40-agente'); require('./test/comun').runAll()"`
Expected: FAIL en las tres.

- [ ] **Step 3: Implementar**

`main/ipc-cambios.js:38`:

```js
    if (!cambios.puedeDeshacer(ws, d)) return { ok: false, code: 'sin_cambios', error: 'no hay ningún cambio de este turno que deshacer' };
```

`renderer/10-chat.js:2185`:

```js
        if (r && r.code === 'sin_cambios') ocultarDeshacer();
```

`renderer/20-app.js:515`:

```js
        feed((ev.name || '') + ' — ' + String(ev.result || 'ok').slice(0, 90), ev.ok === false ? 'err' : 'ok');
```

`agent/agent.js:2050`:

```js
      failed: falloExplicito === null ? typeof text === 'string' && text.startsWith('Error:') : falloExplicito,
```

- [ ] **Step 4: Ejecutar y ver que pasan**

Run: `node -e "require('./test/43-sistema-hardening'); require('./test/40-agente'); require('./test/comun').runAll()"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add main/ipc-cambios.js renderer/10-chat.js renderer/20-app.js agent/agent.js test/43-sistema-hardening.js test/40-agente.js
git commit -m "fix(idioma): el código decide por códigos y banderas, no por el texto del mensaje"
```

---

### Task 6: Marcar el `index.html` completo

**Files:**
- Modify: `renderer/index.html` (296 nodos y sus atributos)
- Modify: `renderer/i18n-es.js`, `renderer/i18n-en.js`
- Modify: `test/renderer/idioma.test.js` (paridad HTML ↔ diccionario)

**Interfaces:**
- Consumes: el núcleo de Task 2.
- Produces: todas las claves de la interfaz usadas en el HTML, presentes en los dos diccionarios.

- [ ] **Step 1: Escribir la prueba que falla**

```js
check('idioma: toda clave marcada en index.html existe en los dos diccionarios', () => {
  const fs = require('fs');
  const path = require('path');
  const RAIZ2 = path.join(__dirname, '..', '..');
  const leer = (f) => fs.readFileSync(path.join(RAIZ2, 'renderer', f), 'utf8');
  const claves = new Set();
  for (const m of HTML.matchAll(/data-i18n(?:-ph|-title|-aria)?="([^"]+)"/g)) claves.add(m[1]);
  const cargar = (f) => {
    const w = new JSDOM('', { runScripts: 'outside-only' }).window;
    w.eval(leer(f));
    return w.I18N_ES ? w.I18N_ES : w.I18N_EN;
  };
  const es = cargar('i18n-es.js');
  const en = cargar('i18n-en.js');
  const faltanEs = [...claves].filter((k) => !(k in es));
  const faltanEn = [...claves].filter((k) => !(k in en));
  if (faltanEs.length) throw new Error('faltan en español: ' + faltanEs.slice(0, 5).join(', '));
  if (faltanEn.length) throw new Error('faltan en inglés: ' + faltanEn.slice(0, 5).join(', '));
  eq(claves.size > 0, true, 'tiene que haber claves marcadas');
});
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `node test/renderer/idioma.test.js`
Expected: FAIL — `tiene que haber claves marcadas` (aún no hay ninguna).

- [ ] **Step 3: Marcar el marcado y añadir las claves**

Regla, para cada texto visible de `index.html`:

1. Resolver en el HTML anterior → `data-i18n`, `data-i18n-ph`, `data-i18n-title` o `data-i18n-aria` según dónde viva el texto:
   `placeholder` → `data-i18n-ph`; `title` → `data-i18n-title`; `aria-label` → `data-i18n-aria`; cualquier otro → `data-i18n`.
2. Clave `área.elemento.detalle`, con el área del panel (`ajustes.`, `chat.`, `vistas.`, `equipo.`, `memoria.`, `hist.`, `herram.`, `mcp.`, `skills.`, `agentes.`).
3. Añadir la misma clave a `renderer/i18n-es.js` (texto que había) y a `renderer/i18n-en.js` (traducción).

Ejemplo real (barra lateral):

```html
<!-- antes -->
<button id="sendBtn" title="Enviar">Enviar</button>
<!-- después -->
<button id="sendBtn" data-i18n-title="chat.enviar" data-i18n="chat.enviar">Enviar</button>
```

Trabajar **panel a panel**, y tras cada panel:

Run: `node test/renderer/idioma.test.js`
Expected: PASS (la paridad cubre lo marcado hasta ese momento).

- [ ] **Step 4: Cerrar el paso**

Run: `npm run test:renderer && npm run lint`
Expected: verde. `index.html` no lleva ni un texto visible sin `data-i18n` (comprobar con la búsqueda del Task 11).

- [ ] **Step 5: Commit**

```bash
git add renderer/index.html renderer/i18n-es.js renderer/i18n-en.js test/renderer/idioma.test.js
git commit -m "feat(idioma): index.html marcado y diccionarios completos"
```

---

### Task 7: Barra y chat (`10-chat.js`, `20-app.js`)

**Files:**
- Modify: `renderer/10-chat.js`, `renderer/20-app.js`, `renderer/i18n-es.js`, `renderer/i18n-en.js`
- Modify: `test/43-sistema-hardening.js` (prueba de barrido)

**Interfaces:**
- Consumes: `I18N.t`.

- [ ] **Step 1: Escribir la prueba que falla**

```js
// test/43-sistema-hardening.js
test('idioma: el renderer no lleva textos fijos fuera de los diccionarios', () => {
  const fs = require('fs');
  const path = require('path');
  const RAIZ = path.join(__dirname, '..', 'renderer');
  /* Lista blanca: ficheros que aún no se han pasado, que se vacía tarea a tarea. */
  const PENDIENTES = ['30-ajustes.js', '40-vistas.js', 'memoria-ui.js', 'chatkit.js'];
  const sospechosos = [];
  for (const f of fs.readdirSync(RAIZ).filter((x) => x.endsWith('.js') && !x.startsWith('i18n'))) {
    if (PENDIENTES.includes(f)) continue;
    const src = fs.readFileSync(path.join(RAIZ, f), 'utf8');
    for (const m of src.matchAll(/(?:textContent|innerHTML|showToast\(|feed\()[^\n]*'([^']*[áéíóúñ¿¡][^']*)'/gi)) {
      sospechosos.push(f + ': ' + m[1].slice(0, 40));
    }
  }
  eq(sospechosos.slice(0, 5).join(' | '), '', 'textos en español sin clave');
});
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `node -e "require('./test/43-sistema-hardening'); require('./test/comun').runAll()"`
Expected: FAIL con la lista de textos de `10-chat.js` y `20-app.js`.

- [ ] **Step 3: Convertir los textos**

Patrón, sin excepciones:

```js
// antes
showToast('No se pudo deshacer: ' + error);
// después
showToast(I18N.t('chat.deshacer.error', { motivo: error }));
```

- Clave nueva en los dos diccionarios (misma clave).
- Interpolación para todo lo variable: `{motivo}`, `{n}`, `{ruta}`, `{modelo}`.
- Los textos de plantillas con HTML: `esc()` se queda; solo cambia el literal por `I18N.t(...)`.
- **No** se traduce el contenido que viene del modelo ni del usuario.

Al terminar, la lista blanca `PENDIENTES` de la prueba de barrido debe quedarse como
`['30-ajustes.js', '40-vistas.js', 'memoria-ui.js', 'chatkit.js']` (esos cuatro se hacen en
las dos tareas siguientes) y la prueba tiene que pasar:

Run: `node -e "require('./test/43-sistema-hardening'); require('./test/comun').runAll()" && npm run test:renderer`
Expected: verde.

- [ ] **Step 4: Commit**

```bash
git add renderer/10-chat.js renderer/20-app.js renderer/i18n-es.js renderer/i18n-en.js test/43-sistema-hardening.js
git commit -m "feat(idioma): barra y chat por claves"
```

---

### Task 8: Ajustes (`30-ajustes.js`)

**Files:**
- Modify: `renderer/30-ajustes.js`, `renderer/i18n-es.js`, `renderer/i18n-en.js`
- Modify: `test/43-sistema-hardening.js` (quitar `'30-ajustes.js'` de `PENDIENTES`)

- [ ] **Step 1: Ejecutar la prueba de barrido y ver los textos que quedan**

Run: `node -e "require('./test/43-sistema-hardening'); require('./test/comun').runAll()"`
Expected: FAIL con textos de `30-ajustes.js`.

- [ ] **Step 2: Convertir**

Mismo patrón que la Task 7. Ojo a dos sitios con texto generado:

```js
// etiqueta de permiso (hoy: `${nombre}: ${texto}` con textos de chatkit)
showToast(I18N.t('ajustes.perm.guardado', { nombre, nivel: I18N.t('nivel.' + valor) }));
```

```js
// aviso de guardado fallido
showToast(I18N.t('ajustes.guardado.error', { motivo: r.error }));
```

`renderer/chatkit.js` (etiquetas de herramientas y niveles) se convierte en la Task 9, pero las claves que `30-ajustes.js` use de él se añaden aquí.

- [ ] **Step 3: Verificar**

Run: `node -e "require('./test/43-sistema-hardening'); require('./test/comun').runAll()" && npm run test:renderer`
Expected: verde.

- [ ] **Step 4: Commit**

```bash
git add renderer/30-ajustes.js renderer/i18n-es.js renderer/i18n-en.js test/43-sistema-hardening.js
git commit -m "feat(idioma): ajustes por claves"
```

---

### Task 9: Vistas (`40-vistas.js`, `memoria-ui.js`, `chatkit.js`)

**Files:**
- Modify: `renderer/40-vistas.js`, `renderer/memoria-ui.js`, `renderer/chatkit.js`, `renderer/i18n-es.js`, `renderer/i18n-en.js`
- Modify: `test/43-sistema-hardening.js` (vaciar `PENDIENTES`)

- [ ] **Step 1: Ejecutar la prueba de barrido**

Run: `node -e "require('./test/43-sistema-hardening'); require('./test/comun').runAll()"`
Expected: FAIL con textos de las tres vistas.

- [ ] **Step 2: Convertir**

Mismo patrón. Dos particularidades:

- `chatkit.js` expone `K.tool(n).label` y `K.COMMANDS`: pasan a devolver `I18N.t('herramienta.' + n)` / `I18N.t('orden.' + name)`; las claves van a los diccionarios.
- `memoria-ui.js` pinta estados y fechas: los textos fijos por clave; las fechas siguen con el formateo del sistema.

- [ ] **Step 3: Vaciar la lista blanca y verificar**

Dejar `const PENDIENTES = [];` y:

Run: `node -e "require('./test/43-sistema-hardening'); require('./test/comun').runAll()" && npm run test:renderer`
Expected: verde.

- [ ] **Step 4: Commit**

```bash
git add renderer/40-vistas.js renderer/memoria-ui.js renderer/chatkit.js renderer/i18n-es.js renderer/i18n-en.js test/43-sistema-hardening.js
git commit -m "feat(idioma): las vistas por claves; el barrido queda cerrado"
```

---

### Task 10: Mensajes del motor

**Files:**
- Modify: `main/*.js` (errores de IPC, avisos, diálogos nativos, bandeja, actualización) y los `agent/*.js` cuyo texto llega a pantalla (resultados de herramientas incluidos)
- Modify: `agent/agent.js` (línea de `/compact`) y `agent/i18n/es.js` / `en.js`
- Modify: `test/47-idioma.js` (prueba del prompt)

**Interfaces:**
- Consumes: `i18n.t`, `i18n.err`.

- [ ] **Step 1: Escribir la prueba que falla**

```js
// test/47-idioma.js
test('idioma: el resumen de /compact se pide en el idioma del usuario, no en español fijo', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'agent.js'), 'utf8');
  ok(!/Responde ÚNICAMENTE con el resumen, en español/.test(src), 'no puede fijar el español');
  ok(/en el idioma del usuario/.test(src), 'tiene que seguir el idioma del usuario');
});
```

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `node -e "require('./test/47-idioma'); require('./test/comun').runAll()"`
Expected: FAIL.

- [ ] **Step 3: Convertir los mensajes**

Regla: **todo `'Error: …'` y todo texto que se pinte** pasa a `i18n.err('clave', vars)` / `i18n.t('clave', vars)`. Los que solo lee el modelo se quedan.

```js
// antes (agent/executors.js)
return 'Error: no pude leer ' + p + ' (' + e.code + ').';
// después
return i18n.err('herramienta.leer.fallo', { ruta: p, motivo: e.code || e.message });
```

Diálogos nativos (`main/ventana.js`, `main/updater.js`):

```js
dialog.showMessageBoxSync(win, {
  type: 'error',
  title: i18n.t('ventana.caida.titulo'),
  message: i18n.t('ventana.caida.mensaje'),
  detail: i18n.t('ventana.caida.detalle'),
  buttons: [i18n.t('ventana.caida.reiniciar'), i18n.t('ventana.caida.cerrar')],
});
```

Y la línea de `/compact` en `agent/agent.js`:

```js
Responde ÚNICAMENTE con el resumen, en el idioma del usuario y en texto plano con los apartados de abajo. …
```

- [ ] **Step 4: Verificar**

Run: `npm test && npm run lint`
Expected: verde.

- [ ] **Step 5: Commit**

```bash
git add main agent test/47-idioma.js
git commit -m "feat(idioma): mensajes del motor y diálogos nativos por clave"
```

---

### Task 11: Barrido y aceptación

**Files:**
- Modify: lo que aparezca en el barrido.

- [ ] **Step 1: Barrido de literales en español**

```bash
grep -rnE "'[^']*[áéíóúñ¿¡][^']*'" --include=*.js agent main renderer \
  | grep -v "renderer/i18n-" | grep -v "^\S*: *//" | grep -vE "\* |/\* " | head -40
```

Expected: solo comentarios, textos que van al modelo y contenido de terceros. Cada línea que no sea eso se convierte.

- [ ] **Step 2: Prueba manual en inglés**

Arrancar con el idioma forzado:

```bash
npx electron . --sag-idioma=en
```

Recorrer: barra, chat (enviar un mensaje), ajustes (los seis paneles), equipo, memoria, herramientas, agentes, historial. Nada en español; ningún hueco vacío.

- [ ] **Step 3: Prueba manual en español**

```bash
npx electron . --sag-idioma=es
```

Todo como antes de este trabajo.

- [ ] **Step 4: Batería completa**

```bash
npm test
npm run test:renderer
npm run lint
```

Expected: 564+ unitarias en verde, 877+ de renderer en verde, lint 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(idioma): español e inglés completos, con el barrido cerrado"
```

---

## Notas de ejecución

- El plan se ejecuta tarea a tarea; cada una deja la app **funcionando en español**.
- Si una tarea descubre que un texto llega a pantalla y no estaba previsto, **se traduce y se anota**; el barrido de la Task 11 es la red, no la excusa.
- Las claves nuevas se añaden **siempre** a los dos diccionarios en el mismo paso, o la paridad se pone roja.
