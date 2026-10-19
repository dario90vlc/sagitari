'use strict';

/* Tests para main/updater.js — versiones, assets y firma de la actualización.
   Se ejecuta directo con node; el guion del ayudante se ejecuta de verdad con la
   PowerShell de la máquina sobre ficheros temporales (nada que descargar). */

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
  /* La función devuelve la hora LOCAL (es lo que `schtasks /st` pide). La base se
     construye en hora local: con un instante UTC fijo, el caso dependía del huso de la
     máquina (en un runner en UTC daba «10:05» y las pruebas se caían allí y no aquí). */
  assertEqual(updater.taskTimePlus(5, new Date(2026, 0, 1, 10, 0).getTime()), '10:05');
  assertEqual(updater.taskTimePlus(2, new Date(2026, 0, 1, 23, 59).getTime()), '00:01', 'cruza la medianoche');
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

/* ---------- huella del instalador y «app viva» en el guion del ayudante ----------

   Hallazgos 6 y 7 de la revisión: el ayudante calculaba si la app seguía viva y
   no lo usaba, y el .exe de %TEMP% se comprobaba una sola vez (al descargarlo, con
   la app aún en marcha) y después se ejecutaba sin volver a mirarlo. Estas pruebas
   ejecutan el guion DE VERDAD con la PowerShell de la máquina sobre ficheros
   temporales de os.tmpdir(): no descargan nada ni tocan el perfil del usuario. */

console.log('updater.js — huella del instalador en el guion del ayudante');

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

/** Ejecuta de verdad el guion que instala (cmd.exe como «instalador» de mentira). */
function correrAyudante(dir, opts) {
  const ps1 = path.join(dir, 'sagitari-instalar.ps1');
  updater.writeHelperPs(ps1, opts);
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
    windowsHide: true,
    timeout: 60000,
    encoding: 'utf8',
  });
}

/** Escenario: un instalador de verdad (cmd.exe) que deja marca si llega a correr. */
function escenario(prefijo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
  const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  return {
    dir,
    installer: cmd,
    marca: path.join(dir, 'marco.txt'),
    logPath: path.join(dir, 'instalar.log'),
    args: '/c echo ok> "' + path.join(dir, 'marco.txt') + '"',
    huella: crypto.createHash('sha512').update(fs.readFileSync(cmd)).digest('base64'),
  };
}

test('el guion comprueba la huella SHA-512 del instalador antes de ejecutarlo', () => {
  const esperado = crypto.createHash('sha512').update('contenido del Setup').digest('base64');
  const hex = crypto.createHash('sha512').update('contenido del Setup').digest('hex');
  const s = updater.installHelperScript({
    name: 'SAGITARI',
    installer: 'C:/t/setup.exe',
    logPath: 'C:/t/instalar.log',
    expected: esperado,
  });
  assertOk(s.includes('[System.Security.Cryptography.SHA512]::Create()'), 'calcula el SHA-512 sin depender de un cmdlet (Get-FileHash puede no estar: PSModulePath heredado de PowerShell 7)');
  assertOk(s.includes(hex), 'la huella esperada viaja dentro del guion');
  assertOk(s.indexOf('SHA512') < s.indexOf('Start-Process -FilePath'), 'se comprueba ANTES de lanzarlo');
  assertOk(s.includes('$codigo = 2'), 'una huella que no cuadra deja el instalador sin ejecutar');
});

test('sin huella publicada no se emite la puerta (los arneses usan un señuelo sin firma)', () => {
  const s = updater.installHelperScript({ name: 'SAGITARI', installer: 'C:/t/setup.exe', logPath: 'C:/t/l.log' });
  assertOk(!s.includes('Get-FileHash'), 'sin huella no hay nada que comparar');
});

test('si la app sigue viva, el guion no lanza el instalador (el cálculo se usa)', () => {
  const s = updater.installHelperScript({ name: 'SAGITARI', installer: 'C:/t/setup.exe', logPath: 'C:/t/l.log' });
  assertOk(s.includes('$codigo = 3'), 'la app viva deja el instalador sin lanzar');
  assertOk(s.indexOf('$codigo = 3') < s.indexOf('Start-Process -FilePath'), 'y la decisión va antes del lanzamiento');
});

test('un instalador cuya huella NO coincide no se ejecuta', () => {
  if (process.platform !== 'win32') return; // el guion es de Windows
  const e = escenario('sagi-huella-');
  // El .exe de disco sigue siendo ejecutable; lo que apunta a otro contenido es
  // la huella publicada: es la ventana en la que alguien sustituye el Setup.
  const r = correrAyudante(e.dir, {
    name: 'SAGITARI-PROCESO-QUE-NO-EXISTE',
    installer: e.installer,
    args: e.args,
    logPath: e.logPath,
    expected: crypto.createHash('sha512').update('otro binario').digest('base64'),
    waitMs: 1,
    graceMs: 0,
  });
  assertOk(!fs.existsSync(e.marca), 'el binario que no cuadra con la huella no debe ejecutarse');
  assertEqual(r.status, 2, 'el guion termina con código 2 (huella que no cuadra)');
  assertOk(/huella SHA-512/.test(fs.readFileSync(e.logPath, 'utf8')), 'y el diario dice por qué no se ejecutó');
});

test('con la huella correcta el camino normal sigue instalando', () => {
  if (process.platform !== 'win32') return;
  const e = escenario('sagi-huella-ok-');
  const r = correrAyudante(e.dir, {
    name: 'SAGITARI-PROCESO-QUE-NO-EXISTE',
    installer: e.installer,
    args: e.args,
    logPath: e.logPath,
    expected: e.huella,
    waitMs: 1,
    graceMs: 0,
  });
  const diario = fs.readFileSync(e.logPath, 'utf8');
  assertOk(
    fs.existsSync(e.marca),
    'el instalador verificado sí se ejecuta (código ' + r.status + '; diario: ' + diario.replace(/\s+/g, ' ').slice(0, 300) + ')',
  );
  assertEqual(r.status, 0, 'y el guion termina sin error (diario: ' + diario.replace(/\s+/g, ' ').slice(0, 200) + ')');
  assertOk(/instalador lanzado/.test(diario), 'el diario registra el lanzamiento');
});

test('con la app todavía viva el instalador no llega a ejecutarse (ni con la huella bien)', () => {
  if (process.platform !== 'win32') return;
  const e = escenario('sagi-viva-');
  // «node» es este mismo proceso de pruebas: la app sigue viva cuando se agota la espera.
  const r = correrAyudante(e.dir, {
    name: 'node',
    installer: e.installer,
    args: e.args,
    logPath: e.logPath,
    expected: e.huella,
    waitMs: 1,
    graceMs: 0,
    extraWaitMs: 0,
  });
  const diario = fs.readFileSync(e.logPath, 'utf8');
  assertOk(!fs.existsSync(e.marca), 'con la app viva no se instala encima de ficheros en uso');
  assertEqual(r.status, 3, 'el guion termina con código 3 (app todavía viva)');
  assertOk(/seguia en ejecucion: True/.test(diario), 'y el diario deja constancia del motivo');
});

test('programarInstalacion lleva la huella esperada al .ps1 que ejecuta la tarea', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sagi-huelle-ps-'));
  const esperado = crypto.createHash('sha512').update('Setup').digest('base64');
  const hex = crypto.createHash('sha512').update('Setup').digest('hex');
  // El .ps1 se escribe antes del primer await, así que basta con leerlo aquí.
  updater.programarInstalacion({
    dir,
    name: 'APP',
    installer: 'C:/t/setup.exe',
    args: '/S',
    logPath: path.join(dir, 'instalar.log'),
    expected: esperado,
    taskName: 'TAREA-HUELLA',
    execFn: async () => ({ code: 0, stdout: '', stderr: '' }),
  });
  const txt = fs.readFileSync(path.join(dir, 'sagitari-instalar.ps1'), 'utf8');
  assertOk(txt.includes('[System.Security.Cryptography.SHA512]::Create()'), 'el ayudante comprueba la huella (sin depender de Get-FileHash)');
  assertOk(txt.includes(hex), 'y la huella esperada llega hasta el .ps1');
});

test('desprogramarInstalacion borra la tarea del Programador (no puede dispararse sola)', () => {
  const llamadas = [];
  const p = updater.desprogramarInstalacion({
    execFn: async (cmd, a) => {
      llamadas.push(cmd + ' ' + a.join(' '));
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assertOk(p && typeof p.then === 'function', 'debe devolver una promesa');
  assertEqual(llamadas.length, 1, 'una sola llamada a schtasks');
  assertEqual(llamadas[0], 'schtasks /delete /tn ' + updater.TASK_NAME + ' /f', llamadas[0]);
});

test('desprogramarInstalacion no revienta si la tarea ya no existe', () => {
  let veces = 0;
  updater.desprogramarInstalacion({
    taskName: 'OTRA',
    execFn: async (cmd, a) => {
      veces++;
      assertEqual(a.join(' '), '/delete /tn OTRA /f', 'respeta el nombre de la tarea');
      return { code: 1, stdout: '', stderr: 'ERROR: no existe la tarea' };
    },
  });
  assertEqual(veces, 1, 'lo intenta aunque falle: es best-effort');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
