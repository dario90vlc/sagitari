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

/**
 * Hash publicado del binario que vamos a ejecutar, o null si el yml no lo trae.
 * El `sha512` de nivel superior corresponde al fichero que nombra `path` (el Setup:
 * electron-builder no escribe info de actualización para el portable), así que
 * devolverlo para cualquier otro archivo comparaba el binario EQUIVOCADO.
 */
function sha512For(parsed, assetName) {
  if (!parsed || !assetName) return null;
  const entry = (parsed.files || []).find(f => f.url === assetName);
  if (entry && entry.sha512) return entry.sha512;
  return parsed.path === assetName ? (parsed.sha512 || null) : null;
}

/**
 * Por qué no hay firma publicada con la que verificar `assetName` (null si la hay).
 *
 * La app descarta cualquier binario que no pueda verificar, así que este texto es
 * lo único que el usuario llega a leer: decía siempre «la release no publica
 * latest.yml» y eso era falso en el fallo de la 3.2.1 —el yml existía y estaba
 * bien, solo que el que genera electron-builder firma el Setup y no el portable,
 * así que la edición portable descargaba 110 MB y los tiraba sin explicar por qué.
 */
function motivoSinFirma({ tieneYml, assetName, expected, error } = {}) {
  if (expected) return null;
  if (!tieneYml) return 'la release no publica latest.yml';
  if (error) return 'no se pudo leer el latest.yml de la release (' + error + ')';
  return 'esta release no publica la firma de ' + assetName + ' (latest.yml solo firma el instalador)';
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
/* El presupuesto por defecto era 8 s y se quedaba corto en el peor caso real: el
   arranque en frío de PowerShell en una máquina cargada (un runner de CI recién
   despierto, o el equipo del usuario con todo abierto) puede pasar de ahí. El
   resultado no era un error visible, sino «no se pudo consultar» sobre un binario
   perfectamente firmado — es decir, la app alarmando sin motivo. 20 s sigue siendo
   un tope: si en ese tiempo no contesta, no se inventa un estado. */
function signatureOf(file, { spawnFn = spawn, env = process.env, timeoutMs = 20000 } = {}) {
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

/* ---------- lanzar el instalador cuando la app ya no esté ---------- */

/**
 * Guion del ayudante que instala la actualización DESPUÉS de que la app muera.
 *
 * Por qué existe: la app no puede reemplazarse a sí misma mientras corre (los
 * ficheros están en uso) y el instalador de electron-builder, cuando lo lanza
 * el propio proceso, se salta su comprobación de «app en ejecución» (mira el
 * proceso PADRE, que sería SAGITARI.exe) y se queda a medias en silencio. Por
 * eso el instalador lo lanza un tercero que espera a que no quede ninguna
 * instancia viva.
 *
 * Se ejecuta con `-EncodedCommand` (base64 de UTF-16LE): así la ruta del
 * instalador no tiene que sobrevivir a dos niveles de comillas —el intérprete
 * de `cmd.exe` y el de Node—, que es justo lo que rompía el lanzamiento
 * anterior. Una ruta con espacios, `/`, `&` o `%` es simplemente texto.
 *
 * Este guion es el ASISTENTE: el que espera a que la app desaparezca y luego instala.
 * Se ejecuta DESLIGADO del árbol de la app (ver `afterExitCommand`), porque es lo
 * único que le permite sobrevivir a su cierre.
 */
function installHelperScript({ name, installer, args = '/S --updated', logPath, waitMs = 90000, graceMs = 1200, taskName = null } = {}) {
  // (el guion es agnóstico del lanzador: sirve igual bajo cmd que bajo PowerShell
  //  directo, que es justo lo que permite comparar las dos formas en el arnés)
  const q = (s) => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";   // literal de PowerShell
  const lista = String(args || '').split(/\s+/).filter(Boolean).map(q).join(',');
  const espera = Number.isFinite(waitMs) && waitMs > 0 ? Math.round(waitMs) : 90000;
  const gracia = Number.isFinite(graceMs) && graceMs >= 0 ? Math.round(graceMs) : 1200;
  // Ojo: dentro de los literales simples NO se interpola nada de JavaScript.
  return [
    "$ErrorActionPreference = 'Continue'",
    '$log = ' + q(logPath),
    'function Diag([string]$m) { try { Add-Content -LiteralPath $log -Value ((Get-Date -Format o) + " " + $m) -Encoding utf8 } catch {} }',
    "Diag ('asistente iniciado (pid=' + $PID + ', PowerShell ' + $PSVersionTable.PSVersion.ToString() + ')')",
    "if ($env:SAGITARI_NO_WINDOW_DEBUG) { Diag ('ventana del asistente=' + (Get-Process -Id $PID).MainWindowHandle) }",
    "$fin = (Get-Date).AddMilliseconds(" + espera + ')' ,
    '$espera = 0',
    // Latido cada ~10 s: si el ayudante muere, el diario dice CUÁNDO fue lo
    // último que hizo en vez de quedarse en «asistente iniciado» para siempre
    // (ese silencio es justo lo que dejó sin diagnosticar todos los fallos).
    '$latido = 0',
    "while ((Get-Date) -lt $fin) {",
    '  $viva = Get-Process -Name ' + q(name) + ' -ErrorAction SilentlyContinue',
    '  if (-not $viva) { break }',
    '  Start-Sleep -Milliseconds 400',
    '  $espera += 400',
    "  $latido += 400",
    "  if ($latido -ge 10000) { $latido = 0; Diag ('sigo esperando a la app (llevo ' + $espera + ' ms)') }",
    '}',
    "Diag ('la app ya no esta en ejecucion (espera ' + $espera + ' ms)')",
    "$vivo = @(Get-Process -Name " + q(name) + " -ErrorAction SilentlyContinue).Count -gt 0",
    "Diag ('al lanzar el instalador la app seguia en ejecucion: ' + $vivo)",
    'Start-Sleep -Milliseconds ' + gracia,
    'try {',
    // -PassThru -Wait: el diario recoge TAMBIÉN el código de salida del instalador.
    // Sin él, un instalador que falla dejaba el mismo rastro que uno que no llegó a
    // arrancar, y el usuario se quedaba sin saber qué había pasado.
    '  $p = Start-Process -FilePath ' + q(installer) + ' -ArgumentList ' + (lista || "'/S'") + ' -PassThru -ErrorAction Stop',
    "  Diag 'instalador lanzado'",   // ANTES de esperar: el rastro queda aunque el instalador tarde
    '  if ($p) {',
    '    $p.WaitForExit()',
    '    Diag ("instalador termino con codigo " + $p.ExitCode)',
    '  } else { Diag "el instalador no devolvio proceso (lo ejecuto Windows por asociacion)" }',
    '} catch {',
    "  Diag ('FALLO al lanzar el instalador: ' + $_.Exception.Message)",
    '  exit 1',
    '}',
  ].join('\n') + (taskName
    // Limpieza cuando el lanzador es el Programador de tareas: la tarea de un
    // solo uso y este .ps1 no se quedan tirados. Va al final para no borrar
    // nada si el instalador falló antes (el diario sigue ahí para diagnosticar).
    ? '\n' + [
      "try { schtasks /delete /tn " + q(taskName) + ' /f | Out-Null; Diag ' + q('tarea programada eliminada') + ' } catch {}',
      "try { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction Stop } catch { Diag ('no se pudo borrar el guion: ' + $_.Exception.Message) }",
    ].join('\n')
    : '');
}

/**
 * Lo que la app tiene que lanzar, y cómo.
 *
 * El ayudante espera a que SAGITARI desaparezca y lanza el Setup: para que esa espera
 * sirva de algo tiene que SOBREVIVIR a la app, y ahí estaba el fallo. Lo que sigue es
 * una MATRIZ MEDIDA con un Electron real que se cierra —no una teoría—: el mismo
 * guion, lanzado de cuatro formas distintas.
 *
 *   powershell.exe directo, hijo normal  → arranca (0,4 s) y MUERE con la app; el
 *                                          diario se queda en «asistente iniciado»
 *                                          para siempre            ← el fallo real
 *   powershell.exe directo, DESLIGADO    → ni arranca (PowerShell suelto no llega a
 *                                          ejecutar nada: sin consola que lo
 *                                          sostenga, sale sin hacer nada)
 *   cmd.exe → powershell, hijo normal    → arranca y sobrevive
 *   cmd.exe → powershell, DESLIGADO      → arranca y sobrevive      ← lo que se envía
 *
 * De ahí salen las dos decisiones, y ninguna es cosmética:
 *   · el proceso que se lanza es un `cmd.exe`, porque a un PowerShell suelto no hay
 *     forma de sostenerlo: como hijo normal muere con la app, y desligado ni
 *     arranca. El `cmd` es un proceso corriente y es él quien lo mantiene con vida.
 *   · va DESLIGADO (`detached`, que en Windows es DETACHED_PROCESS más un grupo de
 *     procesos propio): la forma estándar de pasar el relevo a otro proceso cuando
 *     el que lanza se va a cerrar.
 *
 * Lo comprueba `scripts/verificar-actualizador.js`, que monta el escenario con un
 * Electron de verdad y ejecuta además un CONTROL con PowerShell directo exigiendo
 * que NO funcione. Si el control empezara a funcionar, el arnés ya no estaría
 * midiendo el cierre real, y lo dice: este fallo sobrevivió a dos versiones justo por
 * no tener ese control.
 */
function afterExitCommand(opts = {}) {
  const script = installHelperScript(opts);
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return {
    file: 'cmd.exe',
    args: ['/c', 'powershell.exe', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    /* Van con la orden porque son parte de ella: sin `detached` esto no funciona, y
       el conocimiento de por qué tiene que vivir junto al código que lo lanza. */
    spawnOpts: { stdio: 'ignore', windowsHide: true, detached: true },
    script,
    encoded,
  };
}

/* ---------- lanzamiento vía Programador de tareas (diseño 3.3.4) ----------
 *
 * Por qué existe: el diseño anterior (un cmd desligado que sostiene al
 * PowerShell) sobrevivió 3/3 en el laboratorio pero muere en máquinas reales
 * al cerrarse la app —medido en el diario de un usuario: cuatro intentos, en
 * dos versiones distintas, todos con el asistente muerto tras su primera
 * línea—. Depender de "sobrevivir al cierre" es frágil por construcción.
 *
 * La tarea programada la ejecuta el SERVICIO del Programador de tareas, no un
 * hijo de la app: que SAGITARI se cierre, la mate el sistema o la tumbe el
 * antivirus no afecta a algo que ya vive en otro árbol. Medido con una sonda
 * (tarea que escribe un fichero, lanzada desde un padre que muere al instante):
 * la marca aparece igual.
 *
 * Sin PowerShell ofuscado además: el ayudante viaja como .ps1 en disco (con
 * BOM, para que la 5.1 lea bien los acentos) y se lanza con -ExecutionPolicy
 * Bypass —solo para nuestro propio guion—, así que una política Restricted de
 * la máquina tampoco lo frena. La tarea es de un solo uso y se autoborra al
 * terminar (ver installHelperScript: taskName).
 */

const TASK_NAME = 'SAGITARI-actualizar';

/** Ruta del guion del ayudante junto al instalador descargado. */
function helperPsPath(dir) {
  return path.join(dir, 'sagitari-instalar.ps1');
}

/** Escribe el guion con BOM (la PowerShell 5.1 lee mal los acentos sin ella). */
function writeHelperPs(psPath, opts = {}) {
  const script = installHelperScript(opts);
  fs.mkdirSync(path.dirname(psPath), { recursive: true });
  fs.writeFileSync(psPath, '﻿' + script, 'utf8');
  return { psPath, script };
}

/** "HH:mm" local dentro de `minutes` minutos (para /st, que lo exige). */
function taskTimePlus(minutes, base) {
  const d = new Date((Number(base) || Date.now()) + Math.max(1, Number(minutes) || 5) * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

/** Lo que ejecuta la tarea: nuestro .ps1, oculto y sin depender de la política. */
function taskRunLine(psPath) {
  return 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + String(psPath) + '"';
}

/** argv de `schtasks /create` (sin shell: cada pieza va en su argumento). */
function scheduleCreateArgs({ taskName = TASK_NAME, psPath, startTime } = {}) {
  return ['/create', '/tn', taskName, '/tr', taskRunLine(psPath), '/sc', 'once', '/st', startTime, '/f'];
}

/**
 * Programa y dispara la instalación. `execFn(cmd, argv)` ejecuta y devuelve
 * { code, stdout, stderr } (por defecto, spawnSync: son llamadas locales y
 * rápidas). Lanza si schtasks falla: el llamante decide el plan B.
 */
async function programarInstalacion({ dir, name, installer, args, logPath, waitMs, graceMs, taskName = TASK_NAME, execFn = null } = {}) {
  const exec = execFn || ((cmd, argv) => {
    const { spawnSync } = require('child_process');
    const r = spawnSync(cmd, argv, { windowsHide: true, encoding: 'utf8' });
    return { code: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
  });
  const psPath = helperPsPath(dir);
  const { script } = writeHelperPs(psPath, { name, installer, args, logPath, waitMs, graceMs, taskName });
  const creada = await exec('schtasks', scheduleCreateArgs({ taskName, psPath, startTime: taskTimePlus(5) }));
  if (creada.code !== 0) {
    throw new Error('no se pudo programar la instalación (' + String((creada.stderr || creada.stdout || '').trim()).slice(0, 160) + ')');
  }
  const disparo = await exec('schtasks', ['/run', '/tn', taskName]);
  if (disparo.code !== 0) {
    try { await exec('schtasks', ['/delete', '/tn', taskName, '/f']); } catch {}
    throw new Error('la tarea se programó pero no arrancó (' + String((disparo.stderr || disparo.stdout || '').trim()).slice(0, 160) + ')');
  }
  return { ok: true, taskName, psPath, script };
}

/**
 * Instalación intentada que sigue sin cuajar: el binario descargado espera a
 * que el usuario lo reintente. Devuelve null si ya no aplica (versión al día,
 * o fichero del que no nos fiamos).
 */
function pendingFor(pending, currentVersion) {
  if (!pending || typeof pending !== 'object') return null;
  if (!pending.path || !pending.version) return null;
  if (compareVersions(pending.version, currentVersion) <= 0) return null;
  return { version: String(pending.version), path: String(pending.path), expected: pending.expected || null, at: pending.at || null };
}

/* ---------- modo de ejecución ---------- */

/** Cómo está corriendo la app: instalada, portable o desde el código. */
function hostKind({ isPackaged, env = process.env } = {}) {
  if (!isPackaged) return 'dev';
  return env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'nsis';
}

module.exports = { REPO, API_LATEST, parseVersion, compareVersions, pickAssets, assetFor, parseLatestYml, sha512For, motivoSinFirma, sha512Of, checkForUpdate, downloadTarget, downloadTo, hostKind, signatureOf, installHelperScript, afterExitCommand, pendingFor, TASK_NAME, helperPsPath, writeHelperPs, taskTimePlus, taskRunLine, scheduleCreateArgs, programarInstalacion };
