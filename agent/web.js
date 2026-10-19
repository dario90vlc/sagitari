'use strict';

/* ============================================================================
   web.js — traer una página web al contexto (herramienta web_fetch).

   POR QUÉ existe: hoy el agente solo puede ver la web a través del navegador
   real (browser_control), que arranca Chromium, abre ventanas y cuesta pasos.
   Para «dame el contenido de esta documentación» eso es un cañón: esto es un
   GET con tope de tamaño, reducción a texto y nada más.

   POR QUÉ el filtro SSRF no es un `if (host === 'localhost')`: el agente corre
   DENTRO del equipo del usuario. Un `web_fetch` ingenuo es un proxy hacia la
   red interna (routers, paneles de administración, servicios sin contraseña) y
   hacia los servicios de metadatos del propio equipo. Por eso se comprueba
   (1) el literal del host, (2) a TODAS las direcciones a las que resuelve, y
   (3) CADA redirección: un `302` a `http://169.254.169.254/` burlaría el
   primer chequeo. Lo que no se puede verificar, se bloquea.

   Solo http(s) y solo por GET: nada de métodos, cabeceras del usuario ni
   cuerpos. La herramienta no filtra datos del usuario hacia fuera.
   ============================================================================ */

const dns = require('dns');
const net = require('net');
const terceros = require('./terceros'); // marco único del contenido de terceros (datos, no órdenes)

const MAX_BYTES = 5 * 1024 * 1024; // tope de descarga: aborta al pasarse (ver leerConTope)
const MAX_CHARS_DEF = 12000; // lo que entra al contexto por defecto
const MAX_CHARS_TOPE = 40000; // tope duro del texto devuelto
const MAX_CHARS_MIN = 500;
const MAX_REDIRECCIONES = 5; // cada salto se vuelve a comprobar
const TIMEOUT_MS = 20000;
const USER_AGENT = 'Sagitari/4.1 (+https://github.com/sagitari)';

/* --------------------------------------------------------------------------- *
 *  Filtro SSRF (puro y testeable: sin red)
 * --------------------------------------------------------------------------- */

/** Miembro de la cuádrupla IPv4 en rango privado/reservado (o no verificable). */
function ipv4Bloqueada(a, b) {
  if (a === 0 || a === 10 || a === 127) return true; // "este equipo", privada, loopback
  if (a === 169 && b === 254) return true; // link-local (incluye 169.254.169.254, metadatos)
  if (a === 172 && b >= 16 && b <= 31) return true; // privada
  if (a === 192 && b === 168) return true; // privada
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments / TEST-NET-2 base
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast (224/4) + reservado (240/4) + broadcast
  return false;
}

/** ¿Es una dirección IP que no debe poder alcanzar el agente? Cualquier cosa que
    no sea una IP se considera bloqueada (no se puede verificar → no se permite). */
function ipBloqueada(ip) {
  const v = net.isIP(String(ip || '').replace(/^\[|\]$/g, ''));
  if (v === 4) {
    const p = String(ip).split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    return ipv4Bloqueada(p[0], p[1]);
  }
  if (v === 6) {
    const s = String(ip)
      .toLowerCase()
      .replace(/^\[|\]$/g, '');
    if (s === '::' || s === '::1') return true; // sin dirección / loopback
    // IPv4 mapeada: ::ffff:127.0.0.1 o ::ffff:7f00:1 → se juzga como su IPv4
    const punto = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (punto) return ipBloqueada(punto[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
    if (hex) {
      const hi = parseInt(hex[1], 16),
        lo = parseInt(hex[2], 16);
      return ipv4Bloqueada((hi >> 8) & 255, hi & 255) || ipv4Bloqueada((lo >> 8) & 255, lo & 255);
    }
    if (/^fe[89ab]/.test(s)) return true; // link-local fe80::/10
    if (/^f[cd]/.test(s)) return true; // unique local fc00::/7
    if (s.startsWith('ff')) return true; // multicast
    return false;
  }
  return true; // no es una IP: no verificable
}

/** Nombres que jamás salen a la red pública, aunque no se resuelvan. */
function hostBloqueadoPorNombre(host) {
  const h = String(host || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, ''); // "localhost." es el mismo nombre que "localhost"
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === 'local' || h.endsWith('.local')) return true; // mDNS (Bonjour/impresoras…)
  if (h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  if (h === 'metadata' || h === 'metadata.google.internal') return true;
  if (net.isIP(h.replace(/^\[|\]$/g, '')) && ipBloqueada(h)) return true;
  return false;
}

/** Comprueba el host de una URL: nombre prohibido, IP literal prohibida y, si es un
    nombre, TODAS las direcciones a las que resuelve. Rechaza si no se puede resolver:
    una dirección que no se puede verificar no se abre. */
async function hostPermitido(host, { resolver = dns.promises.lookup } = {}) {
  const h = String(host || '').replace(/^\[|\]$/g, '');
  if (hostBloqueadoPorNombre(h)) return { ok: false, motivo: `«${h}» es una dirección local o privada` };
  if (!net.isIP(h)) {
    let dirs;
    try {
      dirs = await resolver(h, { all: true });
    } catch {
      return { ok: false, motivo: `no pude resolver «${h}»` };
    }
    for (const d of dirs || []) {
      if (ipBloqueada(d && d.address)) return { ok: false, motivo: `«${h}» resuelve a una dirección privada (${d.address})` };
    }
    const ip = (dirs && dirs.length && dirs[0] && dirs[0].address) || h;
    return { ok: true, ip };
  }
  return { ok: true, ip: h };
}

/* --------------------------------------------------------------------------- *
 *  HTML → texto
 * --------------------------------------------------------------------------- */

const ENTIDADES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  ntilde: 'ñ',
  uuml: 'ü',
  iquest: '¿',
  iexcl: '¡',
  middot: '·',
  bull: '•',
  times: '×',
  deg: '°',
  euro: '€',
  pound: '£',
  copy: '©',
  reg: '®',
  trade: '™',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

/** Descodifica entidades HTML (con nombre, decimales y hexadecimales). */
function decodificar(s) {
  return String(s).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const hex = e[1] === 'x' || e[1] === 'X';
      const n = parseInt(hex ? e.slice(2) : e.slice(1), hex ? 16 : 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    const k = e.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTIDADES, k) ? ENTIDADES[k] : m;
  });
}

/** Cuerpo de un <script>/<style>/<nav>… anidado: un regex no entiende de anidamiento,
    pero para HTML real (donde no se anidan) quitar el bloque completo es suficiente. */
const BLOQUES_FUERA = /<(script|style|noscript|template|svg|iframe|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const ETIQUETA_CORTE = /<\/?(p|div|section|article|li|ul|ol|tr|table|thead|tbody|h[1-6]|blockquote|pre|figure|dl|dt|dd)\b[^>]*>/gi;

/** HTML → texto plano legible: fuera scripts/estilos/navegación, saltos donde el
    HTML separa bloques, entidades decodificadas y espacios colapsados. */
function aTexto(html) {
  let s = String(html == null ? '' : html);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(BLOQUES_FUERA, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(td|th)\s*>/gi, '\t');
  s = s.replace(ETIQUETA_CORTE, '\n');
  s = s.replace(/<[^>]*>/g, ' '); // lo que quede son etiquetas en línea
  s = decodificar(s);
  return limpiarTexto(s);
}

/** Colapsa el ruido de la conversión sin comerse la estructura de párrafos. */
function limpiarTexto(t) {
  return String(t == null ? '' : t)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* --------------------------------------------------------------------------- *
 *  Descarga
 * --------------------------------------------------------------------------- */

/** Lee el cuerpo con tope, abortando al pasarse (mismo criterio que skills.js): bufferizar
    primero y medir después dejaría el tope sin aplicar durante la descarga. */
async function leerConTope(res, max) {
  const declarado = Number(res.headers.get('content-length') || 0);
  if (declarado && declarado > max) throw new Error(`la página pesa ${mb(declarado)} y el límite es ${mb(max)}`);
  if (!res.body) return '';
  const reader = res.body.getReader();
  const trozos = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try {
        await reader.cancel();
      } catch {}
      throw new Error(`la página pasa de ${mb(max)} (se cortó la descarga)`);
    }
    trozos.push(Buffer.from(value));
  }
  return Buffer.concat(trozos).toString('utf8');
}

const mb = (n) => `${(Number(n) / 1048576).toFixed(1)} MB`;

/** Cabeceras y estado de una respuesta: `HTTP 200, text/html, 45.2 KB`. */
function aspecto(res, bytes) {
  const tipo =
    String(res.headers.get('content-type') || '')
      .split(';')[0]
      .trim() || 'sin tipo';
  return `HTTP ${res.status}, ${tipo}, ${(Number(bytes) / 1024).toFixed(1)} KB`;
}

/**
 * Trae una URL y devuelve `{url, status, texto}` con el texto YA listo para el modelo.
 * Lanza Error con un mensaje en español (lo enseña la herramienta tal cual) en todos
 * los casos que no son una página legible: esquema no http(s), host prohibido, fallo
 * de red, timeout, límite de tamaño.
 *
 * @param {string} url
 * @param {{maxChars?: number, fetchFn?: Function, registerKillable?: Function,
 *          resolver?: Function}} [opts]
 */
async function traer(url, opts = {}) {
  const fetchFn = opts.fetchFn || fetch;
  let actual;
  try {
    actual = new URL(String(url || '').trim());
  } catch {
    throw new Error(`«${String(url).slice(0, 120)}» no es una URL válida. Escribe la dirección completa, con http(s)://`);
  }
  if (actual.protocol !== 'http:' && actual.protocol !== 'https:') {
    throw new Error(`solo puedo traer direcciones http(s): «${actual.protocol}//» no es una web`);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  if (opts.registerKillable) opts.registerKillable({ stop: () => ac.abort() });
  const dispatchers = [];
  try {
    let res = null;
    let bytes = 0;
    for (let salto = 0; salto <= MAX_REDIRECCIONES; salto++) {
      const puerta = await hostPermitido(actual.hostname, opts.resolver ? { resolver: opts.resolver } : {});
      if (!puerta.ok) throw new Error(`no salgo a la red interna: ${puerta.motivo}`);
      // Fijar la resolución: conectar a la IP ya validada (cierra la ventana TOCTOU
      // entre la comprobación de arriba y la petición real, que volvía a resolver).
      let dispatcher = null;
      const hostLimpio = String(actual.hostname || '').replace(/^\[|\]$/g, '');
      if (!net.isIP(hostLimpio) && puerta.ip) {
        const ip = puerta.ip;
        const { Agent } = require('undici');
        dispatcher = new Agent({
          connect(opts, callback) {
            const isHttps = opts.protocol === 'https:';
            const port = opts.port || (isHttps ? 443 : 80);
            const servername = opts.servername || opts.hostname;
            const mod = isHttps ? require('node:tls') : require('node:net');
            const socketOpts = isHttps ? { host: ip, port, servername } : { host: ip, port };
            // `entregar` se llama como MUCHO una vez: un error del socket después de
            // conectar no puede volver a disparar el callback del conector de undici.
            let settled = false;
            const entregar = (err, socket) => {
              if (settled) return;
              settled = true;
              callback(err, socket);
            };
            const socket = mod.connect(socketOpts, () => entregar(null, socket));
            socket.once('error', (e) => entregar(e));
          },
        });
        dispatchers.push(dispatcher);
      }
      try {
        res = await fetchFn(actual.href, {
          method: 'GET',
          redirect: 'manual', // las redirecciones las sigo yo para poder re-comprobarlas
          signal: ac.signal,
          headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5' },
          dispatcher,
        });
      } catch (e) {
        if (ac.signal.aborted) throw new Error(`se agotó el tiempo (${TIMEOUT_MS / 1000} s) o se canceló la descarga de ${actual.href}`);
        throw new Error(`no pude conectar con ${actual.host}: ${(e && e.message) || e}`);
      }
      const saltoA = [301, 302, 303, 307, 308].includes(res.status) ? res.headers.get('location') : null;
      if (!saltoA) break;
      if (salto >= MAX_REDIRECCIONES) throw new Error(`demasiadas redirecciones (más de ${MAX_REDIRECCIONES}) desde ${url}`);
      let destino;
      try {
        destino = new URL(saltoA, actual);
      } catch {
        throw new Error(`la redirección de ${actual.href} apunta a una dirección inválida`);
      }
      if (destino.protocol !== 'http:' && destino.protocol !== 'https:') {
        throw new Error(`la redirección sale de http(s) («${destino.protocol}//»): no la sigo`);
      }
      actual = destino;
    }
    if (!res) throw new Error(`no pude obtener ${url}`);

    const esHtml = /html|xml/i.test(String(res.headers.get('content-type') || ''));
    const esTexto = esHtml || /^text\/|json|javascript|csv/i.test(String(res.headers.get('content-type') || ''));
    let cuerpo = '';
    try {
      cuerpo = await leerConTope(res, MAX_BYTES);
    } catch (e) {
      if (res.status >= 400) cuerpo = '';
      else throw e;
    }
    bytes = Buffer.byteLength(cuerpo, 'utf8');
    const cabecera = `URL final: ${actual.href} (${aspecto(res, bytes)})`;
    if (!esTexto) {
      return {
        url: actual.href,
        status: res.status,
        /* El texto de la web son DATOS de terceros: va envuelto con el mismo bloque
           que las skills (terceros.js) para que el modelo no lo tome por órdenes. */
        texto: terceros.envolver(
          'LA WEB',
          `${cabecera}\n\n(El servidor devolvió un archivo binario: no lo puedo leer como texto. Puedo bajarlo con run_command si hace falta.)`,
        ),
      };
    }
    const limpio = esHtml ? aTexto(cuerpo) : limpiarTexto(cuerpo);
    const max = Math.min(Math.max(Number(opts.maxChars) || MAX_CHARS_DEF, MAX_CHARS_MIN), MAX_CHARS_TOPE);
    const recorte =
      limpio.length > max
        ? `\n\n...[recortado: ${max} de ${limpio.length} caracteres. Pide solo lo que necesites o vuelve a llamarme con max_chars mayor]`
        : '';
    // El cuerpo NO se escapa ni se recorta aquí de más: el recorte ya está hecho (max).
    return {
      url: actual.href,
      status: res.status,
      texto: terceros.envolver('LA WEB', `${cabecera}\n\n${limpio.slice(0, max)}${recorte}`),
    };
  } finally {
    clearTimeout(timer);
    for (const d of dispatchers) {
      try {
        d.close();
      } catch {}
    }
  }
}

/* Definición de la herramienta: la registra tools.js (mismo patrón que delegate). */
function webFetchDef() {
  return {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Trae el CONTENIDO de una página web como texto (un GET, sin navegador). Úsalo cuando ya sepas la URL y solo quieras leerla: documentación, un README, una API JSON, un artículo. Es mucho más barato que abrir el navegador. Devuelve la URL final, el código HTTP y el texto ya limpio (sin scripts ni menús), recortado a max_chars. Solo http(s) y solo páginas públicas: las direcciones locales/privadas están bloqueadas. Para páginas que necesitan sesión, JavaScript o clics, usa browser_control.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Dirección http(s) completa' },
          max_chars: { type: 'number', description: 'Máximo de caracteres a devolver (por defecto 12000, tope 40000)' },
        },
        required: ['url'],
      },
    },
  };
}

module.exports = {
  traer,
  aTexto,
  limpiarTexto,
  decodificar,
  ipBloqueada,
  hostBloqueadoPorNombre,
  hostPermitido,
  webFetchDef,
  MAX_BYTES,
  MAX_CHARS_DEF,
  MAX_CHARS_TOPE,
  MAX_REDIRECCIONES,
  TIMEOUT_MS,
};
