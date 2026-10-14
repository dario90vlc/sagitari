'use strict';

/* ============================================================================
   contraste.js — auditoría de contraste de la paleta de SAGITARI.

   PRODUCT.md fija el objetivo WCAG 2.1 AA: texto normal ≥ 4,5:1 y texto grande
   (≥18px/24px o ≥14px/18,66px en negrita) ≥ 3:1. Este script lee los tokens de
   renderer/styles.css, compone cada superficie translúcida sobre el fondo base y
   mide el contraste de cada color de texto contra cada superficie.

   Además mide los textos COMPUESTOS, que el barrido de tokens no ve: los que se
   pintan con un `opacity` (el texto efectivo es la mezcla del color con el fondo) y
   los rótulos que van en un `::before`/`::after` con `content`. Así no se vuelve a
   colar un caso como el de `.navgroup::before` (rótulo del menú lateral con
   `opacity: 0.68`: 3,6:1 sobre el panel).

   Uso: node scripts/contraste.js
   ============================================================================ */

const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

/* ---------- utilidades de color ---------- */

function hexToRgb(hex) {
  const m = String(hex)
    .trim()
    .match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function parseColor(v) {
  v = String(v).trim();
  /* rgb(var(--x)) / rgba(var(--x), a): el token vive dentro de la función */
  let m = v.match(/^rgba?\(\s*var\((--[a-z0-9-]+)\)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (m) {
    const inner = resolve(m[1]);
    if (!inner) return null;
    const a = m[2] === undefined ? (inner.a === undefined ? 1 : inner.a) : Number(m[2]);
    return { rgb: inner.rgb, a };
  }
  m = v.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3)
      h = h
        .split('')
        .map((c) => c + c)
        .join('');
    if (h.length === 8) h = h.slice(0, 6);
    return { rgb: hexToRgb('#' + h), a: 1 };
  }
  m = v.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i);
  if (m) {
    const rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
    const a = m[4] === undefined ? 1 : Number(m[4]);
    return { rgb, a };
  }
  /* triplete suelto: --acc-rgb: 148, 118, 255 */
  m = v.match(/^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/);
  if (m) return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: 1 };
  m = v.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (m) return { var: m[1] };
  return null;
}

const lin = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

function luminance([r, g, b]) {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function over(fg, bg) {
  const a = fg.a === undefined ? 1 : fg.a;
  const f = fg.rgb;
  return [0, 1, 2].map((i) => Math.round(f[i] * a + bg[i] * (1 - a)));
}

function contrast(l1, l2) {
  const a = Math.max(l1, l2);
  const b = Math.min(l1, l2);
  return (a + 0.05) / (b + 0.05);
}

/* ---------- leer los tokens ---------- */

const rootBlock = CSS.match(/:root\s*\{([\s\S]*?)\n\}/);
if (!rootBlock) {
  console.error('no se encontró el bloque :root');
  process.exit(1);
}

const tokens = {};
for (const line of rootBlock[1].split('\n')) {
  const m = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i);
  if (m) tokens[m[1]] = m[2].trim();
}

function resolve(name, seen = new Set()) {
  if (seen.has(name)) return null;
  seen.add(name);
  const raw = tokens[name];
  if (!raw) return null;
  const p = parseColor(raw);
  if (!p) return null;
  if (p.var) return resolve(p.var, seen);
  return p;
}

const SURFACES = ['--bg0', '--bg1', '--bg2', '--deep', '--field', '--panel', '--panel2', '--face', '--face2'];
const TEXTOS = ['--txt', '--dim', '--vio', '--vio2', '--blu', '--cyan', '--mag', '--ok', '--warn', '--danger'];

/* ---------- reglas de la hoja ---------- */

/** Todas las reglas de styles.css como {selector, decls}, sin comentarios y saltando
    los bloques de @keyframes (sus `from`/`0%` no pintan texto propio). */
function reglas(css) {
  const limpio = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const salida = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(limpio))) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    if (!selector || selector.startsWith('@')) continue;
    const decls = {};
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      decls[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
    }
    salida.push({ selector, decls });
  }
  return salida;
}

/* ---------- textos compuestos: opacidad y pseudo-elementos ---------- */

/** ¿La regla pinta TEXTO propio? Los rótulos de un pseudo-elemento con `content` (una
    cadena o un attr()) lo son; un `content: ''` es decoración. */
function pintaTexto(decls) {
  const c = decls.content;
  if (c === undefined) return false;
  if (/^attr\(/i.test(c)) return true;
  const cadena = c.match(/^(['"])([\s\S]*)\1$/);
  return !!(cadena && cadena[2].trim());
}

/** Textos que no son un token limpio: color + opacidad (el texto efectivo es la mezcla
    con el fondo) y rótulos de pseudo-elemento. Devuelve también los no medibles, para
    poder decirlo en el informe en vez de darles el visto bueno en silencio. */
function textosCompuestos(css, superficies) {
  const medibles = [];
  const saltados = [];
  for (const { selector, decls } of reglas(css)) {
    const esPseudoTexto = pintaTexto(decls);
    const opRaw = decls.opacity;
    if (!esPseudoTexto && opRaw === undefined) continue;
    if (!decls.color) {
      if (esPseudoTexto) saltados.push({ selector, motivo: 'sin color propio (lo hereda)' });
      continue;
    }
    if (opRaw !== undefined) {
      const op = Number(opRaw);
      if (!Number.isFinite(op)) {
        saltados.push({ selector, motivo: 'opacidad no numérica (' + opRaw + ')' });
        continue;
      }
      if (op <= 0) continue; // invisible: no se pinta nada que leer
      if (op >= 1 && !esPseudoTexto) continue; // opacidad 1: es un texto normal, ya lo cubren los tokens
    }
    const color = parseColor(decls.color);
    const rgb = color && color.var ? resolve(color.var) : color;
    if (!rgb) {
      saltados.push({ selector, motivo: 'color no resoluble (' + decls.color + ')' });
      continue;
    }
    const opacidad = opRaw === undefined ? 1 : Number(opRaw);
    const alfa = (rgb.a === undefined ? 1 : rgb.a) * opacidad;
    /* El fondo real de un rótulo (el panel translúcido del menú) no se puede deducir de
       la regla, así que se mide contra TODAS las superficies y manda la peor: si la peor
       cumple, cumple en cualquiera. */
    let peor = null;
    for (const [sn, srgb] of Object.entries(superficies)) {
      const efectivo = over({ rgb: rgb.rgb, a: alfa }, srgb);
      const ratio = contrast(luminance(efectivo), luminance(srgb));
      if (!peor || ratio < peor.ratio) peor = { sn, ratio, rgb: efectivo };
    }
    if (peor) medibles.push({ selector, opacidad, ratio: peor.ratio, superficie: peor.sn, rgb: peor.rgb });
  }
  /* el mismo selector puede aparecer en dos bloques (color aquí, opacidad allá): se deja el peor */
  const porSelector = new Map();
  for (const t of medibles) {
    const previo = porSelector.get(t.selector);
    if (!previo || t.ratio < previo.ratio) porSelector.set(t.selector, t);
  }
  return { medibles: [...porSelector.values()].sort((a, b) => a.ratio - b.ratio), saltados };
}

/* ---------- análisis ---------- */

const MIN_NORMAL = 4.5;
const MIN_GRANDE = 3.0;

function analizar(css = CSS) {
  const BASE = resolve('--bg0-rgb') ? resolve('--bg0-rgb').rgb : [6, 4, 15];

  const superficies = {};
  for (const key of SURFACES) {
    const c = resolve(key);
    if (!c) continue;
    superficies[key.replace('--', '')] = c.a === undefined ? c.rgb : over(c, BASE);
  }

  const texto = {};
  for (const key of TEXTOS) {
    const c = resolve(key);
    if (c) texto[key.replace('--', '')] = c.rgb;
  }

  const filas = [];
  for (const [tn, trgb] of Object.entries(texto)) {
    for (const [sn, srgb] of Object.entries(superficies)) {
      filas.push({ tn, sn, ratio: contrast(luminance(trgb), luminance(srgb)) });
    }
  }
  filas.sort((a, b) => a.ratio - b.ratio);

  const compuestos = textosCompuestos(css, superficies);
  return { superficies, texto, filas, compuestos: compuestos.medibles, saltados: compuestos.saltados };
}

function informe() {
  const { superficies, filas, compuestos, saltados } = analizar();

  console.log('Superficies compuestas sobre el fondo base:');
  for (const [k, v] of Object.entries(superficies)) {
    console.log(`  ${k.padEnd(8)} rgb(${v.join(',')})  L=${luminance(v).toFixed(4)}`);
  }
  console.log('');

  console.log('Contraste de cada color de texto contra cada superficie (de peor a mejor):');
  console.log('  ' + 'texto'.padEnd(8) + 'superficie'.padEnd(10) + 'ratio    normal(4,5)  grande(3,0)');
  for (const f of filas) {
    const okN = f.ratio >= MIN_NORMAL;
    const okG = f.ratio >= MIN_GRANDE;
    console.log(
      '  ' +
        f.tn.padEnd(8) +
        f.sn.padEnd(10) +
        f.ratio.toFixed(2).padStart(6) +
        '    ' +
        (okN ? 'OK  ' : 'FALLO') +
        '        ' +
        (okG ? 'OK' : 'FALLO'),
    );
  }

  const malosComp = compuestos.filter((c) => c.ratio < MIN_NORMAL);
  if (compuestos.length) {
    console.log('');
    console.log('Textos compuestos (opacidad / pseudo-elementos), contra su peor superficie:');
    console.log('  ' + 'regla'.padEnd(46) + 'opac.  peor        ratio    normal(4,5)');
    for (const c of compuestos) {
      console.log(
        '  ' +
          c.selector.slice(0, 46).padEnd(46) +
          c.opacidad.toFixed(2).padStart(5) +
          '  ' +
          c.superficie.padEnd(10) +
          c.ratio.toFixed(2).padStart(6) +
          '    ' +
          (c.ratio >= MIN_NORMAL ? 'OK' : 'FALLO'),
      );
    }
  }
  if (saltados.length) {
    console.log('');
    console.log('Reglas de texto compuesto no medibles (se saltan, no se dan por buenas):');
    for (const s of saltados) console.log('  ' + s.selector.slice(0, 60).padEnd(60) + s.motivo);
  }

  const malos = filas.filter((f) => f.ratio < MIN_NORMAL);
  const total = filas.length + compuestos.length;
  console.log('');
  console.log(`Pares por debajo de ${MIN_NORMAL}:1 → ${malos.length + malosComp.length} de ${total}`);
  if (malos.length + malosComp.length) {
    for (const f of malos) console.log(`  ${f.tn} sobre ${f.sn} (${f.ratio.toFixed(2)}:1)`);
    for (const c of malosComp) console.log(`  ${c.selector} sobre ${c.superficie} (${c.ratio.toFixed(2)}:1)`);
  }

  return { fallos: malos.length + malosComp.length, total };
}

if (require.main === module) informe();

module.exports = { analizar, informe, contrast, luminance, over, parseColor, resolve, reglas, textosCompuestos };
