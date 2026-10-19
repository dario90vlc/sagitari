'use strict';

/* Tests para agent/cambios.js — diff puro de líneas.
   Sin spawn: se ejecuta directo con node. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cambios = require(path.join(__dirname, '..', '..', 'agent', 'cambios.js'));

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

console.log('cambios.js — diffLineas');

test('texto idéntico produce solo líneas de contexto', () => {
  const ops = cambios.diffLineas('a\nb\nc', 'a\nb\nc');
  assertOk(Array.isArray(ops), 'debe ser un array');
  assertOk(
    ops.every((o) => o.tipo === ' '),
    'todas deben ser contexto',
  );
});

test('una línea cambiada produce un + y un -', () => {
  const ops = cambios.diffLineas('a\nb\nc', 'a\nX\nc');
  assertOk(
    ops.some((o) => o.tipo === '-'),
    'debe haber una eliminación',
  );
  assertOk(
    ops.some((o) => o.tipo === '+'),
    'debe haber una adición',
  );
});

test('añadir una línea produce un +', () => {
  const ops = cambios.diffLineas('a\nb', 'a\nb\nc');
  assertOk(
    ops.some((o) => o.tipo === '+'),
    'debe haber una adición',
  );
});

test('borrar una línea produce un -', () => {
  const ops = cambios.diffLineas('a\nb\nc', 'a\nc');
  assertOk(
    ops.some((o) => o.tipo === '-'),
    'debe haber una eliminación',
  );
});

test('texto vacío contra vacío no produce cambios', () => {
  const ops = cambios.diffLineas('', '');
  assertOk(Array.isArray(ops), 'debe ser un array');
  assertEqual(ops.filter((o) => o.tipo !== ' ').length, 0);
});

test('los tipos solo son " ", "+" o "-"', () => {
  const ops = cambios.diffLineas('a\nb\nc\nd', 'a\nX\nc\nY');
  assertOk(
    ops.every((o) => [' ', '+', '-'].includes(o.tipo)),
    'tipos válidos',
  );
});

console.log('cambios.js — deshacer no toca una carpeta vecina');

/* El workspace `C:\proj` y su vecina `C:\proj-viejo` comparten prefijo de TEXTO, no
   carpeta. Deshacer clasificaba por prefijo (`startsWith(raiz)`) y escribía en la vecina,
   mientras el panel de revisión (archivoRevertir) la rechazaba por estar fuera: dos
   respuestas opuestas para el mismo archivo. */
test('deshacer no restaura un archivo de la carpeta vecina', () => {
  cambios.limpiar();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sagi-ws-'));
  const vecina = ws + '-viejo'; // misma raíz de texto, OTRA carpeta
  fs.mkdirSync(vecina, { recursive: true });
  const dentro = path.join(ws, 'a.txt');
  const fuera = path.join(vecina, 'a.txt');
  fs.writeFileSync(dentro, 'despues\n');
  fs.writeFileSync(fuera, 'despues\n');
  cambios.recordar(ws, dentro, 'dentro-antes\n');
  cambios.recordar(ws, fuera, 'fuera-antes\n');

  const r = cambios.deshacer(ws);
  assertEqual(fs.readFileSync(fuera, 'utf8'), 'despues\n', 'la carpeta vecina no se toca');
  assertEqual(fs.readFileSync(dentro, 'utf8'), 'dentro-antes\n', 'la del proyecto sí vuelve atrás');
  assertEqual(r.restaurados, 1, 'solo se restaura lo del proyecto');
  const hermana = r.archivos.find((x) => x.accion === 'fuera-del-espacio');
  assertOk(hermana, 'y el informe dice que se dejó fuera: ' + JSON.stringify(r.archivos));
  cambios.limpiar();
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(vecina, { recursive: true, force: true });
});

console.log('cambios.js — deshacer y la raíz declarada de una ruta fusionada');

/* La fusión de un árbol aislado registra la pre-imagen contra la RAÍZ DEL REPOSITORIO,
   que con el espacio de trabajo en una subcarpeta (`<repo>/proyecto`) queda POR ENCIMA
   del espacio. Antes esa ruta caía fuera de `dentroDelEspacio` y deshacer la descartaba
   sin restaurarla ni contarla: el usuario leía «deshechos» con el parche todavía dentro. */
test('deshacer restaura una ruta fuera del ws si al recordarla se declaró su raíz', () => {
  cambios.limpiar();
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'sagi-repo-'));
  const ws = path.join(raiz, 'proyecto');
  const otro = path.join(raiz, 'otro');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(otro, { recursive: true });
  const fuera = path.join(otro, 'x.js');
  fs.writeFileSync(fuera, 'del agente\n');
  cambios.recordar(ws, fuera, null, '', raiz); // pre-imagen null = lo creó el turno

  const r = cambios.deshacer(ws);
  assertEqual(r.borrados, 1, 'la ruta fuera del ws se deshace: ' + JSON.stringify(r.archivos));
  assertEqual(r.fallos, 0, 'y no se cuenta como fallo');
  assertOk(!fs.existsSync(fuera), 'el archivo que trajo la fusión se borra al deshacer');
  cambios.limpiar();
  fs.rmSync(raiz, { recursive: true, force: true });
});

/* Lo que NI su raíz declarada cubre no se puede deshacer: no se toca Y se cuenta como
   fallo, para que la interfaz no pueda decir «deshechos» cuando no lo está. */
test('una ruta que ni su raíz declarada cubre se cuenta como fallo, no como deshecho', () => {
  cambios.limpiar();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sagi-ws-fuera-'));
  const otra = ws + '-otra';
  fs.mkdirSync(otra, { recursive: true });
  const fuera = path.join(otra, 'x.js');
  fs.writeFileSync(fuera, 'del agente\n');
  cambios.recordar(ws, fuera, null, '', ws); // raíz declarada = el propio ws

  const r = cambios.deshacer(ws);
  assertEqual(r.fallos, 1, 'no se pudo deshacer → fallo visible: ' + JSON.stringify(r.archivos));
  assertOk(
    r.archivos.some((x) => x.accion === 'fuera-del-espacio'),
    'y el informe dice por qué',
  );
  assertOk(fs.existsSync(fuera), 'el archivo NO se toca');
  cambios.limpiar();
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(otra, { recursive: true, force: true });
});

console.log('cambios.js — pre-imagen de un archivo que no está en UTF-8');

test('leerAntes no devuelve mojibake de un archivo ANSI/CP1252 (pre-imagen inservible)', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sagi-cambios-cp1252-'));
  try {
    /* Un .txt guardado por Windows (Notepad/PowerShell) con acentos en CP1252: al
       leerlo como UTF-8 los acentos se vuelven U+FFFD. Antes esa pre-imagen se guardaba
       tal cual y «Deshacer» reescribía el archivo con basura; ahora se declara sin
       pre-imagen (y `recordar` lo marca como no restaurable, como un binario). */
    const malo = path.join(ws, 'nota.txt');
    fs.writeFileSync(malo, Buffer.from('CAF' + String.fromCharCode(0xe9) + ' con acento\n', 'latin1'));
    assertEqual(cambios.leerAntes(malo), '', 'un archivo que no round-trip a UTF-8 no puede tener pre-imagen:');
    // el mismo contenido en UTF-8 sí tiene pre-imagen (no se rompe lo de siempre)
    const bueno = path.join(ws, 'ok.txt');
    fs.writeFileSync(bueno, 'CAFÉ con acento\n', 'utf8');
    assertEqual(cambios.leerAntes(bueno), 'CAFÉ con acento\n', 'un archivo UTF-8 conserva su pre-imagen:');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
