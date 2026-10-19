'use strict';

/* Límites y extracción de texto de los adjuntos del chat, SIN Electron ni IPC.
   El texto se extrae en el proceso principal y viaja como texto del mensaje, así
   que cualquier modelo lo ve (incluso uno sin visión).

   Vive aquí, y no dentro de main.js, porque estas decisiones (qué se lee, qué se
   descarta y qué se recorta) son las que protegen la memoria y el contexto: en
   main.js solo se podían comprobar leyendo el código fuente. */

const path = require('path');

const MAX_ATTACH_CHARS = 120000; // ~30k tokens por archivo: margen sobrado, techo real
/* Techo del CONJUNTO de adjuntos de un mismo mensaje (~62k tokens). El renderer permite
   8 archivos a la vez, así que sin esto la suma podía rondar el millón de caracteres y el
   mensaje en curso reventaba la ventana del modelo (el recorte de historial no lo toca). */
const MAX_ADJUNTOS_CHARS = 250000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
/* Un fichero sin extensión conocida y pequeño se intenta leer como texto */
const PROBE_AS_TEXT_BYTES = 512 * 1024;

const TEXT_EXTS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.tsv',
  '.log',
  '.xml',
  '.yml',
  '.yaml',
  '.ini',
  '.cfg',
  '.env',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.cpp',
  '.h',
  '.cs',
  '.php',
  '.sh',
  '.bat',
  '.ps1',
  '.sql',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.vue',
  '.svelte',
  '.tex',
  '.rtf',
  '.srt',
  '.vtt',
]);
const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
/* Extensiones claramente binarias: ni intentamos leerlas como texto. Ojo: si se
   anuncia texto y luego sale binario, se degrada a 'binary' con aviso. */
const BINARY_EXTS = new Set([
  '.exe',
  '.dll',
  '.zip',
  '.rar',
  '.7z',
  '.gz',
  '.tar',
  '.bin',
  '.dat',
  '.db',
  '.sqlite',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.epub',
  '.iso',
  '.img',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.mp4',
  '.avi',
  '.mkv',
  '.mov',
  '.wav',
  '.psd',
  '.ai',
]);

const extOf = (name) => path.extname(String(name || '')).toLowerCase();

/** Tipo de adjunto según nombre y tamaño: 'image' | 'text' | 'binary'. */
function kindOf(name, size) {
  const ext = extOf(name);
  if (IMG_EXTS.has(ext)) return 'image';
  if (TEXT_EXTS.has(ext)) return 'text';
  return Number(size) < PROBE_AS_TEXT_BYTES && !BINARY_EXTS.has(ext) ? 'text' : 'binary';
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
  // Busca caracteres no imprimibles a propósito: los adjuntos de texto pueden traer
  // caracteres de control que rompen el renderizado del chat.
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\u0000/g, '').trim();
  if (ext === '.srt' || ext === '.vtt') text = text.replace(/^\d+\s*$/gm, '').replace(/-->\s*/g, ' → ');
  // eslint-disable-next-line no-control-regex
  const printable = text.replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, '');
  if (printable.length < Math.max(40, text.length * 0.55)) return null;
  return text;
}

/** Ficha compacta de un adjunto para el HISTORIAL (conversations.json) y para el modelo
    en los turnos siguientes. El texto de un adjunto solo viaja en el turno en que se
    adjuntó: `blockFor` lo mete en el mensaje en curso, pero guardarlo dejaba cada
    conversación con cientos de miles de caracteres que se releen enteros al arrancar y se
    reescriben en cada turno. La ficha conserva lo que el usuario ve en la tarjeta (nombre,
    tipo y tamaño) y le dice al modelo que ahí hubo un archivo. */
function cardFor(att) {
  const a = att || {};
  const size = a.size ? Math.round(a.size / 1024) + ' KB' : 'n/a';
  const kind = a.kind === 'image' ? 'imagen' : a.kind === 'binary' ? 'binario' : 'texto';
  const nota = a.kind === 'image' ? 'miniatura guardada en la conversación' : 'contenido no conservado en el historial';
  return `--- ARCHIVO ADJUNTO: ${a.name} (${size}, ${kind}) --- (${nota})`;
}

/** Fichas de varios adjuntos, una por línea y en orden (ver `cardFor`). */
function cardsFor(atts) {
  return (atts || []).map(cardFor).join('\n');
}

/** Bloque que se añade al mensaje: recorta al techo real y lo deja dicho. */
function blockFor(att) {
  const a = att || {};
  const text = String(a.text || '');
  const size = a.size ? Math.round(a.size / 1024) + ' KB' : 'n/a';
  return `--- ARCHIVO ADJUNTO: ${a.name} (${size}) ---\n${text.slice(0, MAX_ATTACH_CHARS)}${text.length > MAX_ATTACH_CHARS ? '\n… (truncado)' : ''}`;
}

/** Bloques de varios adjuntos de texto, en orden. El tope por archivo
    (`MAX_ATTACH_CHARS`) no basta: la interfaz permite 8 adjuntos a la vez y la suma
    viajaba entera al mensaje en curso (que `contexto.recortarMensajes` NO puede aliviar:
    es el mensaje actual, no historial viejo). Con 8 archivos grandes el proveedor
    contestaba «context length exceeded» después de esperar. El techo del CONJUNTO se
    anuncia con un bloque que dice qué no se envió, igual que el recorte por archivo. */
function blocksFor(atts) {
  const out = [];
  let total = 0;
  for (const att of atts || []) {
    const nombre = (att && att.name) || 'archivo';
    if (total >= MAX_ADJUNTOS_CHARS) {
      out.push(
        '--- ARCHIVO ADJUNTO: ' + nombre + ' (omitido: se alcanzó el tope de ' + MAX_ADJUNTOS_CHARS + ' caracteres del conjunto) ---',
      );
      continue;
    }
    const bloque = blockFor(att);
    const hueco = MAX_ADJUNTOS_CHARS - total;
    if (bloque.length <= hueco) {
      out.push(bloque);
      total += bloque.length;
    } else {
      out.push(bloque.slice(0, hueco) + '\n… (truncado: ' + (bloque.length - hueco) + ' caracteres más no se enviaron)');
      total = MAX_ADJUNTOS_CHARS;
    }
  }
  return out.join('\n\n');
}

/** ¿La ruta cae dentro de `dir`? Los datos de la app (claves, conversaciones) no
    se pueden adjuntar. `dir` y `file` deben venir ya resueltos (realpath). */
function insideDir(file, dir) {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

module.exports = {
  MAX_ATTACH_CHARS,
  MAX_ADJUNTOS_CHARS,
  MAX_FILE_BYTES,
  PROBE_AS_TEXT_BYTES,
  TEXT_EXTS,
  IMG_EXTS,
  BINARY_EXTS,
  extOf,
  kindOf,
  mimeOf,
  textOf,
  blockFor,
  blocksFor,
  cardFor,
  cardsFor,
  insideDir,
};
