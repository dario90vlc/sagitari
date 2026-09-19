'use strict';

/* Sistema de skills estilo "SKILL.md" (como los agent skills de GitHub):
   cada skill vive en %APPDATA%/SagitariAI/skills/<nombre>/SKILL.md con front-matter:
     ---
     name: mi-skill
     description: Qué hace y CUÁNDO usarla (esta línea viaja siempre en el prompt)
     agents:            # opcional: a qué agentes se le ofrece la skill
       - coding         # (orchestrator, research, browser, coding, file, vision, verification)
       - '*'
     ---
     ...instrucciones completas (solo se cargan bajo demanda con use_skill)...

   Ahorro de tokens: al prompt solo va el ÍNDICE (nombre + description de cada skill).
   El cuerpo completo (que puede ser largo) se inyecta UNA VEZ solo cuando el agente
   decide que la skill es relevante, vía la herramienta use_skill.

   v2.1: las skills se reparten POR AGENTE (`agents:`). El orquestador solo ve las
   suyas y cada subagente solo las de su especialidad: menos ruido en el prompt,
   menos tokens y menos confusión (una skill de navegación no le sirve al de
   verificación). Sin `agents:` la skill aplica a todos, como siempre. */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

let SKILLS_DIR = path.join(require('./datadir').dataDir(), 'skills');

function parseFrontMatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const meta = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase();
    let val = kv[2].trim();
    // lista YAML ("- item" en las líneas siguientes) → array
    if (val === '' && lines[i + 1] !== undefined && /^\s+-\s+\S/.test(lines[i + 1])) {
      const list = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+\S/.test(lines[j])) {
        list.push(lines[j].replace(/^\s+-\s+/, '').trim().replace(/^"|"$/g, ''));
        j++;
      }
      i = j - 1;
      meta[key] = list;
      continue;
    }
    // bloque YAML (>, |, >-, |-…): consume y une las líneas indentadas siguientes
    if (/^[>|][+-]?\d*$/.test(val)) {
      const block = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].startsWith(' ') || lines[j].startsWith('\t') || lines[j] === '')) {
        block.push(lines[j].trim());
        j++;
      }
      i = j - 1;
      val = block.filter(Boolean).join(' ');
    } else {
      const q = val.match(/^"([\s\S]*)"$|^'([\s\S]*)'$/);
      if (q) val = q[1] !== undefined ? q[1] : q[2];
    }
    meta[key] = val;
  }
  return { meta, body: m[2].trim() };
}

/** Carpeta del almacén, creándola la primera vez. El mkdir se hace UNA vez: antes se
    repetía en cada llamada (y `skillsDir()` está en todos los caminos del módulo). */
let DIR_LISTO = false;
function skillsDir() {
  if (!DIR_LISTO) {
    try { fs.mkdirSync(SKILLS_DIR, { recursive: true }); } catch {}
    DIR_LISTO = true;
  }
  return SKILLS_DIR;
}

/* ---------- índice en memoria (v2.2) ----------
   Antes CADA prompt releía y reparseaba el almacén entero: el system prompt (por turno),
   las skills sugeridas (por turno), y otra vez los dos por cada delegación, más `use_skill`
   y la pantalla de Skills. Con 20-50 skills instaladas eso son cientos de lecturas y
   `JSON.parse` por turno en el hilo principal de Electron —el mismo que mueve el navegador
   y la voz—.

   Ahora hay UN índice en memoria que comparten el prompt, las sugerencias, `use_skill` y la
   interfaz. Se invalida de dos formas:
     · explícita: cualquier mutación de este módulo (instalar, crear, borrar, activar,
       actualizar) llama a `invalidarIndice()`;
     · por huella: antes de reutilizarlo se calcula una firma BARATA del almacén (nombres +
       mtime/tamaño de los ficheros que pueden cambiar) que detecta lo editado FUERA de la
       app —la carpeta está abierta al usuario desde Ajustes— sin leer ni parsear nada.
   Coste por consulta: un `readdir` y dos `stat` por skill, frente a las tres lecturas más
   el parseo de antes. */
let INDEX_CACHE = null;   // { dir, firma, skills }
let INDEX_LECTURAS = 0;   // lecturas reales del almacén (se comprueba en los tests)

function invalidarIndice() { INDEX_CACHE = null; }

/** Firma barata del almacén. `''` si todavía no existe. */
function firmaDelAlmacen(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
  const partes = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    partes.push(e.name);
    for (const f of ['SKILL.md', 'enabled.json']) {
      try {
        const st = fs.statSync(path.join(dir, e.name, f));
        partes.push(f + ':' + st.mtimeMs + ':' + st.size);
      } catch { partes.push(f + ':-'); }
    }
  }
  return partes.join('|');
}

/** Índice completo del almacén (síncrono: lo usa el system prompt, que no puede esperar). */
function indexSkills() {
  const dir = skillsDir();
  if (INDEX_CACHE && INDEX_CACHE.dir === dir && firmaDelAlmacen(dir) === INDEX_CACHE.firma) {
    return INDEX_CACHE.skills;
  }
  const skills = leerSkillsSync(dir);
  INDEX_LECTURAS++;
  // la firma se toma DESPUÉS de leer: si algo cambió mientras leíamos, la próxima
  // consulta lo detecta en vez de quedarse con la foto vieja
  INDEX_CACHE = { dir, firma: firmaDelAlmacen(dir), skills };
  return skills;
}

/** Lee y parsea el almacén entero (solo lo hace `indexSkills`, una vez por cambio). */
function leerSkillsSync(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(dir, e.name, 'SKILL.md');
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const fm = parseFrontMatter(raw);
    if (!fm || !fm.meta.name) continue;
    let enabled = true;
    try { enabled = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'enabled.json'), 'utf8')).enabled !== false; } catch {}
    let source = null;
    try { source = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'source.json'), 'utf8')); } catch {}
    out.push({
      id: e.name,
      name: fm.meta.name,
      description: fm.meta.description || '',
      version: fm.meta.version || '',
      author: fm.meta.author || '',
      category: fm.meta.category || '',
      compatibility: fm.meta.compatibility || fm.meta.compatible || '',
      dependencies: Array.isArray(fm.meta.dependencies) ? fm.meta.dependencies : (fm.meta.dependencies ? [String(fm.meta.dependencies)] : []),
      examples: Array.isArray(fm.meta.examples) ? fm.meta.examples : (fm.meta.examples ? [String(fm.meta.examples)] : []),
      triggers: Array.isArray(fm.meta.triggers) ? fm.meta.triggers : (fm.meta.triggers ? [String(fm.meta.triggers)] : []),
      agents: Array.isArray(fm.meta.agents) ? fm.meta.agents : (fm.meta.agents ? [String(fm.meta.agents)] : []),
      allowTools: Array.isArray(fm.meta.tools) ? fm.meta.tools.join(', ') : (fm.meta.tools || ''),
      source,
      enabled,
      bodyChars: fm.body.length,
      body: fm.body
    });
  }
  return out;
}

/**
 * Resuelve la carpeta de una skill validando SIEMPRE el id (única vía para
 * construir rutas con ids que vienen de la UI o de un repo remoto).
 * Rechaza ".", "..", separadores, NUL, caracteres raros y cualquier resultado
 * que no quede DENTRO de skillsDir(). Lanza 'id de skill inválido'.
 */
function safeSkillDir(id) {
  if (typeof id !== 'string' || !id || id !== id.trim()) throw new Error('id de skill inválido');
  // "." , ".." y cualquier id formado solo por puntos: en Windows un componente
  // con puntos finales se normaliza (C:\skills\... → C:\skills), así que borrar
  // «...» podía llevarse por delante el almacén entero
  if (/^\.+$/.test(id)) throw new Error('id de skill inválido');
  if (/[\/\\\0]/.test(id)) throw new Error('id de skill inválido');
  if (!/^[\w.-]+$/.test(id)) throw new Error('id de skill inválido');
  const base = skillsDir();
  const dest = path.resolve(base, id);
  if (!dest.startsWith(base + path.sep)) throw new Error('id de skill inválido');
  return dest;
}

/** Sanea un nombre a un id de skill seguro ('SKILL.md' o '.' → ''). */
function slugifyId(name) {
  const s = String(name || '').replace(/[^\w.-]+/g, '_').replace(/^[^\w]+|[^\w]+$/g, '').slice(0, 64);
  return /\w/.test(s) ? s : '';
}

/** Lista todas las skills instaladas (desde el índice en memoria). */
async function listSkills() { return indexSkills(); }

/**
 * ¿Esta skill se le ofrece a este agente?
 * Sin `agents:` en el front-matter, aplica a TODOS (compatibilidad con las skills
 * que ya existían). Con `agents:`, solo a los listados (o a todos si incluye '*').
 * Un agente desconocido no filtra nada (nunca deja al agente sin skills por un typo).
 */
function skillAppliesTo(skill, agentKey) {
  const list = (skill && Array.isArray(skill.agents)) ? skill.agents : [];
  if (!list.length) return true;
  const key = String(agentKey || '').trim().toLowerCase();
  if (!key) return true;
  return list.some(a => {
    const s = String(a || '').trim().toLowerCase();
    return s === '*' || s === key;
  });
}

/**
 * Índice compacto para el system prompt — versión SÍNCRONA (systemPrompt es sync).
 * `agentKey` reparte las skills por agente (orchestrator, coding, research…).
 */
function promptIndexSync(agentKey) {
  const lines = [];
  for (const s of indexSkills()) {
    if (!s.enabled || !skillAppliesTo(s, agentKey)) continue;
    const d = String(s.description || '');
    lines.push(`- ${s.name}: ${d.slice(0, 180)}${d.length > 180 ? '…' : ''}`);
  }
  return lines.join('\n');
}

/** Índice compacto (async, para UI). `agentKey` opcional para verlo como un agente. */
async function promptIndex(agentKey) { return promptIndexSync(agentKey); }

/** Devuelve el cuerpo completo de una skill por id o nombre. */
async function getSkill(idOrName) {
  const s = indexSkills().find(x => x.id === idOrName || x.name === idOrName);
  return s || null;
}

/* ---------- v1.7: búsqueda y auto-activación ---------- */

/** Busca skills por texto en nombre/descripción/categoría/ejemplos. */
async function searchSkills(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return listSkills();
  const all = await listSkills();
  const terms = q.split(/\s+/);
  return all.filter(s => {
    const hay = `${s.name} ${s.description} ${s.category} ${(s.examples || []).join(' ')} ${(s.triggers || []).join(' ')}`.toLowerCase();
    return terms.every(t => hay.includes(t));
  });
}

/**
 * Auto-activación según la tarea (v1.7): devuelve las skills cuya descripción
 * o triggers encajan con el texto de la petición. Solo skills habilitadas.
 * `opts`: { agent, limit } — filtra por agente (v2.1) y acota cuántas se ofrecen.
 */
async function suggestSkillsFor(text, opts = {}) {
  const { agent, limit } = typeof opts === 'number' ? { limit: opts } : (opts || {});
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return [];
  const all = (await listSkills()).filter(s => s.enabled && skillAppliesTo(s, agent));
  const hits = [];
  for (const s of all) {
    const triggers = (s.triggers || []).filter(Boolean);
    // los triggers vienen de SKILL.md de repos ajenos: se tratan como TEXTO LITERAL
    // (nunca se compilan como RegExp → sin ReDoS en el hilo principal)
    if (triggers.some(tr => t.includes(String(tr).toLowerCase()))) { hits.push(s); continue; }
    const hay = `${s.name} ${s.description}`.toLowerCase();
    const words = hay.split(/[^a-z0-9áéíóúñü]+/).filter(w => w.length >= 4);
    if (words.some(w => t.includes(w) && w.length >= 5)) hits.push(s);
  }
  const max = Number(limit) > 0 ? Number(limit) : 3;
  return hits.slice(0, max);
}

/* ---------- v1.7: actualización de skills importadas ---------- */

/** Escritura atómica: el resto del almacén (memoria, hábitos, checkpoints) ya
    escribe a .tmp y renombra. Aquí un corte a mitad dejaba un SKILL.md sin
    front-matter (la skill desaparecía de la lista) o un enabled.json truncado
    (la skill desactivada volvía al prompt). */
async function writeFileAtomic(file, text) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, text, 'utf8');
  try { await fsp.rename(tmp, file); }
  catch (e) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e; }
}

/** Guarda el origen de una skill importada (repo + path) para poder actualizarla. */
async function writeSource(id, source) {
  const dir = safeSkillDir(id); // id inválido → lanza y no se toca el disco
  // Sin catch: si el origen no se guarda, la skill queda imposible de actualizar o
  // reimportar (la siguiente importación diría «ya existe» para siempre) y el
  // usuario no vería el motivo. El error sube al importador, que lo anota.
  await fsp.mkdir(dir, { recursive: true });
  await writeFileAtomic(path.join(dir, 'source.json'), JSON.stringify(source, null, 2));
  invalidarIndice();
}

/** Re-importa una skill desde su repo de origen. Devuelve {ok, changed}. */
async function updateSkill(id) {
  const dir = safeSkillDir(id);
  const s = await getSkill(id);
  if (!s || !s.source || !s.source.repo) throw new Error('La skill no tiene origen registrado (no es importada).');
  const { repo, path: repoPath } = s.source;
  const { files } = await resolveRepoSkills(repo + (repoPath ? '/' + repoPath.split('/SKILL.md')[0] : ''));
  const f = files.find(x => (repoPath && x.path === repoPath) || (!repoPath && x.path.includes('/' + id + '/')));
  if (!f) throw new Error('No se encontró la skill en el repo de origen.');
  const raw = await fetchSkillMarkdown(f.url);
  const fm = parseFrontMatter(raw);
  const changed = !fm || fm.meta.version !== s.version || fm.body !== s.body;
  if (changed) { await writeFileAtomic(path.join(dir, 'SKILL.md'), raw); invalidarIndice(); }
  return { ok: true, changed, version: fm ? fm.meta.version : '' };
}

/** Actualiza todas las skills con origen. */
async function updateAll() {
  const all = await listSkills();
  const results = [];
  for (const s of all) {
    if (!s.source) continue;
    try { const r = await updateSkill(s.id); results.push({ id: s.id, ...r }); }
    catch (e) { results.push({ id: s.id, ok: false, error: e.message }); }
  }
  return results;
}

async function setEnabled(id, enabled) {
  const dir = safeSkillDir(id); // lanza 'id de skill inválido' ante traversal
  await fsp.mkdir(dir, { recursive: true });
  await writeFileAtomic(path.join(dir, 'enabled.json'), JSON.stringify({ enabled: !!enabled }));
  invalidarIndice();
}

/* ---------- importación desde GitHub (sin git ni unzip) ---------- */

/** Tope de tamaño de un SKILL.md descargado (512 KB). */
const MAX_SKILL_BYTES = 512 * 1024;

/** Lee el cuerpo con tope, abortando al pasarse: bufferizar primero y medir
    después dejaba el tope sin aplicar durante la descarga. */
async function readCapped(res, max) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > max) throw new Error('SKILL.md demasiado grande (máx. 512 KB).');
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try { reader.cancel().catch(() => {}); } catch {}
      throw new Error('SKILL.md demasiado grande (máx. 512 KB).');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Descarga un SKILL.md con tope de tamaño (evita reventar memoria/contexto). */
async function fetchSkillMarkdown(url) {
  // con timeout: un proxy que acepta la conexión y no responde dejaba el botón de
  // importar deshabilitado para siempre (el IPC no llegaba a resolver nunca)
  const res = await fetch(url, { headers: { 'User-Agent': 'Sagitari' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('GitHub ' + res.status);
  return readCapped(res, MAX_SKILL_BYTES);
}

async function ghJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Sagitari', 'Accept': 'application/vnd.github+json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${url}`);
  return res.json();
}

/** Resuelve "owner/repo[/subdir]" a la lista de SKILL.md (path) del árbol remoto. */
async function resolveRepoSkills(repo) {
  const parts = repo.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('Formato: owner/repo o owner/repo/carpeta');
  const [owner, name, ...sub] = parts;
  const prefix = sub.length ? sub.join('/') + '/' : '';
  const info = await ghJson(`https://api.github.com/repos/${owner}/${name}`);
  const branch = info.default_branch || 'main';
  const tree = await ghJson(`https://api.github.com/repos/${owner}/${name}/git/trees/${branch}?recursive=1`);
  const files = (tree.tree || [])
    .filter(f => f.type === 'blob' && /SKILL\.md$/i.test(f.path) && f.path.startsWith(prefix))
    .map(f => ({ path: f.path, sha: f.sha, url: `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${f.path.split('/').map(encodeURIComponent).join('/')}` }));
  if (!files.length) throw new Error('No se encontró ningún SKILL.md en ese repo' + (prefix ? ` (bajo ${prefix})` : '') + '.');
  return { files, repo: `${owner}/${name}` };
}

/* Hash git-blob ("blob <bytes>\0<contenido>") de un Buffer: el formato exacto
   que GitHub publica como `sha` en su API de árboles. Lógica pura. */
function blobSha(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf == null ? '' : buf), 'utf8');
  const h = crypto.createHash('sha1');
  h.update(Buffer.from('blob ' + b.length + '\0', 'utf8'));
  h.update(b);
  return h.digest('hex');
}

/* Id estable de una skill: carpeta del SKILL.md, o el name si va en la raíz. */
function skillIdFor(fpath, metaName) {
  const dirPart = String(fpath || '').replace(/(^|\/)SKILL\.md$/i, '');
  const segs = dirPart.split('/');
  const last = segs[segs.length - 1] || '';
  return slugifyId(last) || slugifyId(metaName) || 'skill';
}

/* Vista previa de una importación SIN escribir nada: lo que se instalaría si
   el usuario confirma (id, nombre, descripción, tamaño). La UI la enseña ANTES
   de pedir el segundo clic: una skill son instrucciones que el agente obedecerá,
   no un texto inerte, y merecen consentimiento informado. */
async function previewImport(repo) {
  const { files, repo: repoName } = await resolveRepoSkills(repo);
  const items = [];
  const seen = new Set();
  const MAX_PREVIEW = 20;
  for (const f of files.slice(0, MAX_PREVIEW)) {
    let raw;
    try { raw = await fetchSkillMarkdown(f.url); } catch (e) {
      items.push({ id: '', path: f.path, name: f.path, description: 'no se pudo descargar: ' + e.message, chars: 0, unreadable: true });
      continue;
    }
    const fm = parseFrontMatter(raw);
    if (!fm || !fm.meta.name) continue;
    const id = skillIdFor(f.path, fm.meta.name);
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, path: f.path, name: fm.meta.name, description: fm.meta.description || '', chars: raw.length });
  }
  return { repo: repoName, items, total: files.length, truncated: files.length > MAX_PREVIEW };
}

/** Importa skills desde un repo de GitHub. Devuelve lista de instaladas (+ omitidas). */
async function importFromGitHub(repo) {
  const { files, repo: repoName } = await resolveRepoSkills(repo);
  const installed = [];
  const skipped = [];
  const seen = new Set();
  for (const f of files) {
    let raw;
    try { raw = await fetchSkillMarkdown(f.url); } catch (e) {
      skipped.push({ id: '', name: f.path, from: repoName, skipped: true, reason: e.message });
      continue;
    }
    // Integridad: lo descargado tiene que ser el blob que listó la API (hash
    // git "blob <bytes>\0<contenido>"). Si raw sirve otra cosa (carrera entre
    // el árbol y la descarga, espejo manipulado), se descarta, no se instala.
    if (f.sha && blobSha(Buffer.from(raw, 'utf8')) !== String(f.sha).toLowerCase()) {
      skipped.push({ id: '', name: f.path, from: repoName, skipped: true, reason: 'el contenido descargado no coincide con el hash publicado por GitHub; descartado por seguridad' });
      continue;
    }
    const fm = parseFrontMatter(raw);
    if (!fm || !fm.meta.name) continue;
    // id = carpeta que contiene el SKILL.md, saneado y SIN el sufijo "SKILL.md"
    const dirPart = f.path.replace(/(^|\/)SKILL\.md$/i, '');
    const segs = dirPart.split('/');
    const last = segs[segs.length - 1] || '';
    // un SKILL.md en la raíz del repo no tiene carpeta: se cae al name del front-matter
    const id = slugifyId(last) || slugifyId(fm.meta.name) || 'skill';
    // el mismo repo suele duplicar skills en varias rutas (skills/, .claude/, plugins/):
    // primera aparición gana, el resto se ignora
    if (seen.has(id)) continue;
    seen.add(id);
    const dest = safeSkillDir(id);
    let prev = null;
    try { prev = JSON.parse(await fsp.readFile(path.join(dest, 'source.json'), 'utf8')); } catch {}
    let exists = false;
    try { await fsp.access(path.join(dest, 'SKILL.md')); exists = true; } catch {}
    // nunca se pisa una skill existente que no venga del MISMO repo+path
    if (exists && !(prev && prev.repo === repoName && prev.path === f.path)) {
      skipped.push({
        id,
        name: fm.meta.name,
        from: repoName,
        skipped: true,
        reason: `Ya existe una skill con el id «${id}»${prev && prev.repo ? ` (importada de ${prev.repo})` : ''}; no se ha sobrescrito.`
      });
      continue;
    }
    try {
      await fsp.mkdir(dest, { recursive: true });
      // El origen PRIMERO: si el SKILL.md falla, no queda una skill «instalada» que
      // no se puede ni actualizar ni reimportar; una carpeta con solo source.json
      // es invisible para listSkills y la siguiente importación la repara.
      await writeSource(id, { repo: repoName, path: f.path, installedAt: new Date().toISOString() });
      await writeFileAtomic(path.join(dest, 'SKILL.md'), raw);
    } catch (e) {
      // un id que Windows rechaza (con/aux/nul…) o un disco lleno no pueden cortar
      // la importación entera dejando las demás sin instalar y sin explicación
      skipped.push({ id, name: fm.meta.name, from: repoName, skipped: true, reason: e.message });
      continue;
    }
    installed.push({ id, name: fm.meta.name, from: repoName });
  }
  invalidarIndice();   // aunque alguna fallara: lo instalado tiene que aparecer ya
  if (!installed.length && !skipped.length) throw new Error('Los SKILL.md encontrados no tienen front-matter válido (name/description).');
  return installed.concat(skipped);
}

/** Crea una skill nueva desde el formulario de la UI. */
async function createSkill({ name, description, body }) {
  const slug = slugifyId(String(name || '').toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '')) || 'skill';
  const dest = safeSkillDir(slug);
  await fsp.mkdir(dest, { recursive: true });
  const md = `---\nname: ${slug}\ndescription: ${description || 'Skill personalizada'}\n---\n\n${body || ''}\n`;
  await writeFileAtomic(path.join(dest, 'SKILL.md'), md);
  invalidarIndice();
  return { id: slug, name: slug };
}

async function deleteSkill(id) {
  const dir = safeSkillDir(id); // '..' o '.' ya no pueden resolver a la carpeta padre
  await fsp.rm(dir, { recursive: true, force: true });
  invalidarIndice();
}

module.exports = {
  listSkills, promptIndex, promptIndexSync, skillAppliesTo, getSkill, setEnabled,
  importFromGitHub, previewImport, blobSha, skillIdFor, createSkill, deleteSkill, searchSkills, suggestSkillsFor,
  updateSkill, updateAll, writeSource, skillsDir, invalidarIndice,
  __test: {
    parseFrontMatter,
    indexSkills,
    lecturas: () => INDEX_LECTURAS,
    firmaDelAlmacen,
    _resetForTests: (dir) => { SKILLS_DIR = dir; DIR_LISTO = false; invalidarIndice(); INDEX_LECTURAS = 0; },
  },
};
