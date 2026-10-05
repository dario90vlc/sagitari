'use strict';

/* Tests para main/config.js — funciones de config y claves.
   safeStorage se mockea porque es un módulo de electron que no existe en Node.
   Sin spawn: se ejecuta directo con node. */

const fs = require('fs');
const path = require('path');
const Module = require('module');

// Mock de safeStorage antes de requerir config.js
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'electron') {
    return {
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from('encrypted:' + s),
        decryptString: (buf) => {
          const s = buf.toString();
          if (!s.startsWith('encrypted:')) throw new Error('datos inválidos');
          return s.replace(/^encrypted:/, '');
        },
      },
    };
  }
  return originalRequire.apply(this, arguments);
};

const { KEY_PREFIX, encryptionAvailable, protectKey, revealKey, protectServerSecrets, revealServerSecrets, writeJsonAtomic } = require(
  path.join(__dirname, '..', '..', 'main', 'config.js'),
);

// Restaurar require original
Module.prototype.require = originalRequire;

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

console.log('config.js — encryptionAvailable');

test('devuelve true cuando safeStorage está disponible', () => {
  assertEqual(encryptionAvailable(), true);
});

console.log('config.js — protectKey');

test('devuelve string vacío si está vacío', () => {
  assertEqual(protectKey(''), '');
});

test('devuelve el mismo valor si ya está cifrado', () => {
  const ya = KEY_PREFIX + 'algo';
  assertEqual(protectKey(ya), ya);
});

test('cifra una clave nueva', () => {
  const cifrada = protectKey('mi-clave-secreta');
  assertOk(cifrada.startsWith(KEY_PREFIX), 'debe empezar con KEY_PREFIX');
  assertOk(cifrada !== 'mi-clave-secreta', 'no debe ser la clave original');
});

console.log('config.js — revealKey');

test('devuelve el valor si no está cifrado', () => {
  assertEqual(
    revealKey('texto-plano', () => {}),
    'texto-plano',
  );
});

test('descifra una clave cifrada', () => {
  const cifrada = protectKey('mi-clave-secreta');
  assertEqual(
    revealKey(cifrada, () => {}),
    'mi-clave-secreta',
  );
});

test('llama a onError si no puede descifrar', () => {
  let called = false;
  // Usar un criptogramar inválido (no es base64 válido después del prefijo)
  const resultado = revealKey(KEY_PREFIX + '!!!invalido!!!', () => {
    called = true;
  });
  assertOk(called, 'debe llamar a onError');
  assertEqual(resultado, KEY_PREFIX + '!!!invalido!!!', 'debe devolver el criptograma');
});

console.log('config.js — protectServerSecrets / revealServerSecrets');

test('cifra y descifra secrets de servidor', () => {
  const server = { command: 'npx', env: { API_KEY: 'secret123' }, headers: { Authorization: 'Bearer token' } };
  const cifrado = protectServerSecrets(server);
  assertOk(cifrado.env.API_KEY.startsWith(KEY_PREFIX), 'env debe estar cifrado');
  assertOk(cifrado.headers.Authorization.startsWith(KEY_PREFIX), 'headers debe estar cifrado');
  const descifrado = revealServerSecrets(cifrado, (k) => revealKey(k, () => {}));
  assertEqual(descifrado.env.API_KEY, 'secret123');
  assertEqual(descifrado.headers.Authorization, 'Bearer token');
});

test('maneja servers sin env ni headers', () => {
  const server = { command: 'npx' };
  const cifrado = protectServerSecrets(server);
  assertEqual(cifrado.command, 'npx');
  const descifrado = revealServerSecrets(cifrado, (k) => revealKey(k, () => {}));
  assertEqual(descifrado.command, 'npx');
});

console.log('config.js — writeJsonAtomic');

test('escribe JSON correctamente', () => {
  const tmp = path.join(__dirname, 'test-config-tmp.json');
  writeJsonAtomic(tmp, JSON.stringify({ hola: 'mundo' }));
  const leido = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  assertEqual(leido.hola, 'mundo');
  fs.unlinkSync(tmp);
});

test('crea directorios si no existen', () => {
  const tmp = path.join(__dirname, 'test-config-subdir', 'test.json');
  writeJsonAtomic(tmp, JSON.stringify({ ok: true }));
  assertOk(fs.existsSync(tmp), 'el archivo debe existir');
  fs.unlinkSync(tmp);
  fs.rmdirSync(path.join(__dirname, 'test-config-subdir'));
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
