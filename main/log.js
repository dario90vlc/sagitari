'use strict';

/* Sistema de logging con niveles para SAGITARI.
   Uso: const log = require('./log'); log.info('mensaje'); log.error('error', err);
   Niveles: debug < info < warn < error. En producción solo se muestran info, warn, error. */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = process.env.SAGITARI_DEBUG ? 'debug' : 'info';

function shouldLog(level) {
  return LEVELS[level] >= LEVELS[MIN_LEVEL];
}

function format(level, args) {
  const ts = new Date().toISOString();
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  return `[${ts}] [${level.toUpperCase()}] ${msg}`;
}

function log(level, ...args) {
  if (!shouldLog(level)) return;
  const line = format(level, args);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = {
  debug: (...args) => log('debug', ...args),
  info: (...args) => log('info', ...args),
  warn: (...args) => log('warn', ...args),
  error: (...args) => log('error', ...args),
};
