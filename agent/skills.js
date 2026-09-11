'use strict';

/* Sistema de skills estilo "SKILL.md" (como los agent skills de GitHub):
   cada skill vive en %APPDATA%/SagitariAI/skills/<nombre>/SKILL.md con front-matter:
     ---
     name: mi-skill
     description: Qué hace y CUÁNDO usarla (esta línea viaja siempre en el prompt)
     ---
     ...instrucciones completas (solo se cargan bajo demanda con use_skill)...

   Ahorro de tokens: al prompt solo va el ÍNDICE (nombre + description de cada skill).
   El cuerpo completo (que puede ser largo) se inyecta UNA VEZ solo cuando el agente
   decide que la skill es relevante, vía la herramienta use_skill. */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

let SKILLS_DIR = path.join(process.env.APPDATA || require('os').homedir(), 'SagitariAI', 'skills');

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

function skillsDir() { fs.mkdirSync(SKILLS_DIR, { recursive: true }); return SKILLS_DIR; }

/** Lista todas las skills instaladas. */
async function listSkills() {
  const dir = skillsDir();
  const out = [];
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(dir, e.name, 'SKILL.md');
    let raw;
    try { raw = await fsp.readFile(file, 'utf8'); } catch { continue; }
    const fm = parseFrontMatter(raw);
    if (!fm || !fm.meta.name) continue;
    let enabled = true;
    try { enabled = JSON.parse(await fsp.readFile(path.join(dir, e.name, 'enabled.json'), 'utf8')).enabled !== false; } catch {}
    let source = null;
    try { source = JSON.parse(await fsp.readFile(path.join(dir, e.name, 'source.json'), 'utf8')); } catch {}
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
      allowTools: Array.isArray(fm.meta.tools) ? fm.meta.tools.join(', ') : (fm.meta.tools || ''),
      source,
      enabled,
      bodyChars: fm.body.length,
      body: fm.body
    });
  }
  return out;
}

/** Índice compacto para el system prompt — versión SÍNCRONA (systemPrompt es sync). */
function promptIndexSync() {
  const dir = skillsDir();
  const lines = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(dir, e.name, 'SKILL.md'), 'utf8'); } catch { continue; }
    const fm = parseFrontMatter(raw);
    if (!fm || !fm.meta.name) continue;
    let enabled = true;
    try { enabled = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'enabled.json'), 'utf8')).enabled !== false; } catch {}
    if (enabled) lines.push(`- ${fm.meta.name}: ${String(fm.meta.description || '').slice(0, 180)}${String(fm.meta.description || '').length > 180 ? '…' : ''}`);
  }
  return lines.join('\n');
}

/** Índice compacto (async, para UI). */
async function promptIndex() { return promptIndexSync(); }

/** Devuelve el cuerpo completo de una skill por id o nombre. */
async function getSkill(idOrName) {
  const all = await listSkills();
  const s = all.find(x => x.id === idOrName || x.name === idOrName);
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
 */
async function suggestSkillsFor(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return [];
  const all = (await listSkills()).filter(s => s.enabled);
  const hits = [];
  for (const s of all) {
    const triggers = (s.triggers || []).filter(Boolean);
    if (triggers.some(tr => { try { return new RegExp(tr, 'i').test(t); } catch { return t.includes(tr.toLowerCase()); } })) { hits.push(s); continue; }
    const hay = `${s.name} ${s.description}`.toLowerCase();
    const words = hay.split(/[^a-z0-9áéíóúñü]+/).filter(w => w.length >= 4);
    if (words.some(w => t.includes(w) && w.length >= 5)) hits.push(s);
  }
  return hits.slice(0, 3);
}

/* ---------- v1.7: actualización de skills importadas ---------- */

/** Guarda el origen de una skill importada (repo + path) para poder actualizarla. */
async function writeSource(id, source) {
  try {
    await fsp.mkdir(path.join(skillsDir(), id), { recursive: true });
    await fsp.writeFile(path.join(skillsDir(), id, 'source.json'), JSON.stringify(source, null, 2), 'utf8');
  } catch {}
}

/** Re-importa una skill desde su repo de origen. Devuelve {ok, changed}. */
async function updateSkill(id) {
  const s = await getSkill(id);
  if (!s || !s.source || !s.source.repo) throw new Error('La skill no tiene origen registrado (no es importada).');
  const { repo, path: repoPath } = s.source;
  const { files } = await resolveRepoSkills(repo + (repoPath ? '/' + repoPath.split('/SKILL.md')[0] : ''));
  const f = files.find(x => (repoPath && x.path === repoPath) || (!repoPath && x.path.includes('/' + id + '/')));
  if (!f) throw new Error('No se encontró la skill en el repo de origen.');
  const res = await fetch(f.url, { headers: { 'User-Agent': 'Sagitari' } });
  if (!res.ok) throw new Error('GitHub ' + res.status);
  const raw = await res.text();
  const fm = parseFrontMatter(raw);
  const changed = !fm || fm.meta.version !== s.version || fm.body !== s.body;
  if (changed) await fsp.writeFile(path.join(skillsDir(), id, 'SKILL.md'), raw, 'utf8');
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
  const dir = path.join(skillsDir(), id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'enabled.json'), JSON.stringify({ enabled: !!enabled }), 'utf8');
}

/* ---------- importación desde GitHub (sin git ni unzip) ---------- */

async function ghJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Sagitari', 'Accept': 'application/vnd.github+json' } });
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

/** Importa skills desde un repo de GitHub. Devuelve lista de instaladas. */
async function importFromGitHub(repo) {
  const { files, repo: repoName } = await resolveRepoSkills(repo);
  const installed = [];
  const seen = new Set();
  for (const f of files) {
    const res = await fetch(f.url, { headers: { 'User-Agent': 'Sagitari' } });
    if (!res.ok) continue;
    const raw = await res.text();
    const fm = parseFrontMatter(raw);
    if (!fm || !fm.meta.name) continue;
    // id = última carpeta antes de SKILL.md, saneado y SIN sufijo "SKILL.md"
    const segs = f.path.replace(/\/SKILL\.md$/i, '').split('/');
    const id = (segs[segs.length - 1] || fm.meta.name || 'skill')
      .replace(/[-_. ]*skill\.md$/i, '')
      .replace(/[^\w.-]+/g, '_');
    // el mismo repo suele duplicar skills en varias rutas (skills/, .claude/, plugins/):
    // primera aparición gana, el resto se ignora
    if (seen.has(id)) continue;
    seen.add(id);
    const dest = path.join(skillsDir(), id);
    await fsp.mkdir(dest, { recursive: true });
    await fsp.writeFile(path.join(dest, 'SKILL.md'), raw, 'utf8');
    await writeSource(id, { repo: repoName, path: f.path, installedAt: new Date().toISOString() });
    installed.push({ id, name: fm.meta.name, from: repoName });
  }
  if (!installed.length) throw new Error('Los SKILL.md encontrados no tienen front-matter válido (name/description).');
  return installed;
}

/** Crea una skill nueva desde el formulario de la UI. */
async function createSkill({ name, description, body }) {
  const slug = String(name || '').toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
  const dest = path.join(skillsDir(), slug);
  await fsp.mkdir(dest, { recursive: true });
  const md = `---\nname: ${slug}\ndescription: ${description || 'Skill personalizada'}\n---\n\n${body || ''}\n`;
  await fsp.writeFile(path.join(dest, 'SKILL.md'), md, 'utf8');
  return { id: slug, name: slug };
}

async function deleteSkill(id) {
  if (!/^[\w.-]+$/.test(id)) throw new Error('id inválido');
  await fsp.rm(path.join(skillsDir(), id), { recursive: true, force: true });
}

module.exports = { listSkills, promptIndex, promptIndexSync, getSkill, setEnabled, importFromGitHub, createSkill, deleteSkill, searchSkills, suggestSkillsFor, updateSkill, updateAll, writeSource, skillsDir, __test: { parseFrontMatter, _resetForTests: (dir) => { SKILLS_DIR = dir; } } };
