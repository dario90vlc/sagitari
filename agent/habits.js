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

function _load() {
  try {
    const d = JSON.parse(fs.readFileSync(HABITS_FILE, 'utf8'));
    return d && typeof d === 'object' ? d : {};
  } catch { return {}; }
}
function _save(d) {
  try {
    fs.mkdirSync(path.dirname(HABITS_FILE), { recursive: true });
    fs.writeFileSync(HABITS_FILE, JSON.stringify(d, null, 2), 'utf8');
  } catch {}
}

function _bump(map, key, weight = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + weight;
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
    _bump(d.tools, ev.name);
    const args = ev.args || {};
    if (ev.name === 'open_app' && args.name) { d.apps = d.apps || {}; _bump(d.apps, String(args.name).toLowerCase().replace(/\.exe$/, '')); }
    if (ev.name === 'run_command' && args.command) {
      const cmd = String(args.command).trim().split(/\s+/)[0];
      if (cmd) { d.commands = d.commands || {}; _bump(d.commands, cmd.toLowerCase()); }
      const cwd = String(args.cwd || '').trim();
      if (cwd) { d.folders = d.folders || {}; _bump(d.folders, cwd); }
    }
    if ((ev.name === 'write_file' || ev.name === 'list_dir' || ev.name === 'read_file') && args.path) {
      const dir = String(args.path).replace(/[\\/][^\\/]*$/, '');
      if (dir) { d.folders = d.folders || {}; _bump(d.folders, dir); }
    }
    if (ev.name === 'browser_control' && args.url) {
      try { const host = new URL(/^https?:/.test(args.url) ? args.url : 'https://' + args.url).hostname; d.sites = d.sites || {}; _bump(d.sites, host); } catch {}
    }
  }
  if (type === 'mode') {
    d.modes = d.modes || {};
    _bump(d.modes, String(ev.mode || 'act').toLowerCase());
  }
  if (type === 'confirm') {
    d.confirms = d.confirms || { approved: 0, denied: 0 };
    d.confirms[ev.approved ? 'approved' : 'denied']++;
  }
  _save(d);
}

/* ---------- perfil para el prompt ---------- */

function _top(map, n = TOP_N) {
  return Object.entries(map || {})
    .sort((a, b) => b[1] - a[1])
    .filter(([, c]) => c >= MIN_COUNT)
    .slice(0, n)
    .map(([k]) => k);
}

/** Perfil legible para inyectar en el system prompt (vacío si no hay datos). */
function profile() {
  const d = _load();
  const apps = _top(d.apps);
  const commands = _top(d.commands);
  const folders = _top(d.folders, 3);
  const sites = _top(d.sites, 3);
  const tools = _top(d.tools);
  const modes = Object.entries(d.modes || {}).sort((a, b) => b[1] - a[1]);
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
  return {
    tools: Object.entries(d.tools || {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count })),
    apps: Object.entries(d.apps || {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count })),
    commands: Object.entries(d.commands || {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count })),
    folders: Object.entries(d.folders || {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count })),
    sites: Object.entries(d.sites || {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count })),
    modes: d.modes || {},
    confirms: d.confirms || { approved: 0, denied: 0 },
    updatedAt: d.updatedAt || null,
  };
}

function reset() { _save({}); }
function _resetForTests(file) { HABITS_FILE = file; }

module.exports = { observe, profile, stats, reset, __test: { _resetForTests } };
