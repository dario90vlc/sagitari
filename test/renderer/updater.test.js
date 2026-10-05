'use strict';

/* Tests para main/updater.js — versiones, assets y firma de la actualización.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const updater = require(path.join(__dirname, '..', '..', 'main', 'updater.js'));

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

console.log('updater.js — parseVersion');

test('descompone una versión normal', () => {
  const v = updater.parseVersion('4.1.0');
  assertEqual(v.nums.join('.'), '4.1.0');
  assertEqual(v.pre, '');
});

test('acepta el prefijo v', () => {
  const v = updater.parseVersion('v4.1.0');
  assertEqual(v.nums.join('.'), '4.1.0');
});

test('separa el sufijo de preestreno', () => {
  const v = updater.parseVersion('4.1.0-beta.2');
  assertEqual(v.nums.join('.'), '4.1.0');
  assertEqual(v.pre, 'beta.2');
});

test('devuelve null para algo que no es versión', () => {
  assertEqual(updater.parseVersion('basura'), null);
});

test('devuelve null para vacío o null', () => {
  assertEqual(updater.parseVersion(''), null);
  assertEqual(updater.parseVersion(null), null);
});

console.log('updater.js — compareVersions');

test('una versión mayor gana', () => {
  assertEqual(updater.compareVersions('4.1.0', '4.0.0'), 1);
});

test('una versión menor pierde', () => {
  assertEqual(updater.compareVersions('4.0.0', '4.1.0'), -1);
});

test('versiones iguales empatan', () => {
  assertEqual(updater.compareVersions('4.1.0', '4.1.0'), 0);
});

test('compara números, no texto (4.10 > 4.9)', () => {
  assertEqual(updater.compareVersions('4.10.0', '4.9.0'), 1);
});

test('el prefijo v no cambia el resultado', () => {
  assertEqual(updater.compareVersions('v4.2.0', '4.1.0'), 1);
});

test('una versión final gana a su preestreno', () => {
  assertEqual(updater.compareVersions('4.1.0', '4.1.0-beta.1'), 1);
});

test('un preestreno pierde frente a la versión final', () => {
  assertEqual(updater.compareVersions('4.1.0-beta.1', '4.1.0'), -1);
});

test('una versión desconocida no se declara más nueva', () => {
  assertEqual(updater.compareVersions('basura', '4.1.0'), 0);
});

console.log('updater.js — pickAssets');

test('encuentra el instalador, el portable y el yml', () => {
  const rel = {
    assets: [
      { name: 'SAGITARI-Setup-4.2.0.exe', browser_download_url: 'u1' },
      { name: 'SAGITARI-Portable-4.2.0.exe', browser_download_url: 'u2' },
      { name: 'latest.yml', browser_download_url: 'u3' },
    ],
  };
  const a = updater.pickAssets(rel);
  assertEqual(a.setup.name, 'SAGITARI-Setup-4.2.0.exe');
  assertEqual(a.portable.name, 'SAGITARI-Portable-4.2.0.exe');
  assertEqual(a.yml.name, 'latest.yml');
});

test('devuelve null en lo que no está', () => {
  const a = updater.pickAssets({ assets: [] });
  assertEqual(a.setup, null);
  assertEqual(a.portable, null);
  assertEqual(a.yml, null);
});

test('no confunde el portable con el instalador', () => {
  const rel = { assets: [{ name: 'SAGITARI-Portable-4.2.0.exe' }] };
  const a = updater.pickAssets(rel);
  assertEqual(a.setup, null);
  assertOk(a.portable, 'debe encontrar el portable');
});

console.log('updater.js — assetFor');

test('el modo portable prefiere el portable', () => {
  const assets = { setup: { name: 'setup.exe' }, portable: { name: 'portable.exe' } };
  assertEqual(updater.assetFor('portable', assets).name, 'portable.exe');
});

test('el modo instalador prefiere el instalador', () => {
  const assets = { setup: { name: 'setup.exe' }, portable: { name: 'portable.exe' } };
  assertEqual(updater.assetFor('installer', assets).name, 'setup.exe');
});

test('si falta el preferido usa el otro', () => {
  assertEqual(updater.assetFor('portable', { setup: { name: 'setup.exe' } }).name, 'setup.exe');
  assertEqual(updater.assetFor('installer', { portable: { name: 'portable.exe' } }).name, 'portable.exe');
});

test('sin assets no hay nada que descargar', () => {
  assertEqual(updater.assetFor('installer', null), null);
  assertEqual(updater.assetFor('installer', {}), null);
});

console.log('updater.js — parseLatestYml');

test('lee versión, ruta y sha512', () => {
  const yml = 'version: 4.2.0\npath: SAGITARI-Setup-4.2.0.exe\nsha512: ABC==\n';
  const p = updater.parseLatestYml(yml);
  assertEqual(p.version, '4.2.0');
  assertEqual(p.path, 'SAGITARI-Setup-4.2.0.exe');
  assertEqual(p.sha512, 'ABC==');
});

test('lee la lista de archivos', () => {
  const yml = 'version: 4.2.0\nfiles:\n  - url: a.exe\n    sha512: AAA==\n    size: 10\n';
  const p = updater.parseLatestYml(yml);
  assertOk(Array.isArray(p.files), 'files debe ser una lista');
  assertEqual(p.files.length, 1);
  assertEqual(p.files[0].url, 'a.exe');
});

test('maneja texto vacío', () => {
  const p = updater.parseLatestYml('');
  assertOk(p && typeof p === 'object', 'debe devolver un objeto');
});

console.log('updater.js — sha512For');

test('devuelve el sha512 del archivo pedido', () => {
  const yml = 'version: 4.2.0\nfiles:\n  - url: a.exe\n    sha512: AAA==\n';
  const p = updater.parseLatestYml(yml);
  assertEqual(updater.sha512For(p, 'a.exe'), 'AAA==');
});

test('devuelve null si el archivo no está firmado', () => {
  const yml = 'version: 4.2.0\nfiles:\n  - url: a.exe\n    sha512: AAA==\n';
  const p = updater.parseLatestYml(yml);
  assertEqual(updater.sha512For(p, 'otro.exe'), null);
});

console.log('updater.js — motivoSinFirma');

test('avisa cuando la release no publica latest.yml', () => {
  const m = updater.motivoSinFirma({ tieneYml: false });
  assertOk(String(m).includes('latest.yml'), 'debe mencionar latest.yml');
});

test('avisa cuando el archivo no está firmado', () => {
  const m = updater.motivoSinFirma({ tieneYml: true, assetName: 'x.exe', expected: null });
  assertOk(String(m).includes('x.exe'), 'debe mencionar el archivo');
});

console.log('updater.js — downloadTarget');

test('el destino cuelga de una carpeta propia', () => {
  const t = updater.downloadTarget({ kind: 'installer', assetName: 'a.exe', env: {} });
  assertOk(t.dir && t.path, 'debe traer dir y path');
  assertOk(t.path.endsWith('a.exe'), 'el path debe acabar en el nombre del asset');
  assertOk(t.path.startsWith(t.dir), 'el path debe estar dentro del dir');
});

console.log('updater.js — tareas programadas');

test('taskTimePlus suma minutos', () => {
  assertEqual(updater.taskTimePlus(5, new Date('2026-01-01T10:00:00Z')), '11:05');
});

test('taskRunLine lanza powershell oculto', () => {
  const l = updater.taskRunLine('C:/x/y.ps1');
  assertOk(l.includes('powershell.exe'), 'debe usar powershell');
  assertOk(l.includes('Hidden'), 'debe ser invisible');
  assertOk(l.includes('y.ps1'), 'debe apuntar al script');
});

test('scheduleCreateArgs monta el schtasks', () => {
  const a = updater.scheduleCreateArgs({ psPath: 'C:/x/y.ps1', startTime: '10:00' });
  assertOk(a.includes('/create'), 'debe crear la tarea');
  assertOk(a.includes('/st'), 'debe fijar la hora');
  assertOk(a.includes('10:00'), 'debe incluir la hora');
});

console.log('updater.js — constantes');

test('REPO y API_LATEST apuntan a GitHub', () => {
  assertOk(updater.REPO.includes('/'), 'REPO debe ser owner/repo');
  assertOk(updater.API_LATEST.startsWith('https://'), 'API_LATEST debe ser https');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
