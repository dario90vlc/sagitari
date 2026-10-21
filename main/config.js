'use strict';

/* Configuración y claves de API de SAGITARI.
   Las claves se guardan cifradas con el almacén del sistema (DPAPI en Windows vía
   safeStorage): un config.json copiado, sincronizado o leído por otro programa ya
   no expone las credenciales. En memoria siempre están en claro porque el agente
   las necesita para llamar al proveedor. Si el sistema no ofrece cifrado, se
   guarda en claro y queda constancia en el log: antes se hacía siempre. */

const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

const KEY_PREFIX = 'enc:v1:';

function encryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function protectKey(k) {
  if (typeof k !== 'string' || !k) return k;
  if (k.startsWith(KEY_PREFIX)) return k; // ya estaba cifrada
  if (!encryptionAvailable()) return k;
  try {
    return KEY_PREFIX + safeStorage.encryptString(k).toString('base64');
  } catch {
    return k;
  }
}

/**
 * Descifra una clave guardada. Si no se puede descifrar (config copiada de otro
 * equipo o perfil, o clave maestra recreada), se devuelve el CRIPTOGRAMA tal cual
 * para que el siguiente guardado no lo pise con una cadena vacía: antes la credencial
 * se destruía en silencio (el .bak incluido) y no había vuelta atrás.
 * @param {(kind: string, err: Error) => void} onError — callback para registrar el fallo
 */
function revealKey(k, onError) {
  if (typeof k !== 'string' || !k.startsWith(KEY_PREFIX)) return k;
  try {
    return safeStorage.decryptString(Buffer.from(k.slice(KEY_PREFIX.length), 'base64'));
  } catch {
    if (onError) onError('revealKey', new Error('no se pudo descifrar una clave guardada en este equipo; vuelve a escribirla en Ajustes'));
    return k;
  }
}

/** Cifra los valores de env/headers de un servidor MCP (pueden ser tokens). */
function protectServerSecrets(s) {
  const paint = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, protectKey(String(v))]));
  return { ...s, env: paint(s.env), headers: paint(s.headers) };
}

/** Descifra los valores de env/headers de un servidor MCP.
 *  @param {(k: string) => string} revealKeyFn — función para descifrar cada valor */
function revealServerSecrets(s, revealKeyFn) {
  const paint = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, revealKeyFn(String(v))]));
  return { ...s, env: paint(s.env), headers: paint(s.headers) };
}

/* Los bloqueos PASAJEROS de Windows no son un fallo del usuario: el antivirus abre
   el archivo recién creado para examinarlo y, si el guardado llega en ese instante,
   el open devuelve EPERM/EBUSY. Se reintenta un par de veces con una espera corta
   (la misma práctica que usan los editores en Windows) en vez de perder el ajuste. */
const TRANSITORIOS = ['EPERM', 'EACCES', 'EBUSY', 'EMFILE', 'ENFILE'];
function reintentar(fn, intentos = 3) {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (!e || !TRANSITORIOS.includes(e.code) || i >= intentos - 1) throw e;
      const hasta = Date.now() + 40 * (i + 1);
      while (Date.now() < hasta) {
        // espera corta y sincrónica: el guardado es síncrono y lo usan varios routers
      }
    }
  }
}

/* Guardado atómico: se escribe en un temporal ÚNICO (proceso + secuencia) y se
   renombra encima, y antes de pisar el archivo bueno se conserva una copia .bak.
   El temporal fijo (`<archivo>.tmp`) chocaba con otro escritor del mismo archivo
   —dos instancias con perfiles distintos comparten el directorio de datos— y el
   open de la segunda fallaba con EPERM. Un nombre único por escritura no choca
   con nadie y el rename sigue siendo atómico. */
let _tmpSeq = 0;
function writeJsonAtomic(file, data) {
  const tmp = file + '.' + process.pid + '.' + ++_tmpSeq + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    reintentar(() => fs.writeFileSync(tmp, data, 'utf8'));
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
    } catch {}
    reintentar(() => fs.renameSync(tmp, file));
  } catch (e) {
    // un fallo definitivo no deja basura al lado de la configuración
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

/* Config de la app ANTERIOR tal y como se puede dejar en disco SIN credenciales.
   Se usa al migrar: copiar la config a SAGITARI —donde las claves ya se cifran— no
   sirve de nada si el fichero viejo se queda con la clave en claro al lado. Mismo
   fichero, mismas claves, mismos valores: solo desaparecen los secretos. */
function sinSecretos(raw) {
  const limpio = { ...(raw && typeof raw === 'object' ? raw : {}) };
  const vaciar = (p) => (p && typeof p === 'object' ? { ...p, apiKey: '' } : p);
  if (limpio.active) limpio.active = vaciar(limpio.active);
  if (Array.isArray(limpio.providers)) limpio.providers = limpio.providers.map(vaciar);
  if (limpio.mcp && Array.isArray(limpio.mcp.servers)) {
    limpio.mcp = {
      ...limpio.mcp,
      servers: limpio.mcp.servers.map((s) => ({ ...s, env: {}, headers: {}, url: sinCredenciales(s && s.url) })),
    };
  }
  return limpio;
}

/** URL sin usuario/contraseña ni `?key=…` (mismo criterio que `urlLlevaCredenciales`,
    que vive en el módulo puro de MCP: aquí no se importa para no crear un ciclo). */
function sinCredenciales(u) {
  if (typeof u !== 'string' || !u) return u;
  try {
    const x = new URL(u);
    if (x.username || x.password) {
      x.username = '';
      x.password = '';
    }
    for (const k of ['key', 'api_key', 'apikey', 'token', 'access_token']) x.searchParams.delete(k);
    return x.toString();
  } catch {
    return u; // no es una URL absoluta: se deja tal cual
  }
}

module.exports = {
  KEY_PREFIX,
  encryptionAvailable,
  protectKey,
  revealKey,
  protectServerSecrets,
  revealServerSecrets,
  sinSecretos,
  writeJsonAtomic,
};
