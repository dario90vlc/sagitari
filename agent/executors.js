'use strict';

const { exec, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const skills = require('./skills');
const memory = require('./memory');
const proyecto = require('./proyecto');
const diagnosticos = require('./diagnosticos');
const repomap = require('./repomap');
const cambios = require('./cambios');
const busqueda = require('./busqueda'); // v2.5: búsqueda híbrida (exacta + relevancia)
const hooks = require('./hooks');
const edicion = require('./edicion'); // v3.0: anclajes tolerantes a espacios
const terceros = require('./terceros'); // v5.0.1: marco único del contenido de terceros
const comandos = require('./comandos'); // v3.0: qué comando es peligroso y cuál no
const mcpTransport = require('./mcp-transport');
const { killTree } = require('./proc');
const { dataDir } = require('./datadir');
const { tipoDeImagen, decodeOut, openUrlAllowed } = require('./exec-util');

/* ---- confinamiento: los datos de la app no se leen ni se escriben ----
   CONFIG_DIR (claves API, conversaciones, memoria) no es un objetivo legítimo
   para read/write/edit del agente: ipc-chat.js ya lo bloquea para adjuntos
   y aquí se cierra para las herramientas. Tampoco se escribe en raíces del
   sistema. `rutaResuelta` normaliza sin tocar disco (el archivo puede no existir),
   pero comparar solo eso deja un agujero: un junction DENTRO del espacio de trabajo
   que apunte a %APPDATA%\SagitariAI tiene ruta normalizada «de fuera» y archivo real
   «de dentro». Por eso, cuando la comparación barata dice «fuera», se compara el
   camino REAL (realpath, como ipc-chat.js con los adjuntos) y, si no se puede
   resolver, se BLOQUEA: la duda nunca se convierte en permiso. */
const DATOS_DIR = (() => {
  try {
    return path.win32.normalize(dataDir().toLowerCase());
  } catch {
    return null;
  }
})();
function rutaResuelta(p) {
  try {
    return path.win32.normalize(path.win32.resolve(String(p || '')));
  } catch {
    return String(p || '');
  }
}
function dentroDe(file, dir) {
  if (!file || !dir) return false;
  const r = path.win32.relative(dir, file);
  return r === '' || (!r.startsWith('..') && !path.win32.isAbsolute(r));
}
/* NTFS no distingue mayúsculas: `Readme.md` y `readme.md` son el MISMO archivo, así que
   dos entradas de un parche que solo cambian de caja no pueden tratarse como dos. */
const claveRuta = (p) => path.win32.normalize(String(p || '')).toLowerCase();
/* Las skills traen sus propias referencias (references/*.md) y `use_skill` anuncia su
   carpeta: sin esta excepción el agente no podía leer ni la documentación que la propia
   skill le manda leer. Es SOLO lectura y SOLO dentro de skills; escribir sigue cerrado. */
const SKILLS_DATOS_DIR = DATOS_DIR ? path.win32.join(DATOS_DIR, 'skills') : null;
/* Camino real de una ruta, con caché: realpath es una llamada al sistema y esto corre
   en cada lectura/escritura del agente. Se paga UNA vez por ruta distinta. Si el
   archivo aún no existe (write_file a algo nuevo) se resuelve el ancestro que SÍ
   existe y se reengancha el resto — que es exactamente donde puede haber el junction.
   Devuelve null si no se pudo resolver nada (quien pregunta bloquea). */
const REALES = new Map(); // ruta normalizada en minúsculas -> camino real (o null)
const MAX_REALES = 4096; // tope del caché: una sesión larga no lo hace crecer sin freno
function caminoReal(norm) {
  const clave = norm.toLowerCase();
  if (REALES.has(clave)) return REALES.get(clave);
  let real = null;
  let actual = norm;
  const cola = [];
  for (let i = 0; i < 64; i++) {
    // 64 saltos: Windows no admite cadenas de enlaces más largas, así que esto no cuelga
    try {
      const r = path.win32.normalize(fs.realpathSync(actual));
      real = cola.length ? path.win32.join(r, ...cola.reverse()) : r;
      break;
    } catch {
      const padre = path.win32.dirname(actual);
      if (padre === actual) break; // raíz de la unidad: no hay nada más que resolver
      cola.push(path.win32.basename(actual));
      actual = padre;
    }
  }
  if (REALES.size >= MAX_REALES) REALES.clear();
  REALES.set(clave, real);
  return real;
}
/* La caché solo vale mientras nadie mueva los enlaces: un `mklink /J` creado después de
   cachear esa ruta la deja diciendo «fuera» cuando el camino REAL ya apunta dentro. Se
   vacía tras cada escritura y tras cada comando (los dos sitios donde se crean enlaces). */
function olvidarCaminosReales() {
  REALES.clear();
}
/** 'si' | 'no' | 'duda': si la ruta (normalizada o REAL) cae en los datos de la app. */
function enDatosApp(p) {
  if (!DATOS_DIR) return 'no';
  const norm = rutaResuelta(p);
  if (dentroDe(norm.toLowerCase(), DATOS_DIR)) return 'si'; // ya cae dentro: sin tocar disco
  const real = caminoReal(norm);
  if (real === null) return 'duda';
  return dentroDe(real.toLowerCase(), DATOS_DIR) ? 'si' : 'no';
}
const MSG_DATOS_LECTURA = 'Error: no puedo leer el directorio de datos de la app (ahí viven tus claves y conversaciones).';
const MSG_DATOS_ESCRITURA = 'Error: no puedo escribir en el directorio de datos de la app (ahí viven tus claves y conversaciones).';
const MSG_DATOS_DUDA =
  'Error: no pude comprobar dónde acaba esa ruta (no se puede resolver); una ruta que no se puede verificar no se toca.';
const MSG_FLUJO =
  'Error: esa ruta es un flujo alternativo de NTFS (archivo:flujo): su contenido no se ve en el Explorador, en git ni en el diff, así que no lo toco.';
const SYS_WRITE_RX = /^[a-z]:\\(windows|program files|program files \(x86\)|programdata)([\\/]|$)/i;
/* `README.md:oculto` es un flujo alternativo de NTFS: la ruta «parece» dentro del espacio de
   trabajo y el contenido queda invisible para el Explorador, git, list_dir y el diff, así
   que escribir ahí era una escritura sin tarjeta que nadie ve. La letra de unidad (`C:\`)
   no cuenta: solo se mira el último tramo de la ruta. */
function esFlujoAlternativo(p) {
  const norm = rutaResuelta(p);
  const ultimo = norm.split(/[\\/]/).pop() || '';
  return ultimo.includes(':');
}
/* Lectura legítima de una skill: dentro de <datos>/skills TAMBIÉN por su camino REAL,
    así un junction metido ahí no sirve para leer config.json. */
function esLecturaDeSkill(p) {
  if (!SKILLS_DATOS_DIR) return false;
  const norm = rutaResuelta(p);
  if (!dentroDe(norm.toLowerCase(), SKILLS_DATOS_DIR)) return false;
  const real = caminoReal(norm);
  return real !== null && dentroDe(real.toLowerCase(), SKILLS_DATOS_DIR);
}
function bloqueoLectura(p) {
  if (esFlujoAlternativo(p)) return MSG_FLUJO;
  const v = enDatosApp(p);
  if (v === 'duda') return MSG_DATOS_DUDA;
  if (v === 'si' && !esLecturaDeSkill(p)) return MSG_DATOS_LECTURA;
  return null;
}
function bloqueoEscritura(p) {
  if (esFlujoAlternativo(p)) return MSG_FLUJO;
  const v = enDatosApp(p);
  if (v === 'si') return MSG_DATOS_ESCRITURA;
  if (v === 'duda') return MSG_DATOS_DUDA;
  // el sistema también se comprueba sobre el camino REAL: un junction a C:\Windows
  // cuela igual que uno a los datos de la app si se mira solo la ruta escrita
  const real = caminoReal(rutaResuelta(p));
  const r = rutaResuelta(p);
  if (SYS_WRITE_RX.test((real || r).toLowerCase())) return 'Error: no puedo escribir en carpetas del sistema.';
  if (/^[a-z]:[\\/]?$/i.test(r)) return 'Error: no puedo escribir en la raíz de una unidad.';
  return null;
}

// cmd.exe y otras herramientas nativas emiten en la página de códigos OEM (CP850 en
// Windows en español), no en UTF-8: si los bytes no forman UTF-8 válido los decodificamos
// como CP850 para que los acentos no lleguen corruptos. (Los acentos españoles coinciden
// en CP850 y CP437, así que la tabla sirve también en equipos con OEM 437.)

function run(cmd, opts = {}) {
  return new Promise((resolve) => {
    const timeout = opts.timeout || 60000;
    let done = false,
      outChunks = [],
      errChunks = [];
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // lo que se acaba de ejecutar pudo crear un enlace: el caché de caminos reales ya no vale
      olvidarCaminosReales();
      resolve({ code, stdout: decodeOut(Buffer.concat(outChunks)), stderr: decodeOut(Buffer.concat(errChunks)) });
    };
    // sin `timeout` de exec: lo gestionamos nosotros para poder matar el árbol completo
    const child = exec(
      cmd,
      { windowsHide: true, maxBuffer: opts.maxBuffer || 16 * 1024 * 1024, cwd: opts.cwd, encoding: 'buffer' },
      (err, stdout, stderr) => {
        if (!outChunks.length) outChunks = [stdout || Buffer.alloc(0)];
        if (!errChunks.length) errChunks = [stderr && stderr.length ? stderr : Buffer.from((err && err.message) || '')];
        finish(err ? (err.code ?? 1) : 0);
      },
    );
    child.stdout?.on('data', (d) => {
      outChunks.push(d);
    });
    child.stderr?.on('data', (d) => {
      errChunks.push(d);
    });
    const timer = setTimeout(() => {
      killTree(child);
      // margen para que se cierren los handles; si no, resolvemos igualmente
      setTimeout(() => finish(1), 300);
    }, timeout);
    // el agente puede matar el comando al pulsar Detener
    if (opts.registerKillable) opts.registerKillable({ stop: () => killTree(child) });
  });
}

/* --------------------------------------------------------------------------- *
 *  Comprobar la sintaxis de lo que se acaba de escribir
 *
 *  Es la diferencia entre enterarse del error AHORA —cuando el modelo tiene el
 *  contexto para arreglarlo— o tres pasos después, cuando ya ha construido
 *  encima. Se ejecuta sin shell y con el Node que la app trae dentro, así que no
 *  depende de que el equipo tenga Node instalado.
 * --------------------------------------------------------------------------- */

/** Ejecuta un programa con argumentos SIN shell (las rutas con espacios y acentos
    llegan intactas). code === null significa «no hay con qué comprobarlo». */
function runProg(file, argv, opts = {}) {
  return new Promise((resolve) => {
    const timeout = opts.timeout || 10000;
    let done = false;
    const out = [],
      err = [];
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      olvidarCaminosReales(); // igual que `run`: el programa pudo crear enlaces
      resolve({ code, stdout: decodeOut(Buffer.concat(out)), stderr: decodeOut(Buffer.concat(err)) });
    };
    let child;
    try {
      child = spawn(file, argv, {
        cwd: opts.cwd || undefined,
        env: { ...process.env, ...(opts.env || {}) },
        windowsHide: true,
        windowsVerbatimArguments: opts.verbatim === true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: String(e.message) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        killTree(child);
      } catch {}
      finish(1);
    }, timeout);
    child.on('error', (e) => finish(e && e.code === 'ENOENT' ? null : 1));
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('close', (code) => finish(code == null ? 1 : code));
  });
}

/** Primera línea que explica algo (los checkers sacan ruido de contexto alrededor). */
function lineaDelError(txt) {
  const lineas = String(txt || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const u = lineas.find((l) => /error|syntax|unexpected|invalid|unexpected token|not defined/i.test(l));
  return clip(u || lineas[0] || 'no compila', 300);
}

/**
 * Comprueba la sintaxis de un archivo y devuelve el motivo del fallo, o null si
 * está bien (o si no hay con qué comprobarlo: eso NO es un error del código).
 */
async function revisarSintaxis(absPath) {
  const c = proyecto.comprobacionSintaxis(absPath);
  if (!c) return null;
  let st;
  try {
    st = await fsp.stat(absPath);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > 1536 * 1024) return null;
  if (c.json) {
    try {
      JSON.parse(await fsp.readFile(absPath, 'utf8'));
      return null;
    } catch (e) {
      return `JSON inválido: ${clip(e.message, 200)}`;
    }
  }
  let res;
  try {
    const r = mcpTransport.resolveCommand(c.prog, [...c.extraArgs, absPath]);
    res = await runProg(r.file, r.argv, { env: r.env, verbatim: r.verbatim, timeout: 15000 });
  } catch {
    return null;
  } // no hay ni Node ni el checker: no se puede comprobar
  if (res.code === null || res.code === 0) return null;
  return `${c.etiqueta}: ${lineaDelError(res.stderr || res.stdout)}`;
}

/* --------------------------------------------------------------------------- *
 *  v2.5: diagnósticos del PROYECTO sobre lo que se acaba de escribir
 *
 *  La sintaxis la comprueba `revisarSintaxis` con el checker del lenguaje. Esto
 *  es lo otro: pasar los comprobadores DEL PROYECTO (ESLint, Ruff, Flake8, Mypy)
 *  sobre los archivos tocados y devolver los hallazgos que caen en las líneas que
 *  este turno ha cambiado. Un tipo que no cuadra o una variable que no existe se
 *  ven AHORA, no tres pasos después.
 *
 *  Tres reglas que evitan que esto estorbe y una que evita que se convierta en una
 *  vía de ejecución:
 *   · un comprobador que no está en el equipo o que tarda demasiado se APARTA
 *     (se recuerda y no se vuelve a intentar), porque eso no es un error del código.
 *   · los hallazgos que caen fuera de las líneas tocadas son PREEXISTENTES: se
 *     cuentan y se dicen, pero no se le exigen.
 *   · un comprobador que vive en el proyecto —o la config que lo define— solo se lanza
 *     si el turno NO lo ha tocado: escribir node_modules/eslint/bin/eslint.js (o un
 *     pyproject.toml que pida ruff) y que la app lo ejecute sola tras la siguiente
 *     escritura sería ejecución sin revisión (v3.1, ver `comprobadorDeConfianza`).
 * --------------------------------------------------------------------------- */

const CHECK_APARTADO = new Set(); // 'id|espacio': no está instalado o no se pudo lanzar
const CHECK_LENTO = new Map(); // 'id|espacio' -> hasta cuándo no repetirlo (es caro aquí)
const CHECK_LENTO_MS = 12000; // a partir de aquí, este comprobador estorba en cada escritura
const CHECK_APARTADO_MS = 10 * 60 * 1000;
const claveCheck = (ws, id) => id + '|' + String(ws || '');

/** Aparta un comprobador (no está en el equipo, o es demasiado caro en este proyecto). */
function apartarCheck(ws, id, ms) {
  if (ms) CHECK_LENTO.set(claveCheck(ws, id), Date.now() + ms);
  else CHECK_APARTADO.add(claveCheck(ws, id));
}

/* Ficheros de los que SALE el plan de comprobación (los lee diagnosticos.js para
   decidir qué comprobador toca: package.json, requirements.txt, la config de ESLint…).
   Si este turno ha escrito alguno, el plan ya no es «el del proyecto» sino el del
   modelo: no se lanza nada de él. */
const CHECK_ENTRADAS = [
  'package.json',
  'requirements.txt',
  'requirements-dev.txt',
  'dev-requirements.txt',
  'pyproject.toml',
  'setup.cfg',
  'mypy.ini',
  'ruff.toml',
  '.ruff.toml',
  '.flake8',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.mjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc',
];

/**
 * ¿Alguna de estas piezas (archivos del espacio de trabajo) la ha escrito ESTE turno?
 *
 * Es la comprobación que comparten el comprobador por archivo (`comprobadorDeConfianza`)
 * y la puerta del cierre (`ejecutarComandoVerificacion`): las dos tienen que saber si el
 * código que van a lanzar salió del modelo en este mismo turno. La lista de tocados es la
 * MISMA con la que se deshace el turno (`cambios`), así que no hay que adivinar.
 * Lo que vive FUERA del espacio de trabajo (un eslint global, ruff, el node de la app) no
 * lo controla el proyecto: no cuenta.
 * Si no se puede consultar, `error: true` (quien pregunta decide; en la duda, no ejecutar).
 *
 * @returns {{tocada: string|null, error: boolean}} la pieza tocada (tal y como llegó) o null.
 */
function piezaTocadaEsteTurno(ws, piezas, dueno = '') {
  const raiz = rutaResuelta(ws).toLowerCase();
  let tocados;
  try {
    tocados = new Set((cambios.archivosTocados(ws, dueno) || []).map((x) => rutaResuelta(x).toLowerCase()));
  } catch {
    return { tocada: null, error: true };
  }
  for (const pieza of piezas || []) {
    const p = String(pieza || '');
    if (!p) continue;
    const abs = rutaResuelta(path.win32.isAbsolute(p) ? p : path.win32.join(ws, p)).toLowerCase();
    if (!dentroDe(abs, raiz)) continue; // de fuera del proyecto: es del equipo
    if (tocados.has(abs)) return { tocada: p, error: false };
  }
  return { tocada: null, error: false };
}

/**
 * ¿Se puede lanzar este comprobador? Se mira lo que se ejecuta (y lo que lo define):
 * lo que vive DENTRO del espacio de trabajo solo se lanza si el turno NO lo ha tocado.
 * Un comprobador de FUERA (un eslint global, ruff, el node de la app) no lo controla el
 * espacio de trabajo: se lanza como siempre.
 * @returns {{ok: boolean, motivo?: string}}
 */
function comprobadorDeConfianza(ws, piezas, dueno = '') {
  const r = piezaTocadaEsteTurno(ws, piezas, dueno);
  if (r.error) return { ok: false, motivo: 'no se pudo comprobar si ya estaba antes de este turno' };
  if (r.tocada) return { ok: false, motivo: 'lo ha escrito este turno (' + r.tocada + ')' };
  return { ok: true };
}

/** Lanza un comprobador del plan y devuelve su salida, null si hay que saltarlo, o
    `{bloqueado}` si no se lanza por seguridad (el texto lo ve el modelo). */
async function lanzarCheck(ws, c, archivos, dueno = '') {
  const clave = claveCheck(ws, c.id);
  if (CHECK_APARTADO.has(clave)) return null;
  const hasta = CHECK_LENTO.get(clave);
  if (hasta && Date.now() < hasta) return null;
  const prog = c.clase === 'py-modulo' ? 'python' : c.clase === 'node-entrada' ? 'node' : c.prog;
  const argv = [
    ...(c.clase === 'node-entrada' ? [c.entrada] : []),
    ...(c.clase === 'py-modulo' ? ['-m', c.modulo] : []),
    ...c.args,
    ...archivos,
  ];
  let res;
  const t0 = Date.now();
  try {
    const r = mcpTransport.resolveCommand(prog, argv);
    /* v3.1: un comprobador que VIVE en el espacio de trabajo es código del proyecto —
       y el proyecto lo puede haber escrito este mismo turno (node_modules/eslint/bin/
       eslint.js). Lanzarlo sería ejecutar lo que escribió el modelo sin que nadie lo
       revise, justo lo que este ejecutor evita con los comandos de cierre. Los del
       EQUIPO (un eslint global, ruff, el node de la app) no dependen del espacio de
       trabajo y siguen lanzándose igual. */
    const conf = comprobadorDeConfianza(ws, [r.file, c.entrada, ...CHECK_ENTRADAS], dueno);
    if (!conf.ok)
      return {
        bloqueado: `No he pasado ${c.etiqueta}: ${conf.motivo}. El comprobador y la configuración que lo define salen del proyecto, y este turno los ha tocado: lanzarlo sería ejecutar lo que ha escrito el propio modelo sin que nadie lo revise. Si lo quieres pasar ahora, lánzalo con run_command (esa sí pide permiso al usuario).`,
      };
    res = await runProg(r.file, r.argv, { env: r.env, verbatim: r.verbatim, timeout: c.timeoutMs || 20000, cwd: ws });
  } catch {
    apartarCheck(ws, c.id);
    return null;
  }
  if (diagnosticos.pareceFalloDeHerramienta(res)) {
    apartarCheck(ws, c.id);
    return null;
  }
  const ms = Date.now() - t0;
  if (ms > CHECK_LENTO_MS) apartarCheck(ws, c.id, CHECK_APARTADO_MS);
  return res;
}

/**
 * Pasa los comprobadores del proyecto sobre los archivos recién escritos.
 * @returns {{texto: string, errores: number}} `errores` = hallazgos NUEVOS de tipo error.
 */
async function revisarEstatico(ws, archivos, dueno = '') {
  if (!ws) return { texto: '', errores: 0 };
  let checks = [];
  try {
    checks = diagnosticos.planPorArchivos(ws, archivos);
  } catch {
    return { texto: '', errores: 0 };
  }
  if (!checks.length) return { texto: '', errores: 0 };
  const lineasDe = (abs) => cambios.lineasCambiadas(ws, abs, dueno);
  const partes = [];
  let errores = 0;
  for (const c of checks) {
    let res = null;
    try {
      res = await lanzarCheck(ws, c, archivos, dueno);
    } catch {
      res = null;
    }
    if (res && res.bloqueado) {
      // no se lanzó por seguridad: se dice (sin contarlo como error del código)
      partes.push('⚠ ' + res.bloqueado);
      continue;
    }
    if (!res) continue;
    const salida = String(res.stdout || '') + (String(res.stderr || '').trim() ? '\n' + String(res.stderr) : '');
    if (!salida.trim()) continue;
    let parsed = { hallazgos: [], sinUbicar: 0 };
    try {
      parsed = diagnosticos.parsear(salida, { formato: c.formato, raiz: ws, herramienta: c.etiqueta });
    } catch {
      continue;
    }
    const clas = diagnosticos.clasificar(parsed.hallazgos, { lineasDe });
    if (!clas.nuevos.length && !clas.preexistentes.length) continue;
    errores += clas.nuevos.filter((h) => h.severidad === 'error').length;
    const txt = diagnosticos.resumen(clas, { etiqueta: c.etiqueta, raiz: ws, otrosArchivos: parsed.sinUbicar });
    if (txt) partes.push(txt);
  }
  return { texto: partes.join('\n'), errores };
}

/* --------------------------------------------------------------------------- *
 *  v2.5: tus hooks (Ajustes ▸ Agente)
 *
 *  `hookEditar` se lanza después de cada escritura y su salida se le enseña al modelo;
 *  `hookCerrar` lo lanza el agente antes de cerrar el turno. La plantilla la escribe el
 *  usuario y aquí solo se expanden sus marcadores, con LAS RUTAS ENTRE COMILLAS (una
 *  ruta de Windows con espacios, sin comillas, es un comando roto).
 * --------------------------------------------------------------------------- */

/**
 * Ejecuta un hook del usuario. Nunca lanza: un hook roto es información, no una excepción.
 * @returns {Promise<{ok: boolean, code: number|null, texto: string, comando: string, ms: number}>}
 */
async function ejecutarHook(plantilla, { ws = '', archivos = [], timeoutMs = 60000, registerKillable = null } = {}) {
  const comando = hooks.expandir(plantilla, { ws, archivos });
  const t0 = Date.now();
  if (!String(comando).trim()) return { ok: false, code: null, texto: 'hook vacío', comando, ms: 0 };
  /* La plantilla la escribe el usuario, pero `settings:set` la puede cambiar
     cualquier IPC: un hook destructivo no se ejecuta ni por esa vía. Misma
     barrera que run_command (comandos.js), adaptada a mensaje de hook. */
  try {
    const clase = comandos.clasificar(comando);
    if (clase.nivel === 'prohibido')
      return { ok: false, code: null, texto: comandos.mensajeProhibido(comando), comando, ms: Date.now() - t0 };
  } catch {}
  let r = null;
  try {
    r = await run(comando, { cwd: ws || undefined, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, registerKillable });
  } catch (e) {
    return { ok: false, code: null, texto: String((e && e.message) || e), comando, ms: Date.now() - t0 };
  }
  const salida = String(r.stdout || '') + (String(r.stderr || '').trim() ? '\n' + String(r.stderr) : '');
  return { ok: r.code === 0, code: r.code, texto: salida, comando, ms: Date.now() - t0 };
}

/**
 * Lanza el comando de comprobación del proyecto (sus pruebas, o su compilación).
 * Va por aquí y no por `run_command` a propósito: es la comprobación de la propia
 * app (como el chequeo de sintaxis), así que no pide confirmación al usuario ni
 * cuenta como una acción del modelo. Se ejecuta con cwd en el espacio de trabajo.
 *
 * v3.1: el comando sale del MANIFIESTO del proyecto (package.json, pyproject.toml,
 * Makefile…) y ese manifiesto lo puede haber escrito el propio modelo —una escritura
 * que el usuario confirmó como «crear un archivo», no como «ejecutar esto»—. Por eso
 * no basta con que el comando se vea inocente: tiene que ser el MISMO que ya era la
 * comprobación del proyecto al EMPEZAR el turno (`comandoPrevio`) y pasar además la
 * barrera de `comandos.clasificar`. Sin las dos cosas no se ejecuta y se explica qué
 * falta; se devuelve la misma forma que una ejecución fallida, para que quien llama
 * (el cierre del turno) lo trate como un fallo y no como un «no había nada».
 *
 * v5.0: comparar el TEXTO del comando no basta en el caso «mismo nombre, otro cuerpo»
 * (el modelo reescribe `scripts.test` o añade un `pretest`/`posttest`): el comando sigue
 * siendo `npm test` y comparar cadenas lo dejaba pasar, ejecutando el script recién
 * escrito sin tarjeta de ejecución. Por eso quien llama mira también si el MANIFIESTO
 * del que sale el plan lo ha escrito el modelo este turno (`manifiestoTocado`, con la
 * misma lista de tocados que usa `comprobadorDeConfianza`).
 *
 * @param {string} comando
 * @param {{cwd?: string, timeoutMs?: number, registerKillable?: Function,
 *          clasificado?: {nivel: string, motivo?: string}, comandoPrevio?: boolean,
 *          manifiestoTocado?: string|null}} opts
 *   `clasificado`: resultado de comandos.clasificar(comando) — si no se pasa, se clasifica aquí.
 *   `comandoPrevio`: ¿este MISMO comando ya era la comprobación del proyecto antes de este
 *   turno? `false` = lo escribió este turno → se rechaza. Ausente = quien llama no usa la
 *   puerta (el banco de tareas: ahí el comando lo escribió el usuario, no el modelo).
 *   `manifiestoTocado`: motivo por el que el manifiesto del plan no es de fiar (lo escribió
 *   este turno, o no se pudo comprobar). Se pasa ya redactado para que el mensaje sea el
 *   mismo que el del comprobador por archivo.
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
async function ejecutarComandoVerificacion(
  comando,
  { cwd, timeoutMs = 300000, registerKillable, clasificado, comandoPrevio, manifiestoTocado } = {},
) {
  const texto = String(comando);
  const clase = clasificado || comandos.clasificar(texto);
  // 'permitido' es el nivel que autoriza; comandos.clasificar lo llama 'normal' (una
  // orden sencilla y de solo lectura) y reserva 'sensible' y 'prohibido' para el resto.
  const permitido = !clase || clase.nivel === 'normal' || clase.nivel === 'permitido';
  const negar = (motivo) => ({
    code: 1,
    stdout: '',
    stderr:
      `Error: no he ejecutado la comprobación de cierre («${texto}»): ${motivo}.` +
      ' Esa comprobación sale de los archivos del proyecto, y esos los puede haber escrito el propio modelo' +
      ' en este mismo turno, así que solo se lanza si ya era la comprobación del proyecto ANTES del turno y si' +
      ' el comando es inocuo. Para lanzarla: puedes ejecutarla con run_command (esa sí pide permiso al usuario),' +
      ' o el usuario puede declararla en el proyecto (por ejemplo en "scripts" de package.json) para que valga' +
      ' desde el próximo turno.',
  });
  if (!permitido) {
    return negar(
      clase.nivel === 'prohibido'
        ? 'no voy a ejecutar un comando prohibido (' + (clase.motivo || 'destruye el sistema o los datos') + ')'
        : 'el comando es sensible (' + (clase.motivo || 'pide confirmación') + ') y aquí no hay usuario a quien preguntar',
    );
  }
  if (manifiestoTocado) {
    // mismo texto de comando, pero el manifiesto del que sale lo escribió este turno
    return negar(manifiestoTocado);
  }
  if (comandoPrevio === false) {
    return negar('no era la comprobación del proyecto al empezar el turno, así que la ha traído este turno');
  }
  return run(texto, { cwd, timeout: timeoutMs, registerKillable, maxBuffer: 8 * 1024 * 1024 });
}

/**
 * Texto del resultado de una escritura, con la comprobación de sintaxis y los
 * diagnósticos del proyecto pegados.
 * Si algo está mal se devuelve como FALLO (con el motivo y diciendo que el archivo
 * SÍ quedó escrito): el modelo lo ve como un paso fallido y lo arregla ya, y la
 * tarjeta del chat se marca en rojo en vez de dar el cambio por bueno.
 */
/* --------------------------------------------------------------------------- *
 *  v3.0 — Anclajes tolerantes: el «¿querías esto?»
 *
 *  Un anclaje que solo falla por la sangría no puede ser un callejón sin salida:
 *  el modelo tiene el texto delante y la corrección es de espacios. El error dice
 *  el bloque EXACTO que hay en el archivo (con números de línea), el texto listo
 *  para copiar y la llamada de una sola vez que lo aplica.
 * --------------------------------------------------------------------------- */
function detalleEdicion(etiqueta, texto, r) {
  const cs = (r && r.candidatos) || [];
  if (!cs.length) return `${etiqueta}: ${r.error}. Copia el texto exacto con read_file (respeta espacios y saltos de línea).`;
  if (cs.length > 1) {
    return `${etiqueta}: ${r.error}; ignorando la sangría aparece en ${cs.length} sitios (líneas ${cs.map((x) => x.linea).join(', ')}). Añade más contexto para que sea único.`;
  }
  const c = cs[0];
  return [
    `${etiqueta}: ${r.error}. Esto es lo MÁS PARECIDO que hay en el archivo — casi siempre es solo la sangría o el final de línea:`,
    edicion.marco(texto, c, { titulo: '¿Querías esto?' }),
    'TEXTO EXACTO de ese bloque (ponlo tal cual en old_string):',
    edicion.textoExacto(texto, c),
    'FIN DEL TEXTO EXACTO.',
    'Si era ESE bloque, repite la misma llamada añadiendo tolerar_espacios: true y se aplicará reajustando la sangría al archivo.',
  ].join('\n');
}

function errorEdicion(p, texto, r) {
  return 'Error en ' + p + ' — ' + detalleEdicion('no se pudo editar', texto, r);
}

async function resultadoEscritura(absPath, okText, { checked = [], workspace = null, settings = null, ownerCambios = '' } = {}) {
  const archivos = [absPath, ...checked];
  const fallos = [];
  for (const f of archivos) {
    if (fallos.length >= 3) break;
    const mal = await revisarSintaxis(f);
    if (mal) fallos.push(`${path.basename(f)}: ${mal}`);
  }
  if (fallos.length) {
    return `Error: ${okText}, pero NO compila:\n- ${fallos.join('\n- ')}\nEl archivo queda tal cual (no se deshace). Arréglalo antes de seguir con otra cosa.`;
  }
  // v2.5: el hook del usuario tras escribir (formatear, lint --fix…). Se le enseña al
  // modelo, pero NO convierte el paso en un fallo: el archivo ya está escrito y el
  // hook es tuyo — un prettier ausente no es un error del código que él ha escrito.
  // El que sí manda es `hookCerrar` (lo lanza el agente antes de cerrar el turno).
  let textoHook = '';
  const plantillaHook = (settings && settings.settings && String(settings.settings.hookEditar || '').trim()) || '';
  if (plantillaHook && workspace) {
    let h = null;
    try {
      h = await ejecutarHook(plantillaHook, { ws: workspace, archivos });
    } catch {
      h = null;
    }
    if (h) {
      textoHook = hooks.resumen(h, { etiqueta: 'Hook', comando: plantillaHook });
      if (!h.ok) textoHook = '⚠ ' + textoHook + '\n(el archivo queda escrito; si el fallo es del código recién escrito, arréglalo)';
    }
  }
  const conHook = (texto) => (textoHook ? texto + '\n' + textoHook : texto);
  // La comprobación del proyecto es opcional (Ajustes ▸ Agente) y necesita saber
  // en qué se ejecuta el robot: sin espacio de trabajo no se puede comprobar nada.
  const activo = !(settings && settings.settings && settings.settings.diagnosticosEscritura === false);
  if (!activo || !workspace) return conHook(`OK: ${okText}`);
  let est = { texto: '', errores: 0 };
  try {
    est = await revisarEstatico(workspace, archivos, ownerCambios);
  } catch {
    est = { texto: '', errores: 0 };
  }
  if (!est.texto) return conHook(`OK: ${okText}`);
  if (est.errores) {
    return conHook(
      `Error: ${okText}, y la comprobación del proyecto encontró ${est.errores} error(es) en eso:\n${est.texto}\nEl archivo queda escrito: arréglalo antes de seguir con otra cosa.`,
    );
  }
  return conHook(`OK: ${okText}\n${est.texto}`);
}

const clip = (s, n = 8000) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n...[truncado, ${s.length} caracteres]` : s;
};

const MEDIA_KEYS = { play_pause: 0xb3, next: 0xb0, previous: 0xb1, volume_up: 0xaf, volume_down: 0xae, mute: 0xad };

async function sendVK(vk, registerKillable) {
  const ps = `
Add-Type -Namespace J -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);'
[J.K]::keybd_event(${vk},0,0,[UIntPtr]::Zero); Start-Sleep -m 40; [J.K]::keybd_event(${vk},0,2,[UIntPtr]::Zero)`;
  return run(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { timeout: 15000, registerKillable });
}

// ---- File helpers -------------------------------------------------------

/**
 * Escribe un archivo con tmp + rename: `writeFile` TRUNCA el destino al abrirlo, así
 * que un cierre de la app, un disco lleno o un antivirus a mitad dejaba el archivo del
 * usuario cortado y sin copia. Con el temporal hermano, el archivo bueno no desaparece
 * hasta que el contenido nuevo está entero en disco (mismo directorio → el rename es
 * atómico y no cruza volúmenes). El temporal se borra siempre que falle.
 */
async function escribirAtomico(p, texto) {
  const tmp = p + '.sagi-tmp';
  try {
    await fsp.writeFile(tmp, texto, 'utf8');
    await fsp.rename(tmp, p);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  } finally {
    /* El archivo ya es otro (o el intento creó algo en su sitio): lo cacheado sobre esa
       ruta puede haber quedado viejo y decidir mal la siguiente escritura. */
    olvidarCaminosReales();
  }
}

/** ¿Existe y es una carpeta? Para no confundir «vacío» con «no pude leerlo». */
async function isDir(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function walk(root, depth, maxDepth, out, budget) {
  if (depth > maxDepth || out.length >= budget.count) return;
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= budget.count) return;
    if (['node_modules', '.git', '$RECYCLE.BIN', 'AppData'].includes(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      out.push('  '.repeat(depth) + e.name + '/');
      await walk(full, depth + 1, maxDepth, out, budget);
    } else {
      let size = '';
      try {
        size = ' (' + Math.round(e.size === undefined ? fs.statSync(full).size : e.size) + ' b)';
      } catch {}
      out.push('  '.repeat(depth) + e.name + size);
    }
  }
}

/* Topes de `search_files`: el patrón lo escribe el modelo y corre en el hilo principal.
   Uno enorme tarda en compilar; uno con cuantificadores anidados congela la app. El
   patrón se acota y se rechaza el que puede explotar ANTES de compilarlo; la línea se
   busca ENTERA (recortarla escondía coincidencias pasada la columna 1000 sin avisar). */
const MAX_PATRON = 200;

/** ¿Lo que hay en `i` repite sin tope? (`*`, `+`, `{n,}`) */
function esCuantificadorSinTope(p, i) {
  const c = p[i];
  if (c === '*' || c === '+') return true;
  if (c !== '{') return false;
  const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i));
  return Boolean(m && m[2] && m[3] === '');
}

/* `(a+)+`, `(\w+\s)*`, `(.*)*`: un grupo que ya repite sin tope y que a su vez se repite
   sin tope. Ahí el retroceso crece de forma explosiva con la longitud de la línea y una
   sola línea de un minificado cuelga la app.
   shortcut: es una heurística, no un verificador; una forma rara —una alternancia
   ambigua tipo `(a|aa)+`— todavía podría ser costosa. Por eso el patrón va además acotado
   a MAX_PATRON. */
function patronCostoso(patron) {
  const p = String(patron || '');
  const pila = []; // un nivel por grupo abierto: { sinTope: true si dentro repite sin tope }
  let escape = false;
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '[') {
      // dentro de una clase los cuantificadores son del carácter, no del grupo
      i++;
      while (i < p.length && p[i] !== ']') {
        if (p[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '(') {
      pila.push({ sinTope: false });
      continue;
    }
    if (ch === ')') {
      const g = pila.pop();
      if (!g) continue;
      if (g.sinTope && esCuantificadorSinTope(p, i + 1)) return true;
      if (pila.length && g.sinTope) pila[pila.length - 1].sinTope = true;
      continue;
    }
    if ((ch === '*' || ch === '+' || ch === '{') && pila.length && esCuantificadorSinTope(p, i)) {
      pila[pila.length - 1].sinTope = true;
    }
  }
  return false;
}

async function searchIn(dir, regex, searchContent, out, budget, depth = 0, maxDepth = 12) {
  // Tope de profundidad como en walk(): sin él, un árbol con un ciclo (junction)
  // volvía a recorrer las mismas carpetas para siempre y colgaba la búsqueda.
  if (depth > maxDepth) return;
  if (out.length >= budget.count || budget.files >= 20000) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= budget.count || budget.files >= 20000) return;
    if (['node_modules', '.git', 'AppData'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await searchIn(full, regex, searchContent, out, budget, depth + 1, maxDepth);
      continue;
    }
    budget.files++;
    if (regex.test(e.name)) out.push(`NOMBRE: ${full}`);
    if (!searchContent || out.length >= budget.count) continue;
    try {
      const st = await fsp.stat(full);
      if (st.size > 512 * 1024) continue;
      const buf = Buffer.alloc(8192);
      const fd = await fsp.open(full, 'r');
      let bytesRead = 0;
      try {
        ({ bytesRead } = await fd.read(buf, 0, 8192, 0));
      } finally {
        // sin este finally, un fallo de lectura dejaba el descriptor abierto (en Windows
        // eso bloquea reescribir o renombrar el archivo hasta cerrar la app)
        await fd.close().catch(() => {});
      }
      if (buf.subarray(0, bytesRead).includes(0)) continue;
      const text = await fsp.readFile(full, 'utf8');
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          out.push(`${full}:${i + 1}: ${clip(lines[i].trim(), 200)}`);
          if (out.length >= budget.count) break;
        }
      }
    } catch {}
  }
}

// ---- Main dispatcher ----------------------------------------------------

async function executeTool(name, args, ctx) {
  const { emit, screenshotFn, browser, settings, home, workspace } = ctx;
  // rutas relativas y vacías resuelven en el ESPACIO DE TRABAJO (no en el home):
  // así "crea un informe.md" aterriza en la carpeta del usuario sin rutas absolutas
  const inWs = (p) => {
    if (!p || p === '.' || p === './') return workspace;
    if (/^~(?=\/|\\|$)/.test(p)) return p.replace(/^~/, home);
    return path.isAbsolute(p) ? p : path.join(workspace, p);
  };
  // Las herramientas MCP no están en la tabla nativa: se despachan por prefijo al
  // gestor, que ya pasó por el motor de permisos en _runToolCall.
  if (String(name).startsWith('mcp__')) {
    if (!ctx.mcp) return 'Error: no hay servidores MCP en esta ejecución.';
    // `_mcp` es la etiqueta interna de la tarjeta de confirmación (servidor y
    // nombre reales): NO es un argumento de la herramienta, así que no puede
    // viajar al servidor (uno estricto rechazaría el campo de más).
    const { _mcp, ...rest } = args;
    // onExit: Detener corta SOLO la llamada en vuelo (el gancho que expone callTool).
    return ctx.mcp.callTool(name, rest, { onExit: ctx.registerKillable });
  }
  switch (name) {
    case 'remember': {
      const textoGuardar = String(args.text == null ? '' : args.text);
      // vacío se rechaza ANTES de nada: una propuesta sin texto no es nada que aprobar
      if (!textoGuardar.trim()) return 'Error: no pude guardar el recuerdo (texto vacío).';
      const importance = Number.isFinite(Number(args.importance)) ? Number(args.importance) : 0.6;
      const confidence = Number.isFinite(Number(args.confidence)) ? Number(args.confidence) : 0.8;
      /* El ajuste «Guardar sin preguntar» (`memoryAutoSave`) manda también AQUÍ. Antes
         `remember` escribía el hecho directo pasara lo que pasara, así que el ajuste
         apagado no servía de nada y la vista Memoria prometía en falso que nada entra sin
         aprobación. Apagado, el recuerdo cae en «Recién aprendido» (la bandeja, que ya
         avisa sola a la interfaz) y el usuario decide. */
      if (!ctx.settings || !ctx.settings.settings || ctx.settings.settings.memoryAutoSave !== true) {
        const nuevas = memory.trayProponer([
          { texto: textoGuardar, origen: 'agent', motivo: 'lo propuso el agente', confianza: confidence },
        ]);
        if (!nuevas.length)
          return 'No se encoló ninguna propuesta nueva: ese recuerdo ya está en la memoria o ya espera aprobación en «Recién aprendido». No hace falta que lo repitas.';
        return 'OK: propuesta guardada en «Recién aprendido», pendiente de que el usuario la apruebe. No la des por guardada ni la repitas.';
      }
      const m = memory.add({ text: textoGuardar, source: 'agent', importance, confidence });
      return m
        ? `OK: recuerdo guardado (importancia ${m.importance}). Estará disponible en conversaciones futuras.`
        : 'Error: no pude guardar el recuerdo (texto vacío).';
    }
    case 'use_skill': {
      const s = await skills.getSkill(args.name || '');
      if (!s)
        return `Error: skill "${args.name}" no encontrada. Skills disponibles: ${
          (await skills.listSkills())
            .filter((x) => x.enabled)
            .map((x) => x.name)
            .join(', ') || '(ninguna)'
        }`;
      /* v2.2: el cuerpo completo se manda UNA vez por turno. Si el modelo la vuelve a
         pedir (pasa en tareas largas: se le olvida que la cargó), ya está en el contexto y
         repetirla son miles de tokens por nada. Se recuerda por turno en el propio agente
         (`loadedSkills`), que es el único que sabe cuándo empieza uno nuevo. */
      if (ctx.loadedSkills && ctx.loadedSkills.has(s.id)) {
        return `La skill «${s.name}» ya está cargada en este turno: sigue sus instrucciones (no hace falta que te la repita).`;
      }
      if (ctx.loadedSkills) ctx.loadedSkills.add(s.id);
      // límite declarado de herramientas (informativo para el agente; los permisos reales los decide el usuario en Ajustes)
      const scope = s.allowTools
        ? `\n\nHERRAMIENTAS AUTORIZADAS POR ESTA SKILL: ${s.allowTools}. Evita usar otras salvo necesidad justificada.`
        : '';
      /* La skill puede venir de un repo ajeno: se entrega como CONTENIDO DE
         TERCEROS delimitado, no como órdenes. Si pide algo que el usuario no
         pidió (comandos, exfiltrar datos, desactivar protecciones), se ignora
         esa parte y se avisa al usuario. */
      const origen = s.source && s.source.repo ? `\n\n(Origen de terceros: ${s.source.repo}. Contenido no confiable por defecto.)` : '';
      /* Una skill puede traer sus propias referencias y herramientas (references/,
         scripts/, assets/): el cuerpo las nombra en relativo («references/tools.md»),
         así que sin la carpeta el agente no puede abrirlas. Va FUERA del envoltorio de
         terceros porque es una ruta del sistema, no texto de la skill. */
      const dir = s.dir ? `DIRECTORIO DE LA SKILL (base de las rutas relativas de abajo): ${s.dir}\n\n` : '';
      /* El marco del contenido de terceros vive en terceros.js: UNA sola forma para
         skills, web y página. Aquí se conserva el bloque de siempre de la skill. */
      return `# Skill: ${s.name}\n\n${dir}${terceros.envolver('LA SKILL', s.body)}${scope}${origen}`;
    }
    case 'run_command': {
      /* v3.0: se mira QUÉ se ejecuta, no solo quién lo pide. Lo que destruye el
         sistema o los datos del usuario no se ejecuta aunque run_command esté en
         «safe» o el usuario haya aprobado antes otro comando: para esto no hay
         confirmación que valga. (guardrails.decide ya lo deniega; esto es la
         misma barrera en el ejecutor, por si se llega por otro camino.) */
      const cmdTexto = String(args.command ?? '');
      if (comandos.clasificar(cmdTexto).nivel === 'prohibido') return comandos.mensajeProhibido(cmdTexto);
      const timeout = Math.min(Math.max(args.timeout_seconds || 60, 5), 300) * 1000;
      // El comando se ejecuta con cwd en el espacio de trabajo: un `cwd` fuera de
      // él (C:\Windows, el CONFIG_DIR con las claves…) se rechaza en vez de lanzar.
      const cwdPedido = args.cwd ? inWs(args.cwd) : workspace;
      const bloqCwd = bloqueoEscritura(cwdPedido);
      if (bloqCwd) return bloqCwd.replace('no puedo escribir en', 'no puedo ejecutar en');
      // chcp 65001 fuerza UTF-8 en cmd.exe para que los acentos no lleguen corruptos
      const r = await run(`chcp 65001>nul & ${args.command}`, { cwd: cwdPedido, timeout, registerKillable: ctx.registerKillable });
      /* v5.0.1: el resultado dice si el comando FALLÓ, no solo qué imprimió. El agente
         deducía el fallo del texto (prefijo «Error…»), y un `exit=1` no lo lleva: el
         comando contaba como comprobación buena y la puerta de cierre se daba por hecha
         tras una ejecución en rojo. El texto es el mismo de siempre para el modelo. */
      return { text: `exit=${r.code}\nSTDOUT:\n${clip(r.stdout)}\nSTDERR:\n${clip(r.stderr, 3000)}`, failed: r.code !== 0 };
    }
    case 'read_file': {
      const p = inWs(args.path);
      const bloq = bloqueoLectura(p);
      if (bloq) return bloq;
      let st;
      try {
        st = await fsp.stat(p);
      } catch (e) {
        return `Error: no pude leer ${p} (${e.code || e.message}).`;
      }
      if (!st.isFile()) return `Error: ${p} no es un archivo.`;
      // rechaza archivos enormes antes de cargarlos enteros en memoria
      if (st.size > 32 * 1024 * 1024) return `Error: archivo demasiado grande (${(st.size / 1048576).toFixed(1)} MB; el límite es 32 MB).`;
      const buf = await fsp.readFile(p);
      if (buf.subarray(0, 8192).includes(0)) return 'Error: archivo binario (no legible como texto).';
      const text = buf.toString('utf8');
      if (args.offset === undefined && args.limit === undefined) return clip(text, 60000);
      const lines = text.split(/\r?\n/);
      const total = lines.length;
      const start = Math.min(Math.max(Number(args.offset) || 1, 1), total);
      const limit = Math.min(Math.max(Number(args.limit) || 2000, 1), 2000);
      const end = Math.min(start + limit - 1, total);
      const rest = end < total ? `\n...[quedan ${total - end} líneas; continúa con offset: ${end + 1}]` : '';
      return clip(`[líneas ${start}-${end} de ${total}]\n${lines.slice(start - 1, end).join('\n')}${rest}`, 60000);
    }
    /* v2.2: mirar una imagen DEL DISCO. Antes solo existía la captura de pantalla y la
       página del navegador: "mira este PNG de mi carpeta" no se podía hacer (y `read_file`
       rechaza binarios a propósito). La imagen vuelve como parte multimodal del resultado,
       que es el mismo camino que ya usa `screenshot`. */
    case 'view_image': {
      const p = inWs(args.path);
      const bloqV = bloqueoLectura(p);
      if (bloqV) return bloqV;
      let st;
      try {
        st = await fsp.stat(p);
      } catch (e) {
        return `Error: no pude abrir ${p} (${e.code || e.message}).`;
      }
      if (!st.isFile()) return `Error: ${p} no es un archivo.`;
      // 8 MB: por encima de eso la petición al modelo se dispara (el base64 pesa ~4/3 del
      // archivo) y la mayoría de proveedores la rechaza o la recorta sin avisar
      if (st.size > 8 * 1024 * 1024) {
        return `Error: imagen demasiado grande (${(st.size / 1048576).toFixed(1)} MB; el límite es 8 MB). Pídele al usuario una versión reducida o recortada.`;
      }
      const buf = await fsp.readFile(p);
      const tipo = tipoDeImagen(buf);
      if (!tipo) return `Error: ${p} no parece una imagen de un formato que los modelos acepten (PNG, JPEG, GIF o WEBP).`;
      const kb = Math.max(1, Math.round(st.size / 1024));
      return {
        text: `Imagen abierta: ${p} (${kb} KB, ${tipo}). La tienes delante: descríbela según lo que VES. Si por lo que sea no puedes ver imágenes, dilo tal cual en vez de inventar su contenido.`,
        images: [`data:${tipo};base64,${buf.toString('base64')}`],
      };
    }
    case 'write_file': {
      const p = inWs(args.path);
      const bloqW = bloqueoEscritura(p);
      if (bloqW) return bloqW;
      const content = String(args.content ?? '');
      await fsp.mkdir(path.dirname(p), { recursive: true });
      // v2.4: pre-imagen para poder REVISAR el cambio después (ver cambios.js)
      cambios.recordar(workspace, p, undefined, ctx.ownerCambios);
      await escribirAtomico(p, content);
      repomap.invalidar(workspace);
      busqueda.invalidar(workspace); // el índice de búsqueda también se queda viejo
      return await resultadoEscritura(p, `${content.length} bytes escritos en ${p}`, {
        workspace,
        settings,
        ownerCambios: ctx.ownerCambios,
      });
    }
    case 'edit_file': {
      const p = inWs(args.path);
      const bloqE = bloqueoEscritura(p);
      if (bloqE) return bloqE;
      const oldStr = String(args.old_string ?? '');
      const newStr = String(args.new_string ?? '');
      if (!oldStr) return 'Error: old_string es obligatorio y no puede estar vacío.';
      let buf;
      try {
        buf = await fsp.readFile(p);
      } catch (e) {
        return `Error: no pude leer ${p} (${e.code === 'ENOENT' ? 'no existe; para crear el archivo usa write_file' : e.code || e.message}).`;
      }
      if (buf.subarray(0, 8192).includes(0)) return `Error: ${p} es binario (no editable como texto).`;
      const text = buf.toString('utf8');
      // Ida y vuelta: si el fichero no está en UTF-8 (un .txt/.csv guardado en
      // ANSI/CP1252 por Notepad) la conversión ya ha metido U+FFFD en los acentos,
      // y reescribirlo los destruiría sin vuelta atrás. Mejor no tocar nada.
      if (!Buffer.from(text, 'utf8').equals(buf)) {
        return `Error: ${p} no está en UTF-8 (probablemente ANSI/CP1252); editarlo corrompería los acentos. Conviértelo a UTF-8 antes, o usa write_file con el contenido completo.`;
      }
      /* v3.0: anclaje tolerante a espacios. Si el texto no aparece exacto pero sí
         ignorando la sangría, el error deja de ser un callejón: se devuelve
         «¿querías esto?» con el bloque EXACTO y la vía de una sola llamada
         (tolerar_espacios: true), que reajusta la sangría en vez de destruirla. */
      const r = edicion.aplicar(text, oldStr, newStr, {
        replaceAll: !!args.replace_all,
        tolerar: args.tolerar_espacios === true,
      });
      if (!r.ok) return errorEdicion(p, text, r);
      cambios.recordar(workspace, p, text, ctx.ownerCambios);
      await escribirAtomico(p, r.texto);
      repomap.invalidar(workspace);
      busqueda.invalidar(workspace); // el índice de búsqueda también se queda viejo
      const relato =
        `${r.veces} reemplazo(s) en ${p}` +
        (r.modo === 'tolerante'
          ? ` — el anclaje no coincidía al carácter: aplicado sobre las líneas ${r.linea}-${r.linea + r.lineas - 1} reajustando la sangría al archivo`
          : '');
      return await resultadoEscritura(p, relato, { workspace, settings, ownerCambios: ctx.ownerCambios });
    }
    /* v2.4: mapa del repositorio e índice de símbolos. En un proyecto grande, leer
       archivo a archivo se come el contexto y aun así se pierden cosas; esto responde
       «¿qué hay aquí?» y «¿dónde se define X?» sin abrir nada. */
    case 'repo_map': {
      const dir = args.path ? inWs(args.path) : workspace;
      const bloqR = bloqueoLectura(dir);
      if (bloqR) return bloqR;
      return clip(repomap.mapa(dir, { maxChars: Number(args.max_chars) || 7000 }), 20000);
    }
    /* v2.5: búsqueda híbrida (coincidencia exacta + relevancia). Es lo que hace que en un
       proyecto grande el agente no vaya leyendo archivos a ciegas. */
    case 'search_code': {
      const q = String(args.query || args.q || args.name || '').trim();
      if (!q) return 'Error: dime qué buscas (query).';
      return clip(busqueda.textoBusqueda(workspace, q, { limit: Math.min(Math.max(Number(args.limit) || 12, 1), 40) }), 12000);
    }
    case 'find_symbol': {
      const q = String(args.name || args.query || '').trim();
      if (!q) return 'Error: dime qué buscas (name).';
      return clip(repomap.textoBusqueda(workspace, q, { limit: Math.min(Number(args.limit) || 30, 60) }), 12000);
    }
    /* v2.4: varios cambios en varios archivos, en una sola llamada y ATÓMICOS:
       primero se comprueba que TODOS los anclajes existen y son únicos y, solo
       entonces, se escribe. Antes, un refactor de cinco archivos eran cinco
       llamadas y un archivo a medias si la tercera fallaba.
       v3.1: y atómico también en el disco — se vuelca todo a temporales hermanos y se
       renombran al final; un fallo a mitad de camino restaura lo ya escrito. */
    case 'apply_patch': {
      // OJO: la local NO puede llamarse `cambios` — sombrearía el módulo `cambios`
      // (el registrador de pre-imágenes) y `cambios.recordar` sería un TypeError.
      const lista = Array.isArray(args.changes) ? args.changes : [];
      if (!lista.length) return 'Error: changes es obligatorio (lista de {path, old_string, new_string}).';
      if (lista.length > 40) return 'Error: demasiados cambios de golpe (máximo 40). Divídelo en partes.';
      const planes = [];
      const errores = [];
      for (const c of lista) {
        const p = inWs(c && c.path);
        const bloqP = bloqueoEscritura(p);
        if (bloqP) {
          errores.push(`${c && c.path}: ${bloqP}`);
          continue;
        }
        const oldStr = String((c && c.old_string) ?? '');
        const newStr = String((c && c.new_string) ?? '');
        if (!oldStr) {
          errores.push(`${c && c.path}: old_string vacío`);
          continue;
        }
        let buf;
        try {
          buf = await fsp.readFile(p);
        } catch (e) {
          errores.push(`${c.path}: no pude leerlo (${e.code || e.message})`);
          continue;
        }
        if (buf.subarray(0, 8192).includes(0)) {
          errores.push(`${c.path}: es binario (no editable como texto)`);
          continue;
        }
        const texto = buf.toString('utf8');
        /* La MISMA ida y vuelta que `edit_file`: si el archivo no está en UTF-8 (un
           .txt/.csv guardado en ANSI/CP1252 por Windows) la conversión ya ha metido
           U+FFFD en los acentos y aquí se reescribe el fichero ENTERO, así que el
           destrozo es de todo el archivo —y el deshacer también, porque su pre-imagen
           salió de la misma lectura. Mejor no tocar nada y decirlo. */
        if (!Buffer.from(texto, 'utf8').equals(buf)) {
          errores.push(
            `${c.path}: no está en UTF-8 (probablemente ANSI/CP1252); editarlo corrompería los acentos. Conviértelo a UTF-8 antes, o usa write_file con el contenido completo.`,
          );
          continue;
        }
        // v3.0: el mismo anclaje tolerante que edit_file, por cambio y para todo el parche
        const r = edicion.aplicar(texto, oldStr, newStr, {
          replaceAll: !!c.replace_all,
          tolerar: c.tolerar_espacios === true || args.tolerar_espacios === true,
        });
        if (!r.ok) {
          errores.push(detalleEdicion(c.path, texto, r));
          continue;
        }
        if (planes.some((x) => claveRuta(x.p) === claveRuta(p))) {
          errores.push(`${c.path}: dos cambios sobre el mismo archivo en una llamada (junta el texto en uno)`);
          continue;
        }
        planes.push({ p, antes: texto, despues: r.texto, n: r.veces, modo: r.modo, linea: r.linea, lineas: r.lineas });
      }
      if (errores.length) {
        return `Error: no se ha escrito NADA (el parche se aplica entero o no se aplica):\n- ${errores.join('\n- ')}`;
      }
      /* v3.1: atómico TAMBIÉN en el disco. Antes se validaban todos los anclajes y luego
         se escribía uno a uno: un disco lleno, un EPERM o un archivo bloqueado en el
         tercero dejaba los dos primeros aplicados — justo lo que este parche promete
         que no pasa. Ahora se vuelca TODO a temporales hermanos y solo cuando los N
         están enteros se renombran; si un rename falla, se restauran los ya renombrados
         desde su pre-imagen (la misma que se guarda para el deshacer) y se dice cuál
         falló. Los temporales se borran siempre. */
      const tmps = planes.map((plan) => plan.p + '.sagi-tmp');
      for (let i = 0; i < planes.length; i++) {
        try {
          await fsp.writeFile(tmps[i], planes[i].despues, 'utf8');
        } catch (e) {
          for (const t of tmps) await fsp.rm(t, { force: true }).catch(() => {});
          return `Error: no se ha escrito NADA (el parche se aplica entero o no se aplica): no pude preparar ${path.basename(planes[i].p)} (${e.code || e.message}). Ningún archivo se ha tocado.`;
        }
      }
      const puestos = [];
      for (let i = 0; i < planes.length; i++) {
        cambios.recordar(workspace, planes[i].p, planes[i].antes, ctx.ownerCambios);
        try {
          await fsp.rename(tmps[i], planes[i].p);
          puestos.push(planes[i]);
        } catch (e) {
          const sinRestaurar = [];
          for (const plan of puestos) {
            try {
              await escribirAtomico(plan.p, plan.antes);
            } catch {
              sinRestaurar.push(path.basename(plan.p));
            }
          }
          for (const t of tmps) await fsp.rm(t, { force: true }).catch(() => {});
          const aviso = sinRestaurar.length
            ? ` No pude restaurar ${sinRestaurar.join(', ')}: su contenido puede ser el del parche, revísalos.`
            : '';
          return `Error: no se ha aplicado el parche: falló al escribir en ${path.basename(planes[i].p)} (${e.code || e.message}). Se han restaurado ${puestos.length - sinRestaurar.length} de ${puestos.length} archivo(s) que ya se habían escrito.${aviso}`;
        }
      }
      repomap.invalidar(workspace);
      busqueda.invalidar(workspace); // el índice de búsqueda también se queda viejo
      const resumen = planes
        .map((pl) => `${path.basename(pl.p)} (${pl.n}${pl.modo === 'tolerante' ? ', sangría reajustada' : ''})`)
        .join(', ');
      return await resultadoEscritura(planes[0].p, `${planes.length} archivo(s) actualizados: ${resumen}`, {
        checked: planes.map((x) => x.p),
        workspace,
        settings,
        ownerCambios: ctx.ownerCambios,
      });
    }
    case 'list_dir': {
      const root = inWs(args.path);
      const bloqL = bloqueoLectura(root);
      if (bloqL) return bloqL;
      // Antes un fallo de readdir se tragaba y la herramienta respondía
      // «(directorio vacío)»: el agente creía que no había nada y podía
      // sobrescribirlo. read_file sí distinguía ENOENT; esto lo iguala.
      if (!(await isDir(root))) return `Error: no pude leer ${root} (no existe, no es una carpeta o no tengo permisos).`;
      const out = [];
      const budget = { count: 500 };
      await walk(root, 0, Math.min(Math.max(args.depth || 2, 1), 4), out, budget);
      return out.join('\n') || '(directorio vacío)';
    }
    case 'search_files': {
      const root = inWs(args.path);
      const bloqS = bloqueoLectura(root);
      if (bloqS) return bloqS;
      const patron = String(args.pattern ?? '');
      if (patron.length > MAX_PATRON) {
        return `Error: el patrón es demasiado largo (${patron.length} caracteres; el máximo es ${MAX_PATRON}). Busca una cadena literal más corta o divide la búsqueda.`;
      }
      if (patronCostoso(patron)) {
        return 'Error: el patrón repite sin tope un grupo que ya repite sin tope (`(a+)+`, `(\\w+\\s)*`): el retroceso se dispara con la longitud de la línea y la búsqueda podría colgar la app. Simplifícalo: una cadena literal, o una sola clase de caracteres (`\\w+`, `[a-z]+`).';
      }
      let regex;
      try {
        regex = new RegExp(patron, 'i');
      } catch {
        return 'Error: patrón de búsqueda inválido (no es una expresión regular válida). Simplifícalo: "informe", "config.*json", "function\\s+nombre"…';
      }
      if (!(await isDir(root))) return `Error: no pude buscar en ${root} (no existe, no es una carpeta o no tengo permisos).`;
      const out = [];
      const budget = { count: 60, files: 0 };
      await searchIn(root, regex, args.search_content !== false, out, budget);
      return out.length ? out.join('\n') : 'Sin resultados.';
    }
    case 'open_app': {
      // `start` se ejecuta dentro de cmd.exe: rechazamos metacaracteres para evitar inyección de shell
      const n = String(args.name ?? '');
      if (!n.trim()) return 'Error: falta el nombre de la aplicación.';
      // `;` separaba un segundo comando que se ejecutaba igual (`start "" "calc"; malware`):
      // antes no estaba en la lista y colaba.
      if (/["&|^<>%;\r\n]/.test(n))
        return 'Error: el nombre de la aplicación no puede contener comillas ni metacaracteres de cmd (" & | ^ < > % ;) ni saltos de línea.';
      const r = await run(`start "" "${n}"`, { timeout: 15000, registerKillable: ctx.registerKillable });
      return r.code === 0 ? `OK: intentando abrir "${n}"` : `Error: ${r.stderr}`;
    }
    case 'open_url': {
      const { shell } = require('electron');
      if (!openUrlAllowed(args.url)) {
        return 'Error: open_url solo abre direcciones http(s). Para ejecutar algo del equipo usa open_app, y para abrir una página local usa browser_control con action=navigate.';
      }
      await shell.openExternal(args.url);
      return `OK: ${args.url} abierta en el navegador por defecto`;
    }
    case 'browser_control':
      /* v2.5: las descargas del navegador caen en una carpeta conocida (y fuera del
         sistema del usuario) y el resultado dice dónde: antes se perdían en la carpeta
         por defecto de Chrome y nadie sabía dónde habían ido. */
      if (ctx.workspace && typeof browser.setDownloadDir === 'function') {
        browser.setDownloadDir(path.join(ctx.workspace, 'descargas-sagitari'));
      }
      return browser.handle(args, ctx.ownerId);
    case 'screenshot': {
      const shot = await screenshotFn();
      emit({ type: 'image', role: 'tool', dataUrl: shot.dataUrl });
      return { text: `Captura de pantalla tomada (${shot.w}x${shot.h}). Analízala junto a este resultado.`, images: [shot.dataUrl] };
    }
    case 'clipboard': {
      const { clipboard } = require('electron');
      if (args.action === 'write') {
        clipboard.writeText(args.text || '');
        return 'OK: portapapeles actualizado';
      }
      return clip(clipboard.readText() || '(vacío)', 4000);
    }
    case 'notify': {
      const { Notification } = require('electron');
      if (Notification.isSupported()) new Notification({ title: args.title || 'SAGITARI', body: args.message || '' }).show();
      emit({ type: 'toast', title: args.title, message: args.message });
      return 'OK';
    }
    case 'media_control': {
      const vk = MEDIA_KEYS[args.action];
      if (!vk) return 'Acción desconocida';
      await sendVK(vk, ctx.registerKillable);
      return `OK: ${args.action}`;
    }
    case 'window_manage': {
      // el enum de la herramienta solo tiene estas dos: cualquier otra acción se
      // rechaza en vez de ejecutar MinimizeAll por defecto (silenciosamente)
      if (args.action !== 'show_desktop' && args.action !== 'minimize_all') {
        return `Error: acción de ventanas no soportada: ${args.action}. Usa minimize_all o show_desktop.`;
      }
      const cmd =
        args.action === 'show_desktop'
          ? `powershell -NoProfile -Command "(New-Object -ComObject Shell.Application).ToggleDesktop()"`
          : `powershell -NoProfile -Command "(New-Object -ComObject Shell.Application).MinimizeAll()"`;
      await run(cmd, { timeout: 15000, registerKillable: ctx.registerKillable });
      return `OK: ${args.action}`;
    }
    case 'system_info': {
      const nets = os.networkInterfaces();
      const ips = Object.values(nets)
        .flat()
        .filter((n) => n && n.family === 'IPv4' && !n.internal)
        .map((n) => n.address);
      const total = os.totalmem(),
        free = os.freemem();
      return [
        `SO: ${os.type()} ${os.release()} (${os.arch()})`,
        `Host: ${os.hostname()} | Usuario: ${os.userInfo().username}`,
        `CPU: ${os.cpus()[0]?.model} x${os.cpus().length}`,
        `RAM: ${(total / 1e9).toFixed(1)} GB total, ${(free / 1e9).toFixed(1)} GB libres`,
        `Uptime: ${(os.uptime() / 3600).toFixed(1)} h`,
        `IPs: ${ips.join(', ') || 'ninguna'}`,
        `Escritorio: ${path.join(home, 'Desktop')}`,
      ].join('\n');
    }
    case 'web_fetch':
    case 'git_status':
    case 'git_diff':
    case 'git_log':
    case 'git_branch':
    case 'git_commit':
      return ejecutarWebOGit(name, args, ctx);
    default:
      return `Error: herramienta desconocida "${name}"`;
  }
}

/* v4.1: web_fetch y las herramientas git_* delegan en su módulo; el ejecutor solo lleva el
   contexto que necesitan (espacio de trabajo y el gancho de Detener). */
async function ejecutarWebOGit(name, args, ctx) {
  const common = { registerKillable: ctx.registerKillable };
  if (name === 'web_fetch') {
    try {
      const r = await require('./web').traer(args.url, { ...common, maxChars: args.max_chars });
      return r.texto;
    } catch (e) {
      return 'Error: ' + String((e && e.message) || e);
    }
  }
  const git = require('./git');
  const opts = { ...common, workspace: ctx.workspace };
  switch (name) {
    case 'git_status':
      return git.status(opts);
    case 'git_diff':
      return git.diff(args, opts);
    case 'git_log':
      return git.log(args, opts);
    case 'git_branch':
      return git.branch(args, opts);
    case 'git_commit':
      return git.commit(args, opts);
  }
}

module.exports = {
  executeTool,
  /* El mismo camino REAL que usa el confinamiento de rutas: guardrails.js lo comparte
     para decidir si una escritura cae DENTRO del espacio de trabajo (un junction de
     dentro hacia fuera no puede abaratar una escritura de fuera). Un solo criterio. */
  caminoReal,
  openUrlAllowed,
  ejecutarComandoVerificacion,
  ejecutarHook,
  piezaTocadaEsteTurno,
  revisarEstatico,
  revisarSintaxis,
  /* Solo para las pruebas: el estado adaptativo (lo que se ha apartado) no debe
     arrastrarse entre casos. */
  __test: {
    _resetChecks: () => {
      CHECK_APARTADO.clear();
      CHECK_LENTO.clear();
    },
  },
};
