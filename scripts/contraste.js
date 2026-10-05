'use strict';

/* ============================================================================
   contraste.js — auditoría de contraste de la paleta de SAGITARI.

   PRODUCT.md fija el objetivo WCAG 2.1 AA: texto normal ≥ 4,5:1 y texto grande
   (≥18px/24px o ≥14px/18,66px en negrita) ≥ 3:1. Este script lee los tokens de
   renderer/styles.css, compone cada superficie translúcida sobre el fondo base y
   mide el contraste de cada color de texto contra cada superficie.

   Uso: node scripts/contraste.js
   ============================================================================ */

const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

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

const rootBlock = css.match(/:root\s*\{([\s\S]*?)\n\}/);
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

/* ---------- superficies compuestas sobre el fondo base ---------- */

const BASE = resolve('--bg0-rgb') ? resolve('--bg0-rgb').rgb : [6, 4, 15];

const superficies = {};
for (const key of ['--bg0', '--bg1', '--bg2', '--deep', '--field', '--panel', '--panel2', '--face', '--face2']) {
  const c = resolve(key);
  if (!c) continue;
  superficies[key.replace('--', '')] = c.a === undefined ? c.rgb : over(c, BASE);
}

/* ---------- colores de texto ---------- */

const texto = {};
for (const key of ['--txt', '--dim', '--vio', '--vio2', '--blu', '--cyan', '--mag', '--ok', '--warn', '--danger']) {
  const c = resolve(key);
  if (c) texto[key.replace('--', '')] = c.rgb;
}

/* ---------- informe ---------- */

const MIN_NORMAL = 4.5;
const MIN_GRANDE = 3.0;

console.log('Superficies compuestas sobre el fondo base:');
for (const [k, v] of Object.entries(superficies)) {
  console.log(`  ${k.padEnd(8)} rgb(${v.join(',')})  L=${luminance(v).toFixed(4)}`);
}
console.log('');

const filas = [];
for (const [tn, trgb] of Object.entries(texto)) {
  for (const [sn, srgb] of Object.entries(superficies)) {
    const ratio = contrast(luminance(trgb), luminance(srgb));
    filas.push({ tn, sn, ratio });
  }
}

filas.sort((a, b) => a.ratio - b.ratio);

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

const malos = filas.filter((f) => f.ratio < MIN_NORMAL);
console.log('');
console.log(`Pares por debajo de ${MIN_NORMAL}:1 → ${malos.length} de ${filas.length}`);
if (malos.length) {
  console.log('  ' + malos.map((f) => `${f.tn} sobre ${f.sn} (${f.ratio.toFixed(2)}:1)`).join('\n  '));
}
