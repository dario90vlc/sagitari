'use strict';

/* Aprendizaje de hábitos de SAGITARI (v2.0 — Agent OS).
   Observa (sinChain-of-thought, solo hechos de herramientas) cómo trabaja el
   usuario: aplicaciones habituales, comandos, carpetas, herramientas usadas,
   modos preferidos y decisiones de confirmación. Agrega un perfil que entra
   en el system prompt para que SAGITARI se comporte "como el usuario espera".

   Persistencia: %APPDATA%/SagitariAI/habits.json. Todo con contadores y
   decaimiento: lo que no se repite, pierde peso. */

const fs = require('fs');
const path = require('path');

let HABITS_FILE = path.join(process.env.APPDATA || require('os').homedir(), 'SagitariAI', 'habits.json');
const TOP_N = 5;          // entradas por categoría en el prompt
const MIN_COUNT = 2;      // mínimo de repeticiones para considerar un hábito
const MAX_ENTRIES = 50;   // techo por categoría (recorte del mapa persistido)
const FORGET_DAYS = 180;  // olvido por antigüedad
const CATEGORIES = ['tools', 'apps', 'commands', 'folders', 'sites'];

let _tainted = false;   // el archivo en disco no es legible/nuestro: no pisarlo

/** Escritura atómica: escribe a .tmp y renombra, conservando el .bak anterior. */
function _atomicWrite(file, text) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text, 'utf8');
  try { fs.copyFileSync(file, file + '.bak'); } catch {}   // aún no había archivo: no es un fallo
  fs.renameSync(tmp, file);
}

function _load() {
  let raw;
  try {
    raw = fs.readFileSync(HABITS_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};   // no existe → perfil vacío legítimo
    // Error de E/S transitorio (EBUSY/EPERM): no es "sin hábitos"; no persistir nada.
    _tainted = true;
    console.error('habits.load: no se pudo leer ' + HABITS_FILE + ': ' + e.message);
    return {};
  }
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new SyntaxError('el contenido no es un objeto');
    _tainted = false;
    return d;
  } catch (e) {
    // JSON truncado/corrupto: lo apartamos para no perderlo
    const dest = HABITS_FILE.replace(/\.json$/i, '') + '.corrupt-' + Date.now() + '.json';
    try {
      fs.renameSync(HABITS_FILE, dest);
      _tainted = false;   // el original ya está a salvo: se puede escribir un perfil nuevo
      console.error('habits.load: ' + e.message + ' — conservado en ' + dest);
    } catch (e2) {
      _tainted = true;
      console.error('habits.load: ' + e.message + ' y no se pudo conservar el original: ' + e2.message);
    }
    return {};
  }
}

function _save(d) {
  if (_tainted) return;   // el archivo en disco no es nuestro: no destruirlo con un perfil vacío
  try {
    _atomicWrite(HABITS_FILE, JSON.stringify(d, null, 2));
  } catch (e) { console.error('habits.save', e.message); }
}

function _bump(d, map, key, weight = 1, cat = '') {
  if (!key) return;
  const k = String(key);
  map[k] = (Number(map[k]) || 0) + weight;
  if (!cat) return;   // categorías sin olvido (modes) no necesitan marca de uso
  d.seen = d.seen || {};
  d.seen[cat + '|' + k] = Date.now();   // marca de uso para el olvido por antigüedad
}

/**
 * Recorta los mapas de cada categoría: olvida lo no usado en FORGET_DAYS y
 * conserva como mucho MAX_ENTRIES por categoría (los más frecuentes; empate
 * resuelto por clave para que el perfil sea determinista).
 */
function _prune(d) {
  const seen = d.seen && typeof d.seen === 'object' ? d.seen : {};
  const cutoff = Date.now() - FORGET_DAYS * 86400000;
  for (const cat of CATEGORIES) {
    const map = d[cat];
    if (!map || typeof map !== 'object') continue;
    d[cat] = Object.fromEntries(
      Object.entries(map)
        .filter(([, count]) => Number(count) > 0)
        .filter(([key]) => { const t = Number(seen[cat + '|' + key]); return !t || t >= cutoff; })
        .sort((a, b) => (Number(b[1]) - Number(a[1])) || String(a[0]).localeCompare(String(b[0])))
        .slice(0, MAX_ENTRIES)
    );
  }
  const alive = new Set();
  for (const cat of CATEGORIES) for (const key of Object.keys(d[cat] || {})) alive.add(cat + '|' + key);
  d.seen = Object.fromEntries(Object.entries(seen).filter(([k]) => alive.has(k)));
  return d;
}

/* ---------- observación ---------- */

/**
 * Registra un evento de uso. Llamar desde el bucle del agente.
 * @param {string} type  'tool' | 'mode' | 'confirm'
 * @param {object} ev    { name, args, approved }
 */
function observe(type, ev = {}) {
  const d = _load();
  d.version = 2;
  d.updatedAt = new Date().toISOString();
  if (type === 'tool') {
    d.tools = d.tools || {};
    _bump(d, d.tools, ev.name, 1, 'tools');
    const args = ev.args || {};
    if (ev.name === 'open_app' && args.name) { d.apps = d.apps || {}; _bump(d, d.apps, String(args.name).toLowerCase().replace(/\.exe$/, ''), 1, 'apps'); }
    if (ev.name === 'run_command' && args.command) {
      const cmd = String(args.command).trim().split(/\s+/)[0];
      if (cmd) { d.commands = d.commands || {}; _bump(d, d.commands, cmd.toLowerCase(), 1, 'commands'); }
      const cwd = String(args.cwd || '').trim();
      if (cwd) { d.folders = d.folders || {}; _bump(d, d.folders, cwd, 1, 'folders'); }
    }
    if ((ev.name === 'write_file' || ev.name === 'list_dir' || ev.name === 'read_file') && args.path) {
      const dir = String(args.path).replace(/[\\/][^\\/]*$/, '');
      if (dir) { d.folders = d.folders || {}; _bump(d, d.folders, dir, 1, 'folders'); }
    }
    if (ev.name === 'browser_control' && args.url) {
      try { const host = new URL(/^https?:/.test(args.url) ? args.url : 'https://' + args.url).hostname; d.sites = d.sites || {}; _bump(d, d.sites, host, 1, 'sites'); } catch {}
    }
  }
  if (type === 'mode') {
    d.modes = d.modes || {};
    _bump(d, d.modes, String(ev.mode || 'act').toLowerCase());
  }
  if (type === 'confirm') {
    d.confirms = d.confirms || { approved: 0, denied: 0 };
    d.confirms[ev.approved ? 'approved' : 'denied']++;
  }
  _prune(d);   // olvido por antigüedad + recorte por categoría
  _save(d);
}

/* ---------- perfil para el prompt ---------- */

function _top(map, n = TOP_N) {
  return Object.entries(map || {})
    .sort((a, b) => (Number(b[1]) - Number(a[1])) || String(a[0]).localeCompare(String(b[0])))
    .filter(([, c]) => c >= MIN_COUNT)
    .slice(0, n)
    .map(([k]) => k);
}

/** Entradas de un mapa ordenadas por frecuencia (empate resuelto por clave). */
function _sorted(map) {
  return Object.entries(map || {})
    .sort((a, b) => (Number(b[1]) - Number(a[1])) || String(a[0]).localeCompare(String(b[0])));
}

/** Perfil legible para inyectar en el system prompt (vacío si no hay datos). */
function profile() {
  const d = _load();
  const apps = _top(d.apps);
  const commands = _top(d.commands);
  const folders = _top(d.folders, 3);
  const sites = _top(d.sites, 3);
  const tools = _top(d.tools);
  const modes = _sorted(d.modes);
  const lines = [];
  if (apps.length) lines.push(`- Aplicaciones habituales: ${apps.join(', ')}.`);
  if (commands.length) lines.push(`- Comandos frecuentes: ${commands.join(', ')}.`);
  if (folders.length) lines.push(`- Carpetas de trabajo frecuentes: ${folders.join(' · ')}.`);
  if (sites.length) lines.push(`- Webs que visita a menudo: ${sites.join(', ')}.`);
  if (tools.length) lines.push(`- Herramientas que más usa: ${tools.join(', ')}.`);
  if (modes.length && modes[0][1] >= MIN_COUNT) lines.push(`- Modo de agente preferido: ${modes[0][0]}.`);
  const c = d.confirms || { approved: 0, denied: 0 };
  const total = c.approved + c.denied;
  if (total >= 5 && c.denied / total >= 0.4) lines.push('- El usuario DENIEGA muchas confirmaciones: sé conservador, explica antes de actuar.');
  return lines.join('\n');
}

/** Estadísticas para la UI. */
function stats() {
  const d = _load();
  const rows = (map, n) => _sorted(map).slice(0, n).map(([name, count]) => ({ name, count }));
  return {
    tools: rows(d.tools, 8),
    apps: rows(d.apps, 8),
    commands: rows(d.commands, 8),
    folders: rows(d.folders, 5),
    sites: rows(d.sites, 5),
    modes: d.modes || {},
    confirms: d.confirms || { approved: 0, denied: 0 },
    updatedAt: d.updatedAt || null,
  };
}

function reset() { _load(); _save({}); }
function _resetForTests(file) { HABITS_FILE = file; _tainted = false; }

module.exports = { observe, profile, stats, reset, __test: { _resetForTests, _prune, MAX_ENTRIES, FORGET_DAYS } };
