'use strict';
/* Suite SAGITARI — actualizador, reparaciones, navegador y logs (antes run.js 2764-3452).
   Registra tests en la cola de ./comun; run.js carga los bloques en orden. */
const {
  fs,
  path,
  tmpDir,
  test,
  eq,
  ok,
  Guardrails,
  describeAction,
  summarizeArgs,
  skills,
  modelsMod,
  SKILLS_TMP,
  MAIN_SRC,
  MAIN_ALL,
  memory,
  habits,
  updater,
  Browser,
  profiles,
  runlog,
  PROF_TMP,
  readRenderer,
} = require('./comun');

/* ---------- actualizador: versiones, assets, descarga y verificación ---------- */

test('updater: compara versiones como semver', () => {
  eq(updater.compareVersions('2.2.0', '2.2.1'), -1);
  eq(updater.compareVersions('2.2.1', '2.2.1'), 0);
  eq(updater.compareVersions('2.10.0', '2.9.9'), 1, 'los números se comparan como números, no como texto');
  eq(updater.compareVersions('v2.3.0', '2.2.9'), 1, 'admite el prefijo v');
  eq(updater.compareVersions('3.0.0', '2.99.99'), 1);
  eq(updater.compareVersions('2.0.0', '2.0.0-beta.1'), 1, 'una estable es más nueva que su beta');
  eq(updater.compareVersions('2.0.0-beta.1', '2.0.0'), -1);
  eq(updater.compareVersions('', '2.0.0'), 0, 'una versión desconocida no se declara más nueva');
});

const RELEASE = {
  tag_name: 'v2.3.0',
  name: '2.3.0',
  draft: false,
  prerelease: false,
  html_url: 'https://github.com/dario90vlc/sagitari/releases/tag/v2.3.0',
  published_at: '2026-10-01T10:00:00Z',
  body: 'Notas de la versión',
  assets: [
    { name: 'latest.yml', browser_download_url: 'https://x/latest.yml', size: 300 },
    { name: 'SAGITARI-Portable-2.3.0.exe', browser_download_url: 'https://x/p.exe', size: 2 },
    { name: 'SAGITARI-Setup-2.3.0.exe', browser_download_url: 'https://x/s.exe', size: 3 },
    { name: 'SAGITARI-Setup-2.3.0.exe.blockmap', browser_download_url: 'https://x/s.blockmap', size: 4 },
  ],
};

test('updater: elige los binarios correctos de la release', () => {
  const a = updater.pickAssets(RELEASE);
  eq(a.setup.name, 'SAGITARI-Setup-2.3.0.exe', 'no debe confundirse con el .blockmap');
  eq(a.portable.name, 'SAGITARI-Portable-2.3.0.exe');
  eq(a.yml.name, 'latest.yml');
  eq(updater.assetFor('nsis', a).name, 'SAGITARI-Setup-2.3.0.exe');
  eq(updater.assetFor('portable', a).name, 'SAGITARI-Portable-2.3.0.exe');
  eq(updater.assetFor('nsis', { portable: a.portable }).name, 'SAGITARI-Portable-2.3.0.exe', 'si falta el Setup, usa el portable');
  eq(updater.assetFor('nsis', {}), null);
});

test('updater: lee el sha512 del latest.yml del CI', () => {
  const yml = [
    'version: 2.3.0',
    'files:',
    '  - url: SAGITARI-Setup-2.3.0.exe',
    '    sha512: ABC123==',
    '    size: 117000000',
    'path: SAGITARI-Setup-2.3.0.exe',
    'sha512: ABC123==',
    'releaseDate: 2026-10-01',
  ].join('\n');
  const y = updater.parseLatestYml(yml);
  eq(y.version, '2.3.0');
  eq(y.sha512, 'ABC123==');
  eq(y.files.length, 1);
  eq(y.files[0].url, 'SAGITARI-Setup-2.3.0.exe');
  eq(y.files[0].sha512, 'ABC123==');
});

test('updater: detecta la actualización y descarta prereleases y errores', async () => {
  const fake = (rel) => async () => new Response(JSON.stringify(rel), { status: 200, headers: { 'content-type': 'application/json' } });
  let r = await updater.checkForUpdate({ currentVersion: '2.2.0', fetchFn: fake(RELEASE) });
  eq(r.ok, true);
  eq(r.available, true);
  eq(r.latest, '2.3.0');
  ok(r.assets.setup, 'trae los assets');
  r = await updater.checkForUpdate({ currentVersion: '2.3.0', fetchFn: fake(RELEASE) });
  eq(r.available, false, 'la misma versión no es una actualización');
  r = await updater.checkForUpdate({ currentVersion: '2.2.0', fetchFn: fake({ ...RELEASE, prerelease: true }) });
  eq(r.available, false, 'una prerelease no cuenta como actualización');
  r = await updater.checkForUpdate({ currentVersion: '2.2.0', fetchFn: async () => new Response('{}', { status: 404 }) });
  eq(r.ok, true);
  eq(r.available, false);
  ok(/sin releases/.test(r.error));
  r = await updater.checkForUpdate({
    currentVersion: '2.2.0',
    fetchFn: async () => {
      throw new Error('ENOTFOUND');
    },
  });
  eq(r.ok, false);
  ok(/ENOTFOUND/.test(r.error), 'un fallo de red se comunica, no se traga');
});

test('updater: descarga, informa del progreso y devuelve el sha512', async () => {
  const dir = tmpDir('sagi-upd-');
  const dest = path.join(dir, 'bin.exe');
  const chunks = ['abc', 'def'];
  const fetchFn = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const ch of chunks) c.enqueue(new Uint8Array(Buffer.from(ch)));
          c.close();
        },
      }),
      { status: 200, headers: { 'content-length': '6' } },
    );
  const ticks = [];
  const r = await updater.downloadTo('https://x/bin.exe', dest, { fetchFn, onProgress: (p) => ticks.push(p) });
  eq(fs.readFileSync(dest, 'utf8'), 'abcdef', 'el archivo llega completo');
  eq(r.bytes, 6);
  eq(r.sha512, require('crypto').createHash('sha512').update('abcdef').digest('base64'), 'el sha512 corresponde al contenido');
  ok(ticks.length >= 1 && typeof ticks[0].total === 'number', 'la descarga informa del progreso con su total');
  eq(fs.existsSync(dest + '.part'), false, 'no deja el .part tirado');
});

test('updater: una descarga cortada no deja un instalador a medias', async () => {
  const dir = tmpDir('sagi-upd2-');
  const dest = path.join(dir, 'bin.exe');
  const fetchFn = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(Buffer.from('ab')));
          c.error(new Error('corte de red'));
        },
      }),
      { status: 200 },
    );
  let fallo = false;
  try {
    await updater.downloadTo('https://x/bin.exe', dest, { fetchFn });
  } catch {
    fallo = true;
  }
  eq(fallo, true, 'el corte debe propagarse');
  eq(fs.existsSync(dest), false, 'no puede quedar un .exe incompleto en el destino');
  eq(fs.existsSync(dest + '.part'), false, 'ni el temporal');
});

test('updater: cada modo guarda el binario donde toca', () => {
  eq(updater.hostKind({ isPackaged: false }), 'dev');
  eq(updater.hostKind({ isPackaged: true, env: {} }), 'nsis');
  eq(updater.hostKind({ isPackaged: true, env: { PORTABLE_EXECUTABLE_DIR: 'C:/apps' } }), 'portable');
  const t = updater.downloadTarget({ kind: 'nsis', assetName: 'SAGITARI-Setup-2.3.0.exe' });
  ok(t.path.includes('sagitari-update'), 'los instaladores van a su carpeta temporal');
  const p = updater.downloadTarget({
    kind: 'portable',
    assetName: 'SAGITARI-Portable-2.3.0.exe',
    env: { PORTABLE_EXECUTABLE_DIR: 'C:/apps' },
  });
  eq(p.path, path.join('C:/apps', 'SAGITARI-Portable-2.3.0.exe'), 'el portable se deja junto al que se está ejecutando');
  const evil = updater.downloadTarget({ kind: 'nsis', assetName: '../../evil name.exe' });
  eq(path.basename(evil.path), '.._.._evil_name.exe', 'el nombre no puede escapar de la carpeta');
});

test('updater: el ayudante que instala espera a la app y no juega con comillas', () => {
  const installer = path.join('C:', 'Temp', "d'actualizacion & 100%", 'SAGITARI-Setup-3.2.1.exe');
  const logPath = path.join('C:', 'Temp', "d'actualizacion & 100%", 'instalar.log');
  const plan = updater.afterExitCommand({ name: 'SAGITARI', installer, logPath });
  /* `detached` NO es un detalle de estilo: es lo único que hace que el ayudante siga
     vivo cuando la app se cierre. Sin él, la instalación no llega a ejecutarse. */
  eq(plan.file, 'cmd.exe', 'el que se desliga es un cmd (PowerShell no arranca desligado)');
  ok(plan.args.includes('powershell.exe'), 'y es él quien sostiene al ayudante de PowerShell');
  ok(plan.args.includes('-EncodedCommand'), 'el guion viaja codificado: no hay comillas que escapar');
  ok(plan.args.includes('Hidden'), 'nada de ventanas (era el «abre una terminal y se cierra»)');
  eq(plan.spawnOpts.detached, true, 'DESLIGADO del árbol de procesos de la app');
  eq(plan.spawnOpts.windowsHide, true, 'y sin ventana');
  eq(Buffer.from(plan.encoded, 'base64').toString('utf16le'), plan.script, 'lo que se ejecuta es el guion tal cual');
  ok(plan.script.includes('ExitCode'), 'y el diario recoge el código con el que salió el instalador');
  ok(plan.script.includes('la app seguia en ejecucion'), 'y si la app seguía viva al lanzarlo, para poder diagnosticarlo');
  ok(
    plan.script.includes("'" + installer.replace(/'/g, "''") + "'"),
    'la ruta va como literal de PowerShell, con sus comillas simples dobladas',
  );
  ok(plan.script.includes("'SAGITARI'"), 'espera a que no quede ninguna instancia de la app');
  ok(plan.script.includes('Start-Process -FilePath'), 'y entonces lanza el instalador');
  ok(plan.script.includes("'/S','--updated'"), 'en silencio y como actualización, no como instalación nueva');
  ok(!/start ""/.test(plan.script), 'sin la línea de órdenes que rompía el lanzamiento');
});

test('updater: la vía tarea programa con schtasks y el guion lleva latido', async () => {
  // taskTimePlus: formato HH:mm y salto de día
  eq(updater.taskTimePlus(5, new Date(2026, 0, 1, 10, 30).getTime()), '10:35');
  eq(updater.taskTimePlus(5, new Date(2026, 0, 1, 23, 58).getTime()), '00:03', 'cruza la medianoche');
  ok(/^\d\d:\d\d$/.test(updater.taskTimePlus(5)), 'formato HH:mm');
  // la línea de la tarea: oculta, con bypass solo para nuestro guion, ruta entrecomillada
  const line = updater.taskRunLine('C:/dir con espacios/x.ps1');
  ok(line.includes('-ExecutionPolicy Bypass'), 'la política Restricted de la máquina no lo frena');
  ok(line.includes('-WindowStyle Hidden'), 'sin ventana');
  ok(line.includes('"C:/dir con espacios/x.ps1"'), 'la ruta con espacios va entrecomillada: ' + line);
  // create: sin shell, piezas separadas, /f para pisar restos de intentos viejos
  const argv = updater.scheduleCreateArgs({ taskName: 'T', psPath: 'C:/x.ps1', startTime: '01:00' });
  eq(argv[0], '/create');
  ok(argv.includes('/tn') && argv.includes('T') && argv.includes('/sc') && argv.includes('/f'), argv.join(' '));
  ok(!argv.some((a) => /&&|\|/.test(a)), 'nada que parezca shell');
  // programarInstalacion con exec falso: escribe el .ps1 y llama create+run
  const dir = tmpDir('sagi-tarea-');
  const llamadas = [];
  const execFn = async (cmd, a) => {
    llamadas.push(cmd + ' ' + a.join(' '));
    return { code: 0, stdout: 'OK', stderr: '' };
  };
  const r = await updater.programarInstalacion({
    dir,
    name: 'APP',
    installer: 'C:/i/setup.exe',
    args: '/S',
    logPath: path.join(dir, 'instalar.log'),
    taskName: 'TAREA-TEST',
    execFn,
  });
  eq(r.ok, true);
  eq(llamadas.length, 2, 'create y run, nada más: ' + JSON.stringify(llamadas));
  ok(/^schtasks \/create /.test(llamadas[0]) && /\/tn TAREA-TEST/.test(llamadas[0]), llamadas[0]);
  ok(/^schtasks \/run \/tn TAREA-TEST$/.test(llamadas[1]), llamadas[1]);
  const ps = fs.readFileSync(path.join(dir, 'sagitari-instalar.ps1'));
  ok(ps[0] === 0xef && ps[1] === 0xbb && ps[2] === 0xbf, 'BOM para que la 5.1 lea los acentos');
  const txt = ps.toString('utf8');
  ok(/latido/.test(txt) && /sigo esperando/.test(txt), 'el diario lleva latido cada ~10 s');
  ok(txt.includes("/delete /tn 'TAREA-TEST'"), 'la tarea de un solo uso se autoborra');
  // si /create falla, no se intenta /run y el motivo llega al usuario
  const bad = async () => ({ code: 1, stdout: '', stderr: 'acceso denegado' });
  let fallo = '';
  try {
    await updater.programarInstalacion({ dir: tmpDir('sagi-tarea2-'), name: 'A', installer: 'x', logPath: 'y', execFn: bad });
  } catch (e) {
    fallo = e.message;
  }
  ok(/no se pudo programar/.test(fallo) && /acceso denegado/.test(fallo), 'el motivo llega: ' + fallo);
});

test('updater: el ayudante lanza el instalador de verdad (integración)', async () => {
  if (process.platform !== 'win32') return; // el actualizador solo instala en Windows
  const { spawn } = require('child_process');
  const dir = tmpDir('sagi-ayudante-');
  const probe = path.join(dir, 'probe.bat');
  const argsFile = path.join(dir, 'args.txt');
  const log = path.join(dir, 'instalar.log');
  fs.writeFileSync(probe, '@echo off\r\necho %* > "' + argsFile + '"\r\n');
  // Un nombre de proceso que no existe: el ayudante no espera y lanza ya. Esto es
  // exactamente lo que antes no llegaba a pasar NUNCA (el señuelo no se ejecutaba).
  const plan = updater.afterExitCommand({
    name: 'SAGITARI-PROCESO-QUE-NO-EXISTE',
    installer: probe,
    args: '/S --updated',
    logPath: log,
    graceMs: 100,
  });
  const hijo = spawn(plan.file, plan.args, plan.spawnOpts);
  hijo.on('error', () => {});
  const esperar = async (f, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fs.existsSync(f)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };
  const esperarTexto = async (f, rx, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        if (rx.test(fs.readFileSync(f, 'utf8'))) return true;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  };
  ok(await esperar(argsFile, 25000), 'el instalador recibe la orden (antes no se ejecutaba nunca)');
  ok(/\/S --updated/.test(fs.readFileSync(argsFile, 'utf8')), 'llega en silencio y en modo actualización');
  ok(await esperar(log, 25000), 'el ayudante deja un registro de lo que hizo');
  ok(await esperarTexto(log, /instalador lanzado/, 20000), 'y el registro dice que lo lanzó');
  eq(fs.existsSync(path.join(dir, 'instalar.log.part')), false, 'sin restos a medias');
});

test('updater: el ayudante SOBREVIVE al cierre de ELECTRON (regresión: «se cierra y no instala»)', async () => {
  /* LA prueba que faltaba, y la razón de que el fallo viviera dos versiones: las
     demás lanzaban al ayudante desde un proceso que seguía vivo, así que nunca se
     ejercitaba el único caso que importa. Peor: la versión anterior de este test
     usaba un Node renombrado como padre, y un PowerShell hijo de un Node sobrevive
     igual que uno bien lanzado — medido, ese test pasaba con el diseño bueno y con el
     roto. Un test que no puede fallar por el fallo que dice guardar no guarda nada.

     Solo un ELECTRON REAL que se cierra lo reproduce: ahí el PowerShell directo
     escribe su primera línea y muere con la app (es el diario de los usuarios, letra
     por letra). Por eso el escenario vive en `scripts/verificar-actualizador.js`, que
     ejecuta también un CONTROL con ese diseño anterior y exige que NO instale: así el
     test se delata si algún día pierde los dientes. */
  if (process.platform !== 'win32') return;
  const { verificar } = require('../scripts/verificar-actualizador');
  const r = await verificar({ dir: tmpDir('sagi-supervivencia-'), pasadas: 1, conControl: true });
  if (r.estado === 'sin-electron') return; // sin binario no hay escenario que montar
  /* Y si el sistema operativo no deja montarlo, se dice y no se inventa un veredicto:
     en un sandbox de token restringido el Electron hijo no puede escribir en el
     directorio del escenario (EPERM) y no hay Programador de tareas, así que el
     ayudante podría ser perfecto y el padre seguiría sin poder dejar su rastro. En
     una máquina normal —y en CI— este `if` no se cumple nunca. */
  if (r.estado === 'entorno') {
    console.log('    (escenario saltado: ' + r.motivo + ')');
    return;
  }
  const p = r.pasadas[0];
  ok(p.arranco, 'el ayudante arranca ANTES de que la app se cierre (padre: ' + p.padre + ')');
  ok(p.ejecuto, 'y el instalador se ejecuta DESPUÉS de que la app haya salido (diario: ' + p.diario.slice(0, 220) + ')');
  ok(p.orden, 'con la orden de silencio, actualización y reapertura');
  ok(p.codigo0, 'y el diario recoge el código de salida del instalador');
  ok(
    r.controlRoto,
    'el CONTROL (PowerShell directo, el diseño que falló) NO debe instalar: si instala, este test no está midiendo el cierre real',
  );
});

test('updater: una instalación a medias se recuerda solo mientras sirva', () => {
  const p = { version: '3.2.1', path: 'C:/tmp/SAGITARI-Setup-3.2.1.exe', expected: 'abc', at: '2026-09-18T10:00:00Z' };
  const vivo = updater.pendingFor(p, '3.2.0');
  eq(vivo.version, '3.2.1', 'con la versión vieja en marcha, la instalación sigue pendiente');
  eq(vivo.path, p.path);
  eq(vivo.expected, 'abc');
  eq(updater.pendingFor(p, '3.2.1'), null, 'si ya se instaló, el aviso desaparece');
  eq(updater.pendingFor(p, '3.3.0'), null, 'y tampoco se ofrece una versión anterior a la instalada');
  eq(updater.pendingFor({ version: '3.2.1' }, '3.2.0'), null, 'sin ruta no hay nada que reintentar');
  eq(updater.pendingFor({ path: 'x' }, '3.2.0'), null, 'ni sin versión');
  eq(updater.pendingFor(null, '3.2.0'), null);
  eq(updater.pendingFor('basura', '3.2.0'), null);
});

test('updater: el motivo de no tener firma dice la verdad', () => {
  // El texto que ve el usuario cuando se descarta una descarga. Decía siempre «la
  // release no publica latest.yml» y en la 3.2.1 eso era mentira: el yml estaba,
  // solo que no firmaba el portable, así que no había forma de saber qué pasaba.
  eq(updater.motivoSinFirma({ tieneYml: true, assetName: 'x.exe', expected: 'abc' }), null, 'con firma no hay motivo');
  ok(
    /no publica latest\.yml$/.test(updater.motivoSinFirma({ tieneYml: false, assetName: 'SAGITARI-Portable-3.2.1.exe' })),
    'sin yml se dice que falta el manifiesto',
  );
  const sinEntrada = updater.motivoSinFirma({ tieneYml: true, assetName: 'SAGITARI-Portable-3.2.1.exe' });
  ok(
    /no publica la firma de SAGITARI-Portable-3\.2\.1\.exe/.test(sinEntrada),
    'si el yml está pero no firma ESTE archivo, se dice cuál: ' + sinEntrada,
  );
  ok(
    /no publica la firma de/.test(updater.motivoSinFirma({ tieneYml: true, assetName: 'x.exe' })),
    'y no se confunde con «la release no publica latest.yml»',
  );
  ok(
    /no se pudo leer/.test(updater.motivoSinFirma({ tieneYml: true, assetName: 'x.exe', error: 'timeout' })),
    'si el yml no se pudo leer, se dice eso, no que no exista',
  );
});

test('updater: latest.yml firma TODOS los binarios y el CI corta si falta alguno', () => {
  // Regresión de la 3.2.1: electron-builder solo firma el Setup, así que la edición
  // portable descargaba 110 MB, no encontraba su firma y los tiraba. Este es el
  // gate del workflow: con el portable sin firmar, la release no se publica.
  const { spawnSync } = require('child_process');
  const script = path.join(__dirname, '..', 'scripts', 'latest-yml.js');
  const dir = tmpDir('sagi-latest-yml-');
  const setup = 'SAGITARI-Setup-9.9.9.exe';
  const portable = 'SAGITARI-Portable-9.9.9.exe';
  for (const f of [setup, portable]) fs.writeFileSync(path.join(dir, f), 'binario falso de prueba: ' + f);
  const sha = (f) => updater.sha512Of(path.join(dir, f));
  const correr = (extra = []) =>
    spawnSync(process.execPath, [script, dir, ...extra], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  const escribirYml = (contenido) => fs.writeFileSync(path.join(dir, 'latest.yml'), contenido);
  const contenido = [
    'version: 9.9.9',
    'files:',
    '  - url: ' + setup,
    '    sha512: ' + sha(setup),
    '    size: ' + fs.statSync(path.join(dir, setup)).size,
    'path: ' + setup,
    'sha512: ' + sha(setup),
    "releaseDate: '2026-01-01T00:00:00.000Z'",
    '',
  ].join('\n');

  escribirYml(contenido);
  const antes = correr(['--check']);
  ok(antes.status !== 0, 'sin firma para el portable el gate no puede pasar');
  ok(/Portable/.test(antes.stderr), 'y el gate dice cuál falta: ' + antes.stderr);

  const hecho = correr();
  eq(hecho.status, 0, 'completar el manifiesto no puede fallar: ' + hecho.stderr);
  const yml = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8');
  const parsed = updater.parseLatestYml(yml);
  for (const f of [setup, portable]) {
    eq(updater.sha512For(parsed, f), sha(f), 'la firma publicada de ' + f + ' es la del binario, no la de otro');
  }
  eq(parsed.version, '9.9.9', 'la versión del manifiesto no se toca');
  eq(parsed.path, setup, 'el hash de nivel superior sigue siendo el del Setup');
  eq(parsed.sha512, sha(setup), 'y con el valor del Setup');
  ok(/releaseDate: '2026-01-01T00:00:00.000Z'/.test(yml), 'la fecha de la release se conserva');
  eq(correr(['--check']).status, 0, 'con todos firmados, el gate pasa');

  correr();
  eq(fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8'), yml, 'volver a ejecutarlo no cambia el fichero');

  escribirYml(yml.replace(sha(portable), 'ZmlybWEgcXVlIG5vIGVzIGxhIGRlbCBiaW5hcmlv'));
  const malo = correr(['--check']);
  ok(malo.status !== 0, 'una firma que no es la del binario tampoco puede publicarse');
  ok(/no es la del binario/.test(malo.stderr), 'y se explica: ' + malo.stderr);
  correr();
  eq(
    updater.sha512For(updater.parseLatestYml(fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8')), portable),
    sha(portable),
    'completar corrige también una firma equivocada',
  );
});

/* ---------- reparaciones: regresiones que no pueden volver ---------- */

test('skills: un id con .. o separadores no puede salir del almacén', async () => {
  const legitima = path.join(SKILLS_TMP, 'victima');
  fs.mkdirSync(legitima, { recursive: true });
  fs.writeFileSync(path.join(legitima, 'SKILL.md'), '---\nname: victima\ndescription: x\n---\ncuerpo');
  const venenos = ['.', '..', '../fuera', '..\\..\\fuera', 'a/b', 'a\\b', '', '   ', '...', 'SKILL.md/..'];
  for (const id of venenos) {
    for (const [nombre, fn] of [
      ['deleteSkill', skills.deleteSkill],
      ['setEnabled', (i) => skills.setEnabled(i, true)],
      ['writeSource', (i) => skills.writeSource(i, { repo: 'x/y' })],
    ]) {
      let lanzo = false;
      try {
        await fn(id);
      } catch {
        lanzo = true;
      }
      ok(lanzo, `${nombre}() debe rechazar ${JSON.stringify(id)}`);
    }
  }
  ok(fs.existsSync(path.join(legitima, 'SKILL.md')), 'las skills legítimas siguen intactas');
  ok(fs.existsSync(SKILLS_TMP), 'el almacén sigue existiendo');
});

test('skills: deleteSkill borra la indicada y solo esa', async () => {
  const borrame = path.join(SKILLS_TMP, 'borrame');
  fs.mkdirSync(borrame, { recursive: true });
  await skills.deleteSkill('borrame');
  eq(fs.existsSync(borrame), false, 'la skill indicada se borra');
  ok(fs.existsSync(path.join(SKILLS_TMP, 'victima')), 'las demás siguen ahí');
});

test('skills: los triggers son literales, no expresiones regulares del repo', async () => {
  // un trigger remoto tipo (a+)+$ congelaba el hilo principal (ReDoS)
  const t0 = Date.now();
  const hits = await skills.suggestSkillsFor('a'.repeat(40000));
  ok(Date.now() - t0 < 2000, 'el análisis no puede quedarse colgado');
  eq(hits.length, 0);
});

test('skills: createSkill avisa en vez de pisar una skill existente', async () => {
  const id = 'no-pisar-' + Date.now().toString(36);
  await skills.createSkill({ name: id, description: 'original', body: 'CONTENIDO-ORIGINAL' });
  let lanzo = false;
  try {
    await skills.createSkill({ name: id, description: 'nueva', body: 'CONTENIDO-NUEVO' });
  } catch {
    lanzo = true;
  }
  ok(lanzo, 'la segunda alta sobre el mismo id debe rechazarse');
  const md = fs.readFileSync(path.join(SKILLS_TMP, id, 'SKILL.md'), 'utf8');
  ok(md.includes('CONTENIDO-ORIGINAL'), 'el contenido original no puede perderse: ' + md);
  ok(!md.includes('CONTENIDO-NUEVO'), 'la segunda alta no puede escribir nada');
  await skills.deleteSkill(id);
});

test('skills: un SKILL.md con BOM o en UTF-16 se lista, no desaparece', async () => {
  const bom = path.join(SKILLS_TMP, 'skill-con-bom');
  fs.mkdirSync(bom, { recursive: true });
  fs.writeFileSync(
    path.join(bom, 'SKILL.md'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('---\nname: skill-con-bom\ndescription: Con BOM – acentos\n---\ncuerpo', 'utf8')]),
  );
  const u16 = path.join(SKILLS_TMP, 'skill-en-utf16');
  fs.mkdirSync(u16, { recursive: true });
  fs.writeFileSync(
    path.join(u16, 'SKILL.md'),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('---\nname: skill-en-utf16\ndescription: En UTF-16 – acentos\n---\ncuerpo', 'utf16le')]),
  );
  skills.invalidarIndice();
  const listado = await skills.listSkills();
  const sBom = listado.find((s) => s.id === 'skill-con-bom');
  const sU16 = listado.find((s) => s.id === 'skill-en-utf16');
  ok(sBom, 'la skill con BOM sigue en el listado');
  ok(sU16, 'la skill en UTF-16 sigue en el listado');
  eq(sBom.description, 'Con BOM – acentos', 'el BOM se descarta y los acentos se leen');
  eq(sU16.description, 'En UTF-16 – acentos', 'y el UTF-16 se decodifica de verdad, sin mojibake');
  await skills.deleteSkill('skill-con-bom');
  await skills.deleteSkill('skill-en-utf16');
});

test('skills-starter: la siembra es de una sola vez (una skill de serie borrada no vuelve)', () => {
  const vm = require('vm');
  const base = tmpDir('sagi-seed-');
  const origen = path.join(base, 'skills-starter');
  const perfil = path.join(base, 'perfil', 'skills');
  for (const n of ['skill-a', 'skill-b']) {
    fs.mkdirSync(path.join(origen, n), { recursive: true });
    fs.writeFileSync(path.join(origen, n, 'SKILL.md'), `---\nname: ${n}\ndescription: de serie\n---\ncuerpo`);
  }
  // una skill de serie puede traer piezas propias (referencias, scripts): la siembra
  // tiene que llevarse la carpeta entera, no solo el SKILL.md
  fs.mkdirSync(path.join(origen, 'skill-a', 'references'), { recursive: true });
  fs.writeFileSync(path.join(origen, 'skill-a', 'references', 'guia.md'), 'la guía');
  // seedStarterSkills vive en main.js y no está exportado: se extrae el cuerpo REAL
  // del fichero y se ejecuta con fs/path/config de mentira para probar su comportamiento.
  const i = MAIN_SRC.indexOf('function seedStarterSkills(');
  ok(i >= 0, 'seedStarterSkills debe existir en main.js');
  let nivel = 0;
  let fin = -1;
  for (let k = MAIN_SRC.indexOf('{', i); k < MAIN_SRC.length; k++) {
    if (MAIN_SRC[k] === '{') nivel++;
    else if (MAIN_SRC[k] === '}' && --nivel === 0) {
      fin = k + 1;
      break;
    }
  }
  const config = { migraciones: {} };
  let guardados = 0;
  const fn = vm.runInNewContext('(' + MAIN_SRC.slice(i, fin) + ')', {
    fs,
    path,
    console,
    __dirname: path.join(base, 'main'),
    skills: { skillsDir: () => perfil },
    config,
    saveConfig: () => {
      guardados++;
    },
  });
  fn(); // primer arranque
  ok(
    fs.existsSync(path.join(perfil, 'skill-a', 'SKILL.md')) && fs.existsSync(path.join(perfil, 'skill-b', 'SKILL.md')),
    'el primer arranque copia las skills incluidas',
  );
  eq(
    fs.readFileSync(path.join(perfil, 'skill-a', 'references', 'guia.md'), 'utf8'),
    'la guía',
    'y sus referencias viajan con ella (sin ellas el cuerpo no se puede seguir)',
  );
  eq(config.migraciones.skillsStarter, true, 'la siembra queda apuntada en la configuración');
  eq(guardados, 1, 'y se persiste una vez');
  fs.rmSync(path.join(perfil, 'skill-b'), { recursive: true, force: true }); // el usuario la borra desde Ajustes
  fn(); // siguiente arranque
  ok(!fs.existsSync(path.join(perfil, 'skill-b', 'SKILL.md')), 'la skill borrada no puede reaparecer al reiniciar');
  ok(fs.existsSync(path.join(perfil, 'skill-a', 'SKILL.md')), 'las demás siguen intactas');
  eq(guardados, 1, 'el segundo arranque no reescribe la configuración');
});

test('skills-starter: una skill de serie nueva llega una vez y, si se borra, no vuelve', () => {
  /* oil-ui no existía cuando se sembraron los perfiles actuales: si la siembra fuera
     solo la de la primera instalación, la skill no llegaría nunca a quien ya tiene la
     app. Se ofrece una vez y queda apuntada: el diálogo de borrado sigue diciendo la
     verdad, «no se puede deshacer». */
  const vm = require('vm');
  const base = tmpDir('sagi-seed-nueva-');
  const origen = path.join(base, 'skills-starter');
  const perfil = path.join(base, 'perfil', 'skills');
  fs.mkdirSync(path.join(origen, 'oil-ui', 'references'), { recursive: true });
  fs.writeFileSync(path.join(origen, 'oil-ui', 'SKILL.md'), '---\nname: oil-ui\ndescription: direcciones de diseño\n---\ncuerpo');
  fs.writeFileSync(path.join(origen, 'oil-ui', 'references', 'tools.md'), 'herramientas');

  const i = MAIN_SRC.indexOf('function seedStarterSkills(');
  ok(i >= 0, 'seedStarterSkills debe existir en main.js');
  let nivel = 0;
  let fin = -1;
  for (let k = MAIN_SRC.indexOf('{', i); k < MAIN_SRC.length; k++) {
    if (MAIN_SRC[k] === '{') nivel++;
    else if (MAIN_SRC[k] === '}' && --nivel === 0) {
      fin = k + 1;
      break;
    }
  }
  // perfil que YA pasó por la siembra inicial
  const config = { migraciones: { skillsStarter: true } };
  let guardados = 0;
  const fn = vm.runInNewContext('(' + MAIN_SRC.slice(i, fin) + ')', {
    fs,
    path,
    console,
    __dirname: path.join(base, 'main'),
    skills: { skillsDir: () => perfil },
    config,
    saveConfig: () => {
      guardados++;
    },
  });

  fn();
  ok(fs.existsSync(path.join(perfil, 'oil-ui', 'SKILL.md')), 'la skill nueva se instala en el perfil existente');
  eq(fs.readFileSync(path.join(perfil, 'oil-ui', 'references', 'tools.md'), 'utf8'), 'herramientas', 'con sus referencias');
  eq(config.migraciones.skillsStarterNuevas.join(','), 'oil-ui', 'y queda apuntada como ofrecida');
  eq(guardados, 1, 'se persiste una vez');

  fs.rmSync(path.join(perfil, 'oil-ui'), { recursive: true, force: true });
  fn();
  ok(!fs.existsSync(path.join(perfil, 'oil-ui', 'SKILL.md')), 'borrada, no reaparece al reiniciar');
  eq(guardados, 1, 'y no se reescribe la configuración');
});

test('arranque: el nombre de fábrica «Darío» se retira una sola vez (y no el que escribe el usuario)', () => {
  const vm = require('vm');
  // La reparación vive suelta dentro de app.whenReady (no es función): se extrae el cuerpo
  // REAL de main.js y se ejecuta con dobles de config/saveConfig/log, como la siembra de
  // skills. Probar el default `userName: ''` no bastaba: el que tiene el nombre guardado
  // en config.json es el que necesita esta migración.
  const inicio = 'if (!config.migraciones || !config.migraciones.nombreFabrica) {';
  const i = MAIN_SRC.indexOf(inicio);
  ok(i >= 0, 'la reparación del nombre de fábrica debe existir en main.js');
  let nivel = 0;
  let fin = -1;
  for (let k = MAIN_SRC.indexOf('{', i); k < MAIN_SRC.length; k++) {
    if (MAIN_SRC[k] === '{') nivel++;
    else if (MAIN_SRC[k] === '}' && --nivel === 0) {
      fin = k + 1;
      break;
    }
  }
  const reparar = (config, guardados) =>
    vm.runInNewContext('(function () {' + MAIN_SRC.slice(i, fin) + '})', {
      config,
      saveConfig: () => {
        guardados.n++;
      },
      log: { info: () => {}, warn: () => {} },
    });
  // (a) perfil que guardó el nombre de fábrica: se limpia y se apunta la migración
  const uno = { n: 0 };
  const a = { settings: { userName: 'Darío' }, migraciones: {} };
  reparar(a, uno)();
  eq(a.settings.userName, '', 'el nombre de fábrica no puede seguir dirigiéndose al usuario');
  eq(a.migraciones.nombreFabrica, true, 'queda apuntado para no repetirlo en cada arranque');
  eq(uno.n, 1, 'y se persiste una vez');
  // (b) a quien de verdad se llame así, la marca protege su nombre escrito a mano
  const dos = { n: 0 };
  const b = { settings: { userName: 'Darío' }, migraciones: { nombreFabrica: true } };
  reparar(b, dos)();
  eq(b.settings.userName, 'Darío', 'un «Darío» escrito después de la migración no se toca');
  eq(dos.n, 0, 'y no se reescribe la configuración');
});

test('permisos: la tabla de riesgo es única y no tiene claves muertas', () => {
  const { RISK, toolDefs } = require('../agent/tools');
  const { DEFAULT_RISK } = require('../agent/guardrails');
  eq(DEFAULT_RISK, RISK, 'guardrails debe consumir la MISMA tabla que declara tools.js');
  const nombres = toolDefs.map((d) => d.function.name);
  const sinNivel = nombres.filter((n) => !RISK[n]);
  eq(sinNivel.join(', '), '', 'toda herramienta debe declarar su nivel de riesgo');
  const muertas = Object.keys(RISK).filter((k) => !nombres.includes(k));
  eq(muertas.join(', '), '', 'la tabla no puede declarar herramientas que no existen');
});

test('permisos: leer el portapapeles y evaluar JS piden confirmación aunque el tool sea safe', () => {
  const g = new Guardrails({ permissions: { clipboard: 'safe', browser_control: 'safe' } });
  eq(g.decide('clipboard', { action: 'read' }).action, 'confirm', 'leer el portapapeles no es automático');
  eq(g.decide('clipboard', { action: 'read' }).sensitive, true);
  eq(g.decide('browser_control', { action: 'eval', expression: 'fetch("/x")' }).action, 'confirm', 'eval ejecuta JS en la página');
  eq(g.decide('browser_control', { action: 'profile', profile: 'work' }).action, 'confirm', 'cambiar de perfil cambia de sesiones');
  eq(g.decide('clipboard', { action: 'write', text: 'hola' }).action, 'allow', 'escribir en el portapapeles es inocuo');
});

test('permisos: el permiso propio de JavaScript gobierna al eval', () => {
  const expr = { action: 'eval', expression: '1+1' };
  // con la clave browser_eval fijada a mano, su nivel manda para action:'eval'
  eq(
    new Guardrails({ permissions: { browser_eval: 'safe' } }).decide('browser_control', expr).action,
    'allow',
    'permitir siempre de JavaScript deja pasar el eval',
  );
  eq(
    new Guardrails({ permissions: { browser_eval: 'confirm' } }).decide('browser_control', expr).action,
    'confirm',
    'preguntar antes sigue preguntando',
  );
  eq(
    new Guardrails({ permissions: { browser_eval: 'restricted' } }).decide('browser_control', expr).action,
    'deny',
    'bloqueado de JavaScript bloquea el eval',
  );
  // bloquear el navegador entero gana al permiso suelto de su JavaScript
  eq(
    new Guardrails({ permissions: { browser_control: 'restricted', browser_eval: 'safe' } }).decide('browser_control', expr).action,
    'deny',
    'bloquear el navegador bloquea también su JavaScript',
  );
  // sin la clave propia, el forzado de siempre no se mueve (test de arriba)
  const d = new Guardrails({ permissions: { browser_control: 'safe' } }).decide('browser_control', expr);
  eq(d.action, 'confirm');
  ok(d.sensitive, 'sin fijar, el eval sigue sensible');
  // el permiso propio es SOLO del eval: el resto de acciones siguen como estaban
  eq(
    new Guardrails({ permissions: { browser_eval: 'safe' } }).decide('browser_control', { action: 'profile', profile: 'work' }).action,
    'confirm',
    'cambiar de perfil no se aprovecha del permiso del JavaScript',
  );
});

test('permisos: un clic por índice se juzga con la etiqueta del inventario', () => {
  const g = new Guardrails({ permissions: { browser_control: 'safe' } });
  // el navegador resuelve la etiqueta y viaja como `_label` (agent.js)
  eq(
    g.decide('browser_control', { action: 'click_index', index: 3, _label: 'Aceptar cookies' }).action,
    'allow',
    'un clic inocuo sigue siendo automático si el usuario confía en el navegador',
  );
  eq(
    g.decide('browser_control', { action: 'click_index', index: 7, _label: 'Pagar ahora 49,90 €' }).action,
    'confirm',
    'comprar por índice también se confirma',
  );
  eq(g.decide('browser_control', { action: 'click_index', index: 7, _label: 'Eliminar cuenta' }).sensitive, true);
  eq(
    g.decide('browser_control', { action: 'click_index', index: 1 }).action,
    'confirm',
    'sin etiqueta no se sabe qué se pulsa: se pregunta',
  );
});

test('permisos: abrir una URL pide confirmación por defecto', () => {
  const g = new Guardrails();
  eq(g.decide('open_url', { url: 'https://github.com' }).action, 'confirm');
});

test('mcp: al reencender el interruptor global se reconecta por `enabled`, no por `autoStart`', () => {
  /* El arranque y `mcp:setGlobal` decidían por `autoStart`, un campo que ningún control
     del formulario escribe: quedaba en `false` para siempre y el catálogo MCP nacía
     vacío (los servidores se quedaban en 'idle'). El interruptor real es `enabled`; esta
     prueba ejercita el criterio por el router, no el campo muerto (ver main.js:1035 y
     main/ipc-mcp.js:99). */
  const { registerMcpIpc } = require('../main/ipc-mcp');
  const handlers = new Map();
  const encendidos = [];
  const config = {
    mcp: {
      enabled: false,
      servers: [
        { id: 'activo', enabled: true, autoStart: false, transport: 'stdio', command: 'node a.js' },
        { id: 'apagado', enabled: false, autoStart: true, transport: 'stdio', command: 'node b.js' },
      ],
    },
  };
  registerMcpIpc(
    { handle: (canal, fn) => handlers.set(canal, fn) },
    {
      config: () => config,
      wireMcp: () => ({ ensure: (id) => (encendidos.push(id), Promise.resolve({ ok: true })) }),
      persistConfig: () => ({ ok: true }),
      mcpState: () => ({ servers: [] }),
      mcpExport: () => ({}),
      setAgentPolicy: () => {},
      mcpConfig: require('../main/mcp-config'),
      serverSlug: (id) => id,
    },
  );
  eq(handlers.get('mcp:setGlobal')(null, true).ok, true);
  eq(
    encendidos.join(','),
    'activo',
    'se reconecta el enabled:true aunque autoStart sea false, y NO el enabled:false',
  );
});

test('mcp: las herramientas dinamicas entran en el catalogo sin tocar la tabla nativa', () => {
  const toolsMod = require('../agent/tools');
  const antes = toolsMod.toolDefs.length;
  const { RISK } = toolsMod;
  toolsMod.setDynamicToolProvider(() => [
    { type: 'function', function: { name: 'mcp__eco__echo', description: 'x', parameters: { type: 'object', properties: {} } } },
  ]);
  try {
    eq(toolsMod.allToolDefs().length, antes + 1, 'la dinamica se suma al catálogo nativo');
    ok(toolsMod.allToolDefs().some((d) => d.function.name === 'mcp__eco__echo'));
    eq(toolsMod.toolDefs.length, antes, 'la tabla nativa no se toca (es la que valida el test de niveles)');
    ok(!RISK['mcp__eco__echo'], 'y no se le inventa un nivel: sin override será confirm');
  } finally {
    toolsMod.setDynamicToolProvider(null);
  }
  eq(toolsMod.allToolDefs().length, antes, 'sin proveedor, el catálogo vuelve a ser el nativo');
});

test('permisos: el comodín de servidor MCP sube la confianza de todo un servidor', () => {
  const g = new Guardrails({ permissions: { 'mcp__github__*': 'safe' } });
  eq(g.levelFor('mcp__github__create_issue'), 'safe', 'el comodín del servidor vale para sus herramientas');
  eq(g.decide('mcp__github__create_issue', {}).action, 'allow');
  eq(g.decide('mcp__otro__x', {}).action, 'confirm', 'y solo para ese servidor');
  // el override exacto sigue ganando al comodín
  const g2 = new Guardrails({ permissions: { 'mcp__github__*': 'safe', mcp__github__borrar: 'restricted' } });
  eq(g2.decide('mcp__github__borrar', {}).action, 'deny');
  // y ninguna herramienta MCP entra en 'safe' por defecto
  eq(new Guardrails().decide('mcp__loquesea__x', {}).action, 'confirm');
});

test('permisos: la tarjeta de confirmación nombra el servidor y la herramienta', () => {
  ok(describeAction('mcp__github__create_issue', {}).includes('MCP'));
  const d = describeAction('mcp__github__create_issue', { _mcp: { serverName: 'GitHub', toolName: 'create_issue' } });
  ok(/GitHub/.test(d) && /create_issue/.test(d), 'con la etiqueta real: ' + d);
  ok(
    summarizeArgs('mcp__github__create_issue', { title: 'x', _mcp: { serverName: 'GitHub', toolName: 'create_issue' } }).includes('GitHub'),
  );
});

test('permisos: un _mcp inyectado no puede falsear la tarjeta de una herramienta nativa', () => {
  // el modelo —o contenido que el modelo lee— puede emitir `_mcp` en los argumentos
  const a = { path: 'C:/importante.txt', content: 'x', _mcp: { serverName: 'GitHub', toolName: 'create_issue' } };
  const d = describeAction('write_file', a);
  ok(/sobrescribir/i.test(d), 'la tarjeta dice lo que va a pasar de verdad: ' + d);
  ok(!/MCP/i.test(d), 'y no se cree una etiqueta en una herramienta nativa');
  const s = summarizeArgs('write_file', a);
  ok(/importante\.txt/.test(s), 'el resumen sigue mostrando la ruta: ' + s);
  // write_file tiene su propio caso en el switch, así que la fuga de la etiqueta
  // sólo se puede ver en una herramienta que cae en el `default` (read_file…)
  const d2 = describeAction('read_file', a);
  ok(!/MCP|GitHub/.test(d2), 'la rama por defecto tampoco se cree la etiqueta: ' + d2);
  const s2 = summarizeArgs('read_file', a);
  ok(/importante\.txt/.test(s2), 'ni el resumen se sustituye por la etiqueta: ' + s2);
});

test('seguridad: open_url solo acepta http(s), no manejadores del sistema', () => {
  const { openUrlAllowed } = require('../agent/executors');
  ok(openUrlAllowed('https://github.com/dario90vlc/sagitari'));
  ok(openUrlAllowed('http://localhost:3000/x'));
  ok(!openUrlAllowed('file:///C:/Windows/System32/calc.exe'), 'file: abriría un ejecutable local');
  ok(!openUrlAllowed('ms-msdt:/id PCWDiagnostic'), 'los manejadores de Windows no son URLs de navegador');
  ok(!openUrlAllowed('javascript:alert(1)'));
  ok(!openUrlAllowed(''));
  ok(!openUrlAllowed(undefined));
});

test('guardrails: esperar la confirmación no consume el límite de duración', async () => {
  /* Determinista a propósito: la pausa empieza antes de esperar y la espera es
     mucho mayor que el límite, así que el resultado no depende de la carga de la
     máquina (una versión anterior medía lapsos cortos y fallaba por ruido). */
  const g = new Guardrails({ guardrails: { maxDurationMs: 400, maxSteps: 0 } });
  g.beginRun();
  g.pauseClock(); // el usuario tiene la tarjeta en pantalla
  await new Promise((r) => setTimeout(r, 600)); // más que el límite entero
  g.resumeClock();
  ok(g.checkStep().ok, 'el tiempo esperando al usuario no es tiempo de ejecución');
});

test('health: el coste por modelo se acumula y llega al panel', () => {
  modelsMod.record('cost-test-model', { ok: true, tokens: { prompt_tokens: 1000, completion_tokens: 500 }, costUsd: 0.25 });
  modelsMod.record('cost-test-model', { ok: true, tokens: { prompt_tokens: 1000, completion_tokens: 500 }, costUsd: 0.25 });
  const s = modelsMod.summary().find((r) => r.model === 'cost-test-model');
  eq(s.costUsd, 0.5, 'el panel publicaba siempre 0.0000 porque record() nunca guardaba el coste');
});

test('apariencia: cada clase de punto que usa el JS existe en el CSS', () => {
  const app = readRenderer();
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  const usadas = new Set();
  // puntos de estado de tarea: { label: '…', cls: 'ok' } → class="dot ${st.cls}"
  for (const m of app.matchAll(/\{\s*label:\s*'[^']*',\s*cls:\s*'([\w-]+)'/g)) usadas.add(m[1]);
  // salud del modelo y color del feed: eligen la clase en un ternario
  for (const m of app.matchAll(/(?:const|let)\s+(?:health|color)\s*=\s*([^;]+);/g)) {
    for (const lit of m[1].matchAll(/'([a-z][\w-]*)'/g)) usadas.add(lit[1]);
  }
  for (const m of app.matchAll(/\bfeed\([^)]*,\s*'([\w-]+)'\s*\)/g)) usadas.add(m[1]);
  ok(usadas.size >= 3, 'deben detectarse las clases de estado (' + [...usadas].join(', ') + ')');
  // `.dot` no define fondo: una clase sin regla deja el punto invisible (pasó con mag/mg)
  for (const c of usadas) ok(css.includes('.dot.' + c), `falta la regla .dot.${c} en styles.css`);
});

test('holo con momentos: puertas numeradas y reloj del monitor', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const app = readRenderer();
  // las puertas NO enseñan números de atajo: solo el nombre (sin ::before numerado)
  ok(!/\.navitem\[data-view="\w+"\] \.nl::before/.test(css), 'las puertas no deben llevar números');
  ok(/\.navitem \.nl::before\s*\{\s*content:\s*none/.test(css), 'el ::before de puerta debe estar anulado');
  ok(html.includes('id="boardClock"'), 'el rail lleva su reloj de estación');
  ok(/function tickBoardClock\(\)/.test(app) && /setInterval\(tickBoardClock, 1000\)/.test(app), 'el reloj late cada segundo');
  /* HIG Liquid Glass: el vidrio vive SOLO en la capa funcional (sidebar,
     compositor, menús, sheets). El contenido (burbujas, tarjetas) son fills
     opacos: nada de backdrop-filter ni vidrio sobre vidrio. */
  const regla = (sel) => (css.match(new RegExp(sel + '\\s*\\{[^}]*\\}')) || [''])[0];
  for (const sel of ['\\.side', '\\.composer', '\\.modelmenu', '\\.csel-menu', '\\.skillmenu'])
    ok(/backdrop-filter/.test(regla(sel)), sel + ' es capa funcional y lleva vidrio');
  for (const sel of ['\\.bubble', '\\.tcard', '\\.fitem', '\\.ragent', '\\.modeseg'])
    ok(!/backdrop-filter/.test(regla(sel)), sel + ' es contenido y NO lleva vidrio');
  // la navegación flota con inset y los controles son cápsulas
  ok(/\.side\s*\{[^}]*margin:\s*12px/.test(css), 'el sidebar flota con inset');
  ok(/\.btn\s*\{[^}]*border-radius:\s*999px/.test(css), 'los botones son cápsulas');
  ok(/@keyframes pop-in/.test(css), 'los sheets nacen con muelle');
});

test('glass27: borde vivo, cáusticas y slider ultra claro ↔ tintado', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const app = readRenderer();
  /* El filo es la luz: un anillo de 1px DENTRO de la superficie, con el nivel en opacidad
     (el degradado se rasteriza una vez y el compositor solo mezcla) y multiplicado por la
     intensidad que eligió el usuario. Cada superficie lee SU nivel. */
  ok(
    /opacity:\s*calc\(var\(--rim[^)]*\)\s*\*\s*var\(--glow-str/.test(css),
    'el filo es el glow y su nivel escala con la intensidad del ajuste',
  );
  ok(/inset 0 0 0 1px rgba\(var\(--rim-rgb\)/.test(css), 'el filo es un anillo de 1px DENTRO de la superficie');
  ok(/--rim:\s*var\(--live-window\)/.test(css), 'la hairline de la ventana lee su nivel');
  ok(/--rim:\s*var\(--live-com\)/.test(css), 'el compositor lee el suyo');
  ok(/--rim:\s*var\(--live-side\)/.test(css), 'y el panel lateral el suyo');
  ok(/mask-image/.test(css), 'el recorrido del filo usa máscara para no asomar fuera de la superficie');
  /* El aura vieja no vuelve: halos girando, propiedades registradas y keyframes fuera. */
  ok(!/glowFlow|halo-[abc]|glowRing/.test(css), 'el aura de halos girando no vuelve');
  ok(!/@property --(giro|reach)\b/.test(css), 'ni las propiedades que la movían');
  ok(!/@keyframes (giro|reachLife|frame-bloom)/.test(css), 'ni sus keyframes');
  ok(!/offset-path/.test(css), 'el glow no recorre el marco (sigue prohibido)');
  ok(html.includes('class="filo'), 'el filo necesita su nodo en las superficies');
  // cáustica: borde oscurecido + highlight en el vidrio héroe
  const comp = (css.match(/\.composer\s*\{[^}]*\}/) || [''])[0];
  ok(/inset 2px 3px/.test(comp) && /inset -3px -5px/.test(comp), 'luz arriba-izquierda, sombra abajo-derecha');
  // slider de vidrio cableado de punta a punta
  ok(html.includes('id="glassTint"'), 'el slider existe en Ajustes');
  ok(/--glass/.test(css), 'el token --glass existe');
  ok(/\$\('#glassTint'\)\.oninput/.test(app) && /function glassTintLabel/.test(app), 'el slider está cableado');
  ok(/setProperty\('--glass'/.test(app), 'applyTheme vuelca --glass');
  ok(/glassTint: 1/.test(MAIN_SRC), 'default del vidrio en main');
});

test('integración: cada canal push del preload tiene remitente en main', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'main', 'preload.js'), 'utf8');
  // Fase 4: los send() viven repartidos entre main.js y los routers main/ipc-*.js.
  const main = MAIN_ALL;
  const canales = [...preload.matchAll(/\bon\('([^']+)'/g)].map((m) => m[1]);
  ok(canales.length >= 5, 'deben detectarse los canales push (' + canales.length + ')');
  const emisores = new Set([...main.matchAll(/send\('([^']+)'/g)].map((m) => m[1]));
  const sinEmisor = [...new Set(canales)].filter((c) => !emisores.has(c));
  eq(sinEmisor.join(', '), '', 'canales push que el renderer nunca recibiría');
  // Los push nuevos de la memoria v2 entran en la misma comprobación: si alguien
  // expone el puente sin empujarlo desde main, la vista se queda muda para siempre.
  for (const c of ['memory:nueva']) {
    ok(canales.includes(c), 'el preload debe suscribirse a ' + c);
    ok(emisores.has(c), 'main debe empujar ' + c);
  }
});

test('integración: los canales de la memoria v2 existen en preload y en main', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'main', 'preload.js'), 'utf8');
  const invocados = new Set([...preload.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]));
  const atendidos = new Set([...MAIN_ALL.matchAll(/handle\('([^']+)'/g)].map((m) => m[1]));
  const CANALES = [
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
  ];
  for (const canal of CANALES) {
    ok(invocados.has(canal), 'el preload debe invocar ' + canal);
    ok(atendidos.has(canal), 'main debe atender ' + canal);
  }
  // y cada canal llega al renderer con el puente que fija el contrato
  const PUENTES = [
    'memoryTrayList',
    'memoryTrayAccept',
    'memoryTrayDiscard',
    'memoryTrashList',
    'memoryTrashRestore',
    'memoryTrashEmpty',
    'memoryExport',
    'memoryWipe',
    'memoryRestoreBackup',
    'habitsForget',
  ];
  for (const puente of [...PUENTES, 'onMemoriaNueva']) {
    ok(new RegExp('\\b' + puente + '\\s*:').test(preload), 'falta el puente ' + puente);
  }
  // los nombres anteriores no se quedan como alias: un puente viejo y otro nuevo
  // harían lo mismo por dos caminos y la vista se cablearía al que no toca
  ok(!/\bmemoryRestore\s*:/.test(preload) && !/\bmemoryTray\s*:/.test(preload) && !/\bhabitsForgetArea\s*:/.test(preload));
});

test('memoria v2: el router IPC valida id y categoría antes de tocar el almacén', () => {
  const { registerMemoryIpc } = require('../main/ipc-memory');
  const handlers = new Map();
  const ipc = { handle: (canal, fn) => handlers.set(canal, fn) };
  const llamadas = [];
  const oyentes = [];
  let resets = 0;
  const propuesta = {
    id: 'p1',
    texto: 'El usuario se llama Darío',
    etiquetas: ['identidad'],
    origen: 'mensaje',
    motivo: 'identidad',
    origenTexto: 'me llamo Darío',
    creado: '2026-10-14T00:00:00.000Z',
  };
  const almacen = {
    list: () => [],
    trayList: () => [propuesta],
    trayAceptar: (id) => {
      llamadas.push('aceptar:' + id);
      return { ok: true, entrada: { id } };
    },
    trayDescartar: (id) => {
      llamadas.push('descartar:' + id);
      return { ok: true };
    },
    listTrash: () => [{ id: 'm1', text: 'algo olvidado', papelera: { fecha: '2026-09-01T00:00:00.000Z' } }],
    restore: (id) => {
      llamadas.push('restore:' + id);
      return { ok: true, entrada: { id } };
    },
    trashEmpty: () => ({ ok: true, borradas: 2 }),
    exportar: () => ({ version: 2, hechos: [] }),
    wipe: () => ({ ok: true, borradas: 3 }),
    restaurarCopia: () => ({ ok: true, restaurado: 2, origen: 'memory.json.bak-v1' }),
    on: (evento, cb) => oyentes.push({ evento, cb }),
  };
  const habits = {
    stats: () => ({}),
    reset: () => {
      resets++;
    },
    olvidar: (categoria) => {
      llamadas.push('olvidar:' + categoria);
      return { ok: true, borradas: categoria === 'todo' ? 9 : 1 };
    },
  };
  registerMemoryIpc(ipc, { memory: almacen, models: { summary: () => ({}) }, habits, getWin: () => null });

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
    ok(handlers.has(canal), 'debe registrarse ' + canal);
  }

  eq(handlers.get('memory:tray:list')().length, 1, 'la bandeja se lista tal cual');
  eq(handlers.get('memory:tray:accept')(null, { id: 'p1' }).ok, true);
  eq(handlers.get('memory:tray:discard')(null, { id: 'p2' }).ok, true);
  eq(llamadas.join(','), 'aceptar:p1,descartar:p2');
  eq(handlers.get('memory:tray:accept')(null, {}).error, 'id es obligatorio');
  eq(handlers.get('memory:tray:accept')(null, { id: '   ' }).error, 'id es obligatorio', 'un id en blanco no vale');
  eq(handlers.get('memory:tray:discard')().error, 'id es obligatorio', 'sin payload no revienta');
  eq(llamadas.join(','), 'aceptar:p1,descartar:p2', 'un id inválido no llega al almacén');

  eq(handlers.get('memory:trash:list')().length, 1);
  eq(handlers.get('memory:trash:restore')(null, { id: 'm1' }).ok, true);
  eq(handlers.get('memory:trash:restore')(null, {}).error, 'id es obligatorio');
  eq(handlers.get('memory:trash:empty')().borradas, 2);
  eq(handlers.get('memory:export')().version, 2);
  eq(handlers.get('memory:wipe')().borradas, 3);
  eq(resets, 1, '«olvídalo todo» borra también el perfil de hábitos (es lo que promete la confirmación)');
  const copia = handlers.get('memory:restore-backup')();
  eq(copia.restaurado, 2);
  eq(copia.origen, 'memory.json.bak-v1');

  eq(handlers.get('habits:forget')(null, { categoria: 'webs' }).borradas, 1);
  eq(handlers.get('habits:forget')(null, { categoria: 'aplicaciones' }).borradas, 1);
  eq(handlers.get('habits:forget')(null, { categoria: 'comandos' }).borradas, 1);
  eq(handlers.get('habits:forget')(null, { categoria: 'carpetas' }).borradas, 1);
  eq(handlers.get('habits:forget')(null, { categoria: 'inventada' }).ok, false, 'solo se olvidan categorías que existen');
  eq(handlers.get('habits:forget')(null, { categoria: 'apps' }).ok, false, 'la clave interna no vale: la app habla en español');
  eq(handlers.get('habits:forget')(null, {}).error, 'categoría no válida');
  eq(handlers.get('habits:forget')(null, { categoria: 'todo' }).borradas, 9);
  eq(
    llamadas.join(','),
    'aceptar:p1,descartar:p2,restore:m1,olvidar:webs,olvidar:aplicaciones,olvidar:comandos,olvidar:carpetas,olvidar:todo',
  );

  // el empuje: el almacén avisa, el router reenvía. Se suscribe una sola vez.
  eq(oyentes.length, 1, 'se suscribe una sola vez al aviso del almacén');
  eq(oyentes[0].evento, 'propuesta');
  oyentes[0].cb(propuesta); // sin ventana no debe reventar

  const enviados = [];
  const ventana = { isDestroyed: () => false, webContents: { send: (canal, dato) => enviados.push({ canal, dato }) } };
  registerMemoryIpc(ipc, { memory: almacen, models: { summary: () => ({}) }, habits, getWin: () => ventana });
  eq(oyentes.length, 2);
  oyentes[1].cb(propuesta);
  eq(enviados.length, 1, 'un aviso por propuesta');
  eq(enviados[0].canal, 'memory:nueva');
  eq(enviados[0].dato.texto, 'El usuario se llama Darío');
});

test('memoria v2: sin el almacén nuevo el canal responde con un aviso, no revienta', () => {
  const { registerMemoryIpc } = require('../main/ipc-memory');
  const handlers = new Map();
  const ipc = { handle: (canal, fn) => handlers.set(canal, fn) };
  // almacén anterior a v2: tiene list/add/remove, pero no bandeja, papelera, copia ni olvido
  registerMemoryIpc(ipc, { memory: { list: () => [] }, models: {}, habits: {}, getWin: () => null });
  const conId = new Set(['memory:tray:accept', 'memory:tray:discard', 'memory:trash:restore']);
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
  ]) {
    const r = conId.has(canal) ? handlers.get(canal)(null, { id: 'x' }) : handlers.get(canal)();
    eq(r.ok, false, canal + ' debe avisar en vez de reventar');
    eq(r.error, 'almacén no disponible', canal);
  }
  eq(handlers.get('habits:forget')(null, { categoria: 'todo' }).error, 'almacén no disponible');
});

test('memoria v2: si el almacén no se puede leer, el router lo dice en vez de fingir memoria vacía', () => {
  /* El defecto: memory:list devolvía SIEMPRE un array, así que un memory.json ilegible se
     veía en la vista como «Aún no sé nada de ti» (sin aviso, sin motivo y sin salida) y la
     siguiente escritura pisaba el fichero. Ahora el canal avisa y las operaciones que
     escribirían se rechazan. */
  const { registerMemoryIpc } = require('../main/ipc-memory');
  const handlers = new Map();
  const ipc = { handle: (canal, fn) => handlers.set(canal, fn) };
  const motivo = 'no se pudo leer memory.json: EBUSY';
  const bloqueado = { ok: false, error: motivo };
  let resets = 0;
  const roto = {
    list: () => [],
    estado: () => ({ ok: false, tipo: 'io', error: motivo }),
    add: () => null,
    update: () => bloqueado,
    remove: () => bloqueado,
    trayList: () => [],
    listTrash: () => [],
    trashEmpty: () => bloqueado,
    exportar: () => ({ version: 2, hechos: [] }),
    wipe: () => bloqueado,
    on: () => {},
  };
  registerMemoryIpc(ipc, {
    memory: roto,
    models: { summary: () => ({}) },
    habits: { stats: () => ({}), reset: () => resets++, olvidar: () => ({ ok: true }) },
    getWin: () => null,
  });

  let lanzo = null;
  try {
    handlers.get('memory:list')();
  } catch (e) {
    lanzo = e;
  }
  ok(lanzo && lanzo.message.includes(motivo), 'memory:list debe contar por qué: ' + (lanzo && lanzo.message));
  let lanzoTrash = null;
  try {
    handlers.get('memory:trash:list')();
  } catch (e) {
    lanzoTrash = e;
  }
  ok(lanzoTrash, 'la papelera del mismo fichero tampoco puede fingir que está vacía');

  eq(handlers.get('memory:add')(null, { text: 'algo' }).ok, false, 'no se acepta un hecho que no se puede guardar');
  eq(handlers.get('memory:add')(null, { text: 'algo' }).error, motivo);
  eq(handlers.get('memory:update')(null, { id: 'x', patch: {} }).ok, false);
  eq(handlers.get('memory:export')().ok, false, 'exportar no puede copiar un volcado que no se ha leído');
  eq(handlers.get('memory:export')().error, motivo);
  eq(handlers.get('memory:wipe')().ok, false, 'ni olvidarlo todo');
  eq(resets, 0, 'si no se han podido olvidar los hechos, el perfil de hábitos se queda como estaba');
});

test('habits: cada categoría real del perfil tiene su «olvidar» en español, y solo una', () => {
  /* Cada categoría que el perfil observa tiene que poder olvidarse desde la app, y
     ninguna etiqueta puede llevarse por delante la de al lado: si mañana se añade una
     categoría observada y no se traduce, aquí se ve en vez de que el usuario no pueda
     olvidarla (o de que un «olvidar webs» le borre los modos). */
  const sembrar = () => {
    habits.reset();
    habits.observe('tool', { name: 'read_file', args: { path: 'C:\\dev\\proyecto-x\\notas.md' } });
    habits.observe('tool', { name: 'open_app', args: { name: 'spotify.exe' } });
    habits.observe('tool', { name: 'run_command', args: { command: 'git status' } });
    habits.observe('tool', { name: 'browser_control', args: { url: 'https://github.com/ejemplo/mi-repo' } });
    habits.observe('mode', { mode: 'plan' });
    habits.observe('confirm', { approved: true });
    habits.observe('confirm', { approved: false });
  };
  const conDatos = () => {
    const s = habits.stats();
    return [
      s.tools.length && 'tools',
      s.apps.length && 'apps',
      s.commands.length && 'commands',
      s.folders.length && 'folders',
      s.sites.length && 'sites',
      Object.keys(s.modes || {}).length && 'modes',
      (s.confirms.approved || 0) + (s.confirms.denied || 0) && 'confirms',
    ].filter(Boolean);
  };

  sembrar();
  const reales = conDatos();
  eq(reales.length, 7, 'el perfil debe tener datos en las siete categorías reales: ' + reales.join(','));

  const cubiertos = new Map();
  for (const etiqueta of ['herramientas', 'aplicaciones', 'comandos', 'carpetas', 'webs', 'modos', 'permisos']) {
    sembrar();
    const antes = conDatos();
    const r = habits.olvidar(etiqueta);
    eq(r.ok, true, 'olvidar «' + etiqueta + '»: ' + JSON.stringify(r));
    const borradas = antes.filter((c) => !conDatos().includes(c));
    eq(borradas.length, 1, '«' + etiqueta + '» debe olvidar una sola categoría (olvidó: ' + borradas.join(',') + ')');
    ok(!cubiertos.has(borradas[0]), 'dos etiquetas olvidan la misma categoría real: ' + borradas[0]);
    cubiertos.set(borradas[0], etiqueta);
  }
  eq(reales.filter((c) => !cubiertos.has(c)).join(', '), '', 'categorías reales del perfil que la app no puede olvidar');

  sembrar();
  const todo = habits.olvidar('todo');
  eq(todo.ok, true, 'olvidar «todo»: ' + JSON.stringify(todo));
  eq(conDatos().join(','), '', '«todo» deja el perfil vacío');
  habits.reset();
});

test('memoria v2: la propuesta nueva del almacén llega al renderer como memory:nueva', () => {
  const { registerMemoryIpc } = require('../main/ipc-memory');
  // La bandeja del módulo compartido apuntaría al perfil real del usuario: se aísla.
  memory.__test._resetTray(path.join(tmpDir('sagi-tray-'), 'memory-tray.json'));
  const handlers = new Map();
  const ipc = { handle: (canal, fn) => handlers.set(canal, fn) };
  const enviados = [];
  const ventana = { isDestroyed: () => false, webContents: { send: (canal, dato) => enviados.push({ canal, dato }) } };
  registerMemoryIpc(ipc, { memory, models: modelsMod, habits, getWin: () => ventana });

  const nuevas = memory.trayProponer([
    { texto: 'El usuario se llama Darío', origenTexto: 'me llamo Darío', etiquetas: ['identidad'], motivo: 'identidad' },
  ]);
  eq(nuevas.length, 1, 'la propuesta entra en la bandeja');
  eq(enviados.length, 1, 'un aviso por propuesta');
  eq(enviados[0].canal, 'memory:nueva');
  eq(enviados[0].dato.id, nuevas[0].id, 'el aviso lleva la propuesta que acaba de entrar');
  eq(enviados[0].dato.texto, 'El usuario se llama Darío');

  // Una repetida no vuelve a avisar: el contador de «Recién aprendido» no baila.
  memory.trayProponer([{ texto: 'El usuario se llama Darío', origenTexto: 'me llamo Darío' }]);
  eq(enviados.length, 1, 'una propuesta repetida no avisa');

  // Y la vista la ve por el canal, con la forma que espera.
  const lista = handlers.get('memory:tray:list')();
  eq(lista.length, 1);
  eq(lista[0].texto, 'El usuario se llama Darío');
  memory.trayDescartar(lista[0].id);
});

test('updater: una descarga que deja de recibir datos se corta sola', async () => {
  const dir = tmpDir('sagi-upd3-');
  const dest = path.join(dir, 'bin.exe');
  // cuerpo que nunca entrega un chunk pero SÍ respeta la señal (como fetch real)
  const fetchFn = async (url, opts = {}) => ({
    ok: true,
    headers: { get: () => null },
    body: {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise((_, reject) => {
            const s = opts.signal;
            if (s) s.addEventListener('abort', () => reject(s.reason || new Error('abortado')), { once: true });
          }),
      }),
    },
  });
  let error = null;
  const t0 = Date.now();
  try {
    await updater.downloadTo('https://x/bin.exe', dest, { fetchFn, idleTimeoutMs: 60 });
  } catch (e) {
    error = e;
  }
  ok(error, 'debe rechazar en vez de esperar para siempre');
  ok(Date.now() - t0 < 3000, 'el vigilante de inactividad debe dispararse pronto');
  eq(fs.existsSync(dest + '.part'), false, 'no puede quedar un temporal a medias');
});

/* ---------- navegador y logs: cobertura que faltaba ---------- */

test('perfiles: cada nombre tiene su carpeta y la migración conserva los logins', () => {
  ok(profiles.profileDirFor('Mi Work!').startsWith(PROF_TMP), 'la carpeta vive en la base de perfiles');
  ok(profiles.profileId('mi perfil') !== profiles.profileId('mi_perfil'), 'nombres parecidos no colapsan');
  const legacy = profiles.legacyDirFor('trabajo');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'Cookies'), 'sesión guardada');
  const dir = profiles.ensureProfileDir('trabajo');
  eq(fs.readFileSync(path.join(dir, 'Cookies'), 'utf8'), 'sesión guardada', 'los logins sobreviven a la actualización');
  eq(fs.existsSync(legacy), false, 'la carpeta antigua se traslada, no se duplica');
});

test('perfiles: ensureProfileDir no pisa lo que ya había', () => {
  const a = profiles.ensureProfileDir('dos');
  fs.mkdirSync(a, { recursive: true }); // la carpeta la crea el navegador al arrancar
  fs.writeFileSync(path.join(a, 'Cookies'), 'x');
  eq(profiles.ensureProfileDir('dos'), a, 'misma carpeta en la segunda llamada');
  eq(fs.readFileSync(path.join(a, 'Cookies'), 'utf8'), 'x');
});

test('browser: el puerto CDP se recupera del perfil', () => {
  const b = new Browser();
  b.profileDir = tmpDir('sagi-prof-');
  const file = path.join(b.profileDir, 'DevToolsActivePort');
  eq(b._portFromProfile(), 0, 'sin fichero no hay puerto');
  fs.writeFileSync(file, 'abc\n/devtools/browser/x\n');
  eq(b._portFromProfile(), 0, 'contenido ilegible → 0');
  fs.writeFileSync(file, '70000\n');
  eq(b._portFromProfile(), 0, 'puerto fuera de rango → 0');
  fs.writeFileSync(file, '9333\n/devtools/browser/abc\n');
  eq(b._portFromProfile(), 9333, 'lee el puerto que dejó Chrome en el perfil');
});

test('browser: el huérfano se reconoce por su --user-data-dir (la tubería no deja puerto)', () => {
  const { __test } = require('../agent/browser');
  const { userDataDirDe, esNuestroPerfil, pidsPropios, psEscanerArgs, PS_ESCANER } = __test;
  const dir = 'C:\\Users\\Usuario\\AppData\\Roaming\\SagitariAI\\browser-profiles\\default-1a2b3c4';

  // El valor se extrae igual con comillas (ruta con espacios) que sin ellas.
  eq(userDataDirDe('--user-data-dir=' + dir + ' --no-first-run'), dir);
  eq(userDataDirDe('"chrome.exe" --remote-debugging-pipe --user-data-dir="' + dir + '"'), dir);

  // Es NUESTRO aunque la ruta cambie de caja (Windows no distingue mayúsculas)…
  ok(esNuestroPerfil('chrome.exe --user-data-dir=' + dir.toUpperCase(), dir), 'el mismo perfil en otra caja sigue siendo el nuestro');
  // …y NO lo son ni el Chrome del usuario, ni otro perfil de SAGITARI, ni un proceso sin el flag.
  eq(esNuestroPerfil('chrome.exe --user-data-dir=C:\\Users\\Usuario\\AppData\\Local\\Google\\Chrome\\User Data', dir), false, 'el perfil del usuario no se toca');
  eq(esNuestroPerfil('chrome.exe --user-data-dir=C:\\Users\\Usuario\\AppData\\Roaming\\SagitariAI\\browser-profiles\\trabajo-9z8y7x6', dir), false, 'otro perfil de SAGITARI no se toca');
  eq(esNuestroPerfil('chrome.exe --type=renderer', dir), false, 'sin --user-data-dir no es nuestro');

  // Del JSON del escáner solo salen los PIDs de nuestro perfil (lista u objeto suelto).
  const salida = JSON.stringify([
    { ProcessId: 111, CommandLine: 'chrome.exe --user-data-dir=' + dir },
    { ProcessId: 222, CommandLine: 'chrome.exe --user-data-dir=C:\\otro' },
    { ProcessId: 333, CommandLine: '"msedge.exe" --user-data-dir="' + dir + '"' },
    { ProcessId: 0, CommandLine: 'chrome.exe --user-data-dir=' + dir }, // PID inválido
  ]);
  eq(pidsPropios(salida, dir).join(','), '111,333');
  eq(pidsPropios(JSON.stringify({ ProcessId: 444, CommandLine: 'chrome --user-data-dir=' + dir }), dir).join(','), '444');
  eq(pidsPropios('esto no es json', dir).length, 0, 'una salida ilegible no mata a nadie');

  // El escáner va en -EncodedCommand (las comillas de child_process en Windows son frágiles
  // con rutas con espacios) y filtra por el flag, no por un puerto.
  const args = psEscanerArgs();
  eq(args[0], '-NoProfile');
  eq(args[2], '-EncodedCommand');
  const script = Buffer.from(args[3], 'base64').toString('utf16le');
  eq(script, PS_ESCANER, 'lo exportado es lo que se ejecuta');
  ok(script.includes('--user-data-dir'), 'filtra por --user-data-dir');
  ok(script.includes('Win32_Process'), 'enumera procesos de Windows');
});

test('browser: sin marcador de PID no se escanea ningún proceso', async () => {
  const b = new Browser();
  b.profileDir = tmpDir('sagi-prof6-');
  const pids = await b._pidsHuerfanos();
  eq(Array.isArray(pids) && pids.length, 0, 'sin marcador no hay nada que buscar (y no se lanza PowerShell)');
});

test('browser: el huérfano de nuestro perfil se mata antes de lanzar', async () => {
  const b = new Browser();
  b.profileDir = tmpDir('sagi-prof7-');
  const matados = [];
  b._matarArbol = (pid) => matados.push(pid);
  b._pidsHuerfanos = async () => [111, 222];
  await b._cerrarHuerfano();
  eq(matados.join(','), '111,222', 'mata el árbol de cada proceso huérfano de nuestro perfil');

  // Si el escáner no pudo determinar nada (null), no se mata a ciegas ni se pierde la marca.
  const marca = path.join(b.profileDir, 'sagitari-browser.pid');
  fs.writeFileSync(marca, '999');
  b._pidsHuerfanos = async () => null;
  await b._cerrarHuerfano();
  eq(matados.join(','), '111,222', 'sin veredicto no se mata nada más');
  ok(fs.existsSync(marca), 'y el marcador se conserva para el próximo intento');
});

test('browser: una acción desconocida no lanza un navegador', async () => {
  const b = new Browser();
  b.profileDir = tmpDir('sagi-prof2-');
  const r = await b.handle({ action: 'clik' }); // errata típica del modelo
  ok(/Acción desconocida/.test(r), 'debe rechazarla');
  eq(b.ws, null, 'sin abrir conexión');
  eq(b.browserPid, null, 'sin lanzar ningún proceso');
});

test('browser: el inventario pertenece a la ejecución que lo pidió', async () => {
  const b = new Browser();
  b.profileDir = tmpDir('sagi-prof4-');
  b._lastElements = [{ role: 'button', name: 'Pagar', fp: 'button||Pagar', css: 'button', x: 10, y: 20, w: 30, h: 10 }];
  b._invOwner = 'agente-A';
  const r = await b.clickIndex(0, 'sess', 'agente-B');
  ok(/otra ejecución/.test(r), 'la otra ejecución no puede clicar con coordenadas ajenas');
  eq(b._lastElements.length, 1, 'no se consumió el inventario del dueño');
  eq(b.labelForIndex(0), 'Pagar button', 'la etiqueta sirve para juzgar la acción');
  eq(b.labelForIndex(9), '', 'un índice inexistente no inventa etiqueta');
});

test('browser: las acciones se ejecutan de una en una', async () => {
  const b = new Browser();
  const order = [];
  b._handle = async (args) => {
    order.push('inicio' + args.n);
    await new Promise((r) => setTimeout(r, 20));
    if (args.n === 1) throw new Error('fallo simulado');
    order.push('fin' + args.n);
  };
  // dos agentes a la vez (chat + tarea de background) comparten el navegador: sus
  // acciones no pueden solaparse porque el estado de la pestaña es global
  const p1 = b.handle({ n: 1 }).catch((e) => 'error:' + e.message);
  const p2 = b.handle({ n: 2 });
  const p3 = b.handle({ n: 3 });
  eq(await p1, 'error:fallo simulado', 'el fallo llega a quien lo pidió');
  await Promise.all([p2, p3]);
  eq(order.join(' '), 'inicio1 inicio2 fin2 inicio3 fin3', 'cada acción termina antes de la siguiente, y un fallo no atasca la cola');
});

test('browser: cambiar de perfil olvida el estado del anterior', async () => {
  const b = new Browser();
  b.port = 9333;
  b.browserPid = 4242; // pid ficticio: no debe poder matarse después
  b.activeId = 'tab1';
  b._lastElements = [{ x: 1, y: 1 }];
  b._sessions.set('tab1', 's1');
  const r = await b.switchProfile('otro');
  ok(/perfil activo/.test(r), 'confirma el cambio');
  eq(b.port, 0, 'el puerto del perfil anterior no vale');
  eq(b.browserPid, null, 'ni su PID: Windows reutiliza los números');
  eq(b._lastElements, null, 'ni el inventario de la página anterior');
  eq(b._sessions.size, 0);
  ok(b.profileDir.startsWith(PROF_TMP), 'y el perfil nuevo usa su propia carpeta');
});

test('browser: cambiar de perfil mata el árbol antes de olvidar el PID', async () => {
  const b = new Browser();
  b.profileDir = tmpDir('sagi-prof8-');
  const matados = [];
  b._matarArbol = (pid) => matados.push(pid);
  b.send = async () => {}; // «Browser.close» atendido
  b.ws = { close() {} }; // hay tubería viva: el proceso es seguro el nuestro
  b.browserPid = 4242;
  await b.switchProfile('otro');
  eq(matados.join(','), '4242', 'no se descarta el PID sin matar el proceso del perfil abandonado');
  eq(b.browserPid, null);

  // Sin socket no se dispara a un PID «a ciegas»: Windows reutiliza los números.
  const b2 = new Browser();
  b2.profileDir = tmpDir('sagi-prof9-');
  const m2 = [];
  b2._matarArbol = (pid) => m2.push(pid);
  b2.browserPid = 4242;
  b2._pidsHuerfanos = async () => [];
  await b2.switchProfile('otro');
  eq(m2.length, 0, 'sin socket no se mata por PID');
});

test('browser: kill deja el estado limpio y se puede repetir', () => {
  const b = new Browser();
  b.profileDir = tmpDir('sagi-prof3-');
  b.port = 9333;
  b.activeId = 'tab1';
  b._sessions.set('tab1', 's1');
  b.kill();
  eq(b.ws, null);
  eq(b.activeId, null);
  eq(b._sessions.size, 0);
  b.kill(); // sin navegador abierto no puede lanzar ningún taskkill
});

test('browser: un lanzamiento que no responde mata el proceso recién creado', async () => {
  const b = new Browser();
  b.profileDir = tmpDir('sagi-prof5-');
  b._exeDe = async () => 'C:\\fake\\chrome.exe';
  let matado = null;
  b._lanzarProceso = (exe, args) => {
    b.browserPid = 99999;
    b.toBrowser = { write() {}, end() {} };
    b.fromBrowser = { on() {}, destroy() {} };
    b.child = { on() {} };
    b.ws = { to: b.toBrowser, from: b.fromBrowser, close() {} };
    return b.child;
  };
  b._esperarPuerto = async () => false;
  b._matarArbol = (pid) => {
    matado = pid;
  };
  const r = await b.launch('chrome');
  ok(/no respondió/.test(r), 'devuelve error si no responde: ' + r);
  eq(matado, 99999, 'mata el proceso recién creado antes de devolver el error');
  eq(b.browserPid, null, 'y deja el pid limpio');
  eq(b.ws, null, 'y la conexión también');
});

test('runlog: escribe, se lee y rota por bytes reales', async () => {
  const dir = tmpDir('sagi-logs-');
  runlog.__test._resetForTests({ dir, maxBytes: 400, maxLogs: 3 });
  let streams = 0;
  const abrir = fs.createWriteStream;
  fs.createWriteStream = (...a) => {
    streams++;
    return abrir(...a);
  };
  for (let i = 0; i < 200; i++) runlog.log({ agent: 'test', event: 'e', text: 'ñ'.repeat(60) + i });
  fs.createWriteStream = abrir;
  runlog.close();
  ok(streams > 1, 'el tope por archivo fuerza rotación (' + streams + ' ficheros abiertos)');
  /* La poda corre en segundo plano y REINTENTA. En Windows `unlinkSync` falla con
     EBUSY/EPERM mientras el handle del stream anterior se cierra; en un runner
     lento eso dura más de lo que aguantaban los reintentos y la carpeta se quedaba
     muy por encima del tope (pasó: 61-70 ficheros). Se simula ese bloqueo durante
     2 s, que es más que los ~1 s que había y menos que el margen real (10 s): con
     el arreglo retirado esta prueba falla. Se espera a que converja en vez de
     mirar el reloj: lo que se comprueba es el TOPE. */
  const unlinkReal = fs.unlinkSync;
  const finBloqueo = Date.now() + 2000;
  fs.unlinkSync = (...a) => {
    if (Date.now() < finBloqueo) {
      const e = new Error('EBUSY: resource busy or locked');
      e.code = 'EBUSY';
      throw e;
    }
    return unlinkReal(...a);
  };
  let files = [];
  let vistoPico = false;
  try {
    for (let i = 0; i < 120; i++) {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      if (files.length > 3) vistoPico = true;
      /* Hay que ver el PICO antes de dar la convergencia por buena: los write
         streams crean los ficheros de forma asíncrona, así que una lectura
         inmediata ve solo el activo y «pasaría» sin que la poda haya corrido. */
      if (vistoPico && files.length <= 3) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    fs.unlinkSync = unlinkReal;
  }
  ok(files.length <= 3, 'no se conservan más ficheros de los permitidos (' + files.length + ')');
  /* El tope es de BYTES: contando caracteres UTF-16 cada línea de 60 «ñ» pesa la
     mitad de lo que ocupa en disco, así que el fichero se pasaba del tope al
     doble. Aquí cada línea son ~190 bytes y el tope 400. */
  for (const f of files) {
    const bytes = fs.statSync(path.join(dir, f)).size;
    ok(bytes <= 600, f + ' ocupa ' + bytes + ' bytes y el tope es 400');
  }
  /* Cada línea tiene que ser un evento completo: una rotación a mitad de línea
     dejaría JSON partido (y el tope se cumple sin cortar nada). */
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
    ok(lines.length > 0, f + ' no puede quedar vacío');
    for (const l of lines) eq(JSON.parse(l).agent, 'test', 'línea completa en ' + f);
  }
  const recent = runlog.readRecent(3);
  ok(recent.length === 3, 'readRecent devuelve los últimos eventos');
  ok(
    recent.every((e) => e.agent === 'test' && e.ts),
    'cada evento con su origen y su marca de tiempo',
  );
  ok(/^run-\d+(-\d+)?\.jsonl$/.test(path.basename(runlog.currentLogFile() || '')), 'el fichero de sesión se nombra run-<ts>.jsonl');
  runlog.__test._resetForTests({});
});

/* ---------- .gitignore anclado, adjuntos cortos, stderr de MCP y traza cortada ---------- */

test('índice: un patrón anclado del .gitignore («/secrets») sí ignora', () => {
  const indice = require('../agent/indice');
  const ws = tmpDir('sagi-ignore-');
  fs.writeFileSync(path.join(ws, '.gitignore'), '/secrets\nnode_modules\n*.log\n');
  fs.mkdirSync(path.join(ws, 'secrets'));
  fs.writeFileSync(path.join(ws, 'secrets', 'key.env'), 'TOKEN=1');
  fs.mkdirSync(path.join(ws, 'node_modules'));
  fs.writeFileSync(path.join(ws, 'node_modules', 'x.js'), 'x');
  fs.writeFileSync(path.join(ws, 'debug.log'), 'x');
  fs.writeFileSync(path.join(ws, 'main.js'), 'x');
  const reglas = indice.reglasIgnoradas(ws);
  ok(indice.ignoradoPorRegla('secrets/key.env', reglas), 'la barra inicial no puede dejar el patrón inerte: ' + reglas.join(','));
  const rutas = indice.recorrer(ws).archivos.map((a) => a.ruta);
  ok(!rutas.includes('secrets/key.env'), 'y el recorrido no indexa el secreto: ' + rutas.join(','));
  ok(rutas.includes('main.js'), 'sin pasarse: el archivo normal sigue en el índice');
});

/* El ancla es de la RAÍZ (como en git): «/secrets» no tapa «sub/secrets», y un patrón con
   carpeta («src/build») tampoco casa a mitad de camino. Antes ambos se ignoraban de más. */
test('índice: el ancla del .gitignore vale para la raíz, no para cualquier profundidad', () => {
  const indice = require('../agent/indice');
  const ws = tmpDir('sagi-ignore-ancla-');
  fs.writeFileSync(path.join(ws, '.gitignore'), '/secrets\nsrc/build\n*.log\n');
  const reglas = indice.reglasIgnoradas(ws);
  ok(indice.ignoradoPorRegla('secrets/key.env', reglas), 'la carpeta anclada sí se ignora en la raíz');
  ok(!indice.ignoradoPorRegla('sub/secrets/key.env', reglas), 'pero no en una subcarpeta: ' + reglas.join(','));
  ok(indice.ignoradoPorRegla('src/build/out.js', reglas), 'una ruta con carpeta se ata a la raíz');
  ok(!indice.ignoradoPorRegla('lib/src/build/out.js', reglas), 'y no casa a mitad de camino');
  const sinAncla = indice.reglasIgnoradas(path.join(ws, 'no-existe'));
  eq(sinAncla.length, 0, 'sin .gitignore no hay reglas');
});

test('adjuntos: un texto corto no se confunde con binario', () => {
  const attach = require('../main/attachments');
  eq(attach.textOf(Buffer.from('hola mundo', 'utf8'), 'a.txt'), 'hola mundo', 'un adjunto de 10 caracteres tiene que llegar al modelo');
  eq(attach.textOf(Buffer.from('notas\n', 'utf8'), 'a.md'), 'notas');
  eq(attach.textOf(Buffer.alloc(400, 0x01), 'a.txt'), null, 'los textos largos siguen exigiendo mayoría imprimible');
  eq(attach.textOf(Buffer.from('\x01\x01\x01\x01\x01\x01\x01\x01\x01\x01', 'utf8'), 'a.txt'), null, 'y un binario corto sigue siendo binario');
});

test('mcp: el stderr del servidor viaja enmascarado hacia la vista', () => {
  const j = MAIN_SRC.indexOf('function mcpState()');
  ok(j > -1, 'main tiene que exponer el estado de los servidores');
  const bloque = MAIN_SRC.slice(j, MAIN_SRC.indexOf('function mcpExport', j));
  const linea = bloque.split('\n').find((l) => /logTail:/.test(l)) || '';
  ok(/redactText\(v\.logTail/.test(linea), 'el stderr crudo no puede llegar al renderer: ' + linea.trim());
  const runlog = require('../agent/runlog');
  ok(!runlog.redactText('Authorization: Bearer sk-abc123456').includes('sk-abc123456'), 'y usa la misma máscara que el log');
});

test('traza: un turno con más texto del que cabe se marca como cortado', () => {
  const traza = require('../main/traza');
  const conv = 'traza-cortada-' + Date.now().toString(36);
  traza.trazaNueva(conv);
  traza.trazaApunta(conv, { type: 'delta', text: 'x'.repeat(traza.MAX_TEXTO_PARTE + 1) });
  const t = traza.trazaActual(conv);
  eq(t.cortado, true, 'el rastro no puede fingir que `parts` está completo');
  eq(JSON.parse(JSON.stringify(t)).cortado, true, 'la marca tiene que viajar al historial guardado');
  traza.trazaCerrar(conv);

  const corto = 'traza-corta-' + Date.now().toString(36);
  traza.trazaNueva(corto);
  traza.trazaApunta(corto, { type: 'delta', text: 'x'.repeat(100) });
  eq(traza.trazaActual(corto).cortado, undefined, 'un turno que cabe entero no lleva la marca');
  traza.trazaCerrar(corto);
});

/* ---------- cierre de la auditoría: estrellas, miniatura y SSE de MCP ---------- */

test('mercado: un contador de estrellas que no es número no llega como HTML', async () => {
  /* `stargazers_count` venía tal cual de la API y se pintaba en Ajustes ▸ Skills con
     innerHTML: una respuesta corrupta o un proxy podían colar una etiqueta. */
  const market = require('../agent/marketplace');
  const fetchPrevio = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      items: [
        { full_name: 'a/b', name: 'b', description: 'x', stargazers_count: '<img src=x onerror=alert(1)>', html_url: 'https://ejemplo' },
      ],
    }),
  });
  try {
    const [r] = await market.searchGitHub('x');
    eq(r.stars, 0, 'se normaliza a número: ' + JSON.stringify(r.stars));
  } finally {
    global.fetch = fetchPrevio;
  }
});

test('chat: la miniatura se mide por el lado mayor y por los bytes, no solo por el ancho', () => {
  /* Una captura de 320×20000 px pasaba el atajo «ya es pequeña» y se guardaba entera en
     conversations.json (que se reescribe en cada turno y se relee al arrancar). */
  const { tamanoMiniatura } = require('../main/ipc-chat');
  eq(tamanoMiniatura({ width: 320, height: 200 }, 50 * 1024), null, 'una imagen que ya cabe no se toca');
  eq(JSON.stringify(tamanoMiniatura({ width: 1000, height: 500 }, 10)), JSON.stringify({ width: 320, height: 160 }), 'se reduce por la proporción');
  eq(JSON.stringify(tamanoMiniatura({ width: 320, height: 20000 }, 6 * 1024 * 1024)), JSON.stringify({ width: 8, height: 480 }), 'una captura larguísima se reduce por el alto');
  ok(tamanoMiniatura({ width: 320, height: 200 }, 5 * 1024 * 1024), 'aunque quepa en píxeles, si pesa se reduce');
  eq(tamanoMiniatura({ width: 0, height: 0 }, 10), null, 'sin tamaño no hay nada que calcular');
});

test('mcp: un stream SSE que no se cierra no deja la petición esperando al timeout', async () => {
  /* La spec permite que el servidor conteste y deje el stream abierto. Antes se leía hasta
     el cierre, así que una respuesta correcta acababa en «timeout: tools/call no respondió». */
  const { createHttpTransport } = require('../agent/mcp-transport');
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n'));
      // y NO se cierra
    },
  });
  const t = createHttpTransport({
    url: 'https://ejemplo.invalid/mcp',
    fetchFn: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    defaultTimeoutMs: 4000,
  });
  try {
    const r = await Promise.race([
      t.rpc.request('tools/call', {}),
      new Promise((_, rej) => setTimeout(() => rej(new Error('el stream abierto dejó la petición esperando')), 1500)),
    ]);
    eq(r && r.ok, true, 'la respuesta llega aunque el servidor no cierre el stream');
  } finally {
    t.kill();
  }
});
