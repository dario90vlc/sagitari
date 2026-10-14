'use strict';

/* Sistema de logging con niveles para SAGITARI.
   Uso: const log = require('./log'); log.info('mensaje'); log.error('error', err);
   Niveles: debug < info < warn < error. En producción solo se muestran info, warn, error.

   Además de la consola (visible en desarrollo), cada línea se ANEXA a un fichero bajo el
   directorio de datos de la app (`logs/sagitari.log`): la app empaquetada es una GUI sin
   consola adjunta, así que el aviso de cifrado de claves y el de «claves en claro»
   (main.js) se perdían sin dejar rastro. La escritura es best-effort: si el disco
   falla, el log no puede tumbar la app. No se registran secretos: es la misma línea que
   ya iba a consola, sin tocar los argumentos. */

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = process.env.SAGITARI_DEBUG ? 'debug' : 'info';

const TAM_MAX_LOG = 2 * 1024 * 1024; // 2 MB: se rota a .old al abrir, para no crecer sin fin
let logFile = null; // ruta del fichero, o false si no se pudo preparar

function shouldLog(level) {
  return LEVELS[level] >= LEVELS[MIN_LEVEL];
}

function format(level, args) {
  const ts = new Date().toISOString();
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  return `[${ts}] [${level.toUpperCase()}] ${msg}`;
}

/* Ruta del fichero de log (perezosa y memoizada). Se calcula UNA vez: cambiar de
   directorio de datos en caliente no es un caso real y ahorra una comprobación por línea. */
function rutaLog() {
  if (logFile !== null) return logFile;
  try {
    const dirDatos = process.env.SAGITARI_DATA_DIR;
    if (!dirDatos) {
      logFile = false;
      return logFile;
    }
    const dir = path.join(dirDatos, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'sagitari.log');
    try {
      if (fs.statSync(f).size > TAM_MAX_LOG) fs.renameSync(f, f + '.old');
    } catch {}
    logFile = f;
  } catch {
    logFile = false;
  }
  return logFile;
}

function log(level, ...args) {
  if (!shouldLog(level)) return;
  const line = format(level, args);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  try {
    const f = rutaLog();
    if (f) fs.appendFileSync(f, line + '\n', 'utf8');
  } catch {}
}

module.exports = {
  debug: (...args) => log('debug', ...args),
  info: (...args) => log('info', ...args),
  warn: (...args) => log('warn', ...args),
  error: (...args) => log('error', ...args),
};
