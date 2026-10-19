'use strict';

/* Tests para agent/proyecto.js — detección de perfil y comprobación de sintaxis.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const fs = require('fs');
const os = require('os');
const proyecto = require(path.join(__dirname, '..', '..', 'agent', 'proyecto.js'));

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

console.log('proyecto.js — extensionesCubiertas');

test('devuelve un array no vacío', () => {
  const ext = proyecto.extensionesCubiertas();
  assertOk(Array.isArray(ext), 'debe ser un array');
  assertOk(ext.length > 0, 'no debe estar vacío');
});

test('incluye .js', () => {
  assertOk(proyecto.extensionesCubiertas().includes('.js'), 'debe incluir .js');
});

test('incluye .json', () => {
  assertOk(proyecto.extensionesCubiertas().includes('.json'), 'debe incluir .json');
});

test('incluye .py', () => {
  assertOk(proyecto.extensionesCubiertas().includes('.py'), 'debe incluir .py');
});

console.log('proyecto.js — comprobacionSintaxis');

test('devuelve null para extensión desconocida', () => {
  assertEqual(proyecto.comprobacionSintaxis('archivo.xyz'), null);
});

test('devuelve null para ruta vacía', () => {
  assertEqual(proyecto.comprobacionSintaxis(''), null);
});

test('devuelve comprobación para .js', () => {
  const c = proyecto.comprobacionSintaxis('index.js');
  assertOk(c, 'debe devolver una comprobación');
  assertOk(c.etiqueta, 'debe tener etiqueta');
});

test('devuelve comprobación JSON para .json', () => {
  const c = proyecto.comprobacionSintaxis('package.json');
  assertOk(c, 'debe devolver una comprobación');
  assertEqual(c.json, true);
});

test('es insensible a mayúsculas en la extensión', () => {
  const c = proyecto.comprobacionSintaxis('INDEX.JS');
  assertOk(c, 'debe reconocer la extensión en mayúsculas');
});

/* Proyecto mixto: la rama Python no puede pisar lo que ya encontró Node
   (mismo patrón que la auditoría del 17-oct: un comando que sale con 0 sin
   correr la suite real deja el turno «verificado»). */
function conProyectoTemporal(ficheros, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proyecto-test-'));
  try {
    for (const [nombre, contenido] of Object.entries(ficheros)) {
      const destino = path.join(dir, nombre);
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.writeFileSync(destino, contenido);
    }
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('proyecto.js — detectar');

test('package.json + requirements.txt conserva el comando de Node para tests', () => {
  conProyectoTemporal(
    {
      'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      'requirements.txt': 'requests\n',
    },
    (dir) => {
      assertEqual(proyecto.detectar(dir).tests, 'npm test');
    }
  );
});

test('package.json + requirements.txt conserva el lint de Node', () => {
  conProyectoTemporal(
    {
      'package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }),
      'requirements.txt': 'requests\n',
      'ruff.toml': '',
    },
    (dir) => {
      assertEqual(proyecto.detectar(dir).lint, 'npm run lint');
    }
  );
});

test('solo Python sigue devolviendo el comando de Python', () => {
  conProyectoTemporal({ 'requirements.txt': 'requests\n' }, (dir) => {
    assertEqual(proyecto.detectar(dir).tests, 'python -m unittest');
  });
});

test('solo Python con pytest.ini usa pytest', () => {
  conProyectoTemporal({ 'requirements.txt': 'requests\n', 'pytest.ini': '[pytest]\n' }, (dir) => {
    assertEqual(proyecto.detectar(dir).tests, 'python -m pytest -q');
  });
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
