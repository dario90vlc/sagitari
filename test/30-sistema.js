'use strict';
/* Suite SAGITARI — actualizador, reparaciones, navegador y logs (antes run.js 2764-3452).
   Registra tests en la cola de ./comun; run.js carga los bloques en orden. */
const { fs, path, tmpDir, test, eq, ok, Guardrails, describeAction, summarizeArgs, skills, memory, modelsMod, SKILLS_TMP, spawnSync, MAIN_SRC, MAIN_ALL, updater, Browser, profiles, runlog, PROF_TMP, readRenderer, RENDERER_JS } = require('./comun');


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
  tag_name: 'v2.3.0', name: '2.3.0', draft: false, prerelease: false,
  html_url: 'https://github.com/dario90vlc/sagitari/releases/tag/v2.3.0',
  published_at: '2026-10-01T10:00:00Z', body: 'Notas de la versión',
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
  const yml = ['version: 2.3.0', 'files:', '  - url: SAGITARI-Setup-2.3.0.exe', '    sha512: ABC123==', '    size: 117000000', 'path: SAGITARI-Setup-2.3.0.exe', 'sha512: ABC123==', 'releaseDate: 2026-10-01'].join('\n');
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
  eq(r.ok, true); eq(r.available, true); eq(r.latest, '2.3.0'); ok(r.assets.setup, 'trae los assets');
  r = await updater.checkForUpdate({ currentVersion: '2.3.0', fetchFn: fake(RELEASE) });
  eq(r.available, false, 'la misma versión no es una actualización');
  r = await updater.checkForUpdate({ currentVersion: '2.2.0', fetchFn: fake({ ...RELEASE, prerelease: true }) });
  eq(r.available, false, 'una prerelease no cuenta como actualización');
  r = await updater.checkForUpdate({ currentVersion: '2.2.0', fetchFn: async () => new Response('{}', { status: 404 }) });
  eq(r.ok, true); eq(r.available, false); ok(/sin releases/.test(r.error));
  r = await updater.checkForUpdate({ currentVersion: '2.2.0', fetchFn: async () => { throw new Error('ENOTFOUND'); } });
  eq(r.ok, false); ok(/ENOTFOUND/.test(r.error), 'un fallo de red se comunica, no se traga');
});

test('updater: descarga, informa del progreso y devuelve el sha512', async () => {
  const dir = tmpDir('sagi-upd-');
  const dest = path.join(dir, 'bin.exe');
  const chunks = ['abc', 'def'];
  const fetchFn = async () => new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(new Uint8Array(Buffer.from(ch))); c.close(); } }), { status: 200, headers: { 'content-length': '6' } });
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
  const fetchFn = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(Buffer.from('ab'))); c.error(new Error('corte de red')); } }), { status: 200 });
  let fallo = false;
  try { await updater.downloadTo('https://x/bin.exe', dest, { fetchFn }); } catch { fallo = true; }
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
  const p = updater.downloadTarget({ kind: 'portable', assetName: 'SAGITARI-Portable-2.3.0.exe', env: { PORTABLE_EXECUTABLE_DIR: 'C:/apps' } });
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
  ok(plan.script.includes("'" + installer.replace(/'/g, "''") + "'"), 'la ruta va como literal de PowerShell, con sus comillas simples dobladas');
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
  ok(!argv.some(a => /&&|\|/.test(a)), 'nada que parezca shell');
  // programarInstalacion con exec falso: escribe el .ps1 y llama create+run
  const dir = tmpDir('sagi-tarea-');
  const llamadas = [];
  const execFn = async (cmd, a) => { llamadas.push(cmd + ' ' + a.join(' ')); return { code: 0, stdout: 'OK', stderr: '' }; };
  const r = await updater.programarInstalacion({ dir, name: 'APP', installer: 'C:/i/setup.exe', args: '/S', logPath: path.join(dir, 'instalar.log'), taskName: 'TAREA-TEST', execFn });
  eq(r.ok, true);
  eq(llamadas.length, 2, 'create y run, nada más: ' + JSON.stringify(llamadas));
  ok(/^schtasks \/create /.test(llamadas[0]) && /\/tn TAREA-TEST/.test(llamadas[0]), llamadas[0]);
  ok(/^schtasks \/run \/tn TAREA-TEST$/.test(llamadas[1]), llamadas[1]);
  const ps = fs.readFileSync(path.join(dir, 'sagitari-instalar.ps1'));
  ok(ps[0] === 0xEF && ps[1] === 0xBB && ps[2] === 0xBF, 'BOM para que la 5.1 lea los acentos');
  const txt = ps.toString('utf8');
  ok(/latido/.test(txt) && /sigo esperando/.test(txt), 'el diario lleva latido cada ~10 s');
  ok(txt.includes("/delete /tn 'TAREA-TEST'"), 'la tarea de un solo uso se autoborra');
  // si /create falla, no se intenta /run y el motivo llega al usuario
  const bad = async () => ({ code: 1, stdout: '', stderr: 'acceso denegado' });
  let fallo = '';
  try { await updater.programarInstalacion({ dir: tmpDir('sagi-tarea2-'), name: 'A', installer: 'x', logPath: 'y', execFn: bad }); } catch (e) { fallo = e.message; }
  ok(/no se pudo programar/.test(fallo) && /acceso denegado/.test(fallo), 'el motivo llega: ' + fallo);
});

test('updater: el ayudante lanza el instalador de verdad (integración)', async () => {
  if (process.platform !== 'win32') return;   // el actualizador solo instala en Windows
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
    installer: probe, args: '/S --updated', logPath: log, graceMs: 100,
  });
  const hijo = spawn(plan.file, plan.args, plan.spawnOpts);
  hijo.on('error', () => {});
  const esperar = async (f, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fs.existsSync(f)) return true; await new Promise((r) => setTimeout(r, 250)); }
    return false;
  };
  const esperarTexto = async (f, rx, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (rx.test(fs.readFileSync(f, 'utf8'))) return true; } catch {}
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
  if (r.estado === 'sin-electron') return;   // sin binario no hay escenario que montar
  const p = r.pasadas[0];
  ok(p.arranco, 'el ayudante arranca ANTES de que la app se cierre (padre: ' + p.padre + ')');
  ok(p.ejecuto, 'y el instalador se ejecuta DESPUÉS de que la app haya salido (diario: ' + p.diario.slice(0, 220) + ')');
  ok(p.orden, 'con la orden de silencio, actualización y reapertura');
  ok(p.codigo0, 'y el diario recoge el código de salida del instalador');
  ok(r.controlRoto, 'el CONTROL (PowerShell directo, el diseño que falló) NO debe instalar: si instala, este test no está midiendo el cierre real');
});

test('updater: una instalación a medias se recuerda solo mientras sirva', () => {
  const p = { version: '3.2.1', path: 'C:/tmp/SAGITARI-Setup-3.2.1.exe', expected: 'abc', at: '2026-09-18T10:00:00Z' };
  const vivo = updater.pendingFor(p, '3.2.0');
  eq(vivo.version, '3.2.1', 'con la versión vieja en marcha, la instalación sigue pendiente');
  eq(vivo.path, p.path); eq(vivo.expected, 'abc');
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
  ok(/no publica latest\.yml$/.test(updater.motivoSinFirma({ tieneYml: false, assetName: 'SAGITARI-Portable-3.2.1.exe' })),
    'sin yml se dice que falta el manifiesto');
  const sinEntrada = updater.motivoSinFirma({ tieneYml: true, assetName: 'SAGITARI-Portable-3.2.1.exe' });
  ok(/no publica la firma de SAGITARI-Portable-3\.2\.1\.exe/.test(sinEntrada), 'si el yml está pero no firma ESTE archivo, se dice cuál: ' + sinEntrada);
  ok(/no publica la firma de/.test(updater.motivoSinFirma({ tieneYml: true, assetName: 'x.exe' })),
    'y no se confunde con «la release no publica latest.yml»');
  ok(/no se pudo leer/.test(updater.motivoSinFirma({ tieneYml: true, assetName: 'x.exe', error: 'timeout' })),
    'si el yml no se pudo leer, se dice eso, no que no exista');
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
  const correr = (extra = []) => spawnSync(process.execPath, [script, dir, ...extra], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
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
  eq(updater.sha512For(updater.parseLatestYml(fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8')), portable), sha(portable),
    'completar corrige también una firma equivocada');
});

/* ---------- reparaciones: regresiones que no pueden volver ---------- */

test('skills: un id con .. o separadores no puede salir del almacén', async () => {
  const legitima = path.join(SKILLS_TMP, 'victima');
  fs.mkdirSync(legitima, { recursive: true });
  fs.writeFileSync(path.join(legitima, 'SKILL.md'), '---\nname: victima\ndescription: x\n---\ncuerpo');
  const venenos = ['.', '..', '../fuera', '..\\..\\fuera', 'a/b', 'a\\b', '', '   ', '...', 'SKILL.md/..'];
  for (const id of venenos) {
    for (const [nombre, fn] of [['deleteSkill', skills.deleteSkill], ['setEnabled', (i) => skills.setEnabled(i, true)], ['writeSource', (i) => skills.writeSource(i, { repo: 'x/y' })]]) {
      let lanzo = false;
      try { await fn(id); } catch { lanzo = true; }
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

test('permisos: la tabla de riesgo es única y no tiene claves muertas', () => {
  const { RISK, toolDefs } = require('../agent/tools');
  const { DEFAULT_RISK } = require('../agent/guardrails');
  eq(DEFAULT_RISK, RISK, 'guardrails debe consumir la MISMA tabla que declara tools.js');
  const nombres = toolDefs.map(d => d.function.name);
  const sinNivel = nombres.filter(n => !RISK[n]);
  eq(sinNivel.join(', '), '', 'toda herramienta debe declarar su nivel de riesgo');
  const muertas = Object.keys(RISK).filter(k => !nombres.includes(k));
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

test('permisos: un clic por índice se juzga con la etiqueta del inventario', () => {
  const g = new Guardrails({ permissions: { browser_control: 'safe' } });
  // el navegador resuelve la etiqueta y viaja como `_label` (agent.js)
  eq(g.decide('browser_control', { action: 'click_index', index: 3, _label: 'Aceptar cookies' }).action, 'allow',
    'un clic inocuo sigue siendo automático si el usuario confía en el navegador');
  eq(g.decide('browser_control', { action: 'click_index', index: 7, _label: 'Pagar ahora 49,90 €' }).action, 'confirm',
    'comprar por índice también se confirma');
  eq(g.decide('browser_control', { action: 'click_index', index: 7, _label: 'Eliminar cuenta' }).sensitive, true);
  eq(g.decide('browser_control', { action: 'click_index', index: 1 }).action, 'confirm',
    'sin etiqueta no se sabe qué se pulsa: se pregunta');
});

test('permisos: abrir una URL pide confirmación por defecto', () => {
  const g = new Guardrails();
  eq(g.decide('open_url', { url: 'https://github.com' }).action, 'confirm');
});

test('mcp: las herramientas dinamicas entran en el catalogo sin tocar la tabla nativa', () => {
  const toolsMod = require('../agent/tools');
  const antes = toolsMod.toolDefs.length;
  const { RISK } = toolsMod;
  toolsMod.setDynamicToolProvider(() => ([{ type: 'function', function: { name: 'mcp__eco__echo', description: 'x', parameters: { type: 'object', properties: {} } } }]));
  try {
    eq(toolsMod.allToolDefs().length, antes + 1, 'la dinamica se suma al catálogo nativo');
    ok(toolsMod.allToolDefs().some(d => d.function.name === 'mcp__eco__echo'));
    eq(toolsMod.toolDefs.length, antes, 'la tabla nativa no se toca (es la que valida el test de niveles)');
    ok(!RISK['mcp__eco__echo'], 'y no se le inventa un nivel: sin override será confirm');
  } finally { toolsMod.setDynamicToolProvider(null); }
  eq(toolsMod.allToolDefs().length, antes, 'sin proveedor, el catálogo vuelve a ser el nativo');
});

test('permisos: el comodín de servidor MCP sube la confianza de todo un servidor', () => {
  const g = new Guardrails({ permissions: { 'mcp__github__*': 'safe' } });
  eq(g.levelFor('mcp__github__create_issue'), 'safe', 'el comodín del servidor vale para sus herramientas');
  eq(g.decide('mcp__github__create_issue', {}).action, 'allow');
  eq(g.decide('mcp__otro__x', {}).action, 'confirm', 'y solo para ese servidor');
  // el override exacto sigue ganando al comodín
  const g2 = new Guardrails({ permissions: { 'mcp__github__*': 'safe', 'mcp__github__borrar': 'restricted' } });
  eq(g2.decide('mcp__github__borrar', {}).action, 'deny');
  // y ninguna herramienta MCP entra en 'safe' por defecto
  eq(new Guardrails().decide('mcp__loquesea__x', {}).action, 'confirm');
});

test('permisos: la tarjeta de confirmación nombra el servidor y la herramienta', () => {
  ok(describeAction('mcp__github__create_issue', {}).includes('MCP'));
  const d = describeAction('mcp__github__create_issue', { _mcp: { serverName: 'GitHub', toolName: 'create_issue' } });
  ok(/GitHub/.test(d) && /create_issue/.test(d), 'con la etiqueta real: ' + d);
  ok(summarizeArgs('mcp__github__create_issue', { title: 'x', _mcp: { serverName: 'GitHub', toolName: 'create_issue' } }).includes('GitHub'));
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
  g.pauseClock();                                // el usuario tiene la tarjeta en pantalla
  await new Promise(r => setTimeout(r, 600));    // más que el límite entero
  g.resumeClock();
  ok(g.checkStep().ok, 'el tiempo esperando al usuario no es tiempo de ejecución');
});

test('health: el coste por modelo se acumula y llega al panel', () => {
  modelsMod.record('cost-test-model', { ok: true, tokens: { prompt_tokens: 1000, completion_tokens: 500 }, costUsd: 0.25 });
  modelsMod.record('cost-test-model', { ok: true, tokens: { prompt_tokens: 1000, completion_tokens: 500 }, costUsd: 0.25 });
  const s = modelsMod.summary().find(r => r.model === 'cost-test-model');
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

test('holo con momentos: puertas numeradas, reloj del monitor y scope en vivo', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const app = readRenderer();
  // las puertas NO enseñan números de atajo: solo el nombre (sin ::before numerado)
  ok(!/\.navitem\[data-view="\w+"\] \.nl::before/.test(css), 'las puertas no deben llevar números');
  ok(/\.navitem \.nl::before \{ content: none/.test(css), 'el ::before de puerta debe estar anulado');
  ok(html.includes('id="boardClock"'), 'el rail lleva su reloj de estación');
  ok(html.includes('id="scopeCanvas"') && html.includes('<script src="scope.js">'), 'el estado vacío lleva su scope en vivo');
  ok(/function tickBoardClock\(\)/.test(app) && /setInterval\(tickBoardClock, 1000\)/.test(app), 'el reloj late cada segundo');
  ok(/\.chat-empty \.scope\s*\{[^}]*mask-image/.test(css), 'el scope se apaga hacia los bordes');
  /* HIG Liquid Glass: el vidrio vive SOLO en la capa funcional (sidebar,
     compositor, menús, sheets). El contenido (burbujas, tarjetas) son fills
     opacos: nada de backdrop-filter ni vidrio sobre vidrio. */
  const regla = (sel) => (css.match(new RegExp(sel + '\\s*\\{[^}]*\\}')) || [''])[0];
  for (const sel of ['\\.side', '\\.composer', '\\.modelmenu', '\\.csel-menu', '\\.skillmenu', '#voiceMode'])
    ok(/backdrop-filter/.test(regla(sel)), sel + ' es capa funcional y lleva vidrio');
  for (const sel of ['\\.bubble', '\\.tcard', '\\.fitem', '\\.ragent', '\\.modeseg'])
    ok(!/backdrop-filter/.test(regla(sel)), sel + ' es contenido y NO lleva vidrio');
  // la navegación flota con inset y los controles son cápsulas
  ok(/\.side\s*\{[^}]*margin:\s*12px/.test(css), 'el sidebar flota con inset');
  ok(/\.btn\s*\{[^}]*border-radius:\s*999px/.test(css), 'los botones son cápsulas');
  ok(/@keyframes pop-in/.test(css), 'los sheets nacen con muelle');
});

test('glass27: aura multicolor, cáusticas y slider ultra claro ↔ tintado', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const app = readRenderer();
  // filo tricolor: el borde nítido de 1px reparte los 3 tonos (un filo de un
  // solo tono mandaba sobre los halos y todo se veía de un color)
  ok(/\.glow::before\s*\{[^}]*conic-gradient\([^}]*--glow-a-rgb[^}]*--glow-b-rgb[^}]*--glow-c-rgb/.test(css), 'el filo del glow debe llevar los 3 tonos');
  ok(/@keyframes giro/.test(css) && /@keyframes reachLife/.test(css), 'los 3 halos ruedan y respiran');
  ok(/@property --giro/.test(css) && /@property --reach/.test(css), 'las propiedades del aura van registradas (si no, el movimiento va a saltos)');
  ok(/\.glowFlow\.halo-a/.test(css) && /--glow-a-rgb/.test(css), 'el halo A lleva su tono');
  ok(/\.glowFlow\.halo-b/.test(css) && /255,255,255/.test(css), 'el halo B lleva su tono + núcleo blanco');
  ok(/\.glowFlow\.halo-c/.test(css) && /--glow-c-rgb/.test(css), 'el halo C lleva su tono');
  ok(!/offset-path/.test(css), 'el glow no recorre el marco (sigue prohibido)');
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
  const canales = [...preload.matchAll(/\bon\('([^']+)'/g)].map(m => m[1]);
  ok(canales.length >= 10, 'deben detectarse los canales push (' + canales.length + ')');
  const emisores = new Set([...main.matchAll(/send\('([^']+)'/g)].map(m => m[1]));
  const sinEmisor = [...new Set(canales)].filter(c => !emisores.has(c));
  eq(sinEmisor.join(', '), '', 'canales push que el renderer nunca recibiría');
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
        next: () => new Promise((_, reject) => {
          const s = opts.signal;
          if (s) s.addEventListener('abort', () => reject(s.reason || new Error('abortado')), { once: true });
        }),
      }),
    },
  });
  let error = null;
  const t0 = Date.now();
  try { await updater.downloadTo('https://x/bin.exe', dest, { fetchFn, idleTimeoutMs: 60 }); }
  catch (e) { error = e; }
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
  fs.mkdirSync(a, { recursive: true });   // la carpeta la crea el navegador al arrancar
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

test('browser: una acción desconocida no lanza un navegador', async () => {
  const b = new Browser();
  b.profileDir = tmpDir('sagi-prof2-');
  const r = await b.handle({ action: 'clik' });   // errata típica del modelo
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
    await new Promise(r => setTimeout(r, 20));
    if (args.n === 1) throw new Error('fallo simulado');
    order.push('fin' + args.n);
  };
  // dos agentes a la vez (chat + tarea de background) comparten el navegador: sus
  // acciones no pueden solaparse porque el estado de la pestaña es global
  const p1 = b.handle({ n: 1 }).catch(e => 'error:' + e.message);
  const p2 = b.handle({ n: 2 });
  const p3 = b.handle({ n: 3 });
  eq(await p1, 'error:fallo simulado', 'el fallo llega a quien lo pidió');
  await Promise.all([p2, p3]);
  eq(order.join(' '), 'inicio1 inicio2 fin2 inicio3 fin3', 'cada acción termina antes de la siguiente, y un fallo no atasca la cola');
});

test('browser: cambiar de perfil olvida el estado del anterior', async () => {
  const b = new Browser();
  b.port = 9333;
  b.browserPid = 4242;              // pid ficticio: no debe poder matarse después
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

test('browser: kill deja el estado limpio y se puede repetir', () => {
  const b = new Browser();
  b.profileDir = tmpDir('sagi-prof3-');
  b.port = 9333; b.activeId = 'tab1'; b._sessions.set('tab1', 's1');
  b.kill();
  eq(b.ws, null); eq(b.activeId, null); eq(b._sessions.size, 0);
  b.kill();   // sin navegador abierto no puede lanzar ningún taskkill
});

test('runlog: escribe, se lee y rota por bytes reales', async () => {
  const dir = tmpDir('sagi-logs-');
  runlog.__test._resetForTests({ dir, maxBytes: 400, maxLogs: 3 });
  let streams = 0;
  const abrir = fs.createWriteStream;
  fs.createWriteStream = (...a) => { streams++; return abrir(...a); };
  for (let i = 0; i < 200; i++) runlog.log({ agent: 'test', event: 'e', text: 'ñ'.repeat(60) + i });
  fs.createWriteStream = abrir;
  runlog.close();
  ok(streams > 1, 'el tope por archivo fuerza rotación (' + streams + ' ficheros abiertos)');
  // la poda corre unos cientos de ms después de la última rotación y reintenta:
  // en Windows el fichero anterior puede seguir con el handle cerrándose
  await new Promise(r => setTimeout(r, 1200));
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
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
  ok(recent.every(e => e.agent === 'test' && e.ts), 'cada evento con su origen y su marca de tiempo');
  ok(/^run-\d+(-\d+)?\.jsonl$/.test(path.basename(runlog.currentLogFile() || '')), 'el fichero de sesión se nombra run-<ts>.jsonl');
  runlog.__test._resetForTests({});
});
