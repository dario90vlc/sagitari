'use strict';

/* memoria-v2.js — esquema, similitud, fusión y heurística de la memoria de largo
   plazo (fase 1 del spec de memoria).

   Este módulo es PURO (no toca disco): el almacén lo sigue llevando agent/memory.js.
   Aquí vive lo que hay que poder probar sin ficheros: la forma del hecho v2, la
   huella para deduplicar, la similitud léxica, la clave que distingue «el mismo dato»
   de «otra cosa» (`claveHecho`/`relacionHechos`), la fusión de duplicados y, más abajo,
   la heurística que decide si una frase «huele» a hecho duradero y las reglas de
   olvido.

   Por qué un módulo aparte: agent/memory.js ya llevaba almacén + scoring + CRUD, y la
   vista y la bandeja añaden más. Separar el ESQUEMA del ALMACÉN deja cada fichero con
   un solo motivo para cambiar.

   Los nombres de campo de un hecho son deliberadamente los de la v1 (`text`, `date`,
   `lastUsed`, `uses`, `importance`) más los nuevos (`origen`, `origenTexto`,
   `etiquetas`, `hash`, `papelera`): el scoring y el resto de la app ya leían esos
   nombres, y renombrarlos obligaba a tocar medio repositorio sin ganar nada. */

const crypto = require('crypto');

const ESQUEMA = 2;

/* Un hecho sin usarse en OLVIDO_BAJA_DIAS baja a importancia baja; sin usarse en
   OLVIDO_PAPELERA_DIAS pasa a la papelera, de donde se puede recuperar PAPELERA_DIAS
   antes de borrarse de verdad. Nunca se borra en silencio. */
const OLVIDO_BAJA_DIAS = 180;
const OLVIDO_PAPELERA_DIAS = 365;
const PAPELERA_DIAS = 30;

/* Dos hechos con esta similitud léxica o más se consideran el mismo: es lo que fusiona
   «El usuario se llama Darío» con «Recuerda que me llamo Dario» al migrar. */
const FUSION_UMBRAL = 0.5;

/* Stopwords ES/EN cortas: suficiente para el solapamiento léxico. Es la MISMA lista que
   usaba agent/memory.js, que ahora tokeniza por aquí para no tener dos. */
const STOP = new Set([
  'de',
  'la',
  'el',
  'los',
  'las',
  'un',
  'una',
  'unos',
  'unas',
  'y',
  'o',
  'que',
  'en',
  'a',
  'del',
  'se',
  'por',
  'con',
  'para',
  'su',
  'al',
  'lo',
  'como',
  'mas',
  'más',
  'pero',
  'es',
  'son',
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'my',
  'your',
  'of',
  'to',
  'in',
]);

function normalizarTexto(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/** Minúsculas y sin acentos: la base de la huella y de los tokens. */
function sinAcentos(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Tokeniza en minúsculas quitando stopwords ES/EN cortas (idéntico al tokenize de memory.js). */
function tokenizar(s) {
  return sinAcentos(s)
    .split(/[^a-z0-9ñ]+/i)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/* Raíz muy simple para el español: quita las terminaciones verbales/plurales más
   comunes. No pretende ser un stemmer: solo hacer que «llamo», «llama» y «llamar»
   coincidan, que es lo que necesita la fusión de duplicados. */
function raiz(t) {
  const r = t.replace(/(ando|iendo|amos|imos|emos|aste|aron|aba|ia|ar|er|ir|as|es|os|o|a|e)$/, '');
  return r.length >= 3 ? r : t;
}

/** Tokens con la raíz aplicada: solo para medir similitud, nunca para puntuar memoria. */
function tokenizarRaiz(s) {
  return tokenizar(s).map(raiz);
}

/** Huella de deduplicación: estable ante mayúsculas, acentos y espacios de más. */
function hashTexto(s) {
  return crypto
    .createHash('sha1')
    .update(sinAcentos(normalizarTexto(s)))
    .digest('hex')
    .slice(0, 16);
}

/** Similitud de Jaccard 0..1 sobre las raíces de los tokens. */
function similitud(a, b) {
  const A = new Set(tokenizarRaiz(a));
  const B = new Set(tokenizarRaiz(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function clamp01(n) {
  n = Number(n);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

/* ---------- claves de hecho: ¿esto es el mismo dato o es otra cosa? ----------
   La similitud léxica sola no puede decidir una fusión: «prefiero el té» y «prefiero el
   café» comparten predicado y difieren en el OBJETO, y fusionarlas borraba un dato
   cierto. Una clave descompone el hecho en predicado + valor (+ polaridad) para poder
   distinguir «hablo del mismo dato» (mismo valor, aunque cambie la forma: «me llamo
   Darío» / «me llamo Dario») de «hablo de otra cosa» (valor distinto) y de una
   contradicción (mismo objeto, polaridad invertida: «me gusta el té» / «no me gusta el
   té»). `unico` marca los predicados que una persona solo tiene una vez (su nombre, su
   idioma, dónde vive): ahí un valor nuevo sustituye al viejo.
   Se reconocen las formas que escribe la memoria (las de PATRONES) Y las que escribe el
   usuario a mano («me llamo Darío», «vivo en Madrid»): el mismo dato tiene que
   reconocerse venga de donde venga. */
const CLAVES = [
  { re: /^(?:el usuario se llama|me llamo|mi nombre es)\s+(.+)$/i, pred: 'nombre', unico: true },
  { re: /^(?:el usuario vive en|vivo en)\s+(.+)$/i, pred: 'vive', unico: true },
  { re: /^(?:el usuario trabaja en|trabajo en)\s+(.+)$/i, pred: 'trabajo', unico: true },
  { re: /^(?:el proyecto del usuario es|mi proyecto es)\s+(.+)$/i, pred: 'proyecto', unico: true },
  {
    re: /^(?:el usuario prefiere que le hable en|háblame en|escríbeme en|contéstame en|quiero que me hables en)\s+(.+)$/i,
    pred: 'idioma',
    unico: true,
  },
  { re: /^(?:al usuario no le gusta|no me gusta)\s+(.+)$/i, pred: 'gusto', unico: false, negado: true },
  { re: /^(?:al usuario le gusta|me gusta|me encanta)\s+(.+)$/i, pred: 'gusto', unico: false },
  { re: /^(?:el usuario prefiere|prefiero|yo prefiero)\s+(.+)$/i, pred: 'prefiere', unico: false },
  { re: /^(?:el usuario siempre|siempre)\s+(.+)$/i, pred: 'siempre', unico: false },
];

/** Las palabras del valor con la raíz aplicada: comparar valores es comparar sus
    palabras, no su puntuación ni sus tildes («el té» ≠ «el café», «Darío» = «Dario»). */
function valorPalabras(valor) {
  return [
    ...new Set(
      sinAcentos(String(valor == null ? '' : valor))
        .split(/[^a-z0-9ñ]+/)
        .filter(Boolean)
        .map(raiz),
    ),
  ];
}

/** ¿Los dos valores dicen lo mismo? Uno puede ser más detallado que el otro («informes en
    PDF» ⊂ «los informes en PDF»), pero ninguno puede aportar una palabra que el otro no
    tenga: eso ya es otro dato. */
function mismoValor(a, b) {
  const A = valorPalabras(a);
  const B = valorPalabras(b);
  if (!A.length || !B.length) return sinAcentos(String(a || '')).trim() === sinAcentos(String(b || '')).trim();
  return A.every((t) => B.includes(t)) || B.every((t) => A.includes(t));
}

/** La clave de un hecho: `{ pred, unico, negado, valor }`, o `null` si la frase no
    declara ningún dato reconocible (ahí no hay nada que comparar). */
function claveHecho(texto) {
  const t = normalizarTexto(texto);
  if (!t) return null;
  for (const c of CLAVES) {
    const m = t.match(c.re);
    if (!m) continue;
    const valor = limpiarValor(m[m.length - 1]);
    if (!valor) continue;
    return { pred: c.pred, unico: !!c.unico, negado: !!c.negado, valor };
  }
  return null;
}

/**
 * Relación entre dos hechos: 'mismo' (el mismo dato), 'cambia' (mismo predicado, valor
 * distinto), 'contradice' (mismo objeto, polaridad invertida), 'otro' (predicados
 * distintos) o `null` (alguno de los dos no declara un dato comparable).
 */
function relacionHechos(a, b) {
  const A = claveHecho(a);
  const B = claveHecho(b);
  if (!A || !B) return null;
  if (A.pred !== B.pred) return 'otro';
  if (!mismoValor(A.valor, B.valor)) return 'cambia';
  return A.negado === B.negado ? 'mismo' : 'contradice';
}

const ORIGENES = ['mensaje', 'herramienta', 'habitos', 'usuario'];

/** La v1 guardaba `source` ('user'|'agent'|'habit'); la v2 lo llama `origen`. */
function origenDe(m) {
  if (ORIGENES.includes(m.origen)) return m.origen;
  if (m.source === 'agent') return 'herramienta';
  if (m.source === 'habit') return 'habitos';
  if (m.source === 'user') return 'usuario';
  return 'mensaje';
}

/** Normaliza cualquier entrada (v1 o v2) a la forma v2 del hecho. */
function normalizarHecho(m) {
  m = m || {}; // un fichero migrado puede traer huecos (null): no puede tumbar la carga
  const texto = normalizarTexto(m.text);
  return {
    id: m.id || 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: texto,
    date: m.date || new Date().toISOString(),
    lastUsed: m.lastUsed || m.date || new Date().toISOString(),
    uses: Number(m.uses) || 0,
    importance: clamp01(m.importance !== undefined ? m.importance : 0.5),
    confidence: clamp01(m.confidence !== undefined ? m.confidence : 0.8),
    origen: origenDe(m),
    origenTexto: normalizarTexto(m.origenTexto) || '',
    etiquetas: Array.isArray(m.etiquetas) ? [...new Set(m.etiquetas.map(String).filter(Boolean))] : [],
    hash: m.hash && String(m.hash).length === 16 ? String(m.hash) : hashTexto(texto),
    papelera: m.papelera || null, // ISO de cuándo se tiró; null = activo
  };
}

/** Fusiona dos hechos que hablan de lo mismo: texto más reciente, usos sumados y el
    origen conservado. `lastUsed` es el más reciente de los dos. */
function fusionarPar(a, b) {
  const [nuevo, viejo] = Date.parse(a.date) >= Date.parse(b.date) ? [a, b] : [b, a];
  return normalizarHecho({
    ...nuevo,
    id: nuevo.id,
    text: nuevo.text, // el texto más reciente
    uses: (Number(a.uses) || 0) + (Number(b.uses) || 0) + 1,
    importance: Math.max(clamp01(a.importance), clamp01(b.importance)),
    lastUsed: Date.parse(a.lastUsed) >= Date.parse(b.lastUsed) ? a.lastUsed : b.lastUsed,
    etiquetas: [...new Set([...(a.etiquetas || []), ...(b.etiquetas || [])])],
    origenTexto: nuevo.origenTexto || viejo.origenTexto,
    origen: nuevo.origen,
    papelera: a.papelera || b.papelera || null,
  });
}

/**
 * Migra una lista v1 (array de entradas) al esquema v2, fusionando los duplicados que
 * se parecen. Devuelve también el registro de fusiones para poder enseñarlo al migrar.
 */
function migrarV1(lista) {
  const hechos = [];
  const fusiones = [];
  for (const raw of Array.isArray(lista) ? lista : []) {
    const h = normalizarHecho(raw);
    if (!h.text) continue;
    const i = hechos.findIndex((x) => x.hash === h.hash || similitud(x.text, h.text) >= FUSION_UMBRAL);
    if (i >= 0) {
      hechos[i] = fusionarPar(hechos[i], h);
      fusiones.push({ seQueda: hechos[i].id, seFusiona: h.id, texto: hechos[i].text });
    } else {
      hechos.push(h);
    }
  }
  return { version: ESQUEMA, hechos, fusiones };
}

/* ---------- extracción heurística ----------
   «¿Esta frase huele a hecho duradero?» — sin llamar al modelo, sin coste, y sin
   inventarse nada. El riesgo real es proponer de MÁS: una bandeja con ruido se apaga y
   la memoria nunca se llena, así que hay tantas guardas de falso positivo como patrones.
   Un falso positivo cuesta un clic de «descartar»; un falso negativo, un hecho que no
   se recuerda.

   El análisis va en cuatro pasos: quitar prefijos conversacionales, trocear en frases,
   descartar las frases que no pueden ser un hecho y, solo entonces, mirar los patrones. */

/* «Oye, recuerda que…», «ten en cuenta que…»: es ruido de conversación, no el hecho. */
const RE_PREFIJOS =
  /^(?:(?:por cierto|oye|mira|recuerda(?:te)?|apúntate|anota|guarda(?:te)?|nota)(?:\s+que)?[,:\s]+|ten en cuenta que\s+|importante[,:\s]+)+/i;
/* Un marcador de corrección suelto se pega a la frase siguiente, que es donde está el
   hecho: «Mejor dicho, prefiero el té» es una sola frase. */
const RE_MARCADOR_CORRECCION = /^(?:no[,:]?\s*)?(?:en realidad|mejor dicho|más bien|corrijo|me corrijo)[,:]?$/i;
const RE_CORRECCION = /^(?:no[,:]?\s*)?(?:en realidad|mejor dicho|más bien|corrijo|me corrijo)[,:]?\s+(.+)$/i;
const RE_PREGUNTA = /[¿?]/;
const RE_CONDICIONAL = /^(?:si|cuando|en caso de que|a menos que|mientras|salvo que)\b/i;
const RE_NEGACION_IDENTIDAD = /^no\s+(?:me llamo|soy|mi nombre es)\b/i;
/* Atribuciones y citas: el hecho es de otro (o es una cita) y no describe al usuario.
   Se mira el MENSAJE entero porque el atribuidor y el hecho pueden caer en frases
   distintas («Según mi jefe, soy un desastre»). */
const RE_TERCEROS = /["“”«»]|\b(?:dice|dijo|decía|comentó|según|afirma|opina|preguntó|respondió)\b/i;
/* Señales de código: se exigen DOS para descartar una frase. Una sola —un paréntesis,
   un `=`— aparece también en castellano. */
const SENALES_CODIGO = [
  /[{}]/,
  /;/,
  /(?:=>|==|!=|<=|>=|\+\+|&&|\|\|)/,
  /`/,
  /\(\)/,
  /\b(?:if|else|for|while|function|const|let|var|class|def|import|export|return|void)\b/,
  /<\/?[a-z]/,
  /\w\s*=\s*["'`\w]/,
];
/* «Soy consciente de que…»: tras «soy» viene un predicado, no una identidad. */
const PREDICADOS_SOY = [
  'consciente',
  'capaz',
  'partidario',
  'fan',
  'muy',
  'tan',
  'alguien',
  'el',
  'la',
  'los',
  'las',
  'un',
  'una',
  'de',
  'del',
  'que',
  'al',
];
const TERCERA = { hago: 'hace', uso: 'usa', escribo: 'escribe', nombro: 'nombra', 'trabajo con': 'trabaja con' };

/* Patrones anclados al principio de la frase: si el hecho no está al principio, no es
   un hecho («¿cómo me llamo?» contiene «me llamo», pero pregunta). */
const PATRONES = [
  {
    re: /^(?:me llamo|mi nombre es)\s+(.+)$/i,
    etiqueta: 'identidad',
    confianza: 0.9,
    motivo: 'parece tu nombre',
    texto: (m) => `El usuario se llama ${m[1]}`,
  },
  {
    re: /^soy\s+(.+)$/i,
    etiqueta: 'identidad',
    confianza: 0.75,
    motivo: 'parece algo que eres',
    predicado: true,
    texto: (m) => `El usuario es ${m[1]}`,
  },
  {
    re: /^no\s+me\s+gusta\s+(.+)$/i,
    etiqueta: 'preferencia',
    confianza: 0.75,
    motivo: 'parece una preferencia tuya',
    texto: (m) => `Al usuario no le gusta ${m[1]}`,
  },
  {
    re: /^(?:yo\s+)?prefiero\s+(.+)$/i,
    etiqueta: 'preferencia',
    confianza: 0.75,
    motivo: 'parece una preferencia tuya',
    texto: (m) => `El usuario prefiere ${m[1]}`,
  },
  {
    re: /^me\s+(?:gusta|encanta)\s+(.+)$/i,
    etiqueta: 'preferencia',
    confianza: 0.7,
    motivo: 'parece una preferencia tuya',
    texto: (m) => `Al usuario le gusta ${m[1]}`,
  },
  {
    re: /^siempre\s+(hago|uso|escribo|nombro|trabajo con)\s+(.+)$/i,
    etiqueta: 'preferencia',
    confianza: 0.7,
    motivo: 'parece algo que haces siempre',
    texto: (m) => `El usuario siempre ${TERCERA[m[1].toLowerCase()] || m[1]} ${m[2]}`,
  },
  {
    re: /^(?:siempre\s+)?trabajo\s+en\s+(.+)$/i,
    etiqueta: 'proyecto',
    confianza: 0.8,
    motivo: 'parece un dato de tu proyecto',
    texto: (m) => `El usuario trabaja en ${m[1]}`,
  },
  {
    re: /^(?:mi proyecto|el proyecto en el que trabajo)\s+es\s+(.+)$/i,
    etiqueta: 'proyecto',
    confianza: 0.8,
    motivo: 'parece un dato de tu proyecto',
    texto: (m) => `El proyecto del usuario es ${m[1]}`,
  },
  {
    re: /^(?:háblame|respóndeme|contéstame|escríbeme|comunícate)\s+en\s+(.+)$/i,
    etiqueta: 'idioma',
    confianza: 0.85,
    motivo: 'parece tu idioma',
    texto: (m) => `El usuario prefiere que le hable en ${m[1]}`,
  },
  {
    re: /^quiero\s+que\s+me\s+(?:hables|respondas|escribas)\s+en\s+(.+)$/i,
    etiqueta: 'idioma',
    confianza: 0.85,
    motivo: 'parece tu idioma',
    texto: (m) => `El usuario prefiere que le hable en ${m[1]}`,
  },
];

const palabras = (s) => (String(s || '').match(/[\p{L}\p{N}]+/gu) || []).length;

/* Un valor concreto dentro de una frase: un nombre propio, un número, una ruta o un
   dominio. Es lo que distingue una corrección que vale la pena recordar («en realidad
   vivo en Madrid») de una petición pasajera («en realidad quiero que me lo digas otra
   vez»), que es conversación y no memoria. */
const RE_VALOR_CONCRETO = /\b\p{Lu}\p{Ll}+\b|\p{Nd}|[\\/]|\.[a-z]{2,}\b/u;

/** Recorta la puntuación final de un valor («el té,» → «el té»). */
function limpiarValor(x) {
  return normalizarTexto(String(x || '').replace(/[,;:!?]+$/, '')).replace(/^["'«»]+|["'«»]+$/g, '');
}

function capitalizar(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Trocea el mensaje en frases candidatas (con prefijos fuera y conjunciones resueltas). */
function triturar(texto) {
  const t = normalizarTexto(texto).replace(RE_PREFIJOS, '');
  if (!t) return [];
  /* El punto solo corta si va seguido de espacio o del final: así «sagitari.app» no se
     parte en dos y «Me llamo Darío. Prefiero el té.» sí. */
  const crudas = t
    .split(/[.;!?…]+(?=\s|$)|,(?=\s|$)|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const frases = [];
  let pendiente = '';
  for (const cruda of crudas) {
    if (RE_MARCADOR_CORRECCION.test(cruda)) {
      pendiente = pendiente ? pendiente + ', ' + cruda : cruda;
      continue;
    }
    frases.push(pendiente ? pendiente + ', ' + cruda : cruda);
    pendiente = '';
  }
  if (pendiente) frases.push(pendiente);
  /* La conjunción solo corta si lo que sigue arranca un patrón por sí solo: «me llamo
     Darío y prefiero el té» son dos hechos, «prefiero el té y el café» es uno. */
  const salida = [];
  for (const f of frases) {
    const partes = f.split(/\s+y\s+/i);
    const resto = partes.slice(1).join(' y ');
    if (partes.length > 1 && PATRONES.some((p) => p.re.test(resto))) salida.push(partes[0], resto);
    else salida.push(f);
  }
  return salida;
}

/** ¿Esta frase puede contener un hecho? Primero se descarta todo lo que no puede. */
function esCandidata(frase, mensaje) {
  if (RE_TERCEROS.test(mensaje)) return false; // atribuido a otro o entrecomillado
  if (palabras(frase) < 3) return false;
  if (RE_PREGUNTA.test(frase)) return false;
  if (RE_CONDICIONAL.test(frase)) return false;
  if (RE_NEGACION_IDENTIDAD.test(frase)) return false;
  if (SENALES_CODIGO.filter((r) => r.test(frase)).length >= 2) return false;
  return true;
}

function primeraPalabra(s) {
  const m = String(s || '').match(/[\p{L}\p{N}]+/u);
  return m ? m[0].toLowerCase() : '';
}

/** Extrae, como mucho, un hecho de una frase. */
function extraerDeFrase(frase, mensaje) {
  if (!esCandidata(frase, mensaje)) return null;
  const correccion = frase.match(RE_CORRECCION);
  const cuerpo = correccion ? correccion[1].trim() : frase;
  const bonus = correccion ? 0.1 : 0;
  for (const p of PATRONES) {
    const m = cuerpo.match(p.re);
    if (!m) continue;
    if (p.predicado && PREDICADOS_SOY.includes(primeraPalabra(m[1]))) continue;
    const valor = limpiarValor(m[m.length - 1]);
    if (!valor) continue;
    return {
      texto: normalizarTexto(p.texto(m.map((x, i) => (i === m.length - 1 ? valor : x)))),
      etiquetas: [p.etiqueta],
      confianza: Math.min(0.95, p.confianza + bonus),
      motivo: p.motivo,
      origen: 'mensaje',
      origenTexto: mensaje,
    };
  }
  /* Rectificar algo es, por definición, información duradera, pero solo si la corrección
     APORTA UN VALOR concreto: sin él la frase es conversación (una petición, un «dímelo
     otra vez») y la bandeja no debe llenarse con ella. */
  if (correccion && palabras(cuerpo) >= 3 && RE_VALOR_CONCRETO.test(cuerpo)) {
    return {
      texto: normalizarTexto(capitalizar(cuerpo)),
      etiquetas: ['correccion'],
      confianza: 0.7,
      motivo: 'parece una corrección de algo anterior',
      origen: 'mensaje',
      origenTexto: mensaje,
    };
  }
  return null;
}

/** Corta el mensaje en frases y devuelve, como mucho, dos hechos duraderos (la bandeja
    tiene que poder mirarse de un vistazo). Sin propuesta si la frase no huele a nada. */
function proponerHechos(texto) {
  if (typeof texto !== 'string') return [];
  const mensaje = normalizarTexto(texto);
  if (mensaje.length < 8) return [];
  const props = [];
  const vistos = new Set();
  for (const frase of triturar(mensaje)) {
    const p = extraerDeFrase(frase, mensaje);
    if (!p) continue;
    const huella = hashTexto(p.texto);
    if (vistos.has(huella)) continue; // el mismo hecho dos veces en el mismo mensaje
    vistos.add(huella);
    props.push(p);
  }
  return props.slice(0, 2);
}

/* ---------- olvido ---------- */

/** Con qué día se mide la antigüedad de un hecho: su último uso o, si nunca se usó, su creación. */
function ultimoToque(h) {
  return Date.parse(h.lastUsed) || Date.parse(h.date) || Date.now();
}

/** Qué le toca a un hecho por antigüedad. null = se queda como está. */
function decidirOlvido(h, ahora = Date.now()) {
  if (h.papelera) return null;
  const dias = (ahora - ultimoToque(h)) / 86400000;
  if (dias >= OLVIDO_PAPELERA_DIAS) return { accion: 'papelera' };
  if (dias >= OLVIDO_BAJA_DIAS) return { accion: 'baja' };
  return null;
}

/** ¿Lleva un hecho en la papelera más de lo que se puede recuperar? */
function expiradoEnPapelera(h, ahora = Date.now()) {
  if (!h.papelera) return false;
  return ahora - (Date.parse(h.papelera) || ahora) >= PAPELERA_DIAS * 86400000;
}

module.exports = {
  ESQUEMA,
  OLVIDO_BAJA_DIAS,
  OLVIDO_PAPELERA_DIAS,
  PAPELERA_DIAS,
  FUSION_UMBRAL,
  STOP,
  normalizarTexto,
  sinAcentos,
  hashTexto,
  tokenizar,
  tokenizarRaiz,
  similitud,
  claveHecho,
  relacionHechos,
  normalizarHecho,
  fusionarPar,
  migrarV1,
  proponerHechos,
  decidirOlvido,
  expiradoEnPapelera,
};
