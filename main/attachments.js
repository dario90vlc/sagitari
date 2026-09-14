'use strict';

/* Límites y extracción de texto de los adjuntos del chat, SIN Electron ni IPC.
   El texto se extrae en el proceso principal y viaja como texto del mensaje, así
   que cualquier modelo lo ve (incluso uno sin visión).

   Vive aquí, y no dentro de main.js, porque estas decisiones (qué se lee, qué se
   descarta y qué se recorta) son las que protegen la memoria y el contexto: en
   main.js solo se podían comprobar leyendo el código fuente. */

const path = require('path');

const MAX_ATTACH_CHARS = 120000;   // ~30k tokens: margen sobrado, techo real
const MAX_FILE_BYTES = 25 * 1024 * 1024;
/* Un fichero sin extensión conocida y pequeño se intenta leer como texto */
const PROBE_AS_TEXT_BYTES = 512 * 1024;

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.xml', '.yml', '.yaml', '.ini', '.cfg', '.env', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.cpp', '.h', '.cs', '.php', '.sh', '.bat', '.ps1', '.sql', '.html', '.htm', '.css', '.scss', '.vue', '.svelte', '.tex', '.rtf', '.srt', '.vtt']);
const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
/* Extensiones claramente binarias: ni intentamos leerlas como texto. Ojo: si se
   anuncia texto y luego sale binario, se degrada a 'binary' con aviso. */
const BINARY_EXTS = new Set(['.exe', '.dll', '.zip', '.rar', '.7z', '.gz', '.tar', '.bin', '.dat', '.db', '.sqlite', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.epub', '.iso', '.img', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.avi', '.mkv', '.mov', '.wav', '.psd', '.ai']);

const extOf = (name) => path.extname(String(name || '')).toLowerCase();

/** Tipo de adjunto según nombre y tamaño: 'image' | 'text' | 'binary'. */
function kindOf(name, size) {
  const ext = extOf(name);
  if (IMG_EXTS.has(ext)) return 'image';
  if (TEXT_EXTS.has(ext)) return 'text';
  return (Number(size) < PROBE_AS_TEXT_BYTES && !BINARY_EXTS.has(ext)) ? 'text' : 'binary';
}

/** MIME de una imagen por su extensión (las que acepta IMG_EXTS). */
function mimeOf(name) {
  const ext = extOf(name);
  return ext === '.svg' ? 'image/svg+xml' : `image/${ext === '.jpg' ? 'jpeg' : ext.slice(1)}`;
}

/**
 * Texto de un fichero de texto, o null si en realidad es binario.
 * Quita los NUL, deja los subtítulos en texto útil y exige que la mayoría de los
 * caracteres sean imprimibles: un .dat renombrado no puede colarse como texto.
 */
function textOf(buf, name) {
  const ext = extOf(name);
  let text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
  text = text.replace(/\u0000/g, '').trim();
  if (ext === '.srt' || ext === '.vtt') text = text.replace(/^\d+\s*$/gm, '').replace(/-->\s*/g, ' → ');
  const printable = text.replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, '');
  if (printable.length < Math.max(40, text.length * 0.55)) return null;
  return text;
}

/** Bloque que se añade al mensaje: recorta al techo real y lo deja dicho. */
function blockFor(att) {
  const a = att || {};
  const text = String(a.text || '');
  const size = a.size ? Math.round(a.size / 1024) + ' KB' : 'n/a';
  return `--- ARCHIVO ADJUNTO: ${a.name} (${size}) ---\n${text.slice(0, MAX_ATTACH_CHARS)}${text.length > MAX_ATTACH_CHARS ? '\n… (truncado)' : ''}`;
}

/** Bloques de varios adjuntos de texto, en orden. */
function blocksFor(atts) {
  return (atts || []).map(blockFor).join('\n\n');
}

/** ¿La ruta cae dentro de `dir`? Los datos de la app (claves, conversaciones) no
    se pueden adjuntar. `dir` y `file` deben venir ya resueltos (realpath). */
function insideDir(file, dir) {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

module.exports = {
  MAX_ATTACH_CHARS, MAX_FILE_BYTES, PROBE_AS_TEXT_BYTES,
  TEXT_EXTS, IMG_EXTS, BINARY_EXTS,
  extOf, kindOf, mimeOf, textOf, blockFor, blocksFor, insideDir,
};
