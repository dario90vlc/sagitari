'use strict';

/* Verificación de la cadena completa del actualizador («Cerrar e instalar»).

   ¿Por qué existe este arnés y no basta con la suite? Porque el fallo vivió DOS
   versiones con la suite en verde. Las pruebas lanzaban al ayudante desde un proceso
   que seguía vivo —o desde un Node renombrado, que Windows no mata al cerrarse—, así
   que pasaban igual con el diseño bueno y con el roto. Un test que no puede fallar por
   el fallo que dice guardar no guarda nada.

   Lo que sí reproduce el fallo es un Electron REAL que se cierra. El padre de este
   arnés es electron.exe con nombre único (para que `Get-Process` solo lo vea a él) y
   el ayudante se lanza con el código de producción, sin retocar nada.

   Desde la 3.3.4 las pasadas usan el diseño 'tarea' (Programador de tareas, la
   vía principal): si el señuelo se ejecuta tras cerrar el padre, la
   supervivencia queda demostrada por construcción. El diseño 'nuevo'
   (cmd desligado, plan B) sigue cubierto por la suite unitaria; el CONTROL
   sigue siendo el PowerShell directo que debe NO instalar.

   Cada pasada comprueba:
     1. el ayudante arranca y deja su rastro ANTES de que la app se cierre;
     2. sobrevive al cierre (cuando mira, la app ya no está);
     3. ejecuta el instalador DESPUÉS, con la orden exacta `/S --updated --force-run`;
     4. recoge el código de salida del instalador (0).

   Y además un CONTROL con el diseño anterior (PowerShell directo, hijo normal) que
   debe NO instalar. Ese control es lo que demuestra que el escenario mide el cierre de
   verdad: es la forma que falló en la 3.2.3 y la 3.3.0, y su diario se queda en
   «asistente iniciado» sin nada más —exactamente lo que veían los usuarios—.

   Uso:  node scripts/verificar-actualizador.js [pasadas] [--sin-control]
*/

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const updater = require(path.join(RAIZ, 'main', 'updater.js'));

/** Electron de verdad; null si no está instalado. */
function electronExe() {
  try {
    const p = require('electron');            // desde Node devuelve la ruta del binario
    if (typeof p === 'string' && fs.existsSync(p)) return p;
  } catch {}
  const p = path.join(RAIZ, 'node_modules', 'electron', 'dist', 'electron.exe');
  return fs.existsSync(p) ? p : null;
}

/**
 * El plan del DISEÑO ANTERIOR (3.2.3 y 3.3.0): el mismo guion, pero lanzado como
 * `powershell.exe` directo. Medido: arranca y muere con la app, así que nunca llega a
 * ejecutar el instalador. Sirve de control: si algún día esto funcionara, el arnés no
 * estaría midiendo el cierre real.
 */
function planAntiguo({ name, installer, args, logPath }) {
  const script = updater.installHelperScript({ name, installer, args, logPath });
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    spawnOpts: { stdio: 'ignore', windowsHide: true },
  };
}

/**
 * Deja el runtime de Electron junto al exe renombrado. Electron busca icudtl.dat,
 * los .pak y resources/ EN LA CARPETA DEL EXE: copiar solo electron.exe no arranca
 * («Invalid file descriptor to ICU data received»). Se enlazan los ficheros (duro,
 * sin ocupar) en vez de usar uniones de directorio: así la limpieza es un borrado
 * normal y no hay enlaces que un borrado recursivo pudiera seguir hasta los archivos
 * de verdad.
 */
function preparar(dir, nombre) {
  const src = electronExe();
  if (!src) return { ok: false, motivo: 'no hay electron.exe instalado (npm i)' };
  const walk = (a, b) => {
    fs.mkdirSync(b, { recursive: true });
    for (const e of fs.readdirSync(a, { withFileTypes: true })) {
      const p1 = path.join(a, e.name);
      const p2 = path.join(b, e.name === path.basename(src) ? nombre + '.exe' : e.name);
      if (e.isDirectory()) walk(p1, p2);
      else if (!fs.existsSync(p2)) { try { fs.linkSync(p1, p2); } catch { fs.copyFileSync(p1, p2); } }
    }
  };
  walk(path.dirname(src), dir);
  return { ok: true, exe: path.join(dir, nombre + '.exe') };
}

/**
 * El ayudante espera a que no quede NINGÚN proceso con ese nombre. Si la pasada anterior
 * todavía se está cerrando, la siguiente esperaría a un fantasma y la pasada se daría por
 * fallida sin serlo (intermitencia medida: 1 de cada 3 pasadas). Por eso cada pasada usa un
 * nombre de proceso PROPIO y aquí se espera a que el suyo desaparezca antes de seguir.
 */
async function sinProceso(nombre, ms = 10000) {
  const rx = new RegExp('"' + nombre + '\\.exe"', 'i');
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    let out = '';
    try {
      const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ' + nombre + '.exe', '/FO', 'CSV', '/NH'],
        { windowsHide: true, encoding: 'utf8' });
      out = String((r && r.stdout) || '');
    } catch {}
    if (!rx.test(out)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Guion del padre: lanza el plan, espera el RASTRO (no «que siga vivo») y sale. */
function escribirPadre(padreJs, padreTxt) {
  fs.writeFileSync(padreJs, [
    "'use strict';",
    "const fs = require('fs');",
    "const { app } = require('electron');",
    "const { spawn } = require('child_process');",
    'const [file, argsJson, optsJson, logPath, padreTxt] = process.argv.slice(2);',
    "const rastro = () => { try { return fs.readFileSync(logPath, 'utf8'); } catch { return ''; } };",
    "app.whenReady().then(async () => {",
    "  try { fs.rmSync(logPath, { force: true }); } catch {}",
    "  let h = null;",
    "  try {",
    '    h = spawn(file, JSON.parse(argsJson), JSON.parse(optsJson));',
    "    try { h.unref(); } catch {}",
    "    h.on('error', () => {});",
    "  } catch (e) {",
    "    return salir('FALLO al lanzar: ' + e.message);",
    "  }",
    "  const t0 = Date.now();",
    "  while (Date.now() - t0 < 45000) {",
    "    if (rastro().includes('asistente iniciado')) break;",
    "    await new Promise((r) => setTimeout(r, 200));",
    "  }",
    "  salir('arrancado=' + rastro().includes('asistente iniciado') + ' esperado_ms=' + (Date.now() - t0));",
    "});",
    "function salir(info) { fs.writeFileSync(padreTxt, info); setTimeout(() => app.quit(), 500); }",
  ].join('\n'));
}

/**
 * Guion del padre para el diseño 'tarea' (3.3.4): programa la instalación con
 * el Programador de tareas y sale. El ayudante lo ejecuta el servicio, no un
 * hijo del padre: si el señuelo se ejecuta, la supervivencia está demostrada
 * por construcción, no por suerte del árbol de procesos.
 */
function escribirPadreTarea(padreJs, padreTxt) {
  fs.writeFileSync(padreJs, [
    "'use strict';",
    "const fs = require('fs');",
    "const { app } = require('electron');",
    "const [updaterPath, dir, name, installer, args, logPath, taskName, txt] = process.argv.slice(2);",
    "const updater = require(updaterPath);",
    "app.whenReady().then(async () => {",
    "  try {",
    "    await updater.programarInstalacion({ dir, name, installer, args, logPath, taskName, waitMs: 20000 });",
    "    salir('programada=' + taskName);",
    "  } catch (e) { salir('FALLO al programar: ' + (e && e.message)); }",
    "});",
    "function salir(info) { fs.writeFileSync(txt, info); setTimeout(() => app.quit(), 500); }",
  ].join('\n'));
}

/**
 * Una pasada: monta el escenario, ejecuta el padre Electron y mide.
 * @param {{dir, nombre, diseño?: 'nuevo'|'antiguo'|'tarea', capMs?: number}} o
 *   'nuevo' = cmd desligado (plan B desde la 3.3.4), 'antiguo' = control que
 *   debe fallar, 'tarea' = Programador de tareas (vía principal desde la 3.3.4).
 */
async function pasada({ dir, nombre, exe = null, diseño = 'nuevo', capMs = 45000 }) {
  const d = path.join(dir, diseño === 'tarea' ? 'tarea' : (diseño === 'nuevo' ? 'nuevo' : 'antiguo'));
  fs.rmSync(d, { recursive: true, force: true });
  /* El runtime de Electron se monta UNA vez para todas las pasadas: el exe lleva el
     mismo nombre en las dos (el que `Get-Process` busca), así que compartirlo es
     correcto y ahorra recorrer el dist entero en cada una. */
  if (!exe) {
    const prep = preparar(d, nombre);
    if (!prep.ok) return { saltada: true, motivo: prep.motivo };
    exe = prep.exe;
  } else {
    fs.mkdirSync(d, { recursive: true });
  }

  const senuelo = path.join(d, 'senuelo.bat');
  const salida = path.join(d, 'senuelo.txt');
  const log = path.join(d, 'instalar.log');
  const padreTxt = path.join(d, 'padre.txt');
  const padreJs = path.join(d, 'padre.js');
  fs.writeFileSync(senuelo, '@echo off\r\necho %* > "' + salida + '"\r\n');

  const comun = { name: nombre, installer: senuelo, args: '/S --updated --force-run', logPath: log };
  // nombre de tarea propio por pasada: una tarea colgada de otra pasada no debe
  // ni dispararse con este diario ni impedir crear la nuestra (/f la pisa igual).
  const taskName = 'SAGVERIF-' + nombre;
  let spawnArgs;
  if (diseño === 'tarea') {
    escribirPadreTarea(padreJs, padreTxt);
    spawnArgs = [padreJs, path.join(RAIZ, 'main', 'updater.js'), d, nombre, senuelo, comun.args, log, taskName, padreTxt];
  } else {
    escribirPadre(padreJs, padreTxt);
    const plan = diseño === 'nuevo' ? updater.afterExitCommand(comun) : planAntiguo(comun);
    spawnArgs = [padreJs, plan.file, JSON.stringify(plan.args), JSON.stringify(plan.spawnOpts), log, padreTxt];
  }

  const hijo = spawn(exe, spawnArgs, { stdio: 'ignore', windowsHide: true });
  hijo.on('error', () => {});
  const capar = () => { try { hijo.kill(); } catch {} };

  const t0 = Date.now();
  while (Date.now() - t0 < capMs && !fs.existsSync(salida)) await new Promise((r) => setTimeout(r, 250));
  /* El señuelo escribe su fichero MIENTRAS el ayudante sigue esperando el código de salida
     del instalador, así que leer el diario en cuanto aparece el fichero era una carrera:
     de vez en cuando la última línea todavía no estaba escrita y la pasada se daba por
     fallida sin serlo (intermitencia medida). Se espera a esa línea, que es lo que de
     verdad se quiere comprobar. */
  if (fs.existsSync(salida)) {
    const t1 = Date.now();
    while (Date.now() - t1 < 8000) {
      let t = '';
      try { t = fs.readFileSync(log, 'utf8'); } catch {}
      if (/instalador termino con codigo/.test(t) || /FALLO al lanzar el instalador/.test(t)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const diario = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const args = fs.existsSync(salida) ? fs.readFileSync(salida, 'utf8') : '';
  const padre = fs.existsSync(padreTxt) ? fs.readFileSync(padreTxt, 'utf8') : '(el padre no escribió nada)';
  capar();
  // higiene: la tarea es de un solo uso y el ayudante se autoborra al terminar,
  // pero si la pasada falló antes, no se deja basura en el Programador.
  if (diseño === 'tarea') {
    try { spawnSync('schtasks', ['/delete', '/tn', taskName, '/f'], { windowsHide: true }); } catch {}
  }
  // la siguiente pasada no puede empezar con este proceso todavía vivo
  const limpio = await sinProceso(nombre);
  return {
    nombre, limpio,
    diseño,
    arranco: /asistente iniciado/.test(diario),
    ejecuto: fs.existsSync(salida),
    orden: /\/S --updated --force-run/.test(args),
    codigo0: /instalador termino con codigo 0/.test(diario),
    args: args.trim(), padre,
    diario: diario.replace(/\s+/g, ' ').trim(),
  };
}

/**
 * Verifica la cadena completa. El control exige que el diseño anterior FALLE.
 * @returns {Promise<{estado:'ok'|'fallo'|'sin-electron', pasadas:Array, control:Object|null}>}
 */
async function verificar({ dir, pasadas = 1, conControl = true, capMs = 45000 } = {}) {
  const base = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'sagitari-verif-'));
  const nombre = 'SAGVERIF' + Math.random().toString(16).slice(2, 8).toUpperCase();
  const prep = preparar(base, nombre);            // una sola vez para todo
  if (!prep.ok) return { estado: 'sin-electron', pasadas: [{ saltada: true, motivo: prep.motivo }], control: null };
  /* Un exe con nombre propio por pasada (enlace al mismo archivo, sin copiarlo): así el
     ayudante de una pasada no se queda esperando a la anterior, que puede estar cerrándose. */
  const conNombre = (nom) => {
    const p = path.join(base, nom + '.exe');
    if (!fs.existsSync(p)) { try { fs.linkSync(prep.exe, p); } catch { fs.copyFileSync(prep.exe, p); } }
    return p;
  };
  const hechas = [];
  for (let i = 0; i < pasadas; i++) {
    const nom = i === 0 ? nombre : nombre + 'P' + i;
    const p = await pasada({ dir: base, nombre: nom, exe: conNombre(nom), diseño: 'tarea', capMs });
    if (p.saltada) return { estado: 'sin-electron', pasadas: [p], control: null };
    hechas.push(p);
  }
  const okTodas = hechas.every((p) => p.arranco && p.ejecuto && p.orden && p.codigo0);
  let control = null;
  if (conControl) {
    const nom = nombre + 'C';
    control = await pasada({ dir: base, nombre: nom, exe: conNombre(nom), diseño: 'antiguo', capMs });
    if (control.saltada) control = null;
  }
  // El control NO debe instalar nada. Si instala, el escenario no reproduce el cierre.
  const controlRoto = control ? !control.ejecuto : true;
  return { estado: okTodas && controlRoto ? 'ok' : 'fallo', pasadas: hechas, control, controlRoto };
}

module.exports = { verificar, pasada, electronExe, planAntiguo };

/* ---------- línea de órdenes ---------- */
if (require.main === module) {
  const args = process.argv.slice(2);
  const conControl = !args.includes('--sin-control');
  const pasadas = Math.max(1, Number(args.find((a) => /^\d+$/.test(a)) || 1));
  verificar({ pasadas, conControl }).then((r) => {
    if (r.estado === 'sin-electron') {
      console.log('SIN ELECTRON: ' + (r.pasadas[0] && r.pasadas[0].motivo));
      process.exit(2);
    }
    for (const [i, p] of r.pasadas.entries()) {
      const bien = p.arranco && p.ejecuto && p.orden && p.codigo0;
      console.log('pasada ' + (i + 1) + ': ' + (bien ? 'OK' : 'FALLO')
        + '  [ayudante=' + p.arranco + ' ejecutado=' + p.ejecuto + ' orden=' + p.orden + ' codigo0=' + p.codigo0 + ' limpio=' + p.limpio + ']');
      console.log('  padre   : ' + p.padre);
      console.log('  diario  : ' + p.diario);
      console.log('  señuelo : ' + p.args);
    }
    if (r.control) {
      console.log('control (PowerShell directo, el diseño que falló): ' +
        (r.controlRoto ? 'OK — no instala, como debe' : 'FALLO — instala, el arnés no mide el cierre real'));
      console.log('  diario  : ' + r.control.diario);
    }
    console.log('\n' + (r.estado === 'ok' ? 'TODO OK' : 'HAY FALLOS'));
    process.exit(r.estado === 'ok' ? 0 : 1);
  });
}
