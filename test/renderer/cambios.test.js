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

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
