'use strict';

/* Model Router + Fallback + Model Health de SAGITARI (v1.6).
   Puro Node, sin I/O de red → testeable.

   - ROUTER: clasifica una tarea en una categoría y elige el modelo adecuado
     de un mapping configurable (userSettings.models por categoría).
   - FALLBACK: dada la config (config.providers + config.fallbackChain),
     produce la lista de cfgs a intentar en orden: primario → secundarios →
     proveedores locales (Ollama/LM Studio). La tarea continúa si un proveedor
     cae y hay local disponible.
   - HEALTH: registro persistente de latencia/errores/tokens/coste por modelo
     (runs.json) con resumen para el panel Model Health. */

const fs = require('fs');
const path = require('path');
const protocols = require('./protocols');

/* ---------- categorías y clasificación ---------- */

const CATEGORIES = ['simple', 'coding', 'reasoning', 'vision', 'browser', 'research', 'complex'];

function classify(goal, opts = {}) {
  const t = String(goal || '').toLowerCase();
  const has = (rx) => rx.test(t);
  if (opts.hasImage) return 'vision';
  // stems sin \b final: casan con inflexiones españolas ("investiga", "código")
  if (has(/\b(cod|program|script|funci|bug|error|compil|refactor|test|debug|api|css|html|python|javascript|node|sql)/)) return 'coding';
  if (has(/\b(navega|navegador|browser|web\b|url\b|pagina|p.gina|chrome|edge|clic|formulario)/)) return 'browser';
  if (has(/\b(investig|busca|search|research|compar|analiza|fuentes)/)) return 'research';
  if (has(/\b(razona|piensa|estrategi|plan\b|planif|dilema|decide|argument)/)) return 'reasoning';
  if (has(/\b(informe|proyecto|pipeline|multipaso|varias tareas|organiza todo)/) || t.length > 240) return 'complex';
  return 'simple';
}

/* ---------- fallback chain ---------- */

const LOCAL_PRESETS = ['ollama', 'lmstudio'];

/**
 * Devuelve la lista de proveedores en orden de intento:
 *   [primario, ...secundarios ordenados, ...locales disponibles]
 * @param {object} config  { providers: [...], active: {providerId,...}, settings: {} }
 * @param {string} category  categoría clasificada (para priorizar modelos adecuados)
 */
function fallbackChain(config, category) {
  const providers = (config && config.providers) || [];
  const active = config && config.active;
  const manual = (config && config.fallbackChain) || [];   // providerIds en orden (opcional)
  const byId = Object.fromEntries(providers.map(p => [p.id, p]));
  const out = [];
  const push = (p, role) => {
    if (!p || !p.baseUrl) return;
    if (out.some(x => x.providerId === p.id)) return;
    // El modelo ELEGIDO por el usuario manda (active.model / activeModel):
    // pickModelFor solo rellena cuando el proveedor no tiene elección explícita.
    // Antes se reelegía SIEMPRE por categoría y una petición «simple» cambiaba
    // en silencio p. ej. mimo-v2.5 por deepseek-flash (coincidía con /flash/):
    // el usuario probaba un modelo, la app pedía otro, y «ese modelo no va».
    const model = (!p.activeModel && category && p.models && pickModelFor(p.models, category)) || (p.activeModel && p.models && p.models.includes(p.activeModel) ? p.activeModel : (p.models && p.models[0]) || p.activeModel);
    if (!model) return;
    // cada entrada viaja con su protocolo (chat/completions, messages o responses)
    const format = protocols.detectFormat({ baseUrl: p.baseUrl, providerId: p.id, model, format: p.format });
    out.push({ providerId: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, model, role, format });
  };
  // 1) activo (primario) — conserva el formato forzado en Ajustes, si lo hay
  const saved = (active && byId[active.providerId]) || {};
  const activeProv = active && {
    ...saved,
    id: active.providerId || saved.id,
    name: active.name || saved.name,
    baseUrl: active.baseUrl || saved.baseUrl,
    apiKey: active.apiKey,
    models: saved.models || [active.model],
    activeModel: active.model,
    format: active.format || saved.format,
  };
  push(activeProv, 'primary');
  // 2) orden manual del usuario
  for (const id of manual) push(byId[id], 'secondary');
  const isLocal = (p) => LOCAL_PRESETS.some(l => String(p.id || '').toLowerCase().includes(l) || String(p.baseUrl || '').toLowerCase().includes(l));
  // 3) resto de proveedores cloud guardados
  for (const p of providers) {
    if (isLocal(p)) continue;
    push(p, 'secondary');
  }
  // 4) locales al final (Ollama/LM Studio) — la red de salvamento
  for (const p of providers) {
    if (isLocal(p)) push(p, 'local');
  }
  // active puede no estar en providers (custom inline): asegúralo primero
  return out;
}

/** Elige el modelo más adecuado de una lista para una categoría. */
function pickModelFor(models, category) {
  const list = (models || []).map(String);
  if (!list.length) return null;
  const prefer = {
    coding: /(cod|qwen.*coder|deepseek|devstral|starcoder|gpt-5|claude)/i,
    reasoning: /(r1|o1|o3|reason|think|gpt-5|claude|gemini)/i,
    vision: /(vision|vl|4o|gpt-5|llava|gemini|pixtral)/i,
    browser: /(mini|flash|fast|haiku|4o|gpt-5-mini)/i,
    research: /(flash|mini|haiku|fast|sonnet|gpt-5)/i,
    complex: /(gpt-5|opus|sonnet|gemini|deepseek)/i,
    simple: /(mini|flash|haiku|8b|small|fast)/i,
  }[category];
  if (prefer) {
    const m = list.find(id => prefer.test(id));
    if (m) return m;
  }
  return list[0];
}

/* ---------- health ---------- */

let HEALTH_FILE = path.join(require('./datadir').dataDir(), 'model-health.json');

/* El fichero se lee una vez y se mantiene en memoria: `record()` corre en cada
   llamada al modelo y no debe releer ni reescribir el JSON entero cada vez. */
let _cache = null;
let _tainted = false;   // no se pudo leer el fichero: no se pisa con el almacén vacío

function _load() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
  } catch (e) {
    // Un fichero ilegible no puede acabar pisado por un almacén vacío: se aparta
    // con marca de tiempo (mismo criterio que memory.js y habits.js) para no
    // perder el histórico de salud de los modelos. Si la cuarentena tampoco se
    // puede hacer (permisos, fichero bloqueado), la marca impide que el siguiente
    // record() reescriba el histórico con lo poco de esta sesión.
    if (e && e.code !== 'ENOENT') {
      _tainted = true;
      try { fs.renameSync(HEALTH_FILE, HEALTH_FILE + '.corrupt-' + Date.now()); } catch {}
    }
    _cache = {};
  }
  return _cache;
}

/* Escritura atómica: un corte a mitad no debe truncar las estadísticas. */
function _save(data) {
  if (_tainted) return;
  try {
    fs.mkdirSync(path.dirname(HEALTH_FILE), { recursive: true });
    const tmp = HEALTH_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, HEALTH_FILE);
  } catch {}
}

/** Registra una llamada a un modelo. ok=false con error cuenta como fallo. */
function record(model, { ok, durationMs, tokens, error, fallbackFrom, costUsd }) {
  const data = _load();
  const m = data[model] || { calls: 0, errors: 0, totalLatencyMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, fallbacks: 0, lastError: null, lastUsed: null };
  m.calls++;
  if (durationMs) m.totalLatencyMs += durationMs;
  if (tokens) { m.tokensIn += tokens.prompt_tokens || 0; m.tokensOut += tokens.completion_tokens || 0; }
  // el coste por modelo sólo se calculaba por ejecución y en memoria: el panel
  // Model Health publicaba siempre $0.0000
  if (costUsd) m.costUsd = (Number(m.costUsd) || 0) + Number(costUsd);
  if (!ok) {
    m.errors++;
    m.lastError = String(error || 'error').slice(0, 300);
    if (fallbackFrom) m.fallbacks++;
  }
  // El resultado de la ÚLTIMA llamada, aparte de los totales: la píldora del
  // sidebar tiene que describir el estado actual, no el historial de por vida
  // (con solo los acumulados, un modelo que falló 100 veces sigue «Con errores»
  // para siempre aunque hoy funcione).
  m.lastOk = !!ok;
  m.lastUsed = new Date().toISOString();
  data[model] = m;
  _save(data);
  return m;
}

/** Resumen por modelo para el panel: latencia media, tasa de error, etc. */
function summary() {
  const data = _load();
  return Object.entries(data).map(([model, m]) => ({
    model,
    calls: m.calls,
    errors: m.errors,
    errorRate: m.calls ? +(m.errors / m.calls).toFixed(3) : 0,
    avgLatencyMs: m.calls ? Math.round(m.totalLatencyMs / m.calls) : null,
    tokensIn: m.tokensIn,
    tokensOut: m.tokensOut,
    costUsd: +Number(m.costUsd || 0).toFixed(4),
    fallbacks: m.fallbacks || 0,
    lastError: m.lastError,
    lastOk: typeof m.lastOk === 'boolean' ? m.lastOk : null,
    lastUsed: m.lastUsed,
  })).sort((a, b) => b.calls - a.calls);
}

/** Para tests: redirige el fichero. */
function _resetForTests(file) { HEALTH_FILE = file; _cache = null; _tainted = false; }

module.exports = { CATEGORIES, classify, fallbackChain, pickModelFor, record, summary, _resetForTests };
