'use strict';

/* v3.0 — Edición tolerante a espacios (hueco 1, la propina).

   Un anclaje con la sangría mal —o con el final de línea cambiado, o con un
   tabulador donde había cuatro espacios— hacía fallar `edit_file` y `apply_patch`
   con un «no encontrado» seco. Para el modelo eso es un callejón: tiene el texto
   DELANTE, la corrección es de espacios, y no sabe qué sangría usa el archivo
   porque read_file puede haber recortado esa parte.

   Aquí se busca ignorando la sangría y el final de línea. Cuando hay UNA sola
   coincidencia así, no se aplica a ciegas: se le enseña al modelo el texto EXACTO
   que hay en el archivo («¿querías esto?») y se le da una salida de una sola
   llamada (`tolerar_espacios: true`), que reajusta la sangría en vez de destruirla.

   Por qué no se aplica solo: aplicar un anclaje que no coincidía significa
   adivinar la sangría, y una adivinanza silenciosa en el código del usuario es
   peor que un error honesto. La coincidencia tolerante se acepta cuando alguien
   la pide; nunca por sorpresa.

   Lógica pura (sin I/O) para poder probarla entera. */

/** Líneas con su posición real en el texto. `texto` no incluye el \n (puede acabar en \r). */
function lineas(texto) {
  const out = [];
  let i = 0;
  const n = texto.length;
  while (i <= n) {
    const j = texto.indexOf('\n', i);
    if (j === -1) { out.push({ start: i, end: n, texto: texto.slice(i) }); break; }
    out.push({ start: i, end: j + 1, texto: texto.slice(i, j) });
    i = j + 1;
  }
  return out;
}

/** Forma comparable de una línea: sin sangría, sin espacios finales y sin el \r del CRLF. */
function norm(s) {
  return String(s).replace(/\r$/, '').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function sangriaDe(s) {
  const m = String(s).match(/^[ \t]*/);
  return m ? m[0] : '';
}

/**
 * Ventanas del archivo que coinciden con `busca` ignorando sangría y finales de
 * línea. Devuelve posiciones reales ({inicio,fin}, índices sobre `texto`), la
 * línea 1-based y la sangría del archivo, para poder reajustar.
 */
function candidatos(texto, busca, limit) {
  const fl = lineas(texto);
  const b = String(busca);
  /* Si el anclaje no acababa en salto de línea, el bloque NO puede tragarse el
     salto de la última línea: hacerlo pegaba la línea siguiente al bloque nuevo
     (`return x;}` en vez de `return x;\n}`). Si acaba en salto, sí se incluye. */
  const buscaConSalto = /\r?\n$/.test(b);
  let bl = b.split('\n').map(norm);
  if (buscaConSalto && bl.length && bl[bl.length - 1] === '') bl = bl.slice(0, -1);
  if (!bl.length || !bl.some((l) => l.length)) return [];
  const out = [];
  const tope = limit || 8;
  for (let i = 0; i + bl.length <= fl.length; i++) {
    let ok = true;
    for (let k = 0; k < bl.length; k++) {
      if (norm(fl[i + k].texto) !== bl[k]) { ok = false; break; }
    }
    if (!ok) continue;
    const ultima = fl[i + bl.length - 1];
    let fin = ultima.end;
    if (!buscaConSalto) {
      // fuera el salto de línea Y su \r: si se dejaba el \r dentro del bloque
      // sustituido, el archivo acababa con «let a = 9;\n» donde había «\r\n»
      if (texto.slice(ultima.start, ultima.end).endsWith('\n')) fin -= 1;
      if (fin > ultima.start && texto[fin - 1] === '\r') fin -= 1;
    }
    const sangrias = [];
    for (let k = 0; k < bl.length; k++) sangrias.push(sangriaDe(fl[i + k].texto));
    out.push({
      inicio: fl[i].start,
      fin,
      linea: i + 1,
      lineas: bl.length,
      sangria: sangrias[0],
      sangrias,
    });
    if (out.length >= tope) break;
  }
  return out;
}

/**
 * Busca el anclaje. Primero exacto (como siempre); si no aparece, tolerante.
 * Devuelve { modo: 'exacto'|'tolerante'|null, veces, posiciones, candidatos }.
 */
function buscar(texto, busca, opts = {}) {
  const t = String(texto);
  const b = String(busca);
  if (!b) return { modo: null, veces: 0, posiciones: [], candidatos: [] };
  const veces = t.split(b).length - 1;
  if (veces > 0) {
    const posiciones = [];
    let from = 0;
    for (let i = 0; i < veces; i++) {
      const at = t.indexOf(b, from);
      posiciones.push({ inicio: at, fin: at + b.length });
      from = at + b.length;
    }
    return { modo: 'exacto', veces, posiciones, candidatos: [] };
  }
  const cs = candidatos(t, b, opts.limit);
  return { modo: cs.length ? 'tolerante' : null, veces: cs.length, posiciones: [], candidatos: cs };
}

/**
 * Reajusta la sangría del bloque nuevo a la que tiene el archivo.
 *
 * Se hace LÍNEA A LÍNEA, no con una diferencia de longitudes: comparar cuántos
 * caracteres de sangría hay se rompe en cuanto aparece un tabulador (un `\t` es un
 * carácter y cuatro columnas), y el bloque salía con 3 espacios donde el archivo
 * tenía 4. Aquí se quita de cada línea la sangría que traía el anclaje y se pone la
 * que tiene esa misma línea en el archivo; las líneas que el modelo añada (más
 * sangradas, típicamente un bloque anidado) conservan su sangría RELATIVA.
 */
function reindentar(nuevo, ancla, sangrArchivo) {
  const nl = String(nuevo).split('\n');
  const al = String(ancla).split('\n');
  const f = (Array.isArray(sangrArchivo) && sangrArchivo.length) ? sangrArchivo : [''];
  return nl.map((l, i) => {
    if (!l.trim()) return l;
    const a = sangriaDe(al[i] !== undefined ? al[i] : (al[al.length - 1] || ''));
    const destino = f[i] !== undefined ? f[i] : f[0];
    const sin = l.startsWith(a) ? l.slice(a.length) : l;
    return destino + sin;
  }).join('\n');
}

/**
 * Aplica la edición. opts: { replaceAll, tolerar (bool) }.
 * Devuelve { ok, texto, veces, modo, lineas, error, candidatos }.
 *  - exacto único            → reemplaza
 *  - exacto repetido + !all  → error (necesita contexto)
 *  - tolerante único + toler → reemplaza reajustando la sangría
 *  - tolerante único + !toler→ error «¿querías esto?» (con candidato para citarlo)
 *  - ambiguo                 → error con todos los candidatos
 */
function aplicar(texto, busca, nuevo, opts = {}) {
  const t = String(texto);
  const b = String(busca);
  const n = String(nuevo ?? '');
  const r = buscar(t, b);
  if (r.modo === 'exacto') {
    if (r.veces > 1 && !opts.replaceAll) {
      return { ok: false, error: `el texto aparece ${r.veces} veces`, candidatos: [] };
    }
    const txt = opts.replaceAll ? t.split(b).join(n) : t.replace(b, () => n);
    return { ok: true, texto: txt, veces: opts.replaceAll ? r.veces : 1, modo: 'exacto' };
  }
  if (r.modo !== 'tolerante') {
    return { ok: false, error: 'no se encontró (ni exacto ni sin sangría)', candidatos: [] };
  }
  if (r.veces > 1) {
    return { ok: false, error: `sin sangría coincide en ${r.veces} sitios`, candidatos: r.candidatos };
  }
  const c = r.candidatos[0];
  if (!opts.tolerar) {
    return { ok: false, error: 'solo coincide si se ignora la sangría', candidatos: r.candidatos };
  }
  // se reajusta la sangría al anclaje que se ha encontrado de verdad, para que el
  // bloque nuevo herede la indentación del archivo y no la del modelo
  const txt = t.slice(0, c.inicio) + reindentar(n, b, c.sangrias || [c.sangria]) + t.slice(c.fin);
  return { ok: true, texto: txt, veces: 1, modo: 'tolerante', linea: c.linea, lineas: c.lineas };
}

/** Marco con números de línea: el «¿querías esto?» que se le enseña al modelo. */
function marco(texto, c, opts = {}) {
  const fl = lineas(String(texto));
  const desde = Math.max(1, c.linea - 1);
  const hasta = Math.min(fl.length, c.linea + (c.lineas || 1) - 1);
  const ancho = String(hasta).length;
  const out = [];
  for (let i = desde; i <= hasta; i++) {
    const marca = i >= c.linea && i < c.linea + (c.lineas || 1) ? '>' : ' ';
    out.push(`${marca} ${String(i).padStart(ancho)} | ${String(fl[i - 1].texto).replace(/\r$/, '')}`);
  }
  const cab = opts.titulo || 'Lo más parecido que hay en el archivo';
  return `${cab} (línea${(c.lineas || 1) > 1 ? 's' : ''} ${c.linea}${(c.lineas || 1) > 1 ? '-' + hasta : ''}):\n${out.join('\n')}`;
}

/** Texto exacto del candidato, listo para copiar en old_string o para citarlo. */
function textoExacto(texto, c) {
  return String(texto).slice(c.inicio, c.fin);
}

module.exports = { buscar, candidatos, aplicar, marco, reindentar, textoExacto, lineas, norm };
