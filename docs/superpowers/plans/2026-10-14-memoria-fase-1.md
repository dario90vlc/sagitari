# Memoria a largo plazo — Fase 1 (vista + ficha + hábitos) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la memoria de SAGITARI pase de ser una lista plana sin extracción a una ficha de hechos duraderos con procedencia, bandeja de aprobación, papelera recuperable, hábitos legibles y un interruptor de aprendizaje.

**Architecture:** El esquema y la heurística viven en un módulo puro nuevo (`agent/memoria-v2.js`); `agent/memory.js` sigue siendo el único que toca disco y añade migración v1→v2 con fusión de duplicados, consolidación al añadir, papelera, exportar/borrar y una bandeja de propuestas. La vista se reescribe en un fichero de renderer propio (`renderer/memoria-ui.js`) con sus secciones, y el resto (IPC, preload, ajustes, hábitos, gancho de extracción al cerrar turno) se cablea sobre lo que ya existe.

**Tech Stack:** Node 20, Electron 44, CommonJS en `agent/`/`main/`/`test/`, scripts clásicos de navegador en `renderer/` (scope global compartido), tests con `node test/run.js` y `node test/renderer/run.js` (sin spawn), jsdom para lo DOM, arnés CDP sobre la app viva (`scripts/ui-check.js`).

**Spec:** docs/superpowers/specs/2026-10-14-memoria-y-contexto-largo-design.md

## Global Constraints

- Todo local: nada sale del equipo; la fase 1 no usa red ni servicios.
- Sin dependencias nuevas en la fase 1 (npm no cambia; solo `ws` y las devDependencies actuales).
- Con el interruptor de aprendizaje apagado (`memoryLearn: false`), nada se guarda ni se propone.
- WCAG 2.1 AA en la vista: foco visible, nombres accesibles (`aria-label`/`role`) y navegación por teclado como el resto de la app.
- Español en textos de interfaz, comentarios de código y nombres de test.
- `memory.json` es la fuente de verdad y no se borra nunca en silencio: el olvido automático mueve a la papelera (recuperable 30 días); solo «Vaciar papelera» y «Olvídalo todo» borran de verdad, y siempre con confirmación escrita.
- Si el almacén no se puede leer, la vista lo dice y ofrece «Restaurar copia»; el fichero ilegible se conserva (cuarentena / `.roto-<fecha>`) antes de escribir nada.
- Los tests van ANTES que el código en cada tarea, y cada tarea termina en algo que se puede probar solo.
- Puertas del repo que deben seguir pasando al final de cada tarea: `node test/run.js`, `node test/renderer/run.js`, `npx eslint .`, `npx prettier --check .`.

## File Structure

**Se crean**

- `agent/memoria-v2.js` — esquema v2 de un hecho, huella de deduplicación, similitud léxica con raíz, fusión de duplicados, heurística `proponerHechos` y reglas de olvido. Puro: no toca disco. *Por qué aparte:* `agent/memory.js` ya llevaba almacén + scoring + CRUD; separar el esquema del almacén deja cada fichero con un solo motivo para cambiar y permite probar la migración sin ficheros.
- `renderer/memoria-ui.js` — toda la vista Memoria (secciones, tarjetas editables, bandeja, hábitos, papelera y pie con interruptor/exportar/olvidar). *Por qué aparte:* `renderer/40-vistas.js` ya tiene 2100 líneas; meter aquí otras ~350 de vista dejaría el fichero sin poder abarcarse de una lectura.
- `test/renderer/memoria-v2.test.js` — pruebas puras de `agent/memoria-v2.js`.
- `test/renderer/memoria-ui.test.js` — pruebas en jsdom de los constructores HTML de la vista.

**Se modifican**

- `agent/memory.js` — almacén v2 en disco, migración al cargar, consolidación al añadir, papelera (`listTrash`/`restore`/`trashEmpty`), `exportar`/`wipe`/`restaurarCopia`, bandeja de propuestas y `proponerDeTurno`.
- `agent/habits.js` — `olvidar(categoria)` para el «olvidar esta categoría» de la vista.
- `main/ipc-memory.js` — handlers nuevos de bandeja, papelera (listar/restaurar/vaciar), exportar, `restore-backup`, borrar y olvidar hábitos; y emisor único de `memory:nueva`.
- `main/main.js` — ajustes por defecto `memoryLearn`/`memoryAutoSave` y `memory` en el `ctx` del router de chat.
- `main/ipc-config.js` — allowlist de ajustes con las dos claves nuevas.
- `main/ipc-chat.js` — gancho que propone hechos al cerrar el turno.
- `agent/tools.js` — solo la descripción de la herramienta `remember`.
- `main/preload.js` — un puente por cada handler nuevo.
- `renderer/index.html` — la sección `#view-memory` pasa a tener sus bloques; `memoria-ui.js` entra en la lista de scripts.
- `renderer/10-chat.js` — `goto('memory')` llama a `renderMemoria()`.
- `renderer/40-vistas.js` — se borra la vista vieja (`renderMemory` y el manejador de `#memAdd`); `fillMemorySens` se queda.
- `renderer/30-ajustes.js` — el panel de hábitos usa `olvidar(categoria)` (botón por categoría).
- `test/comun.js` — `memoria-ui.js` se suma a `RENDERER_JS`.
- `test/10-nucleo.js` — pruebas de almacén (migración, consolidación, papelera, vaciar, restaurar copia, bandeja, exportar/borrar) y de hábitos.
- `test/renderer/memory.test.js` — se añade una prueba de que `memory.tokenize` no cambió.
- `eslint.config.js` — la superficie global del renderer pierde `renderMemory` y gana `renderMemoria` y `vListEmpty`.
- `scripts/ui-check.js` — comprobación viva del ciclo aprender → bandeja → guardar → usar.
- `renderer/styles.css` — estilos de las secciones nuevas de la vista.

**Reparto de escritura (un solo dueño por fichero, para trabajar en paralelo sin pisarse)**

- Núcleo de memoria: `agent/memoria-v2.js`, `agent/memory.js`, `agent/habits.js`, `test/renderer/memoria-v2.test.js`, `test/10-nucleo.js`, `test/renderer/memory.test.js` (Tasks 1-7 y 10).
- IPC y puentes: `main/ipc-memory.js`, `main/preload.js` (Task 8).
- Extracción al cerrar turno: `main/ipc-chat.js`, `main/main.js`, `main/ipc-config.js`, `agent/tools.js` (Task 9).
- Vista: `renderer/memoria-ui.js`, `renderer/index.html`, `renderer/styles.css`, `renderer/40-vistas.js`, `renderer/10-chat.js`, `renderer/30-ajustes.js`, `test/renderer/memoria-ui.test.js`, `test/comun.js`, `eslint.config.js`, `scripts/ui-check.js` (Tasks 11-13).

**Hoja de ruta (no se detalla aquí)**

- Fase 2: planificador único de contexto, resumen durable persistido y editable, ventanas reales por modelo, medidor explicado y «Resumir lo antiguo».
- Fase 3: índice de episodios, buscador en la vista, herramientas `recall`/`recap` y aviso «usando lo que sé de ti» (la sección 4 de la vista, «Buscar en lo que hemos hablado», es de esta fase).
- Fase 4: motor semántico local opcional, ranking y fusión, deduplicación semántica (el camino léxico sigue siendo el respaldo).

---

### Task 1: Módulo puro del esquema v2 y migración con fusión

**Files:**
- Create: `agent/memoria-v2.js`
- Create: `test/renderer/memoria-v2.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `ESQUEMA = 2`
  - `OLVIDO_BAJA_DIAS = 180`, `OLVIDO_PAPELERA_DIAS = 365`, `PAPELERA_DIAS = 30`, `FUSION_UMBRAL = 0.5`
  - `normalizarTexto(s) -> string` (colapsa espacios, recorta a 500)
  - `hashTexto(s) -> string` (sha1 hex de 16, sin acentos y en minúsculas)
  - `tokenizar(s) -> string[]` (idéntico al `tokenize` de `agent/memory.js`: minúsculas, sin acentos, ≥3 letras, sin stopwords)
  - `tokenizarRaiz(s) -> string[]` (como `tokenizar` pero con la raíz de cada palabra)
  - `similitud(a, b) -> number` (Jaccard 0..1 sobre `tokenizarRaiz`)
  - `normalizarHecho(m) -> Hecho` con la forma `{ id, text, date, lastUsed, uses, importance, confidence, origen, origenTexto, etiquetas, hash, papelera }`
  - `fusionarPar(a, b) -> Hecho`
  - `migrarV1(lista) -> { version, hechos, fusiones }`

- [ ] **Step 1: Write the failing test**

Create `test/renderer/memoria-v2.test.js`:

```js
'use strict';

/* Tests para agent/memoria-v2.js — esquema v2, similitud, fusión y migración.
   Módulo PURO: no toca disco, así que no hace falta aislar ningún almacén.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const v2 = require(path.join(__dirname, '..', '..', 'agent', 'memoria-v2.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${e.message}`);
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || ''} esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
}

function assertOk(value, msg) {
  if (!value) throw new Error(msg || 'valor falso');
}

console.log('memoria-v2.js — esquema');

test('normalizarHecho rellena los campos v2 que faltan', () => {
  const h = v2.normalizarHecho({ id: 'a1', text: 'El usuario prefiere informes en PDF', date: '2026-01-02T00:00:00.000Z' });
  assertEqual(h.origen, 'mensaje', 'origen por defecto');
  assertEqual(h.origenTexto, '');
  assertOk(Array.isArray(h.etiquetas));
  assertEqual(h.papelera, null);
  assertOk(/^[0-9a-f]{16}$/.test(h.hash), 'huella hexadecimal de 16');
});

test('normalizarHecho traduce el `source` de la v1 a `origen`', () => {
  assertEqual(v2.normalizarHecho({ text: 'x', source: 'agent' }).origen, 'herramienta');
  assertEqual(v2.normalizarHecho({ text: 'x', source: 'habit' }).origen, 'habitos');
  assertEqual(v2.normalizarHecho({ text: 'x', source: 'user' }).origen, 'usuario');
});

console.log('memoria-v2.js — similitud');

test('la huella no cambia con mayúsculas ni acentos', () => {
  assertEqual(v2.hashTexto('El Usuario se llama Darío'), v2.hashTexto('el usuario se llama dario'));
});

test('similitud reconoce dos frases que hablan de lo mismo', () => {
  const s = v2.similitud('El usuario se llama Darío', 'Recuerda que me llamo Dario');
  assertOk(s >= v2.FUSION_UMBRAL, `debería superar el umbral de fusión, obtuve ${s}`);
});

test('similitud no mezcla temas distintos', () => {
  const s = v2.similitud('El usuario se llama Darío', 'Trabajo con proyectos de Blender y renders');
  assertOk(s < v2.FUSION_UMBRAL, `no debería fusionarse, obtuve ${s}`);
});

console.log('memoria-v2.js — migrarV1');

test('migrarV1 fusiona las dos entradas reales del usuario en una', () => {
  const r = v2.migrarV1([
    { id: 'a', text: 'El usuario se llama Darío', date: '2026-10-12T10:00:00.000Z' },
    { id: 'b', text: 'Recuerda que me llamo Dario', date: '2026-10-13T10:00:00.000Z' },
  ]);
  assertEqual(r.version, v2.ESQUEMA);
  assertEqual(r.hechos.length, 1, 'una sola entrada tras fusionar');
  assertEqual(r.hechos[0].text, 'Recuerda que me llamo Dario', 'se conserva el texto más reciente');
  assertEqual(r.fusiones.length, 1);
});

test('migrarV1 conserva los hechos que no se parecen', () => {
  const r = v2.migrarV1([
    { text: 'El usuario se llama Darío' },
    { text: 'Trabajo con proyectos de Blender y renders' },
  ]);
  assertEqual(r.hechos.length, 2);
  assertEqual(r.fusiones.length, 0);
});

test('migrarV1 suma los usos al fusionar', () => {
  const r = v2.migrarV1([
    { id: 'a', text: 'Prefiero informes en PDF', uses: 2, importance: 0.3 },
    { id: 'b', text: 'Prefiero los informes en PDF', uses: 4, importance: 0.9 },
  ]);
  assertEqual(r.hechos.length, 1);
  assertOk(r.hechos[0].uses >= 6, 'los usos se suman');
  assertEqual(r.hechos[0].importance, 0.9, 'la importancia es la mayor');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/renderer/memoria-v2.test.js`
Expected: FAIL — `Cannot find module '.../agent/memoria-v2.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `agent/memoria-v2.js`:

```js
'use strict';

/* memoria-v2.js — esquema, similitud, fusión y heurística de la memoria de largo
   plazo (fase 1 del spec de memoria).

   Este módulo es PURO (no toca disco): el almacén lo sigue llevando agent/memory.js.
   Aquí vive lo que hay que poder probar sin ficheros: la forma del hecho v2, la
   huella para deduplicar, la similitud léxica, la fusión de duplicados y, más abajo,
   la heurística que decide si una frase «huele» a hecho duradero y las reglas de
   olvido.

   Por qué un módulo aparte: agent/memory.js ya llevaba almacén + scoring + CRUD, y la
   vista y la bandeja añaden más. Separar el ESQUEMA del ALMACÉN deja cada fichero con
   un solo motivo para cambiar. */

const crypto = require('crypto');

const ESQUEMA = 2;

/* Un hecho sin usarse en OLVIDO_BAJA_DIAS baja a importancia baja; sin usarse en
   OLVIDO_PAPELERA_DIAS pasa a la papelera, de donde se puede recuperar PAPELERA_DIAS
   antes de borrarse de verdad. Nunca se borra en silencio. */
const OLVIDO_BAJA_DIAS = 180;
const OLVIDO_PAPELERA_DIAS = 365;
const PAPELERA_DIAS = 30;

/* Dos hechos con esta similitud léxica o más se consideran el mismo: es lo que fusiona
   «El usuario se llama Darío» con «Recuerda que me llamo Dario» al migrar. */
const FUSION_UMBRAL = 0.5;

/* Stopwords ES/EN cortas: suficiente para el solapamiento léxico. Es la MISMA lista que
   usaba agent/memory.js, que ahora la importa de aquí para no tener dos. */
const STOP = new Set([
  'de',
  'la',
  'el',
  'los',
  'las',
  'un',
  'una',
  'unos',
  'unas',
  'y',
  'o',
  'que',
  'en',
  'a',
  'del',
  'se',
  'por',
  'con',
  'para',
  'su',
  'al',
  'lo',
  'como',
  'mas',
  'más',
  'pero',
  'es',
  'son',
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'my',
  'your',
  'of',
  'to',
  'in',
]);

function normalizarTexto(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/** Minúsculas y sin acentos: la base de la huella y de los tokens. */
function sinAcentos(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Tokeniza en minúsculas quitando stopwords ES/EN cortas (idéntico al tokenize de memory.js). */
function tokenizar(s) {
  return sinAcentos(s)
    .split(/[^a-z0-9ñ]+/i)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/* Raíz muy simple para el español: quita las terminaciones verbales/plurales más
   comunes. No pretende ser un stemmer: solo hacer que «llamo», «llama» y «llamar»
   coincidan, que es lo que necesita la fusión de duplicados. */
function raiz(t) {
  const r = t.replace(/(ando|iendo|amos|imos|emos|aste|aron|aba|ia|ar|er|ir|as|es|os|o|a|e)$/, '');
  return r.length >= 3 ? r : t;
}

/** Tokens con la raíz aplicada: solo para medir similitud, nunca para puntuar memoria. */
function tokenizarRaiz(s) {
  return tokenizar(s).map(raiz);
}

function hashTexto(s) {
  return crypto.createHash('sha1').update(sinAcentos(normalizarTexto(s))).digest('hex').slice(0, 16);
}

/** Similitud de Jaccard 0..1 sobre las raíces de los tokens. */
function similitud(a, b) {
  const A = new Set(tokenizarRaiz(a));
  const B = new Set(tokenizarRaiz(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function clamp01(n) {
  n = Number(n);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

const ORIGENES = ['mensaje', 'herramienta', 'habitos', 'usuario'];

/** La v1 guardaba `source` ('user'|'agent'|'habit'); la v2 lo llama `origen`. */
function origenDe(m) {
  if (ORIGENES.includes(m.origen)) return m.origen;
  if (m.source === 'agent') return 'herramienta';
  if (m.source === 'habit') return 'habitos';
  if (m.source === 'user') return 'usuario';
  return 'mensaje';
}

/** Normaliza cualquier entrada (v1 o v2) a la forma v2 del hecho. */
function normalizarHecho(m) {
  const texto = normalizarTexto(m.text);
  return {
    id: m.id || 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: texto,
    date: m.date || new Date().toISOString(),
    lastUsed: m.lastUsed || m.date || new Date().toISOString(),
    uses: Number(m.uses) || 0,
    importance: clamp01(m.importance !== undefined ? m.importance : 0.5),
    confidence: clamp01(m.confidence !== undefined ? m.confidence : 0.8),
    origen: origenDe(m),
    origenTexto: normalizarTexto(m.origenTexto) || '',
    etiquetas: Array.isArray(m.etiquetas) ? [...new Set(m.etiquetas.map(String).filter(Boolean))] : [],
    hash: m.hash || hashTexto(texto),
    papelera: m.papelera || null, // ISO de cuándo se tiró; null = activo
  };
}

/** Fusiona dos hechos que hablan de lo mismo: texto más reciente, usos sumados y el
    origen conservado. `lastUsed` es el más reciente de los dos. */
function fusionarPar(a, b) {
  const [nuevo, viejo] = Date.parse(a.date) >= Date.parse(b.date) ? [a, b] : [b, a];
  return normalizarHecho({
    ...nuevo,
    id: nuevo.id,
    text: nuevo.text, // el texto más reciente
    uses: (Number(a.uses) || 0) + (Number(b.uses) || 0) + 1,
    importance: Math.max(clamp01(a.importance), clamp01(b.importance)),
    lastUsed: Date.parse(a.lastUsed) >= Date.parse(b.lastUsed) ? a.lastUsed : b.lastUsed,
    etiquetas: [...new Set([...(a.etiquetas || []), ...(b.etiquetas || [])])],
    origenTexto: nuevo.origenTexto || viejo.origenTexto,
    origen: nuevo.origen,
    papelera: a.papelera || b.papelera || null,
  });
}

/**
 * Migra una lista v1 (array de entradas) al esquema v2, fusionando los duplicados que
 * se parecen. Devuelve también el registro de fusiones para poder enseñarlo al migrar.
 */
function migrarV1(lista) {
  const hechos = [];
  const fusiones = [];
  for (const raw of Array.isArray(lista) ? lista : []) {
    const h = normalizarHecho(raw);
    if (!h.text) continue;
    const i = hechos.findIndex((x) => x.hash === h.hash || similitud(x.text, h.text) >= FUSION_UMBRAL);
    if (i >= 0) {
      hechos[i] = fusionarPar(hechos[i], h);
      fusiones.push({ seQueda: hechos[i].id, seFusiona: h.id, texto: hechos[i].text });
    } else {
      hechos.push(h);
    }
  }
  return { version: ESQUEMA, hechos, fusiones };
}

module.exports = {
  ESQUEMA,
  OLVIDO_BAJA_DIAS,
  OLVIDO_PAPELERA_DIAS,
  PAPELERA_DIAS,
  FUSION_UMBRAL,
  STOP,
  normalizarTexto,
  sinAcentos,
  hashTexto,
  tokenizar,
  tokenizarRaiz,
  similitud,
  normalizarHecho,
  fusionarPar,
  migrarV1,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/renderer/memoria-v2.test.js`
Expected: PASS — todos los tests en verde.

- [ ] **Step 5: Commit**

```bash
git add agent/memoria-v2.js test/renderer/memoria-v2.test.js
git commit -m "feat(memoria): esquema v2 puro con huella, similitud y migración con fusión"
```

---

### Task 2: Extracción heurística de hechos

**Files:**
- Modify: `agent/memoria-v2.js` (añade `proponerHechos` antes de `module.exports`)
- Modify: `test/renderer/memoria-v2.test.js` (añade el bloque de extracción)

**Interfaces:**
- Consumes: `normalizarTexto`, `hashTexto` y `clamp01` de la Task 1.
- Produces:
  - `proponerHechos(texto) -> Propuesta[]` donde `Propuesta = { texto, etiquetas: string[], origen: 'mensaje', motivo: string, origenTexto: string }`. Devuelve `[]` si la frase no huele a hecho duradero.

- [ ] **Step 1: Write the failing test**

Añade al final de `test/renderer/memoria-v2.test.js`, antes de la línea `console.log(\`\\n${passed} pasaron...\`)`:

```js
console.log('memoria-v2.js — proponerHechos');

test('reconoce una identidad («me llamo X»)', () => {
  const p = v2.proponerHechos('recuerda que me llamo Darío');
  assertEqual(p.length, 1);
  assertOk(p[0].texto.includes('Darío'), 'el hecho lleva el nombre');
  assertOk(p[0].etiquetas.includes('identidad'));
  assertEqual(p[0].origen, 'mensaje');
  assertEqual(p[0].origenTexto, 'recuerda que me llamo Darío');
});

test('reconoce una preferencia', () => {
  const p = v2.proponerHechos('prefiero las respuestas cortas y sin rodeos');
  assertEqual(p.length, 1);
  assertOk(p[0].etiquetas.includes('preferencia'));
});

test('reconoce una ruta de trabajo', () => {
  const p = v2.proponerHechos('mis proyectos están en C:\\Users\\Dario\\Desktop\\APPS');
  assertEqual(p.length, 1);
  assertOk(p[0].etiquetas.includes('ruta'));
});

test('reconoce una corrección', () => {
  const p = v2.proponerHechos('en realidad el informe va en la carpeta de octubre');
  assertEqual(p.length, 1);
  assertOk(p[0].etiquetas.includes('correccion'));
});

test('una pregunta normal NO propone nada', () => {
  assertEqual(v2.proponerHechos('¿puedes abrirme la carpeta de descargas?').length, 0);
});

test('un saludo NO propone nada', () => {
  assertEqual(v2.proponerHechos('hola, ¿cómo estás?').length, 0);
});

test('una orden corta NO propone nada', () => {
  assertEqual(v2.proponerHechos('abre el navegador y busca vuelos').length, 0);
});

test('un texto vacío NO propone nada', () => {
  assertEqual(v2.proponerHechos('   ').length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/renderer/memoria-v2.test.js`
Expected: FAIL — `v2.proponerHechos is not a function`.

- [ ] **Step 3: Write minimal implementation**

En `agent/memoria-v2.js`, justo antes de `module.exports = {`, añade:

```js
/* ---------- extracción heurística ----------
   «¿Esta frase huele a hecho duradero?» — sin llamar al modelo, sin coste. Devuelve
   cero o una propuesta por cada patrón que encaje (como mucho dos, para no llenar la
   bandeja de ruido). Un falso positivo aquí solo cuesta un clic de «descartar». */

const RE_NOMBRE = /\b(?:me llamo|mi nombre es)\s+([^\s,.;!?]{2,40})/i;
const RE_SOY = /\bsoy\s+([A-ZÁÉÍÓÚÑ][a-záéíóúüñ]{1,30})\b/;
const RE_PREFERENCIA = /\b(prefiero|preferiría|me gusta más|me gustaría|odio|no soporto|no me gusta)\b/i;
const RE_RUTA = /\b[A-Za-z]:\\[^\s]+/;
const RE_PROYECTO = /\b(mi proyecto|trabajo en|estoy en)\s+([^\s,.;!?]{2,60})/i;
const RE_CORRECCION = /\b(en realidad|mejor dicho|corrijo|no era eso|quise decir|perdón,? me refería)\b/i;
const RE_IDIOMA = /\b(?:háblame|habla|respóndeme|responde|contéstame|contesta)\s+en\s+(español|inglés|ingles|francés|frances|alemán|aleman|portugués|portugues|italiano)\b/i;

function proponerHechos(texto) {
  const t = normalizarTexto(texto);
  if (t.length < 8) return [];
  const props = [];
  const push = (texto, etiquetas, motivo) =>
    props.push({ texto: normalizarTexto(texto), etiquetas, origen: 'mensaje', motivo, origenTexto: t });

  const nombre = t.match(RE_NOMBRE) || t.match(RE_SOY);
  if (nombre) push(`El usuario se llama ${nombre[1]}`, ['identidad'], 'parece tu nombre');

  const idioma = t.match(RE_IDIOMA);
  if (idioma) push(`El usuario prefiere que le hables en ${idioma[1].toLowerCase()}`, ['identidad', 'idioma'], 'parece tu idioma');

  const ruta = t.match(RE_RUTA);
  if (ruta) push(`Trabajas en la ruta ${ruta[0]}`, ['ruta'], 'parece una carpeta de trabajo');
  else {
    const proyecto = t.match(RE_PROYECTO);
    if (proyecto) push(`Sobre tu proyecto: ${t.slice(0, 200)}`, ['proyecto'], 'parece un dato de proyecto');
  }

  if (RE_PREFERENCIA.test(t)) push(t.slice(0, 200), ['preferencia'], 'parece una preferencia');

  if (RE_CORRECCION.test(t)) push(t.slice(0, 200), ['correccion'], 'parece una corrección de algo anterior');

  // Como mucho una propuesta por etiqueta de identidad, y en total dos: la bandeja tiene
  // que poder mirarse de un vistazo.
  const vistos = new Set();
  return props.filter((p) => {
    const k = hashTexto(p.texto);
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  }).slice(0, 2);
}
```

Y añade `proponerHechos` a `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/renderer/memoria-v2.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/memoria-v2.js test/renderer/memoria-v2.test.js
git commit -m "feat(memoria): extracción heurística de hechos duraderos"
```

---

### Task 3: Decaimiento y papelera (reglas puras)

**Files:**
- Modify: `agent/memoria-v2.js` (añade `decidirOlvido` y `expiradoEnPapelera`)
- Modify: `test/renderer/memoria-v2.test.js`

**Interfaces:**
- Consumes: `OLVIDO_BAJA_DIAS`, `OLVIDO_PAPELERA_DIAS`, `PAPELERA_DIAS` de la Task 1.
- Produces:
  - `decidirOlvido(hecho, ahora?) -> null | { accion: 'baja' } | { accion: 'papelera' }`
  - `expiradoEnPapelera(hecho, ahora?) -> boolean`

- [ ] **Step 1: Write the failing test**

Añade antes del cierre de `test/renderer/memoria-v2.test.js`:

```js
console.log('memoria-v2.js — olvido');

const dias = (n) => new Date(Date.now() - n * 86400000).toISOString();

test('un hecho reciente no se toca', () => {
  assertEqual(v2.decidirOlvido({ lastUsed: dias(1) }), null);
});

test('a los 180 días sin usarse baja a importancia baja', () => {
  const d = v2.decidirOlvido({ lastUsed: dias(200) });
  assertEqual(d && d.accion, 'baja');
});

test('a los 365 días sin usarse pasa a la papelera', () => {
  const d = v2.decidirOlvido({ lastUsed: dias(400) });
  assertEqual(d && d.accion, 'papelera');
});

test('lo que ya está en la papelera no vuelve a decidirse', () => {
  assertEqual(v2.decidirOlvido({ lastUsed: dias(400), papelera: dias(1) }), null);
});

test('un hecho en papelera más de 30 días caduca', () => {
  assertOk(v2.expiradoEnPapelera({ papelera: dias(40) }));
  assertOk(!v2.expiradoEnPapelera({ papelera: dias(5) }));
  assertOk(!v2.expiradoEnPapelera({ papelera: null }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/renderer/memoria-v2.test.js`
Expected: FAIL — `v2.decidirOlvido is not a function`.

- [ ] **Step 3: Write minimal implementation**

En `agent/memoria-v2.js`, antes de `module.exports`, añade:

```js
/* ---------- olvido ---------- */

/** Con qué día se mide la antigüedad de un hecho: su último uso o, si nunca se usó, su creación. */
function ultimoToque(h) {
  return Date.parse(h.lastUsed) || Date.parse(h.date) || Date.now();
}

/** Qué le toca a un hecho por antigüedad. null = se queda como está. */
function decidirOlvido(h, ahora = Date.now()) {
  if (h.papelera) return null;
  const dias = (ahora - ultimoToque(h)) / 86400000;
  if (dias >= OLVIDO_PAPELERA_DIAS) return { accion: 'papelera' };
  if (dias >= OLVIDO_BAJA_DIAS) return { accion: 'baja' };
  return null;
}

/** ¿Lleva un hecho en la papelera más de lo que se puede recuperar? */
function expiradoEnPapelera(h, ahora = Date.now()) {
  if (!h.papelera) return false;
  return ahora - (Date.parse(h.papelera) || ahora) >= PAPELERA_DIAS * 86400000;
}
```

Y añade `decidirOlvido` y `expiradoEnPapelera` a `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/renderer/memoria-v2.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/memoria-v2.js test/renderer/memoria-v2.test.js
git commit -m "feat(memoria): reglas puras de decaimiento y papelera"
```

---

### Task 4: Almacén v2 en disco, migración al cargar y consolidación al añadir

**Files:**
- Modify: `agent/memory.js`
- Modify: `test/10-nucleo.js` (bloque nuevo tras el test `remember tool rejects empty text`, sobre la línea 365)
- Modify: `test/renderer/memory.test.js` (prueba de que `tokenize` no cambió)

**Interfaces:**
- Consumes: `migrarV1`, `normalizarHecho`, `fusionarPar`, `similitud`, `hashTexto`, `tokenizar`, `STOP` de `agent/memoria-v2.js`.
- Produces (todo dentro de `agent/memory.js`):
  - El fichero en disco pasa a ser `{ version: 2, hechos: [...] }` (antes era un array).
  - `load()` sigue devolviendo el array de hechos activos (compatibilidad interna).
  - `tokenize` sigue exportándose con el MISMO resultado de antes.
  - `add({ text, source, importance, confidence, etiquetas, origenTexto })` consolida: si encuentra un hecho parecido, lo fusiona y devuelve `{ ...hecho, fusionado: true, antes: <hecho previo> }`; si no, crea uno nuevo.

- [ ] **Step 1: Write the failing test**

En `test/10-nucleo.js`, justo después del test `remember tool rejects empty text` (línea ~365), añade:

```js
/* ---------- memoria v2: migración, fusión y almacén en disco ---------- */
test('memory: un memory.json v1 (array) se migra a v2 fusionando los duplicados', () => {
  const dir = tmpDir('sagi-memv2-');
  const f = path.join(dir, 'memory.json');
  fs.writeFileSync(
    f,
    JSON.stringify([
      { id: 'a', text: 'El usuario se llama Darío', date: '2026-10-12T10:00:00.000Z' },
      { id: 'b', text: 'Recuerda que me llamo Dario', date: '2026-10-13T10:00:00.000Z' },
    ]),
    'utf8',
  );
  memory.__test._resetForTests(f);
  const list = memory.list();
  eq(list.length, 1, 'las dos entradas del usuario quedan en una');
  ok(list[0].origen, 'trae el origen v2');
  ok(fs.existsSync(f + '.bak'), 'se conserva una copia .bak antes de migrar');
  ok(fs.existsSync(f.replace(/\.json$/, '') + '.bak-v1'), 'y el original v1 como .bak-v1');
  const enDisco = JSON.parse(fs.readFileSync(f, 'utf8'));
  eq(enDisco.version, 2, 'el fichero se reescribe en el esquema v2');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json')); // vuelve al almacén de la suite
});

test('memory: añadir un hecho parecido lo consolida en vez de duplicarlo', () => {
  const dir = tmpDir('sagi-memcon-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  const a = memory.add({ text: 'Prefiero informes en PDF', importance: 0.5 });
  const b = memory.add({ text: 'Prefiero los informes en PDF', importance: 0.7 });
  eq(memory.list().length, 1, 'no hay dos entradas parecidas');
  ok(b.fusionado, 'se informa de la fusión');
  eq(b.antes.id, a.id, 'se puede deshacer sobre el hecho anterior');
  eq(memory.list()[0].importance, 0.7, 'gana la importancia mayor');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});
```

En `test/renderer/memory.test.js`, añade dentro del bloque `memory.js — tokenize`:

```js
test('tokeniza igual que siempre (la suite de scoring depende de esto)', () => {
  const t = memory.tokenize('El usuario prefiere informes en PDF');
  assertOk(t.includes('usuario') && t.includes('informes') && t.includes('pdf'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run.js`
Expected: FAIL — el primer test falla en `eq(list.length, 1)` (la memoria v1 devuelve 2) y `enDisco.version` es `undefined`; `b.fusionado` es `undefined`.

- [ ] **Step 3: Write minimal implementation**

En `agent/memory.js`, cambia la cabecera para importar el módulo puro y sustituye las piezas indicadas.

Arriba del todo, tras `const path = require('path');`:

```js
const v2 = require('./memoria-v2');
```

Sustituye el cuerpo de `load()` (la parte que interpreta el fichero) por:

```js
function load() {
  if (cache) return cache;
  let raw;
  try {
    raw = fs.readFileSync(MEMORY_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      cache = [];
      return cache;
    } // no existe → memoria vacía legítima
    // Error de E/S (EBUSY/EPERM transitorios de Windows): NO significa "no hay memoria".
    tainted = true;
    cache = [];
    console.error('memory.load: no se pudo leer ' + MEMORY_FILE + ': ' + e.message);
    return cache;
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Fichero v1 (array plano): se migra y se reescribe en v2. `atomicWrite` ya deja
      // la copia .bak del original antes de pisarlo.
      const r = v2.migrarV1(parsed);
      cache = r.hechos;
      /* Se conserva el original v1 con un nombre propio (`.bak-v1`) antes de reescribir:
         es de donde `restaurarCopia()` recupera si el fichero v2 se corrompe luego. */
      try {
        fs.copyFileSync(MEMORY_FILE, MEMORY_FILE.replace(/\.json$/i, '') + '.bak-v1');
      } catch {}
      if (r.fusiones.length) console.error('memory.migrar: ' + r.fusiones.length + ' duplicado(s) fusionado(s) al migrar a v2');
      save();
    } else if (parsed && parsed.version === v2.ESQUEMA && Array.isArray(parsed.hechos)) {
      cache = parsed.hechos.map(v2.normalizarHecho);
    } else {
      throw new SyntaxError('esquema desconocido');
    }
  } catch (e) {
    // JSON truncado/corrupto: lo apartamos y NO dejamos que un save() lo pise con []
    tainted = true;
    cache = [];
    quarantine(e.message);
  }
  if (cache.length) prune(); // poda automática al cargar (una vez por proceso)
  return cache;
}
```

Sustituye el cuerpo de `save()` por:

```js
function save() {
  if (!cache) return;
  if (tainted && !cache.length) return; // tras un error de lectura nunca se persiste un almacén vacío
  try {
    atomicWrite(MEMORY_FILE, JSON.stringify({ version: v2.ESQUEMA, hechos: cache }, null, 2));
    tainted = false;
  } catch (e) {
    console.error('memory.save', e.message);
  }
}
```

Sustituye `normalize` y `tokenize` por alias del módulo puro (borra sus cuerpos):

```js
const normalize = v2.normalizarHecho;
const tokenize = v2.tokenizar;
```

Sustituye el cuerpo de `add()` por (conserva la deduplicación exacta y añade la fusión por similitud):

```js
function add({ text, source = 'user', importance = 0.5, confidence = 0.8, etiquetas, origenTexto }) {
  const t = v2.normalizarTexto(text);
  if (!t) return null;
  const list0 = load();
  // 1) texto idéntico: se refuerza en su lugar (comportamiento de siempre)
  const dup = list0.find((m) => m.text.toLowerCase() === t.toLowerCase());
  if (dup) {
    dup.importance = v2.normalizarHecho({ ...dup, importance: Math.max(dup.importance, importance) }).importance;
    dup.uses++;
    dup.lastUsed = new Date().toISOString();
    save();
    return { ...dup };
  }
  // 2) texto PARECIDO: se consolida (es lo que corrige los dos «me llamo Darío»)
  const i = list0.findIndex((m) => !m.papelera && v2.similitud(m.text, t) >= v2.FUSION_UMBRAL);
  if (i >= 0) {
    const antes = { ...list0[i] };
    const fusionado = v2.fusionarPar(antes, v2.normalizarHecho({ text: t, source, importance, confidence, etiquetas, origenTexto }));
    // fusionarPar conserva el texto más reciente: aquí el recién llegado es el nuevo
    list0[i] = { ...fusionado, text: t };
    cache = list0;
    save();
    return { ...list0[i], fusionado: true, antes };
  }
  const m = v2.normalizarHecho({ text: t, source, importance, confidence, etiquetas, origenTexto });
  list0.unshift(m);
  cache = list0.slice(0, MAX_MEMORIES);
  save();
  return { ...m };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/run.js && node test/renderer/run.js`
Expected: PASS. Si algún test de scoring falla por el cambio de tokenización, revisa que `tokenizar` sea idéntico al `tokenize` anterior (misma lista de stopwords y mismo filtro de longitud).

- [ ] **Step 5: Commit**

```bash
git add agent/memory.js test/10-nucleo.js test/renderer/memory.test.js
git commit -m "feat(memoria): almacén v2, migración al cargar y consolidación al añadir"
```

---

### Task 5: Olvido no destructivo, papelera, exportar y borrar todo

**Files:**
- Modify: `agent/memory.js`
- Modify: `test/10-nucleo.js`

**Interfaces:**
- Consumes: `decidirOlvido`, `expiradoEnPapelera` de `agent/memoria-v2.js`.
- Produces:
  - `listTrash() -> Hecho[]` (solo los que están en papelera)
  - `restore(id) -> { ok: true, memory: Hecho } | { ok: false, error }` (saca de la papelera; NO renombrar)
  - `trashEmpty() -> { ok: true, borradas: number }` (vacía la papelera de verdad)
  - `exportar() -> { version: 2, exportado: ISO, hechos: Hecho[], papelera: Hecho[] }`
  - `wipe() -> { ok: true, borrados: number }`
  - `restaurarCopia() -> { ok: true, restaurado: number, origen: string } | { ok: false, error }` (recupera el almacén del `.bak-v1` o, si no está, de la cuarentena más nueva)
  - `prune()` ya no borra: mueve a papelera y solo elimina lo caducado.

- [ ] **Step 1: Write the failing test**

En `test/10-nucleo.js`, tras el bloque de la Task 4, añade:

```js
test('memory: olvidar mueve a la papelera, no borra', () => {
  const dir = tmpDir('sagi-mempap-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  const años = new Date(Date.now() - 400 * 86400000).toISOString();
  const h = memory.add({ text: 'Dato antiquísimo sin usar', importance: 0.9 });
  memory.update(h.id, {}); // asegura que el almacén está cargado
  // se falsifica la antigüedad por la puerta de tests: el hecho lleva 400 días sin usarse
  const almacen = JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8'));
  almacen.hechos[0].lastUsed = años;
  almacen.hechos[0].date = años;
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify(almacen), 'utf8');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  memory.prune();
  eq(memory.list().length, 0, 'sale de la lista de activos');
  eq(memory.listTrash().length, 1, 'pero está en la papelera');
  const r = memory.restore(h.id);
  ok(r.ok, 'se puede restaurar');
  eq(memory.list().length, 1, 'vuelve a los activos');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

test('memory: exportar incluye activos y papelera, y wipe lo borra todo', () => {
  const dir = tmpDir('sagi-memexp-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  memory.add({ text: 'Un hecho para exportar' });
  const exp = memory.exportar();
  eq(exp.version, 2);
  eq(exp.hechos.length, 1);
  ok(Array.isArray(exp.papelera));
  const w = memory.wipe();
  ok(w.ok);
  eq(memory.list().length, 0);
  eq(memory.listTrash().length, 0);
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

test('memory: vaciar la papelera borra de verdad lo que había dentro', () => {
  const dir = tmpDir('sagi-memvac-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  const años = new Date(Date.now() - 400 * 86400000).toISOString();
  memory.add({ text: 'Dato que se olvidará del todo' });
  const almacen = JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8'));
  almacen.hechos[0].lastUsed = años;
  almacen.hechos[0].date = años;
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify(almacen), 'utf8');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  memory.prune(); // lo mueve a la papelera
  const r = memory.trashEmpty();
  ok(r.ok);
  eq(r.borradas, 1);
  eq(memory.listTrash().length, 0);
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});

test('memory: restaurar copia recupera el almacén y conserva el fichero roto', () => {
  const dir = tmpDir('sagi-memres-');
  const f = path.join(dir, 'memory.json');
  fs.writeFileSync(f, '{ esto no es JSON', 'utf8'); // el almacén ilegible de partida
  fs.writeFileSync(
    f.replace(/\.json$/, '') + '.bak-v1',
    JSON.stringify([{ id: 'a', text: 'Hecho rescatado de la copia' }]),
    'utf8',
  );
  memory.__test._resetForTests(f);
  memory.list(); // carga: como no se puede leer, dispara la cuarentena
  const r = memory.restaurarCopia();
  ok(r.ok, 'se restaura');
  ok(r.restaurado >= 1, 'trae al menos un hecho');
  ok(/bak-v1|corrupt/.test(r.origen), 'dice de dónde salió: ' + r.origen);
  ok(memory.list().some((m) => /Hecho rescatado/.test(m.text)), 'el hecho está en la memoria');
  const rotos = fs.readdirSync(dir).filter((n) => n.startsWith('memory.json.roto-'));
  ok(rotos.length >= 1, 'el fichero ilegible se conserva como .roto-…');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run.js`
Expected: FAIL — `memory.listTrash is not a function`.

- [ ] **Step 3: Write minimal implementation**

En `agent/memory.js`, sustituye el cuerpo de `prune()` por:

```js
/**
 * Olvido por antigüedad (se llama al cargar y desde la vista). Ya NO borra en silencio:
 * lo que lleva OLVIDO_BAJA_DIAS sin usarse baja a importancia baja, lo que lleva
 * OLVIDO_PAPELERA_DIAS pasa a la papelera y solo lo caducado en papelera desaparece.
 */
function prune() {
  const ahora = Date.now();
  let cambiado = false;
  for (const m of load()) {
    if (m.papelera) {
      if (v2.expiradoEnPapelera(m, ahora)) cambiado = true;
      continue;
    }
    const d = v2.decidirOlvido(m, ahora);
    if (!d) continue;
    cambiado = true;
    if (d.accion === 'baja') m.importance = Math.min(m.importance, 0.3);
    else m.papelera = new Date(ahora).toISOString();
  }
  if (cambiado) {
    cache = load().filter((m) => !(m.papelera && v2.expiradoEnPapelera(m, ahora)));
    save();
  }
  return { ok: true };
}
```

Y añade, antes de `module.exports`:

```js
/* ---------- papelera / exportar / borrar ---------- */

/** Los hechos que están en la papelera (recuperables 30 días). */
function listTrash() {
  return load()
    .filter((m) => m.papelera)
    .map((m) => ({ ...m }));
}

/** Saca un hecho de la papelera: vuelve a la lista activa. */
function restore(id) {
  const m = load().find((x) => x.id === id);
  if (!m) return { ok: false, error: 'recuerdo no encontrado' };
  m.papelera = null;
  m.lastUsed = new Date().toISOString();
  save();
  return { ok: true, memory: { ...m } };
}

/** Volcado legible para el botón «Exportar mi memoria». */
function exportar() {
  const l = load();
  return {
    version: v2.ESQUEMA,
    exportado: new Date().toISOString(),
    hechos: l.filter((m) => !m.papelera).map((m) => ({ ...m })),
    papelera: l.filter((m) => m.papelera).map((m) => ({ ...m })),
  };
}

/** «Olvídalo todo»: vacía el almacén (la copia .bak del fichero anterior se conserva). */
function wipe() {
  const borrados = load().length;
  cache = [];
  tainted = false;
  save();
  return { ok: true, borrados };
}

/** «Vaciar la papelera» (spec §5): aquí sí se borra de verdad, porque el usuario lo pidió. */
function trashEmpty() {
  const l = load();
  const borradas = l.filter((m) => m.papelera).length;
  cache = l.filter((m) => !m.papelera);
  save();
  return { ok: true, borradas };
}

/**
 * «Restaurar copia» del estado «no se pudo leer el almacén» (spec §5): recupera el
 * almacén del original v1 (`.bak-v1`) o, si no está, de la cuarentena más nueva. Antes
 * de pisar nada, el fichero ilegible actual se conserva como `memory.json.roto-<fecha>`.
 */
function restaurarCopia() {
  const base = MEMORY_FILE.replace(/\.json$/i, '');
  const dir = path.dirname(MEMORY_FILE);
  const cuarentenas = [];
  try {
    for (const f of fs.readdirSync(dir)) if (/^memory\.corrupt-\d+\.json$/.test(f)) cuarentenas.push(path.join(dir, f));
  } catch {}
  const mtime = (f) => {
    try {
      return fs.statSync(f).mtimeMs;
    } catch {
      return 0;
    }
  };
  cuarentenas.sort((a, b) => mtime(b) - mtime(a));
  const origen = fs.existsSync(base + '.bak-v1') ? base + '.bak-v1' : cuarentenas[0];
  if (!origen) return { ok: false, error: 'no hay ninguna copia que restaurar' };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(origen, 'utf8'));
  } catch (e) {
    return { ok: false, error: 'la copia no se pudo leer: ' + e.message };
  }
  const hechos = Array.isArray(parsed)
    ? v2.migrarV1(parsed).hechos
    : parsed && Array.isArray(parsed.hechos)
      ? parsed.hechos.map(v2.normalizarHecho)
      : null;
  if (!hechos) return { ok: false, error: 'la copia no tiene un formato reconocible' };
  try {
    if (fs.existsSync(MEMORY_FILE)) fs.copyFileSync(MEMORY_FILE, base + '.roto-' + Date.now() + '.json');
  } catch {}
  cache = hechos;
  tainted = false;
  save();
  return { ok: true, restaurado: hechos.length, origen };
}
```

Añade `listTrash`, `restore`, `trashEmpty`, `exportar`, `wipe` y `restaurarCopia` a `module.exports`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/run.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/memory.js test/10-nucleo.js
git commit -m "feat(memoria): papelera recuperable, exportar y olvidar todo"
```

---

### Task 6: Identidad siempre presente al elegir recuerdos

**Files:**
- Modify: `agent/memory.js` (función `relevantMemories`)
- Modify: `test/10-nucleo.js`

**Interfaces:**
- Consumes: hechos con la etiqueta `identidad` (los pone `proponerHechos`).
- Produces: `relevantMemories(contextText, opts)` garantiza que los hechos de identidad van SIEMPRE en el resultado (hasta el tope), delante de los puntuados.

- [ ] **Step 1: Write the failing test**

En `test/10-nucleo.js`, tras el bloque de la Task 5:

```js
test('relevantMemories incluye siempre los hechos de identidad', () => {
  const dir = tmpDir('sagi-memid-');
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  memory.add({ text: 'El usuario se llama Darío', etiquetas: ['identidad'] });
  memory.add({ text: 'Trabajo con proyectos de Blender y renders' });
  const rel = memory.relevantMemories('cuéntame un chiste de cocina', { minScore: 0.99 });
  ok(rel.some((x) => /se llama Darío/.test(x.mem.text)), 'la identidad entra aunque no solape');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run.js`
Expected: FAIL — la identidad no está en el resultado (nada solapa y el fallback ordena por importancia).

- [ ] **Step 3: Write minimal implementation**

En `agent/memory.js`, sustituye el comienzo del cuerpo de `relevantMemories` para anteponer la identidad. Cambia:

```js
function relevantMemories(contextText, opts = {}) {
  const list = load();
  const limit = Math.min(Math.max(opts.limit || MAX_IN_CONTEXT, 1), MAX_IN_CONTEXT);
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0.4;
  const scored = list
    .map((m) => ({ mem: m, ...scoreAgainst(m, contextText) }))
    .filter((x) => x.overlap > 0 && x.score >= minScore)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
```

por:

```js
function relevantMemories(contextText, opts = {}) {
  const activos = load().filter((m) => !m.papelera);
  const limit = Math.min(Math.max(opts.limit || MAX_IN_CONTEXT, 1), MAX_IN_CONTEXT);
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0.4;
  /* Los hechos de identidad (nombre, idioma) van SIEMPRE: son lo que hace que el agente
     te llame por tu nombre sin que se lo repitas. Ocupan el presupuesto primero. */
  const identidad = activos
    .filter((m) => (m.etiquetas || []).includes('identidad'))
    .map((m) => ({ mem: m, score: 1, overlap: 1 }))
    .slice(0, limit);
  const yaEstan = new Set(identidad.map((x) => x.mem.id));
  const scored = activos
    .filter((m) => !yaEstan.has(m.id))
    .map((m) => ({ mem: m, ...scoreAgainst(m, contextText) }))
    .filter((x) => x.overlap > 0 && x.score >= minScore)
    .sort((x, y) => y.score - x.score)
    .slice(0, Math.max(0, limit - identidad.length));
```

Y cambia las dos salidas para que devuelvan `identidad.concat(scored)` y el fallback también incluya la identidad. Sustituye el bloque:

```js
  if (scored.length) {
    // toca lastUsed/uses de los recuperados (recuerdo usado = recuerdo vivo)
    for (const s of scored) {
      s.mem.lastUsed = new Date().toISOString();
      s.mem.uses++;
    }
    save();
    return scored;
  }
  // fallback: los más importantes (nunca contexto vacío si hay memoria)
  return list
    .map((m) => ({ mem: m, score: m.importance * 0.6, overlap: 0 }))
    .sort((x, y) => y.score - x.score)
    .slice(0, Math.min(5, limit));
```

por:

```js
  const resultado = identidad.concat(scored);
  if (scored.length || identidad.length) {
    // toca lastUsed/uses de los recuperados (recuerdo usado = recuerdo vivo)
    for (const s of resultado) {
      s.mem.lastUsed = new Date().toISOString();
      s.mem.uses++;
    }
    save();
    return resultado;
  }
  // fallback: los más importantes (nunca contexto vacío si hay memoria)
  return activos
    .map((m) => ({ mem: m, score: m.importance * 0.6, overlap: 0 }))
    .sort((x, y) => y.score - x.score)
    .slice(0, Math.min(5, limit));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/run.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/memory.js test/10-nucleo.js
git commit -m "feat(memoria): los hechos de identidad entran siempre en el contexto"
```

---

### Task 7: Bandeja de propuestas (tray) y `proponerDeTurno`

**Files:**
- Modify: `agent/memory.js`
- Modify: `test/10-nucleo.js`

**Interfaces:**
- Consumes: `proponerHechos` de `agent/memoria-v2.js`.
- Produces (en `agent/memory.js`):
  - `trayList() -> Propuesta[]` (persistidas en `memory-tray.json`)
  - `trayProponer(props) -> Propuesta[]` (creadas; ignora las que ya están o ya existen como hecho)
  - `trayAceptar(id, patch?) -> { ok: true, memory: Hecho } | { ok: false, error }` (patch puede traer `{ text, importance, etiquetas }`)
  - `trayDescartar(id) -> { ok: true }`
  - `proponerDeTurno(texto, { convId, convTitulo, autoGuardar }) -> Propuesta[] | Hecho[]` (propone sobre el texto; con `autoGuardar: true` acepta directamente)
  - `__test._resetTray(file)` para aislar la bandeja en los tests

- [ ] **Step 1: Write the failing test**

En `test/10-nucleo.js`, tras el bloque de la Task 6:

```js
test('memory: la bandeja propone, acepta y descarta', () => {
  const dir = tmpDir('sagi-memtray-');
  memory.__test._resetTray(path.join(dir, 'memory-tray.json'));
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  const props = memory.proponerDeTurno('recuerda que me llamo Darío', { convId: 'c1', convTitulo: 'Prueba' });
  eq(props.length, 1, 'la frase propone un hecho');
  eq(memory.trayList().length, 1);
  const r = memory.trayAceptar(props[0].id);
  ok(r.ok, 'se acepta');
  eq(memory.trayList().length, 0, 'sale de la bandeja');
  ok(memory.list().some((m) => m.text.includes('Darío')), 'entra en la memoria');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
  memory.__test._resetTray(path.join(MEM_DIR, 'memory-tray.json'));
});

test('memory: descartar una propuesta la quita sin guardarla', () => {
  const dir = tmpDir('sagi-memdis-');
  memory.__test._resetTray(path.join(dir, 'memory-tray.json'));
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  const props = memory.proponerDeTurno('prefiero las respuestas cortas');
  eq(props.length, 1);
  memory.trayDescartar(props[0].id);
  eq(memory.trayList().length, 0);
  eq(memory.list().length, 0, 'no se guardó nada');
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
  memory.__test._resetTray(path.join(MEM_DIR, 'memory-tray.json'));
});

test('memory: con guardar-sin-preguntar la propuesta se guarda sola', () => {
  const dir = tmpDir('sagi-memauto-');
  memory.__test._resetTray(path.join(dir, 'memory-tray.json'));
  memory.__test._resetForTests(path.join(dir, 'memory.json'));
  const guardados = memory.proponerDeTurno('me llamo Darío', { autoGuardar: true });
  eq(memory.trayList().length, 0, 'no pasa por la bandeja');
  eq(guardados.length, 1);
  eq(memory.list().length, 1);
  memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
  memory.__test._resetTray(path.join(MEM_DIR, 'memory-tray.json'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run.js`
Expected: FAIL — `memory.proponerDeTurno is not a function`.

- [ ] **Step 3: Write minimal implementation**

En `agent/memory.js`, añade el require del emisor junto a los de la cabecera y, tras la definición de `MEMORY_FILE`, estas líneas:

```js
const EventEmitter = require('events'); // junto a require('fs')/require('path')

const TRAY_FILE_INICIAL = path.join(CONFIG_DIR, 'memory-tray.json');
let TRAY_FILE = TRAY_FILE_INICIAL;
let trayCache = null;
/* Aviso interno: cuando la bandeja recibe propuestas nuevas, se emite 'propuesta'.
   El router IPC (main/ipc-memory.js) lo escucha y manda `memory:nueva` al renderer;
   el módulo no conoce ventanas ni canales. */
const eventos = new EventEmitter();
/* Azúcar para el router: `memory.on('propuesta', cb)` sin tocar el emisor. */
const on = (ev, cb) => eventos.on(ev, cb);
```

Antes de `module.exports`, añade:

```js
/* ---------- bandeja de aprobación («Recién aprendido») ---------- */

function trayLoad() {
  if (trayCache) return trayCache;
  try {
    const raw = JSON.parse(fs.readFileSync(TRAY_FILE, 'utf8'));
    trayCache = Array.isArray(raw) ? raw : Array.isArray(raw && raw.propuestas) ? raw.propuestas : [];
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('memory.tray: no se pudo leer ' + TRAY_FILE + ': ' + e.message);
    trayCache = [];
  }
  return trayCache;
}

function traySave() {
  try {
    atomicWrite(TRAY_FILE, JSON.stringify({ version: v2.ESQUEMA, propuestas: trayCache || [] }, null, 2));
  } catch (e) {
    console.error('memory.tray.save', e.message);
  }
}

function trayList() {
  return trayLoad().map((p) => ({ ...p }));
}

/** Encola propuestas nuevas: ignora las repetidas (misma huella) y las que ya son hechos. */
function trayProponer(props) {
  const lista = trayLoad();
  const yaHechos = new Set(load().map((m) => m.hash));
  const yaEnBandeja = new Set(lista.map((p) => p.hash));
  const nuevas = [];
  for (const p of Array.isArray(props) ? props : []) {
    const hash = v2.hashTexto(p.texto);
    if (yaHechos.has(hash) || yaEnBandeja.has(hash)) continue;
    const prop = {
      id: p.id || 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      texto: v2.normalizarTexto(p.texto),
      etiquetas: Array.isArray(p.etiquetas) ? p.etiquetas : [],
      motivo: p.motivo || '',
      origenTexto: v2.normalizarTexto(p.origenTexto),
      hash,
      creado: p.creado || new Date().toISOString(),
      convId: p.convId || null,
      convTitulo: p.convTitulo || '',
    };
    lista.push(prop);
    yaEnBandeja.add(hash);
    nuevas.push(prop);
  }
  if (nuevas.length) {
    trayCache = lista.slice(-50); // la bandeja no crece sin freno
    traySave();
    // Un evento por propuesta: el router IPC reenvía cada una al renderer tal cual.
    for (const p of nuevas) eventos.emit('propuesta', p);
  }
  return nuevas;
}

function trayAceptar(id, patch = {}) {
  const lista = trayLoad();
  const p = lista.find((x) => x.id === id);
  if (!p) return { ok: false, error: 'propuesta no encontrada' };
  const m = add({
    text: patch.text !== undefined ? patch.text : p.texto,
    source: 'user',
    importance: patch.importance !== undefined ? patch.importance : 0.6,
    etiquetas: patch.etiquetas || p.etiquetas,
    origenTexto: p.origenTexto,
  });
  trayCache = lista.filter((x) => x.id !== id);
  traySave();
  return { ok: true, memory: m };
}

function trayDescartar(id) {
  trayCache = trayLoad().filter((x) => x.id !== id);
  traySave();
  return { ok: true };
}

/** El gancho del cierre de turno: mira la frase del usuario y propone hechos duraderos. */
function proponerDeTurno(texto, { convId = null, convTitulo = '', autoGuardar = false } = {}) {
  const props = v2.proponerHechos(texto).map((p) => ({ ...p, convId, convTitulo }));
  if (!props.length) return [];
  if (autoGuardar) return props.map((p) => trayAceptar(null, {})).filter(Boolean).length ? props : props;
  return trayProponer(props);
}
```

> Nota sobre `autoGuardar`: con `trayAceptar(null, {})` no habría propuesta a la que apuntar. Sustituye esa rama por la versión directa de abajo antes de ejecutar los tests:

```js
  if (autoGuardar) {
    const creados = [];
    for (const p of props) {
      creados.push(
        add({ text: p.texto, source: 'user', importance: 0.6, etiquetas: p.etiquetas, origenTexto: p.origenTexto }),
      );
    }
    return creados;
  }
```

Añade `trayList`, `trayProponer`, `trayAceptar`, `trayDescartar`, `proponerDeTurno`, `eventos` y `on` a `module.exports` (el router IPC usa `memory.on('propuesta', cb)`), y dentro de `__test` añade:

```js
_resetTray(file) {
  trayCache = null;
  TRAY_FILE = file || TRAY_FILE_INICIAL;
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/run.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/memory.js test/10-nucleo.js
git commit -m "feat(memoria): bandeja de aprobación y propuesta al cerrar turno"
```

---

### Task 8: IPC, preload y ajustes nuevos

**Files:**
- Modify: `main/ipc-memory.js`
- Modify: `main/preload.js` (junto a los `memory*` que ya existen)
- Modify: `main/main.js:148-170` (ajustes por defecto)
- Modify: `main/ipc-config.js:171-205` (allowlist)
- Modify: `test/10-nucleo.js`

**Interfaces:**
- Consumes: `memory.trayList/trayAceptar/trayDescartar/listTrash/restore/trashEmpty/exportar/wipe/restaurarCopia` (Task 5 y 7), `memory.on('propuesta', cb)` (Task 7) y `habits.olvidar` (Task 10).
- Produce:
  - `registerMemoryIpc(ipcMain, { memory, models, habits, getWin })` — `getWin()` devuelve la ventana de chat (o `null`); el router lo usa para el aviso `memory:nueva`.
  - Canales IPC: `memory:tray:list`, `memory:tray:accept`, `memory:tray:discard`, `memory:trash:list`, `memory:trash:restore`, `memory:trash:empty`, `memory:export`, `memory:wipe`, `memory:restore-backup`, `habits:forget`.
  - Puentes de preload: `memoryTrayList()`, `memoryTrayAccept(id, patch)`, `memoryTrayDiscard(id)`, `memoryTrashList()`, `memoryTrashRestore(id)`, `memoryTrashEmpty()`, `memoryExport()`, `memoryWipe()`, `memoryRestoreBackup()`, `habitsForget(categoria)`, y la suscripción `onMemoriaNueva(cb)` (devuelve la baja, como el resto de `on*` de preload).
  - Aviso `memory:nueva` (canal de ventana, no `agent:event`): lo EMITE este router, suscrito una sola vez a `memory.on('propuesta', cb)` y reenviando la propuesta tal cual; `memoria-ui.js` se suscribe (`onMemoriaNueva`) para refrescar «Recién aprendido» sin sondear.
- Reparto de ficheros: `main/ipc-memory.js` y `main/preload.js` son de esta tarea; `main/main.js` (contexto de los routers y ajustes por defecto) e `main/ipc-chat.js` (gancho) son de la Task 9. El gancho solo llama a `proponerDeTurno`; el empuje lo hace el router de aquí (un único punto de emisión).

- [ ] **Step 1: Write the failing test**

En `test/10-nucleo.js`, tras el bloque de la Task 7, añade:

```js
test('ipc: los canales de memoria de la fase 1 están declarados', () => {
  for (const canal of [
    'memory:tray:list',
    'memory:tray:accept',
    'memory:tray:discard',
    'memory:trash:list',
    'memory:trash:restore',
    'memory:trash:empty',
    'memory:export',
    'memory:wipe',
    'memory:restore-backup',
    'habits:forget',
  ]) {
    ok(MAIN_ALL.includes(`'${canal}'`), 'falta el handler ' + canal);
  }
});

test('preload: cada canal nuevo tiene su puente', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'main', 'preload.js'), 'utf8');
  for (const puente of [
    'memoryTrayList',
    'memoryTrayAccept',
    'memoryTrashList',
    'memoryTrashRestore',
    'memoryTrashEmpty',
    'memoryExport',
    'memoryWipe',
    'memoryRestoreBackup',
    'habitsForget',
    'onMemoriaNueva',
  ]) {
    ok(new RegExp(`\\b${puente}\\s*:`).test(preload), 'falta el puente ' + puente);
  }
  ok(!/\bmemoryRestore\s*:/.test(preload), 'no debe existir un puente memoryRestore (es memoryRestoreBackup)');
});
```

> Este test necesita `MAIN_ALL`, que ya está exportado por `./comun`. Añade `MAIN_ALL` a la lista de `require('./comun')` de la cabecera de `test/10-nucleo.js` (las líneas 4-34) si no está.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run.js`
Expected: FAIL — `falta el handler memory:tray:list`.

- [ ] **Step 3: Write minimal implementation**

**`main/ipc-memory.js`** — cambia la firma y añade los handlers. La primera línea del router pasa a ser:

```js
function registerMemoryIpc(ipcMain, { memory, models, habits, getWin }) {
```

(El aviso `memory:nueva` se emite AQUÍ, escuchando el evento `'propuesta'` del módulo: es el único punto de emisión. `ipc-chat.js` solo llama a `proponerDeTurno`.)

Dentro de `registerMemoryIpc`, tras `memory:remove`, añade:

```js
  // ---- fase 1 de memoria: bandeja, papelera, exportar y olvidar ----
  ipcMain.handle('memory:tray:list', () => memory.trayList());
  ipcMain.handle('memory:tray:accept', (e, { id, patch } = {}) => {
    if (!id || typeof id !== 'string') return { ok: false, error: 'id es obligatorio' };
    return memory.trayAceptar(id, patch || {});
  });
  ipcMain.handle('memory:tray:discard', (e, id) => {
    if (!id || typeof id !== 'string') return { ok: false, error: 'id es obligatorio' };
    return memory.trayDescartar(id);
  });
  ipcMain.handle('memory:trash:list', () => memory.listTrash());
  ipcMain.handle('memory:trash:restore', (e, id) => {
    if (!id || typeof id !== 'string') return { ok: false, error: 'id es obligatorio' };
    return memory.restore(id); // sacar de la papelera (NO confundir con restaurar copia)
  });
  ipcMain.handle('memory:trash:empty', () => memory.trashEmpty());
  ipcMain.handle('memory:export', () => memory.exportar());
  ipcMain.handle('memory:wipe', () => {
    const r = memory.wipe();
    habits.reset();
    return r;
  });
  ipcMain.handle('memory:restore-backup', () => memory.restaurarCopia());
  /* «Olvidar esta categoría» de la vista. Acepta las OCHO cadenas en español
     (`herramientas`|`aplicaciones`|`comandos`|`carpetas`|`webs`|`modos`|`permisos`|`todo`);
     la validación y la traducción a las claves reales viven en `habits.olvidar`, que
     devuelve `{ ok:false, error:'categoria desconocida' }` si no es una de ellas. */
  ipcMain.handle('habits:forget', (e, categoria) => {
    if (!categoria || typeof categoria !== 'string') return { ok: false, error: 'categoría es obligatoria' };
    return habits.olvidar(categoria);
  });
  /* La propuesta nueva se anuncia al renderer tal cual sale del almacén: el router es
     el ÚNICO emisor de `memory:nueva` (el gancho de ipc-chat solo llama a proponer). */
  memory.on('propuesta', (propuesta) => {
    const w = getWin();
    if (w && !w.isDestroyed()) w.webContents.send('memory:nueva', propuesta);
  });
```

**`main/preload.js`** — junto a `memoryRemove`, añade:

```js
  memoryTrayList: () => ipcRenderer.invoke('memory:tray:list'),
  memoryTrayAccept: (id, patch) => ipcRenderer.invoke('memory:tray:accept', { id, patch }),
  memoryTrayDiscard: (id) => ipcRenderer.invoke('memory:tray:discard', id),
  memoryTrashList: () => ipcRenderer.invoke('memory:trash:list'),
  memoryTrashRestore: (id) => ipcRenderer.invoke('memory:trash:restore', id),
  memoryTrashEmpty: () => ipcRenderer.invoke('memory:trash:empty'),
  memoryExport: () => ipcRenderer.invoke('memory:export'),
  memoryWipe: () => ipcRenderer.invoke('memory:wipe'),
  memoryRestoreBackup: () => ipcRenderer.invoke('memory:restore-backup'),
  habitsForget: (categoria) => ipcRenderer.invoke('habits:forget', categoria),
  /* Aviso «hay una propuesta nueva»: llega la propuesta tal cual (id, texto, motivo…),
     para refrescar «Recién aprendido» sin sondear. */
  onMemoriaNueva: on('memory:nueva', ([p]) => [p]),
```

**`main/main.js`** — cambia la llamada al router de memoria (línea 76) para pasar `getWin` de forma perezosa (`getWin` se declara más abajo, tras crear la ventana: pasar el identificador sin envolver daría un error de zona muerta temporal):

```js
registerMemoryIpc(ipcMain, {
  memory: require('../agent/memory'),
  models: require('../agent/models'),
  habits: require('../agent/habits'),
  getWin: () => getWin(), // perezoso: getWin se declara al crear la ventana, más abajo
});
```

**`main/main.js`** — en el objeto `settings:` de `config`, tras `hookCerrar: '',`, añade:

```js
    /* Fase 1 de memoria: aprender de las conversaciones (propone, no guarda) y guardar
       sin preguntar (acepta solo lo propuesto). El aprendizaje es opt-out; guardar solo,
       opt-in. */
    memoryLearn: true,
    memoryAutoSave: false,
```

**`main/ipc-config.js`** — en `CLAVES_AJUSTES_PERMITIDAS`, tras `'memSensitivity',`, añade:

```js
    'memoryLearn',
    'memoryAutoSave',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/run.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add main/ipc-memory.js main/preload.js main/main.js main/ipc-config.js test/10-nucleo.js
git commit -m "feat(memoria): IPC, preload y ajustes de la fase 1"
```

---

### Task 9: Gancho de extracción al cerrar el turno

**Files:**
- Modify: `main/ipc-chat.js` (dentro de `chat:send`, sobre la llamada `a.chat(...)`)
- Modify: `main/main.js:633-645` (pasar `memory` en el `ctx` del router de chat)
- Modify: `agent/tools.js` (solo la descripción de la herramienta `remember`: que mencione guardar tras una corrección del usuario, como pide el spec §3.1)
- Modify: `test/10-nucleo.js`

**Interfaces:**
- Consumes: `ctx.memory()` (el módulo `agent/memory.js`) y `cfg().settings.memoryLearn` / `memoryAutoSave`.
- Produces: al terminar un turno con `memoryLearn !== false`, la frase del usuario se pasa a `memory.proponerDeTurno(texto, { convId, convTitulo, autoGuardar })`.

- [ ] **Step 1: Write the failing test**

En `test/10-nucleo.js`, tras el bloque de la Task 8:

```js
test('ipc-chat: el cierre de turno propone memoria con el interruptor encendido', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc-chat.js'), 'utf8');
  ok(/proponerDeTurno\(/.test(src), 'el router llama a proponerDeTurno');
  ok(/memoryLearn/.test(src), 'respeta el interruptor de aprendizaje');
  ok(/memoryAutoSave/.test(src), 'respeta el guardar-sin-preguntar');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run.js`
Expected: FAIL — el router no menciona `proponerDeTurno`.

- [ ] **Step 3: Write minimal implementation**

**`main/main.js`** — en el objeto pasado a `registerChatIpc` (línea ~634), añade una línea junto a `getSkills`:

```js
  memory: () => require('../agent/memory'),
```

**`main/ipc-chat.js`** — en la desestructuración del `ctx` (línea ~26), añade `memory`:

```js
  const { getSkills, getGlow: glow, dialog, fsp, path, attach, memory } = ctx;
```

Y sustituye la llamada `a.chat(...)` del final de `chat:send` por:

```js
    a.chat(body, cfg(), firstImage, { attachments: atts })
      /* Al CERRAR el turno (no al empezarlo): la heurística mira la frase del usuario y
         la bandeja de «Recién aprendido» se llena con lo que huela a hecho duradero.
         Con el interruptor apagado no se propone nada; con «guardar sin preguntar», se
         guarda directamente. Es gratis: no llama al modelo. */
      .then(() => {
        try {
          const s = cfg().settings || {};
          if (s.memoryLearn === false) return;
          /* Solo se propone: el aviso `memory:nueva` lo emite el router de memoria
             escuchando el evento 'propuesta' del módulo (un único punto de emisión). */
          memory().proponerDeTurno(text || body, { convId: c.id, convTitulo: c.title, autoGuardar: s.memoryAutoSave === true });
        } catch (err) {
          ctx.onError('memory:proponer', err);
        }
      })
      .catch((err) => ctx.onError('chat:send', err)) // sin esto el fallo se perdía como promesa flotante
      .finally(() => setTimeout(() => glow('off'), 2400));
```

**`agent/tools.js`** — en la definición de la herramienta `remember` (línea ~458), amplía la descripción para que el modelo la use al corregirle algo, como pide el spec §3.1:

```js
      description:
        'Guarda un recuerdo permanente para futuras conversaciones (preferencias del usuario, datos importantes, decisiones). Úsalo cuando el usuario diga "recuerda que...", o para anotar hábitos y preferencias relevantes que descubras. Úsalo también cuando el usuario CORRIJA algo que creías saber: corrige el recuerdo viejo en vez de dejar los dos.',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/run.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add main/ipc-chat.js main/main.js agent/tools.js test/10-nucleo.js
git commit -m "feat(memoria): proponer hechos al cerrar el turno"
```

---

### Task 10: Hábitos: olvidar por categoría

**Files:**
- Modify: `agent/habits.js`
- Modify: `renderer/30-ajustes.js` (`renderHabitsPreview` y el «Olvidar todo»)
- Modify: `renderer/index.html` (botón `#habitsForgetBtn` en la tarjeta de hábitos de Ajustes)
- Modify: `test/10-nucleo.js`

**Interfaces:**
- Consumes: nada.
- Produces: `habits.olvidar(categoria) -> { ok: true } | { ok: false, error }` con una de las OCHO cadenas en español que ve el usuario: `'herramientas'|'aplicaciones'|'comandos'|'carpetas'|'webs'|'modos'|'permisos'|'todo'`. Internamente traduce a las claves reales del perfil (`tools`,`apps`,`commands`,`folders`,`sites`,`modes`,`confirms`); una cadena desconocida devuelve `{ ok: false, error: 'categoria desconocida' }`. La tabla de traducción se exporta en `__test.CATEGORIAS_USUARIO` para poder probar la cobertura.

- [ ] **Step 1: Write the failing test**

En `test/10-nucleo.js`, dentro de la sección de hábitos, tras el test `habits: single occurrences do not become habits (MIN_COUNT)` (línea ~910), añade:

```js
test('habits: cada categoría real del perfil está cubierta por UNA categoría de la vista', () => {
  const reales = ['tools', 'apps', 'commands', 'folders', 'sites', 'modes', 'confirms'];
  const tabla = habits.__test.CATEGORIAS_USUARIO;
  const cubiertas = Object.values(tabla).flat();
  for (const r of reales) eq(cubiertas.filter((c) => c === r).length, 1, 'cubierta exactamente una vez: ' + r);
  for (const c of cubiertas) ok(reales.includes(c), 'clave real desconocida: ' + c);
});

test('habits: olvidar una categoría borra solo esa categoría', () => {
  habits.reset();
  habits.observe('tool', { name: 'open_app', args: { name: 'spotify.exe' } });
  habits.observe('tool', { name: 'run_command', args: { command: 'git status' } });
  habits.observe('tool', { name: 'browser_control', args: { url: 'https://github.com/ejemplo/x' } });
  const r = habits.olvidar('aplicaciones');
  ok(r.ok, 'devuelve ok');
  const s = habits.stats();
  eq(s.apps.length, 0, 'se olvidaron las apps');
  ok(s.commands.some((c) => c.name === 'git'), 'los comandos siguen ahí');
  ok(s.sites.some((x) => x.name === 'github.com'), 'las webs siguen ahí');
  habits.reset();
});

test('habits: olvidar una categoría desconocida no rompe', () => {
  const r = habits.olvidar('inventada');
  eq(r.ok, false);
  eq(r.error, 'categoria desconocida');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run.js`
Expected: FAIL — `habits.olvidar is not a function`.

- [ ] **Step 3: Write minimal implementation**

En `agent/habits.js`, antes de `function reset()`, añade:

```js
/* Traducción de las categorías que ve el usuario (español) a las claves REALES del
   perfil. La tabla cubre las siete claves observables (tools, apps, commands, folders,
   sites, modes, confirms): si mañana se añade una categoría real y no se traduce, la
   prueba de cobertura de la suite falla y no se puede dejar sin olvidar. */
const CATEGORIAS_USUARIO = {
  herramientas: ['tools'],
  aplicaciones: ['apps'],
  comandos: ['commands'],
  carpetas: ['folders'],
  webs: ['sites'],
  modos: ['modes'],
  permisos: ['confirms'],
};

/** «Olvidar esta categoría» de la vista: borra solo lo observado en ese grupo.
    `'todo'` borra el perfil entero (lo mismo que `reset`). */
function olvidar(categoria) {
  const d = _load();
  if (categoria === 'todo') {
    _save({});
    return { ok: true };
  }
  const mapas = CATEGORIAS_USUARIO[categoria];
  if (!mapas) return { ok: false, error: 'categoria desconocida' };
  for (const c of mapas) {
    if (c === 'confirms') d.confirms = { approved: 0, denied: 0 };
    else if (c === 'modes') delete d.modes;
    else delete d[c];
  }
  // las marcas de uso de esa categoría ya no sirven para nada
  if (d.seen && typeof d.seen === 'object') {
    const prefijos = mapas.map((c) => c + '|');
    for (const k of Object.keys(d.seen)) if (prefijos.some((p) => k.startsWith(p))) delete d.seen[k];
  }
  _save(d);
  return { ok: true };
}
```

Añade `olvidar` a `module.exports` (junto a `observe, profile, stats, reset`) y `CATEGORIAS_USUARIO` dentro de `__test`:

```js
module.exports = { observe, profile, stats, reset, olvidar, __test: { _resetForTests, _prune, MAX_ENTRIES, FORGET_DAYS, CATEGORIAS_USUARIO } };
```

En `renderer/30-ajustes.js`, sustituye el cuerpo de `renderHabitsPreview` por los siete grupos en su orden, cada uno con su botón «olvidar» y su recuento (lo que no haya no se pinta):

```js
async function renderHabitsPreview() {
  const box = $('#habitsPreview');
  if (!box) return;
  let s = null;
  try {
    s = await window.sagitari.habitsGet();
  } catch {}
  if (!s) {
    box.innerHTML = '';
    return;
  }
  const pills = (arr) => (arr || []).map((x) => `<span class="hpill">${esc(x.name)} ×${x.count}</span>`).join(' ');
  const boton = (cat, label) =>
    `<button class="btn ghost sq" data-olvidar="${cat}" title="Olvidar ${esc(label)}" aria-label="Olvidar ${esc(label)}">${ic('trash')}</button>`;
  const modes = Object.entries(s.modes || {}).sort((a, b) => b[1] - a[1]);
  const c = s.confirms || {};
  const permisos =
    c.approved || c.denied ? [`${c.approved || 0} aceptadas`, `${c.denied || 0} denegadas`] : [];
  const grupos = [
    ['herramientas', 'herramientas', (s.tools || []).map((x) => `${esc(x.name)} ×${x.count}`)],
    ['aplicaciones', 'aplicaciones', (s.apps || []).map((x) => `${esc(x.name)} ×${x.count}`)],
    ['comandos', 'comandos', (s.commands || []).map((x) => `${esc(x.name)} ×${x.count}`)],
    ['carpetas', 'carpetas', (s.folders || []).map((x) => `${esc(x.name)} ×${x.count}`)],
    ['webs', 'webs', (s.sites || []).map((x) => `${esc(x.name)} ×${x.count}`)],
    ['modos', 'modos', modes.filter(([, n]) => n >= 2).map(([k, n]) => `${esc(k)} ×${n}`)],
    ['permisos', 'permisos', permisos.map((t) => `<span class="hpill">${esc(t)}</span>`)],
  ];
  const bloques = grupos
    .filter(([, , arr]) => arr && arr.length)
    .map(([cat, label, arr]) => `<div class="hgrupo"><b>${esc(label)}</b> ${arr.join(' ')} ${boton(cat, label)}</div>`);
  box.innerHTML = bloques.length
    ? bloques.join('')
    : '<span class="hdim">Todavía no hay hábitos: se aprenden con el uso normal de la app.</span>';
  box.querySelectorAll('[data-olvidar]').forEach((b) => {
    b.onclick = async () => {
      const cat = b.dataset.olvidar;
      if (!(await askConfirm(b, '¿Olvidar este grupo de hábitos?', 'Dejará de aparecer en el perfil que Sagitari usa para conocerte.'))) return;
      await window.sagitari.habitsForget(cat);
      await renderHabitsPreview();
      showToast('Hábitos olvidados: ' + cat);
    };
  });
}
```

Y en `renderer/30-ajustes.js`, añade junto al botón «Reiniciar hábitos aprendidos» (`#habitsResetBtn`) un botón «Olvidar todo» del grupo de hábitos, que llama a `habitsForget('todo')` con confirmación escrita:

```js
if ($('#habitsForgetBtn'))
  $('#habitsForgetBtn').onclick = async () => {
    const b = $('#habitsForgetBtn');
    if (!(await askConfirm(b, '¿Olvidar TODOS los hábitos?', 'Se borra todo lo que Sagitari ha aprendido de tu uso: herramientas, apps, comandos, carpetas, webs, modos y permisos.'))) return;
    await window.sagitari.habitsForget('todo');
    await renderHabitsPreview();
    showToast('Hábitos olvidados: todo');
  };
```

> `#habitsForgetBtn` es un botón nuevo en la tarjeta de hábitos de Ajustes (`renderer/index.html`, junto a `#habitsResetBtn`), con `<span class="bi"><i data-i="trash"></i></span> Olvidar todo`. El pie de la vista Memoria también lo ofrece (Task 11).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/run.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/habits.js renderer/30-ajustes.js test/10-nucleo.js
git commit -m "feat(habitos): olvidar por categoría desde la vista"
```

---

### Task 11: La vista Memoria (secciones, tarjetas, bandeja, papelera y pie)

**Files:**
- Create: `renderer/memoria-ui.js`
- Modify: `renderer/index.html:486-504` (sección `#view-memory`)
- Modify: `renderer/index.html:1403-1408` (lista de `<script>`)
- Modify: `renderer/10-chat.js:504` (`renderMemory()` → `renderMemoria()`)
- Modify: `renderer/40-vistas.js` (borra `renderMemory` y el manejador de `#memAdd`, líneas ~347-410)
- Modify: `eslint.config.js` (globals del renderer)
- Modify: `renderer/styles.css` (estilos de las secciones)
- Modify: `test/comun.js:73` (`RENDERER_JS`)

**Interfaces:**
- Consumes: puentes de preload de la Task 8.
- Produces:
  - `renderMemoria()` — pinta la vista entera (global del renderer).
  - `window.MemoriaUI = { htmlHecho, htmlPropuesta, htmlPapelera, htmlVacio }` — constructores puros para los tests de la Task 12.

- [ ] **Step 1: Write the failing test**

Aún no hay test de la vista (llega en la Task 12); el primer test comprueba que la vista nueva existe y que la vieja desapareció. En `test/10-nucleo.js`, tras el bloque de la Task 9, añade:

```js
test('renderer: la vista Memoria nueva existe y la vieja se retiró', () => {
  const app = readRenderer();
  ok(/function renderMemoria\(/.test(app), 'existe renderMemoria');
  ok(!/function renderMemory\(/.test(app), 'la vista plana vieja se retiró');
  ok(/view === 'memory'\) renderMemoria\(\)/.test(app), 'goto llama a la vista nueva');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  for (const id of ['memBandeja', 'memHabitos', 'memPapelera', 'memVaciar', 'swMemLearn', 'swMemAuto', 'memExport', 'memWipe', 'habitsForgetBtn']) {
    ok(html.includes(`id="${id}"`), 'falta el bloque ' + id);
  }
});
```

> `readRenderer` ya está en `./comun`; añádelo al `require` de la cabecera si no está.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run.js`
Expected: FAIL — `existe renderMemoria`.

- [ ] **Step 3: Write minimal implementation**

**`renderer/index.html`** — sustituye la sección `#view-memory` completa (líneas 486-504) por:

```html
          <!-- MEMORY -->
          <section class="view" id="view-memory">
            <h1 class="sr-only">Memoria</h1>
            <div class="viewhead">
              <h2>Memoria</h2>
              <div class="vh-actions">
                <input
                  type="text"
                  id="memInput"
                  aria-label="Añade algo que Sagitari debe recordar"
                  placeholder="Añade algo que Sagitari debe recordar…"
                />
                <button class="btn" id="memAdd">
                  <span class="bi"><i data-i="plus"></i></span> Añadir
                </button>
              </div>
            </div>

            <div class="memsec">
              <h3 class="memsec-t">Lo que sé de ti</h3>
              <div id="memFiltro" class="memfiltro"></div>
              <div id="memList" class="memlist"></div>
            </div>

            <div class="memsec">
              <h3 class="memsec-t">Recién aprendido</h3>
              <div id="memBandeja" class="memlist"></div>
            </div>

            <div class="memsec">
              <h3 class="memsec-t">Cómo trabajas conmigo</h3>
              <div id="memHabitos" class="habitprev"></div>
            </div>

            <div class="memsec">
              <h3 class="memsec-t">Papelera</h3>
              <div id="memPapelera" class="memlist"></div>
              <div class="btnrow" style="margin: 8px 0 0">
                <button class="btn ghost danger" id="memVaciar">
                  <span class="bi"><i data-i="trash"></i></span> Vaciar papelera
                </button>
              </div>
            </div>

            <div class="memsec mempie">
              <div class="swrow srow">
                <span class="st"
                  ><b>Que aprenda de nuestras conversaciones</b
                  ><small
                    >Al cerrar cada turno propone hechos duraderos que ve en tus frases. Tú decides qué se guarda; no sale nada de tu
                    equipo.</small
                  ></span
                >
                <div class="sw" id="swMemLearn" role="switch" tabindex="0" aria-label="Que aprenda de nuestras conversaciones"></div>
              </div>
              <div class="swrow srow">
                <span class="st"
                  ><b>Guardar sin preguntar</b
                  ><small>Lo que proponga se guarda solo, sin pasar por «Recién aprendido».</small></span
                >
                <div class="sw" id="swMemAuto" role="switch" tabindex="0" aria-label="Guardar sin preguntar"></div>
              </div>
              <div class="btnrow" style="margin: 10px 0 0">
                <button class="btn ghost" id="memExport">
                  <span class="bi"><i data-i="download"></i></span> Exportar mi memoria
                </button>
                <button class="btn ghost danger" id="memWipe">
                  <span class="bi"><i data-i="trash"></i></span> Olvídalo todo
                </button>
              </div>
            </div>
          </section>
```

Y en la lista de scripts (línea ~1408), añade `memoria-ui.js` antes de `40-vistas.js`:

```html
    <script src="30-ajustes.js"></script>
    <script src="ajustes-util.js"></script>
    <script src="memoria-ui.js"></script>
    <script src="40-vistas.js"></script>
```

**`renderer/memoria-ui.js`** (fichero nuevo, completo):

```js
/* SAGITARI renderer — memoria-ui.js: la vista Memoria (fase 1 del spec de memoria).
   Script clásico: comparte el scope global con los demás 1x-*.js (se carga antes de
   40-vistas.js). La vista vieja vivía en 40-vistas.js; se retiró de allí. */
/* exported renderMemoria */
/* global $, esc, ic, vListEmpty, pintarFill, showToast, askConfirm, CFG */

/** Formatea «hace 3 días» a partir de un instante ISO. */
function haceDe(iso) {
  const d = Date.parse(iso);
  if (!d) return 'nunca';
  const dias = Math.floor((Date.now() - d) / 86400000);
  if (dias <= 0) return 'hoy';
  if (dias === 1) return 'ayer';
  if (dias < 30) return 'hace ' + dias + ' días';
  const meses = Math.floor(dias / 30);
  return meses === 1 ? 'hace 1 mes' : 'hace ' + meses + ' meses';
}

/** De dónde salió un hecho, en una frase. */
function procedencia(m) {
  const cuando = new Date(m.date).toLocaleDateString('es', { day: 'numeric', month: 'short' });
  const origen = { mensaje: 'de tu frase', herramienta: 'de una herramienta', habitos: 'de lo que observo', usuario: 'de tu frase' }[m.origen] || 'de tu frase';
  return origen + ' del ' + cuando;
}

/** HTML de una tarjeta de hecho (activo). Puro: solo depende del hecho. */
function htmlHecho(m) {
  const nivel = m.importance >= 0.8 ? 'alta' : m.importance <= 0.4 ? 'baja' : 'normal';
  const tags = (m.etiquetas || []).map((t) => `<span class="memtag">${esc(t)}</span>`).join('');
  return `<div class="memitem" data-id="${esc(m.id)}">
    <span class="mt"><span class="memtxt" contenteditable="false">${esc(m.text)}</span><br>
      <small class="md">${esc(procedencia(m))} · usado ${esc(haceDe(m.lastUsed))}, ${m.uses || 0} ${(m.uses || 0) === 1 ? 'vez' : 'veces'} ${tags}</small>
    </span>
    <span class="memimp" role="radiogroup" aria-label="Importancia">
      <button class="btn ghost sq${nivel === 'alta' ? ' on' : ''}" data-imp="1" role="radio" aria-checked="${nivel === 'alta'}" title="Alta">A</button>
      <button class="btn ghost sq${nivel === 'normal' ? ' on' : ''}" data-imp="0.6" role="radio" aria-checked="${nivel === 'normal'}" title="Normal">N</button>
      <button class="btn ghost sq${nivel === 'baja' ? ' on' : ''}" data-imp="0.3" role="radio" aria-checked="${nivel === 'baja'}" title="Baja">B</button>
    </span>
    <button class="btn ghost sq" data-edit title="Editar" aria-label="Editar este recuerdo">${ic('code')}</button>
    <button class="btn ghost sq danger" data-del title="Olvidar" aria-label="Olvidar este recuerdo">${ic('trash')}</button>
  </div>`;
}

/** HTML de una propuesta de «Recién aprendido». */
function htmlPropuesta(p) {
  const motivo = p.motivo ? `<small class="md">${esc(p.motivo)}</small>` : '';
  const origen = p.origenTexto && p.origenTexto !== p.texto ? `<small class="md">Lo dijiste así: «${esc(p.origenTexto)}»</small>` : '';
  return `<div class="memitem" data-id="${esc(p.id)}">
    <span class="mt"><span class="memtxt">${esc(p.texto)}</span><br>${motivo}${origen}</span>
    <button class="btn" data-acc="guardar">Guardar</button>
    <button class="btn ghost" data-acc="editar">Editar</button>
    <button class="btn ghost" data-acc="descartar">Descartar</button>
  </div>`;
}

/** HTML de una entrada de la papelera. */
function htmlPapelera(m) {
  return `<div class="memitem" data-id="${esc(m.id)}">
    <span class="mt">${esc(m.text)}<br><small class="md">en papelera desde ${esc(haceDe(m.papelera))}</small></span>
    <button class="btn ghost" data-acc="restaurar">${ic('restore')} Restaurar</button>
  </div>`;
}

/** Estado vacío reutilizable de una sección. */
function htmlVacio(titulo, texto) {
  return vListEmpty('memory', titulo, texto);
}

/** Pinta una sección con su lista, avisando del error de lectura en vez de fingir vacío.
    El estado de error del almacén ofrece la salida del spec §5: «restaurar copia». */
function pintarLista(sel, html, error, vacio) {
  const box = $(sel);
  if (!box) return;
  if (error) {
    box.innerHTML =
      `<div class="subnote">No se pudo leer la memoria: ${esc(error)}. ` +
      `Puedes recuperar la última copia guardada (el fichero ilegible se conserva). ` +
      `<button class="btn ghost" data-restaurar-copia>Restaurar copia</button></div>`;
    const b = box.querySelector('[data-restaurar-copia]');
    if (b)
      b.onclick = async () => {
        const r = await window.sagitari.memoryRestoreBackup();
        if (!r || r.ok === false) showToast((r && r.error) || 'No se pudo restaurar la copia');
        else showToast('Memoria restaurada desde la copia');
        renderMemoria();
      };
    return;
  }
  box.innerHTML = html || vacio;
}

/* ---------- secciones ---------- */

async function pintarHechos() {
  let list = [],
    err = null;
  try {
    list = (await window.sagitari.memoryList()) || [];
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  const q = ($('#memFiltro') && $('#memFiltro').dataset.q) || '';
  const filtrados = q ? list.filter((m) => (m.text + ' ' + (m.etiquetas || []).join(' ')).toLowerCase().includes(q.toLowerCase())) : list;
  pintarLista(
    '#memList',
    filtrados.map(htmlHecho).join(''),
    err,
    q ? '<div class="subnote">Ningún recuerdo coincide con la búsqueda.</div>' : htmlVacio('Aún no sé nada de ti', 'Escribe un recuerdo arriba, o deja que aprenda de lo que le cuentas: lo usaré cuando encaje con lo que pides.'),
  );
  const box = $('#memList');
  box.querySelectorAll('.memitem').forEach((it) => {
    const id = it.dataset.id;
    const m = list.find((x) => x.id === id);
    if (!m) return;
    it.querySelectorAll('[data-imp]').forEach((b) => {
      b.onclick = async () => {
        await window.sagitari.memoryUpdate(id, { importance: Number(b.dataset.imp) });
        pintarHechos();
      };
    });
    it.querySelector('[data-edit]').onclick = () => {
      const t = it.querySelector('.memtxt');
      const editando = t.getAttribute('contenteditable') === 'true';
      t.setAttribute('contenteditable', editando ? 'false' : 'true');
      if (!editando) t.focus();
      else window.sagitari.memoryUpdate(id, { text: t.textContent.trim() }).then(pintarHechos);
    };
    it.querySelector('[data-del]').onclick = async () => {
      if (!(await askConfirm(it, '¿Olvidar este recuerdo?', m.text))) return;
      await window.sagitari.memoryRemove(id);
      pintarHechos();
    };
  });
}

async function pintarBandeja() {
  let props = [],
    err = null;
  try {
    props = (await window.sagitari.memoryTrayList()) || [];
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  pintarLista(
    '#memBandeja',
    props.map(htmlPropuesta).join(''),
    err,
    htmlVacio('Nada nuevo por ahora', 'Cuando en tus frases haya algo duradero (un dato, una preferencia, una ruta), aparecerá aquí para que decidas si lo guardo.'),
  );
  const box = $('#memBandeja');
  box.querySelectorAll('.memitem').forEach((it) => {
    const id = it.dataset.id;
    it.querySelector('[data-acc="guardar"]').onclick = async () => {
      await window.sagitari.memoryTrayAccept(id);
      showToast('Guardado en tu memoria');
      pintarBandeja();
      pintarHechos();
    };
    it.querySelector('[data-acc="descartar"]').onclick = async () => {
      await window.sagitari.memoryTrayDiscard(id);
      pintarBandeja();
    };
    it.querySelector('[data-acc="editar"]').onclick = () => {
      const t = it.querySelector('.memtxt');
      t.setAttribute('contenteditable', 'true');
      t.focus();
      t.onblur = async () => {
        await window.sagitari.memoryTrayAccept(id, { text: t.textContent.trim() });
        pintarBandeja();
        pintarHechos();
      };
    };
  });
}

async function pintarHabitos() {
  let s = null;
  try {
    s = await window.sagitari.habitsGet();
  } catch {}
  const box = $('#memHabitos');
  if (!box) return;
  if (!s) {
    box.innerHTML = '';
    return;
  }
  /* Las siete categorías con las MISMAS cadenas que `habits.olvidar` (herramientas,
     aplicaciones, comandos, carpetas, webs, modos, permisos), en su orden. */
  const pills = (arr) => (arr || []).map((x) => `<span class="hpill">${esc(x.name)} ×${x.count}</span>`).join('');
  const modoPills = (m) => (m && m[1] >= 2 ? `<span class="hpill">${esc(m[0])} ×${m[1]}</span>` : '');
  const c = s.confirms || {};
  const permisos = c.approved || c.denied ? `<span class="hpill">${c.approved || 0} aceptadas</span><span class="hpill">${c.denied || 0} denegadas</span>` : '';
  const grupos = [
    ['herramientas', 'Herramientas', s.tools],
    ['aplicaciones', 'Aplicaciones', s.apps],
    ['comandos', 'Comandos', s.commands],
    ['carpetas', 'Carpetas', s.folders],
    ['webs', 'Webs', s.sites],
  ];
  const bloques = grupos
    .filter(([, , arr]) => arr && arr.length)
    .map(
      ([cat, label, arr]) =>
        `<div class="hgrupo"><span class="hgr-t">${esc(label)}</span>${pills(arr)}<button class="btn ghost sq" data-olvidar="${cat}" title="Olvidar ${esc(label.toLowerCase())}" aria-label="Olvidar ${esc(label.toLowerCase())}">${ic('trash')}</button></div>`,
    );
  const modo = Object.entries(s.modes || {}).sort((a, b) => b[1] - a[1])[0];
  if (modoPills(modo))
    bloques.push(
      `<div class="hgrupo"><span class="hgr-t">Modos</span>${modoPills(modo)}<button class="btn ghost sq" data-olvidar="modos" title="Olvidar el modo preferido" aria-label="Olvidar el modo preferido">${ic('trash')}</button></div>`,
    );
  bloques.push(
    `<div class="hgrupo"><span class="hgr-t">Permisos</span>${permisos}<button class="btn ghost sq" data-olvidar="permisos" title="Olvidar los permisos" aria-label="Olvidar los permisos">${ic('trash')}</button></div>`,
  );
  if (bloques.length)
    bloques.push(
      `<div class="hgrupo"><button class="btn ghost danger" data-olvidar-todo><span class="bi"><i data-i="trash"></i></span> Olvidar todo lo aprendido</button></div>`,
    );
  box.innerHTML = bloques.length
    ? bloques.join('')
    : '<span class="hdim">Todavía no he observado nada: se aprende con el uso normal de la app.</span>';
  box.querySelectorAll('[data-olvidar]').forEach((b) => {
    b.onclick = async () => {
      if (!(await askConfirm(b, '¿Olvidar este grupo de hábitos?', 'Dejará de usarse para conocerte.'))) return;
      await window.sagitari.habitsForget(b.dataset.olvidar);
      pintarHabitos();
    };
  });
  const todo = box.querySelector('[data-olvidar-todo]');
  if (todo)
    todo.onclick = async () => {
      if (!(await askConfirm(todo, '¿Olvidar TODO lo aprendido?', 'Se borra todo lo que Sagitari ha deducido de tu uso.'))) return;
      await window.sagitari.habitsForget('todo');
      pintarHabitos();
    };
}

async function pintarPapelera() {
  let list = [],
    err = null;
  try {
    list = (await window.sagitari.memoryTrashList()) || [];
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  pintarLista('#memPapelera', list.map(htmlPapelera).join(''), err, '<div class="subnote">La papelera está vacía. Aquí caerá lo que se olvide, recuperable 30 días.</div>');
  const box = $('#memPapelera');
  box.querySelectorAll('.memitem').forEach((it) => {
    it.querySelector('[data-acc="restaurar"]').onclick = async () => {
      await window.sagitari.memoryTrashRestore(it.dataset.id);
      pintarPapelera();
      pintarHechos();
    };
  });
}

/** Entrada de la vista: refresca todas las secciones y cablea el pie. */
async function renderMemoria() {
  const filtro = $('#memFiltro');
  if (filtro && !filtro.dataset.listo) {
    filtro.dataset.listo = '1';
    filtro.innerHTML = `<input type="search" id="memSearch" placeholder="Buscar en lo que sé…" aria-label="Buscar en lo que sé de ti" />`;
    $('#memSearch').oninput = (e) => {
      filtro.dataset.q = e.target.value || '';
      pintarHechos();
    };
  }
  await Promise.all([pintarHechos(), pintarBandeja(), pintarHabitos(), pintarPapelera()]);
}

/* El aviso «hay una propuesta nueva» llega del proceso principal al cerrar el turno:
   si la bandeja está a la vista (o el usuario vuelve a ella), se refresca sola. */
if (window.sagitari && window.sagitari.onMemoriaNueva) {
  window.sagitari.onMemoriaNueva(() => {
    if ($('#view-memory') && $('#view-memory').classList.contains('on')) pintarBandeja();
  });
}

/* El pie (interruptores y acciones) se cablea una vez, al cargar el script. */
if ($('#memAdd'))
  $('#memAdd').onclick = async () => {
    const t = $('#memInput').value.trim();
    if (!t) return;
    $('#memInput').value = '';
    await window.sagitari.memoryAdd(t);
    pintarHechos();
  };
if ($('#swMemLearn'))
  $('#swMemLearn').onclick = async () => {
    const on = !$('#swMemLearn').classList.contains('on');
    $('#swMemLearn').classList.toggle('on', on);
    await window.sagitari.setSettings({ memoryLearn: on });
  };
if ($('#swMemAuto'))
  $('#swMemAuto').onclick = async () => {
    const on = !$('#swMemAuto').classList.contains('on');
    $('#swMemAuto').classList.toggle('on', on);
    await window.sagitari.setSettings({ memoryAutoSave: on });
  };
if ($('#memExport'))
  $('#memExport').onclick = async () => {
    const data = await window.sagitari.memoryExport();
    copyText(JSON.stringify(data, null, 2), 'Memoria copiada al portapapeles');
  };
if ($('#memWipe'))
  $('#memWipe').onclick = async () => {
    const r = await askConfirm($('#memWipe'), '¿Olvidarlo todo?', 'Se borra todo lo que sé de ti (incluida la papelera). Se conserva una copia .bak del fichero anterior en tu carpeta de datos.');
    if (!r) return;
    await window.sagitari.memoryWipe();
    showToast('Memoria borrada');
    renderMemoria();
  };
if ($('#memVaciar'))
  $('#memVaciar').onclick = async () => {
    const r = await askConfirm($('#memVaciar'), '¿Vaciar la papelera?', 'Se borrarán para siempre los recuerdos olvidados. Hasta ahora se podían recuperar durante 30 días.');
    if (!r) return;
    await window.sagitari.memoryTrashEmpty();
    showToast('Papelera vaciada');
    pintarPapelera();
  };

if (typeof window !== 'undefined') window.MemoriaUI = { htmlHecho, htmlPropuesta, htmlPapelera, htmlVacio, haceDe, procedencia };
```

**`renderer/10-chat.js`** — cambia la línea `if (view === 'memory') renderMemory();` por:

```js
  if (view === 'memory') renderMemoria();
```

**`renderer/40-vistas.js`** — borra la función `renderMemory` entera (líneas 347-394) y el bloque `$('#memAdd').onclick = ...` (líneas 395-410). Deja el comentario de sección y `fillMemorySens` (que sigue usándose en Ajustes).

**`eslint.config.js`** — en los globals del renderer, sustituye `renderMemory: 'readonly',` por:

```js
        renderMemoria: 'readonly',
        vListEmpty: 'readonly',
        copyText: 'readonly',
```

**`test/comun.js`** — cambia la línea 73 por:

```js
const RENDERER_JS = ['10-chat.js', '20-app.js', '30-ajustes.js', 'memoria-ui.js', '40-vistas.js'];
```

**`renderer/styles.css`** — al final, añade:

```css
/* ---- vista Memoria (fase 1): secciones, hábitos por grupo y pie ---- */
.memsec {
  margin: 0 0 22px;
}
.memsec-t {
  font-size: 0.78rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.7;
  margin: 0 0 10px;
}
.memfiltro input[type='search'] {
  width: 100%;
  max-width: 420px;
  margin-bottom: 10px;
}
.memimp {
  display: inline-flex;
  gap: 4px;
}
.memimp .on {
  box-shadow: inset 0 0 0 1px currentColor;
}
.memtag {
  display: inline-block;
  padding: 1px 7px;
  margin-left: 6px;
  border-radius: 999px;
  font-size: 0.72rem;
  background: color-mix(in srgb, currentColor 14%, transparent);
}
.hgrupo {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.hgr-t {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  opacity: 0.8;
}
.mempie {
  border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  padding-top: 14px;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/run.js && node test/renderer/run.js && npx eslint .`
Expected: PASS. `eslint` puede quejarse de `renderMemoria` no usada en su fichero: el `/* exported renderMemoria */` de la cabecera lo resuelve. Si se queja de `copyText` como global, ya está en la lista.

- [ ] **Step 5: Commit**

```bash
git add renderer/memoria-ui.js renderer/index.html renderer/10-chat.js renderer/40-vistas.js renderer/styles.css eslint.config.js test/comun.js test/10-nucleo.js
git commit -m "feat(memoria): vista con tarjetas, bandeja, hábitos, papelera y pie"
```

---

### Task 12: Tests de la vista en jsdom

**Files:**
- Create: `test/renderer/memoria-ui.test.js`

**Interfaces:**
- Consumes: `window.MemoriaUI` de la Task 11.
- Produces: nada.

- [ ] **Step 1: Write the failing test**

Create `test/renderer/memoria-ui.test.js`:

```js
'use strict';

/* Tests de renderer/memoria-ui.js — los constructores HTML de la vista Memoria.
   Sin spawn: el fichero se evalúa en jsdom con las funciones globales que comparte
   con el resto del renderer (esc, ic, vListEmpty) inyectadas como parámetros. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'memoria-ui.js'), 'utf8');

function cargar() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/' });
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ic = () => '<svg></svg>';
  const vListEmpty = (icon, titulo, texto) => `<div class="listempty"><b>${titulo}</b><p>${texto}</p></div>`;
  const $ = (s) => dom.window.document.querySelector(s);
  const fn = new Function('window', 'document', '$', 'esc', 'ic', 'vListEmpty', 'pintarFill', 'showToast', 'askConfirm', SRC);
  fn(dom.window, dom.window.document, $, esc, ic, vListEmpty, () => {}, () => {}, async () => true);
  return dom.window.MemoriaUI;
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${e.message}`);
  }
}
function assertOk(v, m) {
  if (!v) throw new Error(m || 'valor falso');
}
function assertEqual(a, b, m) {
  if (a !== b) throw new Error(`${m || ''} esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)}`);
}

const UI = cargar();

console.log('memoria-ui.js — constructores');

test('htmlHecho pinta el texto, la procedencia y el uso', () => {
  const html = UI.htmlHecho({
    id: 'a1',
    text: 'El usuario se llama Darío',
    date: '2026-10-12T10:00:00.000Z',
    lastUsed: new Date().toISOString(),
    uses: 3,
    importance: 0.9,
    origen: 'mensaje',
    etiquetas: ['identidad'],
  });
  assertOk(html.includes('El usuario se llama Darío'), 'lleva el texto');
  assertOk(html.includes('de tu frase'), 'lleva la procedencia');
  assertOk(html.includes('3 veces'), 'lleva el uso');
  assertOk(html.includes('identidad'), 'lleva la etiqueta');
  assertOk(html.includes('data-imp="1"'), 'los tres niveles de importancia');
});

test('htmlHecho escapa el texto (no inyecta HTML)', () => {
  const html = UI.htmlHecho({ id: 'x', text: '<script>alert(1)</script>', date: '2026-01-01T00:00:00.000Z', lastUsed: '2026-01-01T00:00:00.000Z', importance: 0.5 });
  assertOk(!html.includes('<script>'), 'el texto va escapado');
});

test('htmlPropuesta pinta los tres botones y el texto literal', () => {
  const html = UI.htmlPropuesta({ id: 'p1', texto: 'El usuario se llama Darío', motivo: 'parece tu nombre', origenTexto: 'me llamo Darío' });
  assertOk(html.includes('data-acc="guardar"'));
  assertOk(html.includes('data-acc="editar"'));
  assertOk(html.includes('data-acc="descartar"'));
  assertOk(html.includes('me llamo Darío'), 'enseña la frase literal');
});

test('htmlPapelera trae el botón de restaurar', () => {
  const html = UI.htmlPapelera({ id: 't1', text: 'Dato viejo', papelera: new Date().toISOString() });
  assertOk(html.includes('data-acc="restaurar"'));
});

test('htmlVacio explica qué hacer', () => {
  const html = UI.htmlVacio('Aún no sé nada de ti', 'Deja que aprenda de lo que le cuentas.');
  assertOk(html.includes('Aún no sé nada de ti'));
  assertOk(html.includes('Deja que aprenda'));
});

test('haceDe describe el último uso en lenguaje humano', () => {
  assertEqual(UI.haceDe(new Date().toISOString()), 'hoy');
  assertEqual(UI.haceDe(new Date(Date.now() - 3 * 86400000).toISOString()), 'hace 3 días');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/renderer/memoria-ui.test.js`
Expected: FAIL — si la Task 11 no expuso `window.MemoriaUI`, `UI` es `undefined` y revienta en `cargar()`. Si la Task 11 ya está hecha, este paso comprueba que el test está bien escrito antes de darlo por bueno.

- [ ] **Step 3: Write minimal implementation**

No hay código nuevo: la implementación es `renderer/memoria-ui.js` de la Task 11. Si algún test falla, corrige el constructor correspondiente hasta que pase (por ejemplo, que `haceDe` devuelva `'hoy'` para menos de un día).

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/renderer/run.js`
Expected: PASS — el runner descubre el archivo nuevo solo.

- [ ] **Step 5: Commit**

```bash
git add test/renderer/memoria-ui.test.js
git commit -m "test(memoria): constructores HTML de la vista en jsdom"
```

---

### Task 13: Arnés vivo (`ui-check`): aprender → bandeja → guardar → usar

**Files:**
- Modify: `scripts/ui-check.js` (limpieza del perfil de pruebas + bloque de comprobación al final, antes de la sección de errores del renderer)
- Modify: `renderer/30-ajustes.js` (nada: el panel de hábitos ya se cambió en la Task 10)

**Interfaces:**
- Consumes: todos los puentes de la Task 8 y la vista de la Task 11.
- Produces: tres comprobaciones vivas sobre la app real.

- [ ] **Step 1: Write the failing check**

En `scripts/ui-check.js`, dentro de `seedTestConfig`, amplía el borrado del historial para limpiar también la memoria entre ejecuciones. Sustituye:

```js
    for (const f of ['conversations.json', 'conversations.json.bak']) {
```

por:

```js
    for (const f of ['conversations.json', 'conversations.json.bak', 'memory.json', 'memory.json.bak', 'memory-tray.json']) {
```

Y añade, antes del bloque `// errores que la propia interfaz haya detectado` (línea ~1478):

```js
  /* ---- FASE 1 MEMORIA: un turno que aprende un hecho, aparece en «Recién aprendido»,
     se guarda y se usa en el turno siguiente. Todo offline: la heurística no llama al
     modelo, así que la comprobación no depende de ningún proveedor. ---- */
  await evaluate('document.querySelector(\'.navitem[data-view="chat"]\').click()');
  await evaluate('document.querySelector("#btnClear").click()');
  await new Promise((r) => setTimeout(r, 600));
  const HECHO_MARCA = 'Memoria' + Date.now();
  const antesHecho = llm.cuerpos.length;
  await evaluate(
    'document.querySelector("#chatInput").value = ' +
      JSON.stringify('recuerda que me llamo ' + HECHO_MARCA) +
      '; document.querySelector("#chatSend").click()',
  );
  const enBandeja = await esperar('(async function(){ const l = await window.sagitari.memoryTrayList(); return l.length > 0; })()', 20000);
  if (enBandeja) console.log('  ok   el turno que aprende un hecho lo deja en «Recién aprendido»');
  else {
    failed++;
    console.log('  FALLO el hecho aprendido no llegó a la bandeja');
  }
  await evaluate('document.querySelector(\'.navitem[data-view="memory"]\').click()');
  await new Promise((r) => setTimeout(r, 400));
  const guardadoOk = await evaluate(
    '(function(){ var b = document.querySelector("#memBandeja [data-acc=\\"guardar\\"]"); if (!b) return false; b.click(); return true; })()',
  );
  if (guardadoOk) {
    const aparece = await esperar(
      'document.querySelector("#memList").textContent.includes(' + JSON.stringify(HECHO_MARCA) + ')',
      8000,
    );
    if (aparece) console.log('  ok   el hecho guardado aparece en «Lo que sé de ti»');
    else {
      failed++;
      console.log('  FALLO el hecho guardado no aparece en la lista');
    }
  } else {
    failed++;
    console.log('  FALLO no había botón «Guardar» en la bandeja');
  }
  /* Y se usa en el turno siguiente: el hecho viaja en el prompt que recibe el modelo. */
  await evaluate('document.querySelector(\'.navitem[data-view="chat"]\').click()');
  await evaluate('document.querySelector("#chatInput").value = "¿cómo me llamo?"; document.querySelector("#chatSend").click()');
  let enPrompt = false;
  const limitePrompt = Date.now() + 20000;
  while (!enPrompt && Date.now() < limitePrompt) {
    if (llm.cuerpos.slice(antesHecho).join('\n').includes(HECHO_MARCA)) enPrompt = true;
    else await new Promise((r) => setTimeout(r, 250));
  }
  if (enPrompt) console.log('  ok   el hecho guardado viaja al prompt del turno siguiente');
  else {
    failed++;
    console.log('  FALLO el hecho guardado no llegó al prompt del modelo');
  }
```

- [ ] **Step 2: Run the check to verify it fails**

Run: `SAGITARI_TEST_PROFILE=$PWD/.perfil-pruebas node scripts/ui-check.js`
Expected: FALLO en las tres comprobaciones nuevas si la app no tiene aún la vista/los puentes (o si el bloque se añadió antes de implementar). Con la fase 1 ya implementada, este paso confirma que el arnés arranca; si falla por un selector, corrige el selector, no el producto.

- [ ] **Step 3: Write minimal implementation**

No hay código nuevo: la comprobación solo usa lo que construyeron las tareas anteriores (el gancho de la Task 9 llena la bandeja, la vista de la Task 11 tiene el botón `data-acc="guardar"` y `#memList`, y los hechos de identidad entran siempre al prompt por la Task 6). Si algo no existe con ese nombre, arréglalo en su tarea de origen y vuelve aquí.

- [ ] **Step 4: Run the check to verify it passes**

Run: `SAGITARI_TEST_PROFILE=$PWD/.perfil-pruebas node scripts/ui-check.js`
Expected: las tres líneas `ok` de memoria y `UI-CHECK::{"ok":true,...}`.

- [ ] **Step 5: Commit**

```bash
git add scripts/ui-check.js
git commit -m "test(ui): ciclo vivo de la memoria (aprende, bandeja, guarda, usa)"
```

---

## Self-review del plan

- **Cobertura del spec (fase 1):** migración v1→v2 con fusión (Task 1 y 4), extracción heurística (Task 2), consolidación al añadir (Task 4), decaimiento y papelera sin borrado silencioso (Task 3 y 5), papelera con restaurar **y vaciar**, más «restaurar copia» del estado de error (Task 5, 8 y 11), bandeja de aprobación (Task 7), interruptor de aprendizaje y guardar sin preguntar (Task 8 y 9), hábitos legibles con olvidar por categoría (Task 10), vista con «Lo que sé de ti» / «Recién aprendido» / «Cómo trabajas conmigo» / papelera / pie con exportar y olvidar todo (Task 11), exportar y wipe (Task 5 y 8), pruebas puras, de renderer y vivas (Task 1-13).
- **Fuera de este plan, con su fase:** la sección 4 de la vista («Buscar en lo que hemos hablado») es de Episodios (fase 3). El «usando lo que sé de ti (n)» del chat y el tope de tokens del recuerdo son de la fase 3. El planificador único de contexto, el resumen durable persistido y las ventanas por modelo son de la fase 2. El motor semántico es la fase 4.
- **Nota de decisión:** `importance` se conserva numérico 0..1 (los tres niveles de la vista son 1 / 0.6 / 0.3) para no romper el scoring ni las pruebas existentes; el spec pide tres niveles en la interfaz, no un cambio de tipo en el almacén.
- **Coherencia de nombres:** `renderMemoria` (no `renderMemory`), `MemoriaUI`, `memoryLearn`/`memoryAutoSave`, `habits.olvidar(categoria)` con las siete categorías en español + `'todo'` (`herramientas`/`aplicaciones`/`comandos`/`carpetas`/`webs`/`modos`/`permisos`), `memoryTray*`/`memoryTrash*` (incluye `memoryTrashEmpty`)/`memoryExport`/`memoryWipe`/`memoryRestoreBackup` y los campos `{ id, text, date, lastUsed, uses, importance, confidence, origen, origenTexto, etiquetas, hash, papelera }` se usan con el mismo nombre en todas las tareas. `memory.restore(id)` (sacar de la papelera) y `memory.restaurarCopia()` (recuperar la copia) son cosas distintas y no se renombran.
