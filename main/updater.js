'use strict';

/* Actualizador de SAGITARI.

   Comprueba la última release publicada en GitHub, descarga el instalador y lo
   ejecuta. Sin dependencias: la API pública de GitHub no necesita autenticación
   y el único binario que descargamos es el que publica nuestro propio CI, que
   viene con su sha512 en `latest.yml` (se verifica antes de ejecutarlo).

   Tres modos según cómo se esté ejecutando la app (`hostKind`):
     nsis     → instalada con el instalador: descarga el Setup y lo lanza en silencio
     portable → el .exe portable: descarga el portable nuevo junto al actual
     dev      → desde el código fuente: comprueba, pero no instala nada

   Todo lo que depende del entorno (fetch, versión actual, isPackaged) se inyecta
   para poder probarlo sin red y sin Electron. */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = 'dario90vlc/sagitari';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const UA = 'SAGITARI-updater';

/* ---------- versiones ---------- */

/** «v2.2.0-beta.1» → { nums: [2,2,0], pre: 'beta.1' } (null si no es una versión). */
function parseVersion(v) {
  const m = String(v == null ? '' : v).trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' };
}

/** -1 si a<b, 0 si son iguales, 1 si a>b. Una versión desconocida no se declara «más nueva». */
function compareVersions(a, b) {
  const A = parseVersion(a);
  const B = parseVersion(b);
  if (!A || !B) return 0;
  for (let i = 0; i < 3; i++) if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1;
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1;    // 2.0.0 > 2.0.0-beta.1
  if (!B.pre) return -1;
  return A.pre < B.pre ? -1 : 1;
}

/* ---------- assets de la release ---------- */

/** Localiza en la release lo que sabemos usar. */
function pickAssets(release) {
  const assets = (release && release.assets) || [];
  const find = (rx) => assets.find(a => rx.test(String(a.name || ''))) || null;
  const slim = (a) => (a ? { name: a.name, url: a.browser_download_url, size: a.size || 0 } : null);
  return {
    setup: slim(find(/^SAGITARI-Setup-.*\.exe$/i)),
    portable: slim(find(/^SAGITARI-Portable-.*\.exe$/i)),
    yml: slim(find(/^latest\.yml$/i)),
  };
}

/** Url desde la que se descarga el binario que corresponde a este modo de ejecución. */
function assetFor(kind, assets) {
  if (!assets) return null;
  const a = kind === 'portable' ? (assets.portable || assets.setup) : (assets.setup || assets.portable);
  return a || null;
}

/* ---------- latest.yml (sha512 del binario) ---------- */

/**
 * Parser mínimo del `latest.yml` que genera electron-builder. No es un YAML
 * genérico: solo necesitamos `version`, la ruta y el sha512 de cada archivo.
 */
function parseLatestYml(text) {
  const src = String(text || '');
  const val = (re) => {
    const m = src.match(re);
    return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null;
  };
  const out = { version: val(/^version:\s*(.+)$/m), path: val(/^path:\s*(.+)$/m), sha512: val(/^sha512:\s*(.+)$/m), files: [] };
  // El bloque `files:` son SOLO las líneas indentadas que le siguen (`^` y `$`
  // con /m casan en cualquier línea, así que el corte se hace por indentación).
  const block = src.match(/^files:[ \t]*\r?\n((?:[ \t]+[^\n]*\r?\n?)*)/m);
  if (block) {
    for (const item of block[1].split(/^[ \t]*-[ \t]*/m).filter(s => s.trim())) {
      const url = (item.match(/url:\s*(.+)/) || [])[1];
      const sha512 = (item.match(/sha512:\s*(.+)/) || [])[1];
      const size = (item.match(/size:\s*(\d+)/) || [])[1];
      if (url || sha512) out.files.push({ url: url ? url.trim().replace(/^['"]|['"]$/g, '') : null, sha512: sha512 ? sha512.trim() : null, size: size ? Number(size) : null });
    }
  }
  return out;
}

/** sha512 en base64 (el formato que usa latest.yml), o null si no se pudo leer. */
function sha512Of(file) {
  try { return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64'); } catch { return null; }
}

/* ---------- comprobación ---------- */

/**
 * ¿Hay una versión más nueva publicada?
 * @returns {Promise<{ok, current, latest, available, url, name, publishedAt, notes, assets, assetsOk, error?}>}
 */
async function checkForUpdate({ currentVersion, fetchFn = fetch, api = API_LATEST, timeoutMs = 12000 } = {}) {
  const base = { ok: true, current: currentVersion, latest: null, available: false, url: null, name: null, publishedAt: null, notes: null, assets: null };
  try {
    const res = await fetchFn(api, {
      headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return { ...base, error: 'sin releases publicadas' };   // repo sin ninguna release
    if (!res.ok) return { ...base, ok: false, error: 'GitHub respondió ' + res.status };
    const rel = await res.json();
    if (!rel || rel.draft || rel.prerelease) return base;                            // borradores/prerelease no cuentan
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    const assets = pickAssets(rel);
    return {
      ...base,
      latest,
      available: compareVersions(latest, currentVersion) > 0,
      url: rel.html_url || null,
      name: rel.name || null,
      publishedAt: rel.published_at || null,
      notes: String(rel.body || '').slice(0, 4000),
      assets,
      assetsOk: !!(assets.setup || assets.portable),
    };
  } catch (e) {
    const msg = e && e.name === 'TimeoutError' ? 'la comprobación tardó demasiado' : ((e && e.message) || 'error de red');
    return { ...base, ok: false, error: msg };
  }
}

/* ---------- descarga ---------- */

/** Directorio y nombre donde dejar el binario descargado, según el modo. */
function downloadTarget({ kind, assetName, env = process.env }) {
  const name = String(assetName || 'sagitari-update.exe').replace(/[^\w.\-]/g, '_');
  if (kind === 'portable' && env.PORTABLE_EXECUTABLE_DIR) return { dir: env.PORTABLE_EXECUTABLE_DIR, path: path.join(env.PORTABLE_EXECUTABLE_DIR, name) };
  const dir = path.join(os.tmpdir(), 'sagitari-update');
  return { dir, path: path.join(dir, name) };
}

/**
 * Descarga con progreso y devuelve el sha512 (base64) del archivo descargado.
 * Escribe primero a `.part` y renombra al terminar: un corte no deja un .exe a medias.
 */
async function downloadTo(url, dest, { fetchFn = fetch, onProgress = null, timeoutMs = 0, idleTimeoutMs = 60000 } = {}) {
  // Un servidor que acepta la conexión y deja de enviar datos dejaría la
  // descarga (y el .part) vivos para siempre: el vigilante de inactividad corta
  // si pasan `idleTimeoutMs` sin recibir un solo chunk. `timeoutMs` sigue siendo
  // el tope global opcional.
  const ac = new AbortController();
  let idle = null;
  const bump = () => {
    if (!(idleTimeoutMs > 0)) return;
    clearTimeout(idle);
    idle = setTimeout(() => ac.abort(new Error('la descarga se quedó sin datos')), idleTimeoutMs);
  };
  const deadline = timeoutMs > 0 ? setTimeout(() => ac.abort(new Error('la descarga tardó demasiado')), timeoutMs) : null;
  const clearWatchdogs = () => { clearTimeout(idle); clearTimeout(deadline); };
  try {
    const res = await fetchFn(url, {
      headers: { 'User-Agent': UA, Accept: 'application/octet-stream' },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error('la descarga respondió ' + res.status);
    const total = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0) || 0;
    const part = dest + '.part';
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const hash = crypto.createHash('sha512');
    const fh = await fs.promises.open(part, 'w');
    let received = 0;
    let lastTick = 0;
    try {
      bump();
      for await (const chunk of res.body) {
        bump();
        hash.update(chunk);
        received += chunk.length;
        await fh.write(chunk);
        if (onProgress && Date.now() - lastTick > 250) {
          lastTick = Date.now();
          onProgress({ received, total, pct: total ? Math.min(99, Math.round((received / total) * 100)) : null });
        }
      }
    } catch (e) {
      await fh.close().catch(() => {});
      await fs.promises.rm(part, { force: true }).catch(() => {});
      throw e;
    }
    await fh.close();
    await fs.promises.rename(part, dest);
    return { path: dest, bytes: received, sha512: hash.digest('base64') };
  } finally {
    clearWatchdogs();
  }
}

/* ---------- firma Authenticode ---------- */

/**
 * Firma digital del binario descargado (status + firmante), según Windows.
 * El SHA-512 publicado en la misma release demuestra integridad, pero no
 * autenticidad: si el repositorio se compromete, el binario y su hash lo hacen
 * a la vez. La firma Authenticode ancla la confianza en una autoridad externa.
 * Se informa al usuario; con `NotSigned` se lo decimos en vez de callarlo.
 * Devuelve null si no se pudo consultar (no es Windows, sin PowerShell…).
 */
function signatureOf(file, { spawnFn = spawn, env = process.env, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    try {
      if (process.platform !== 'win32') return resolve(null);
      // La ruta va por entorno: no se interpola en la línea de comandos.
      const ps = 'Get-AuthenticodeSignature -LiteralPath $env:SAGITARI_SIG_FILE | '
        + 'ForEach-Object { [pscustomobject]@{ status = "$($_.Status)"; signer = "$($_.SignerCertificate.Subject)" } } '
        + '| ConvertTo-Json -Compress';
      // PowerShell 5.1 hereda el PSModulePath del proceso que la lanza. Si la app
      // se lanzó desde PowerShell 7, delante van los módulos de la 7 y la 5.1
      // intenta cargar Microsoft.PowerShell.Security desde ahí: es incompatible,
      // la carga falla y Get-AuthenticodeSignature deja de existir. El resultado
      // era informar "no se pudo consultar" en vez de la firma real. Se le da el
      // valor de la propia 5.1, que es donde vive su módulo.
      const psHome = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0');
      const childEnv = {
        ...env,
        SAGITARI_SIG_FILE: file,
        PSModulePath: [
          path.join(psHome, 'Modules'),
          path.join(env.ProgramFiles || 'C:\\Program Files', 'WindowsPowerShell', 'Modules'),
        ].join(path.delimiter),
      };
      const p = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        windowsHide: true, env: childEnv,
      });
      let out = '';
      let done = false;
      const finish = (v) => { if (!done) { done = true; try { p.kill(); } catch {} resolve(v); } };
      const timer = setTimeout(() => finish(null), timeoutMs);
      p.stdout.on('data', (d) => { out += d; });
      p.stdout.on('end', () => {
        clearTimeout(timer);
        try {
          const r = JSON.parse(out.trim());
          finish(r && r.status ? { status: String(r.status), signer: String(r.signer || '') || null } : null);
        } catch { finish(null); }
      });
      p.on('error', () => { clearTimeout(timer); finish(null); });
    } catch { resolve(null); }
  });
}

/* ---------- modo de ejecución ---------- */

/** Cómo está corriendo la app: instalada, portable o desde el código. */
function hostKind({ isPackaged, env = process.env } = {}) {
  if (!isPackaged) return 'dev';
  return env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'nsis';
}

module.exports = { REPO, API_LATEST, parseVersion, compareVersions, pickAssets, assetFor, parseLatestYml, sha512Of, checkForUpdate, downloadTarget, downloadTo, hostKind, signatureOf };
