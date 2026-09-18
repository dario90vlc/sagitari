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
const busqueda = require('./busqueda');   // v2.5: búsqueda híbrida (exacta + relevancia)
const hooks = require('./hooks');
const edicion = require('./edicion');     // v3.0: anclajes tolerantes a espacios
const comandos = require('./comandos');   // v3.0: qué comando es peligroso y cuál no
const mcpTransport = require('./mcp-transport');
const { killTree } = require('./proc');

// cmd.exe y otras herramientas nativas emiten en la página de códigos OEM (CP850 en
// Windows en español), no en UTF-8: si los bytes no forman UTF-8 válido los decodificamos
// como CP850 para que los acentos no lleguen corruptos. (Los acentos españoles coinciden
// en CP850 y CP437, así que la tabla sirve también en equipos con OEM 437.)
const CP850 = '\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00f8\u00a3\u00d8\u00d7\u0192' +
  '\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u00ae\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u00c1\u00c2\u00c0\u00a9\u2563\u2551\u2557\u255d\u00a2\u00a5\u2510' +
  '\u2514\u2534\u252c\u251c\u2500\u253c\u00e3\u00c3\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u00a4\u00f0\u00d0\u00ca\u00cb\u00c8\u0131\u00cd\u00ce\u00cf\u2518\u250c\u2588\u2584\u00a6\u00cc\u2580' +
  '\u00d3\u00df\u00d4\u00d2\u00f5\u00d5\u00b5\u00fe\u00de\u00da\u00db\u00d9\u00fd\u00dd\u00af\u00b4\u00ad\u00b1\u2017\u00be\u00b6\u00a7\u00f7\u00b8\u00b0\u00a8\u00b7\u00b9\u00b3\u00b2\u25a0\u00a0';
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });
/**
 * Tipo MIME real de una imagen por sus primeros bytes (no por la extensión: renombrar
 * un .txt a .png no lo convierte en imagen, y los modelos solo aceptan formatos de
 * verdad). Devuelve null si no es de un formato que se pueda enviar.
 */
function tipoDeImagen(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function decodeOut(buf) {
  buf = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'utf8');
  try { return UTF8_STRICT.decode(buf); } catch {}
  const s = buf.toString('latin1');
  let out = '';
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out += c < 0x80 ? s[i] : CP850[c - 0x80]; }
  return out;
}

/* open_url acaba en shell.openExternal, que en Windows invoca el handler del
   SISTEMA, no el navegador: file://, ms-msdt:, search-ms: o cualquier otro
   protocolo registrado se abrirían sin que el usuario lo vea. Solo http(s) es
   una dirección de navegador, así que es lo único que se acepta. */
function openUrlAllowed(url) {
  try {
    const p = new URL(String(url || '').trim()).protocol.toLowerCase();
    return p === 'http:' || p === 'https:';
  } catch { return false; }
}

function run(cmd, opts = {}) {
  return new Promise((resolve) => {
    const timeout = opts.timeout || 60000;
    let done = false, outChunks = [], errChunks = [];
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: decodeOut(Buffer.concat(outChunks)), stderr: decodeOut(Buffer.concat(errChunks)) });
    };
    // sin `timeout` de exec: lo gestionamos nosotros para poder matar el árbol completo
    const child = exec(cmd, { windowsHide: true, maxBuffer: opts.maxBuffer || 16 * 1024 * 1024, cwd: opts.cwd, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (!outChunks.length) outChunks = [stdout || Buffer.alloc(0)];
      if (!errChunks.length) errChunks = [stderr && stderr.length ? stderr : Buffer.from((err && err.message) || '')];
      finish(err ? (err.code ?? 1) : 0);
    });
    child.stdout?.on('data', (d) => { outChunks.push(d); });
    child.stderr?.on('data', (d) => { errChunks.push(d); });
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
    let done = false, out = [], err = [];
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
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
    } catch (e) { resolve({ code: null, stdout: '', stderr: String(e.message) }); return; }
    const timer = setTimeout(() => { try { killTree(child); } catch {} finish(1); }, timeout);
    child.on('error', (e) => finish(e && e.code === 'ENOENT' ? null : 1));
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('close', (code) => finish(code == null ? 1 : code));
  });
}

/** Primera línea que explica algo (los checkers sacan ruido de contexto alrededor). */
function lineaDelError(txt) {
  const lineas = String(txt || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const u = lineas.find(l => /error|syntax|unexpected|invalid|unexpected token|not defined/i.test(l));
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
  try { st = await fsp.stat(absPath); } catch { return null; }
  if (!st.isFile() || st.size > 1536 * 1024) return null;
  if (c.json) {
    try { JSON.parse(await fsp.readFile(absPath, 'utf8')); return null; }
    catch (e) { return `JSON inválido: ${clip(e.message, 200)}`; }
  }
  let res;
  try {
    const r = mcpTransport.resolveCommand(c.prog, [...c.extraArgs, absPath]);
    res = await runProg(r.file, r.argv, { env: r.env, verbatim: r.verbatim, timeout: 15000 });
  } catch { return null; }   // no hay ni Node ni el checker: no se puede comprobar
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
 *  Dos reglas que evitan que esto estorbe:
 *   · un comprobador que no está en el equipo o que tarda demasiado se APARTA
 *     (se recuerda y no se vuelve a intentar), porque eso no es un error del código.
 *   · los hallazgos que caen fuera de las líneas tocadas son PREEXISTENTES: se
 *     cuentan y se dicen, pero no se le exigen.
 * --------------------------------------------------------------------------- */

const CHECK_APARTADO = new Set();   // 'id|espacio': no está instalado o no se pudo lanzar
const CHECK_LENTO = new Map();      // 'id|espacio' -> hasta cuándo no repetirlo (es caro aquí)
const CHECK_LENTO_MS = 12000;       // a partir de aquí, este comprobador estorba en cada escritura
const CHECK_APARTADO_MS = 10 * 60 * 1000;
const claveCheck = (ws, id) => id + '|' + String(ws || '');

/** Aparta un comprobador (no está en el equipo, o es demasiado caro en este proyecto). */
function apartarCheck(ws, id, ms) {
  if (ms) CHECK_LENTO.set(claveCheck(ws, id), Date.now() + ms);
  else CHECK_APARTADO.add(claveCheck(ws, id));
}

/** Lanza un comprobador del plan y devuelve su salida, o null si hay que saltarlo. */
async function lanzarCheck(ws, c, archivos) {
  const clave = claveCheck(ws, c.id);
  if (CHECK_APARTADO.has(clave)) return null;
  const hasta = CHECK_LENTO.get(clave);
  if (hasta && Date.now() < hasta) return null;
  const prog = c.clase === 'py-modulo' ? 'python' : (c.clase === 'node-entrada' ? 'node' : c.prog);
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
    res = await runProg(r.file, r.argv, { env: r.env, verbatim: r.verbatim, timeout: c.timeoutMs || 20000, cwd: ws });
  } catch { apartarCheck(ws, c.id); return null; }
  if (diagnosticos.pareceFalloDeHerramienta(res)) { apartarCheck(ws, c.id); return null; }
  const ms = Date.now() - t0;
  if (ms > CHECK_LENTO_MS) apartarCheck(ws, c.id, CHECK_APARTADO_MS);
  return res;
}

/**
 * Pasa los comprobadores del proyecto sobre los archivos recién escritos.
 * @returns {{texto: string, errores: number}} `errores` = hallazgos NUEVOS de tipo error.
 */
async function revisarEstatico(ws, archivos) {
  if (!ws) return { texto: '', errores: 0 };
  let checks = [];
  try { checks = diagnosticos.planPorArchivos(ws, archivos); } catch { return { texto: '', errores: 0 }; }
  if (!checks.length) return { texto: '', errores: 0 };
  const lineasDe = (abs) => cambios.lineasCambiadas(ws, abs);
  const partes = [];
  let errores = 0;
  for (const c of checks) {
    let res = null;
    try { res = await lanzarCheck(ws, c, archivos); } catch { res = null; }
    if (!res) continue;
    const salida = String(res.stdout || '') + (String(res.stderr || '').trim() ? '\n' + String(res.stderr) : '');
    if (!salida.trim()) continue;
    let parsed = { hallazgos: [], sinUbicar: 0 };
    try { parsed = diagnosticos.parsear(salida, { formato: c.formato, raiz: ws, herramienta: c.etiqueta }); } catch { continue; }
    const clas = diagnosticos.clasificar(parsed.hallazgos, { lineasDe });
    if (!clas.nuevos.length && !clas.preexistentes.length) continue;
    errores += clas.nuevos.filter(h => h.severidad === 'error').length;
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
 */
async function ejecutarComandoVerificacion(comando, { cwd, timeoutMs = 300000, registerKillable } = {}) {
  return run(String(comando), { cwd, timeout: timeoutMs, registerKillable, maxBuffer: 8 * 1024 * 1024 });
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
    return `${etiqueta}: ${r.error}; ignorando la sangría aparece en ${cs.length} sitios (líneas ${cs.map(x => x.linea).join(', ')}). Añade más contexto para que sea único.`;
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

async function resultadoEscritura(absPath, okText, { checked = [], workspace = null, settings = null } = {}) {
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
    try { h = await ejecutarHook(plantillaHook, { ws: workspace, archivos }); } catch { h = null; }
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
  try { est = await revisarEstatico(workspace, archivos); } catch { est = { texto: '', errores: 0 }; }
  if (!est.texto) return conHook(`OK: ${okText}`);
  if (est.errores) {
    return conHook(`Error: ${okText}, y la comprobación del proyecto encontró ${est.errores} error(es) en eso:\n${est.texto}\nEl archivo queda escrito: arréglalo antes de seguir con otra cosa.`);
  }
  return conHook(`OK: ${okText}\n${est.texto}`);
}

const clip = (s, n = 8000) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n...[truncado, ${s.length} caracteres]` : s;
};

const MEDIA_KEYS = { play_pause: 0xB3, next: 0xB0, previous: 0xB1, volume_up: 0xAF, volume_down: 0xAE, mute: 0xAD };

async function sendVK(vk, registerKillable) {
  const ps = `
Add-Type -Namespace J -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);'
[J.K]::keybd_event(${vk},0,0,[UIntPtr]::Zero); Start-Sleep -m 40; [J.K]::keybd_event(${vk},0,2,[UIntPtr]::Zero)`;
  return run(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { timeout: 15000, registerKillable });
}

// ---- File helpers -------------------------------------------------------

/** ¿Existe y es una carpeta? Para no confundir «vacío» con «no pude leerlo». */
async function isDir(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

async function walk(root, depth, maxDepth, out, budget) {
  if (depth > maxDepth || out.length >= budget.count) return;
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= budget.count) return;
    if (['node_modules', '.git', '$RECYCLE.BIN', 'AppData'].includes(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      out.push('  '.repeat(depth) + e.name + '/');
      await walk(full, depth + 1, maxDepth, out, budget);
    } else {
      let size = '';
      try { size = ' (' + Math.round(e.size === undefined ? (fs.statSync(full).size) : e.size) + ' b)'; } catch {}
      out.push('  '.repeat(depth) + e.name + size);
    }
  }
}

async function searchIn(dir, regex, searchContent, out, budget, depth = 0, maxDepth = 12) {
  // Tope de profundidad como en walk(): sin él, un árbol con un ciclo (junction)
  // volvía a recorrer las mismas carpetas para siempre y colgaba la búsqueda.
  if (depth > maxDepth) return;
  if (out.length >= budget.count || budget.files >= 20000) return;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= budget.count || budget.files >= 20000) return;
    if (['node_modules', '.git', 'AppData'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { await searchIn(full, regex, searchContent, out, budget, depth + 1, maxDepth); continue; }
    budget.files++;
    if (regex.test(e.name)) out.push(`NOMBRE: ${full}`);
    if (!searchContent || out.length >= budget.count) continue;
    try {
      const st = await fsp.stat(full);
      if (st.size > 512 * 1024) continue;
      const buf = Buffer.alloc(8192);
      const fd = await fsp.open(full, 'r');
      const { bytesRead } = await fd.read(buf, 0, 8192, 0);
      await fd.close();
      if (buf.subarray(0, bytesRead).includes(0)) continue;
      const text = await fsp.readFile(full, 'utf8');
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) { out.push(`${full}:${i + 1}: ${clip(lines[i].trim(), 200)}`); if (out.length >= budget.count) break; }
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
      const m = memory.add({
        text: args.text,
        source: 'agent',
        importance: Number.isFinite(Number(args.importance)) ? Number(args.importance) : 0.6,
        confidence: Number.isFinite(Number(args.confidence)) ? Number(args.confidence) : 0.8,
      });
      return m ? `OK: recuerdo guardado (importancia ${m.importance}). Estará disponible en conversaciones futuras.` : 'Error: no pude guardar el recuerdo (texto vacío).';
    }
    case 'use_skill': {
      const s = await skills.getSkill(args.name || '');
      if (!s) return `Error: skill "${args.name}" no encontrada. Skills disponibles: ${(await skills.listSkills()).filter(x => x.enabled).map(x => x.name).join(', ') || '(ninguna)'}`;
      /* v2.2: el cuerpo completo se manda UNA vez por turno. Si el modelo la vuelve a
         pedir (pasa en tareas largas: se le olvida que la cargó), ya está en el contexto y
         repetirla son miles de tokens por nada. Se recuerda por turno en el propio agente
         (`loadedSkills`), que es el único que sabe cuándo empieza uno nuevo. */
      if (ctx.loadedSkills && ctx.loadedSkills.has(s.id)) {
        return `La skill «${s.name}» ya está cargada en este turno: sigue sus instrucciones (no hace falta que te la repita).`;
      }
      if (ctx.loadedSkills) ctx.loadedSkills.add(s.id);
      // límite declarado de herramientas (informativo para el agente; los permisos reales los decide el usuario en Ajustes)
      const scope = s.allowTools ? `\n\nHERRAMIENTAS AUTORIZADAS POR ESTA SKILL: ${s.allowTools}. Evita usar otras salvo necesidad justificada.` : '';
      return `# Skill: ${s.name}\n\n${s.body}${scope}`;
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
      // chcp 65001 fuerza UTF-8 en cmd.exe para que los acentos no lleguen corruptos
      const r = await run(`chcp 65001>nul & ${args.command}`, { cwd: args.cwd ? inWs(args.cwd) : workspace, timeout, registerKillable: ctx.registerKillable });
      return `exit=${r.code}\nSTDOUT:\n${clip(r.stdout)}\nSTDERR:\n${clip(r.stderr, 3000)}`;
    }
    case 'read_file': {
      const p = inWs(args.path);
      let st;
      try { st = await fsp.stat(p); }
      catch (e) { return `Error: no pude leer ${p} (${e.code || e.message}).`; }
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
      let st;
      try { st = await fsp.stat(p); }
      catch (e) { return `Error: no pude abrir ${p} (${e.code || e.message}).`; }
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
      const content = String(args.content ?? '');
      await fsp.mkdir(path.dirname(p), { recursive: true });
      // tmp + rename: writeFile trunca el destino al abrirlo, así que un cierre o
      // un disco lleno a mitad dejaba el fichero del usuario cortado y sin copia.
      // Es el mismo patrón que ya usan checkpoints, memoria y hábitos.
      const tmp = p + '.sagi-tmp';
      // v2.4: pre-imagen para poder REVISAR el cambio después (ver cambios.js)
      cambios.recordar(workspace, p);
      try {
        await fsp.writeFile(tmp, content, 'utf8');
        await fsp.rename(tmp, p);
      } catch (e) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
      repomap.invalidar(workspace);
      busqueda.invalidar(workspace);   // el índice de búsqueda también se queda viejo
      return await resultadoEscritura(p, `${content.length} bytes escritos en ${p}`, { workspace, settings });
    }
    case 'edit_file': {
      const p = inWs(args.path);
      const oldStr = String(args.old_string ?? '');
      const newStr = String(args.new_string ?? '');
      if (!oldStr) return 'Error: old_string es obligatorio y no puede estar vacío.';
      let buf;
      try { buf = await fsp.readFile(p); }
      catch (e) { return `Error: no pude leer ${p} (${e.code === 'ENOENT' ? 'no existe; para crear el archivo usa write_file' : (e.code || e.message)}).`; }
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
      cambios.recordar(workspace, p, text);
      await fsp.writeFile(p, r.texto, 'utf8');
      repomap.invalidar(workspace);
      busqueda.invalidar(workspace);   // el índice de búsqueda también se queda viejo
      const relato = `${r.veces} reemplazo(s) en ${p}` + (r.modo === 'tolerante'
        ? ` — el anclaje no coincidía al carácter: aplicado sobre las líneas ${r.linea}-${r.linea + r.lineas - 1} reajustando la sangría al archivo`
        : '');
      return await resultadoEscritura(p, relato, { workspace, settings });
    }
    /* v2.4: mapa del repositorio e índice de símbolos. En un proyecto grande, leer
       archivo a archivo se come el contexto y aun así se pierden cosas; esto responde
       «¿qué hay aquí?» y «¿dónde se define X?» sin abrir nada. */
    case 'repo_map': {
      const dir = args.path ? inWs(args.path) : workspace;
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
       llamadas y un archivo a medias si la tercera fallaba. */
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
        const oldStr = String((c && c.old_string) ?? '');
        const newStr = String((c && c.new_string) ?? '');
        if (!oldStr) { errores.push(`${c && c.path}: old_string vacío`); continue; }
        let texto;
        try { texto = await fsp.readFile(p, 'utf8'); }
        catch (e) { errores.push(`${c.path}: no pude leerlo (${e.code || e.message})`); continue; }
        // v3.0: el mismo anclaje tolerante que edit_file, por cambio y para todo el parche
        const r = edicion.aplicar(texto, oldStr, newStr, {
          replaceAll: !!c.replace_all,
          tolerar: c.tolerar_espacios === true || args.tolerar_espacios === true,
        });
        if (!r.ok) { errores.push(detalleEdicion(c.path, texto, r)); continue; }
        if (planes.some(x => x.p === p)) { errores.push(`${c.path}: dos cambios sobre el mismo archivo en una llamada (junta el texto en uno)`); continue; }
        planes.push({ p, antes: texto, despues: r.texto, n: r.veces, modo: r.modo, linea: r.linea, lineas: r.lineas });
      }
      if (errores.length) {
        return `Error: no se ha escrito NADA (el parche se aplica entero o no se aplica):\n- ${errores.join('\n- ')}`;
      }
      for (const plan of planes) { cambios.recordar(workspace, plan.p, plan.antes); await fsp.writeFile(plan.p, plan.despues, 'utf8'); }
      repomap.invalidar(workspace);
      busqueda.invalidar(workspace);   // el índice de búsqueda también se queda viejo
      const resumen = planes.map(pl => `${path.basename(pl.p)} (${pl.n}${pl.modo === 'tolerante' ? ', sangría reajustada' : ''})`).join(', ');
      return await resultadoEscritura(planes[0].p, `${planes.length} archivo(s) actualizados: ${resumen}`, { checked: planes.map(x => x.p), workspace, settings });
    }
    case 'list_dir': {
      const root = inWs(args.path);
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
      let regex;
      try { regex = new RegExp(args.pattern, 'i'); }
      catch { return 'Error: patrón de búsqueda inválido (no es una expresión regular válida). Simplifícalo: "informe", "config.*json", "function\\s+nombre"…'; }
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
      if (/["&|^<>%\r\n]/.test(n)) return 'Error: el nombre de la aplicación no puede contener comillas ni metacaracteres de cmd (" & | ^ < > %) ni saltos de línea.';
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
      if (args.action === 'write') { clipboard.writeText(args.text || ''); return 'OK: portapapeles actualizado'; }
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
      const cmd = args.action === 'show_desktop'
        ? `powershell -NoProfile -Command "(New-Object -ComObject Shell.Application).ToggleDesktop()"`
        : `powershell -NoProfile -Command "(New-Object -ComObject Shell.Application).MinimizeAll()"`;
      await run(cmd, { timeout: 15000, registerKillable: ctx.registerKillable });
      return `OK: ${args.action}`;
    }
    case 'system_info': {
      const nets = os.networkInterfaces();
      const ips = Object.values(nets).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
      const total = os.totalmem(), free = os.freemem();
      return [
        `SO: ${os.type()} ${os.release()} (${os.arch()})`,
        `Host: ${os.hostname()} | Usuario: ${os.userInfo().username}`,
        `CPU: ${os.cpus()[0]?.model} x${os.cpus().length}`,
        `RAM: ${(total / 1e9).toFixed(1)} GB total, ${(free / 1e9).toFixed(1)} GB libres`,
        `Uptime: ${(os.uptime() / 3600).toFixed(1)} h`,
        `IPs: ${ips.join(', ') || 'ninguna'}`,
        `Escritorio: ${path.join(home, 'Desktop')}`
      ].join('\n');
    }
    default:
      return `Error: herramienta desconocida "${name}"`;
  }
}

module.exports = {
  executeTool, openUrlAllowed, ejecutarComandoVerificacion, ejecutarHook, revisarEstatico, revisarSintaxis,
  /* Solo para las pruebas: el estado adaptativo (lo que se ha apartado) no debe
     arrastrarse entre casos. */
  __test: { _resetChecks: () => { CHECK_APARTADO.clear(); CHECK_LENTO.clear(); } },
};
