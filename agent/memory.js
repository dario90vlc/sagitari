'use strict';

/* Memoria avanzada de SAGITARI (v1.2 — bloque PRIORIDAD MÁXIMA del roadmap).
   Sustituye al memory.json plano por un almacén con metadata y SELECCIÓN POR
   RELEVANCIA: al system prompt solo entran los recuerdos que aplican a la
   conversación actual, no los 30 primeros.

   Cada recuerdo:
     { id, text, date, lastUsed, uses, importance: 0..1, confidence: 0..1, source }

   Persistencia: %APPDATA%/SagitariAI/memory.json (mismo archivo que antes →
   los recuerdos antiguos se migran automáticamente con defaults). */

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = require('./datadir').dataDir();
let MEMORY_FILE = path.join(CONFIG_DIR, 'memory.json');
const MAX_MEMORIES = 300;         // techo duro del almacén
const MAX_IN_CONTEXT = 30;        // tope de recuerdos inyectados en el prompt

let cache = null;
let tainted = false;   // el archivo no se pudo interpretar: NO persistir un almacén vacío encima

/** Escritura atómica: escribe a .tmp y renombra, conservando el .bak anterior. */
function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text, 'utf8');
  try { fs.copyFileSync(file, file + '.bak'); } catch {}   // aún no había archivo: no es un fallo
  fs.renameSync(tmp, file);
}

/** Conserva un archivo ilegible como memory.corrupt-<ts>.json en vez de perderlo. */
function quarantine(reason) {
  const dest = MEMORY_FILE.replace(/\.json$/i, '') + '.corrupt-' + Date.now() + '.json';
  try {
    fs.renameSync(MEMORY_FILE, dest);
    console.error('memory.load: ' + reason + ' — conservado en ' + dest);
  } catch (e2) {
    console.error('memory.load: ' + reason + ' y no se pudo conservar el original: ' + e2.message);
  }
}

function load() {
  if (cache) return cache;
  let raw;
  try {
    raw = fs.readFileSync(MEMORY_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') { cache = []; return cache; }   // no existe → memoria vacía legítima
    // Error de E/S (EBUSY/EPERM transitorios de Windows): NO significa "no hay memoria".
    tainted = true;
    cache = [];
    console.error('memory.load: no se pudo leer ' + MEMORY_FILE + ': ' + e.message);
    return cache;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new SyntaxError('el contenido no es un array');
    cache = parsed.map(normalize);
  } catch (e) {
    // JSON truncado/corrupto: lo apartamos y NO dejamos que un save() lo pise con []
    tainted = true;
    cache = [];
    quarantine(e.message);
  }
  if (cache.length) prune();   // poda automática al cargar (una vez por proceso)
  return cache;
}

function save() {
  if (!cache) return;
  if (tainted && !cache.length) return;   // tras un error de lectura nunca se persiste un almacén vacío
  try {
    atomicWrite(MEMORY_FILE, JSON.stringify(cache, null, 2));
    tainted = false;
  } catch (e) { console.error('memory.save', e.message); }
}

/** Normaliza un recuerdo: migra el formato antiguo {id,text,date} rellenando metadata. */
function normalize(m) {
  return {
    id: m.id || 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: String(m.text || '').slice(0, 500),
    date: m.date || new Date().toISOString(),
    lastUsed: m.lastUsed || m.date || new Date().toISOString(),
    uses: Number(m.uses) || 0,
    importance: clamp01(m.importance !== undefined ? m.importance : 0.5),
    confidence: clamp01(m.confidence !== undefined ? m.confidence : 0.8),
    source: m.source === 'agent' || m.source === 'user' || m.source === 'habit' ? m.source : 'user',
  };
}

function clamp01(n) { n = Number(n); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5; }

/** Tokeniza en minúsculas quitando stopwords ES/EN cortas (suficiente para solapamiento léxico). */
function tokenize(s) {
  const STOP = new Set(['de', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'que', 'en', 'a', 'del', 'se', 'por', 'con', 'para', 'su', 'al', 'lo', 'como', 'mas', 'más', 'pero', 'es', 'son', 'the', 'and', 'for', 'with', 'this', 'that', 'my', 'your', 'of', 'to', 'in']);
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9ñ]+/i).filter(t => t.length >= 3 && !STOP.has(t));
}

/* ---------- scoring ---------- */

/**
 * Score de un recuerdo frente a un texto de contexto: mezcla solapamiento léxico
 * (Jaccard sobre tokens) con importancia y frescura. Determinista, sin embeddings:
 * evita introducir memoria irrelevante en el contexto.
 */
function scoreAgainst(mem, contextText) {
  const a = new Set(tokenize(contextText));
  const b = new Set(tokenize(mem.text));
  if (!a.size || !b.size) return { score: mem.importance * 0.3, overlap: 0 };
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const overlap = inter / (a.size + b.size - inter);   // Jaccard 0..1
  const ageDays = (Date.now() - Date.parse(mem.date || 0)) / 86400000;
  const freshness = 1 / (1 + ageDays / 30);            // decae con ~1 mes de constante
  return {
    overlap,
    score: overlap * 2.0 + mem.importance * 0.6 + mem.confidence * 0.2 + freshness * 0.4,
  };
}

/**
 * Recuerdos relevantes para inyectar en el prompt.
 * @param {string} contextText  texto de la petición (e historial reciente si se pasa)
 * @param {object} opts  { limit, minScore }  minScore: umbral de score (sensibilidad 0-3)
 * Devuelve [{mem, score, overlap}] ordenados por score, con solapamiento > 0;
 * si NADA solapa, cae a los más importantes (para no quedarse nunca vacío).
 */
function relevantMemories(contextText, opts = {}) {
  const list = load();
  const limit = Math.min(Math.max(opts.limit || MAX_IN_CONTEXT, 1), MAX_IN_CONTEXT);
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 0.4;
  const scored = list
    .map(m => ({ mem: m, ...scoreAgainst(m, contextText) }))
    .filter(x => x.overlap > 0 && x.score >= minScore)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
  if (scored.length) {
    // toca lastUsed/uses de los recuperados (recuerdo usado = recuerdo vivo)
    for (const s of scored) {
      s.mem.lastUsed = new Date().toISOString();
      s.mem.uses++;
    }
    save();
    return scored;
  }
  // fallback: los más importantes (nunca contexto vacío si hay memoria)
  return list
    .map(m => ({ mem: m, score: m.importance * 0.6, overlap: 0 }))
    .sort((x, y) => y.score - x.score)
    .slice(0, Math.min(5, limit));
}

/* ---------- CRUD ---------- */

function list() { return load().map(m => ({ ...m })); }

/**
 * Añade un recuerdo con metadata completa.
 * @returns el recuerdo creado. Deduplica por texto igual (refuerza en su lugar).
 */
function add({ text, source = 'user', importance = 0.5, confidence = 0.8 }) {
  const t = String(text || '').trim().slice(0, 500);
  if (!t) return null;
  const list0 = load();
  const dup = list0.find(m => m.text.toLowerCase() === t.toLowerCase());
  if (dup) { dup.importance = clamp01(Math.max(dup.importance, importance)); dup.uses++; dup.lastUsed = new Date().toISOString(); save(); return { ...dup }; }
  const m = normalize({ text: t, source, importance: clamp01(importance), confidence: clamp01(confidence) });
  list0.unshift(m);
  cache = list0.slice(0, MAX_MEMORIES);
  save();
  return { ...m };
}

function remove(id) { cache = load().filter(m => m.id !== id); save(); return { ok: true }; }

/** Actualiza metadata (importancia, confianza) desde la UI. */
function update(id, patch = {}) {
  const m = load().find(x => x.id === id);
  if (!m) return { ok: false, error: 'recuerdo no encontrado' };
  if (patch.importance !== undefined) m.importance = clamp01(patch.importance);
  if (patch.confidence !== undefined) m.confidence = clamp01(patch.confidence);
  if (patch.text !== undefined) m.text = String(patch.text).slice(0, 500);
  save();
  return { ok: true, memory: { ...m } };
}

/**
 * Poda automática (se llama al cargar): elimina lo viejo, ocioso y poco
 * importante, o lo de confianza ínfima nunca usado. Antes el predicado era
 * `confidence >= 0.2 || reciente`, y como el default es 0.8 no borraba nada.
 */
function prune(minConfidence = 0.2, olderThanDays = 180) {
  const before = load().length;
  const now = Date.now();
  const maxAge = (Number(olderThanDays) || 180) * 86400000;
  const maxIdle = 60 * 86400000;         // 2 meses sin usarse
  const lowConf = Number.isFinite(Number(minConfidence)) ? Number(minConfidence) : 0.2;
  cache = load().filter(m => {
    const created = Date.parse(m.date) || now;
    const last = Date.parse(m.lastUsed) || created;
    if (m.confidence < lowConf && m.uses === 0) return false;   // confianza ínfima y sin uso
    const old = now - created >= maxAge;
    const idle = now - last >= maxIdle;
    return !(old && idle && m.uses < 3 && m.importance < 0.6);
  });
  if (cache.length !== before) save();   // solo escribe si algo cambió
  return { removed: before - cache.length };
}

/** Para tests: reinicia el singleton apuntando a otro archivo. */
function _resetForTests(file) { cache = null; tainted = false; MEMORY_FILE = file; }

module.exports = {
  list, add, remove, update, prune, relevantMemories, scoreAgainst, tokenize,
  __file: () => MEMORY_FILE,
  __test: { _resetForTests, normalize, MAX_MEMORIES, MAX_IN_CONTEXT },
};
