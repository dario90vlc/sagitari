'use strict';

/* ipc-update.js — router IPC del dominio actualizaciones.
 *
 * Duodécimo router de la fase 4: comprobación, descarga verificada (SHA-512
 * + puertas de firma/TOFU), instalación con ayudante y reintento pendiente
 * (update:*). Todo el estado (lastUpdate/updateReady/updatePending) vive en
 * este módulo: main.js ya no guarda nada del dominio.
 * Lo que toca de main.js viaja en `ctx`:
 *   - config: el objeto vivo (se lee fresco vía getter)
 *   - saveConfig(): persiste la configuración (TOFU de firmante)
 *   - getWin(): ventana principal (o null) para los eventos update:event
 *   - updater, UPDATE_API, DATA_DIR: singleton y constantes del dominio
 *   - runlog: registro de eventos
 *   - app, shell, fsp, fs, path, spawn: módulos ya importados en main
 */

function registerUpdateIpc(ipcMain, ctx) {
  const cfg = () => (typeof ctx.config === 'function' ? ctx.config() : ctx.config);
  const getWin = () => ctx.getWin();
  const { saveConfig, updater, UPDATE_API, DATA_DIR, runlog, app, shell, fsp, fs, path } = ctx;
  const { spawn } = require('child_process');
/* ---------- actualizaciones (releases de GitHub) ----------
   Sin dependencias: se consulta la API pública, se descarga el binario de esta
   plataforma y se verifica su sha512 contra el `latest.yml` que publica el CI
   antes de ejecutarlo. El aviso al usuario es discreto: un toast y un punto en
   Ajustes; nada se descarga ni se instala sin que él lo pida. */
let lastUpdate = null;        // último resultado de la comprobación
let updateReady = null;       // binario ya descargado y verificado

/* Una instalación que se intentó y no llegó a cuajar. Como para instalar hay que
   cerrar la app, el intento no puede contarlo nada al usuario en el momento: se
   deja anotado en disco y el siguiente arranque, si la versión sigue siendo la
   vieja, se lo dice con el botón para reintentarlo. Sin esto, un fallo deja al
   usuario en un bucle de «se cierra y no pasa nada» sin saber por qué. */
const UPDATE_PENDING_FILE = path.join(DATA_DIR, 'update-pending.json');
let updatePending = null;

function savePending(p) {
  updatePending = p;
  try { fs.writeFileSync(UPDATE_PENDING_FILE, JSON.stringify(p, null, 2)); } catch {}
}
function clearPending() {
  updatePending = null;
  try { fs.rmSync(UPDATE_PENDING_FILE, { force: true }); } catch {}
}
function readPending() {
  try { return JSON.parse(fs.readFileSync(UPDATE_PENDING_FILE, 'utf8')); } catch { return null; }
}
function pendingInfo() {
  return updatePending
    ? { version: updatePending.version, path: updatePending.path, at: updatePending.at || null, exists: fs.existsSync(updatePending.path), signed: updatePending.signed }
    : null;
}

function sendUpdate(ev) {
  try { const _w = getWin(); if (_w && !_w.isDestroyed()) _w.webContents.send('update:event', ev); } catch {}
}

async function checkUpdates({ announce = false } = {}) {
  const r = await updater.checkForUpdate({ currentVersion: app.getVersion(), ...(UPDATE_API ? { api: UPDATE_API } : {}) });
  lastUpdate = r;
  if (r.available) {
    runlog.log({ agent: 'sagitari', event: 'update_available', version: r.latest });
    if (announce) sendUpdate({ type: 'available', version: r.latest, current: r.current, url: r.url });
  } else if (announce) {
    sendUpdate({ type: r.ok ? 'up-to-date' : 'error', version: r.latest, current: r.current, message: r.error || null });
  }
  return r;
}

ipcMain.handle('update:check', async () => {
  const r = await checkUpdates();
  return {
    ok: r.ok,
    error: r.error || null,
    current: r.current || app.getVersion(),
    latest: r.latest || null,
    available: !!r.available,
    url: r.url || `https://github.com/${updater.REPO}/releases`,
    publishedAt: r.publishedAt || null,
    notes: r.notes || null,
    kind: updater.hostKind({ isPackaged: app.isPackaged }),
    ready: updateReady ? { name: updateReady.name, version: updateReady.version, verified: updateReady.verified, signed: updateReady.signed, signer: updateReady.signer } : null,
    pending: pendingInfo(),
  };
});

ipcMain.handle('update:download', async () => {
  const r = (lastUpdate && lastUpdate.available) ? lastUpdate : await checkUpdates();
  if (!r.available) return { ok: false, error: 'no hay ninguna actualización disponible' };
  const kind = updater.hostKind({ isPackaged: app.isPackaged });
  const asset = updater.assetFor(kind, r.assets);
  if (!asset) return { ok: false, error: 'esta release no trae binarios para Windows' };
  const target = updater.downloadTarget({ kind, assetName: asset.name });
  runlog.log({ agent: 'sagitari', event: 'update_download_start', version: r.latest, asset: asset.name });
  try {
    const dl = await updater.downloadTo(asset.url, target.path, { onProgress: (p) => sendUpdate({ type: 'progress', ...p }) });
    // el sha512 publicado manda: si no cuadra, ese archivo no se ejecuta
    let expected = null;
    let errorYml = null;
    if (r.assets && r.assets.yml) {
      try {
        const y = await (await fetch(r.assets.yml.url, { headers: { 'User-Agent': 'SAGITARI-updater' }, signal: AbortSignal.timeout(15000) })).text();
        const parsed = updater.parseLatestYml(y);
        // El hash de nivel superior es el del fichero `path` del yml (el Setup): la
        // edición portable no podía actualizarse nunca porque se comparaba contra
        // el hash del Setup (updater.sha512For documenta la regla).
        expected = updater.sha512For(parsed, asset.name);
      } catch (e) { errorYml = e.message; }
    }
    // Por qué no hay firma con la que comparar. Antes se contaba siempre como «la
    // release no publica latest.yml», que era falso y despistaba cuando el yml
    // existía pero no listaba este binario (le pasó al portable en la 3.2.1).
    const motivo = updater.motivoSinFirma({
      tieneYml: !!(r.assets && r.assets.yml), assetName: asset.name, expected, error: errorYml,
    });
    // Sin hash publicado no hay verificación posible: se descarta igual que si
    // no cuadrara. Antes `expected === null` dejaba `verified` en null y el
    // binario se marcaba como listo para ejecutarse SIN comprobar nada.
    const verified = expected ? expected === dl.sha512 : false;
    if (verified !== true) {
      await fsp.rm(target.path, { force: true }).catch(() => {});
      runlog.log({ agent: 'sagitari', event: 'update_verify_failed', version: r.latest, asset: asset.name, reason: expected ? 'hash' : motivo });
      sendUpdate({ type: 'error', message: expected
        ? 'La descarga no coincide con la firma publicada; se ha descartado.'
        : 'La release no publica la firma sha512 de este archivo; se ha descartado por seguridad.' });
      return { ok: false, error: expected
        ? 'la verificación sha512 falló: el archivo se ha descartado'
        : motivo + ': descartado por seguridad. Puedes instalarlo a mano desde ' + (r.url || 'https://github.com/' + updater.REPO + '/releases') };
    }
    updateReady = { path: target.path, name: asset.name, verified, expected, version: r.latest, kind };
    // firma Authenticode: se consulta para poder decírselo al usuario. El hash
    // demuestra integridad, no autenticidad: si el repo se compromete, el binario
    // y su hash cambian a la vez. Con un binario sin firmar, el usuario debe saberlo.
    try {
      const sig = await updater.signatureOf(target.path);
      if (sig) {
        updateReady.signed = sig.status === 'Valid';
        updateReady.signer = sig.signer;
        runlog.log({ agent: 'sagitari', event: 'update_signature', version: r.latest, status: sig.status, signer: sig.signer });
      }
    } catch {}
    /* TOFU de firmante (sin certificado propio no hay ancla externa, así que la
       confianza se ancla en la PRIMERA firma válida que se vea): si alguna vez un
       binario llega firmado y válido, su firmante queda guardado y a partir de ahí
       un binario con OTRO firmante (o sin firma) no se instala sin avisar de que
       el firmante cambió. Un repo comprometido que sirva binarios sin firmar ya
       no cuela en silencio después de una release firmada. */
    try {
      if (updateReady.signed === true && updateReady.signer) {
        const conocido = cfg().trustedSigner || null;
        if (!conocido) {
          cfg().trustedSigner = String(updateReady.signer);
          saveConfig();
          runlog.log({ agent: 'sagitari', event: 'update_signer_pinned', signer: updateReady.signer });
        } else if (conocido !== String(updateReady.signer)) {
          updateReady.signerChanged = true;
          updateReady.signerExpected = conocido;
          runlog.log({ agent: 'sagitari', event: 'update_signer_changed', expected: conocido, got: updateReady.signer });
        }
      } else if (cfg().trustedSigner && updateReady.signed !== true) {
        // Hubo una firma válida en el pasado y esta release no la trae: se marca
        // igual que un cambio de firmante (un atacante que quita la firma para
        // colar un binario sin firmar no puede hacerlo en silencio).
        updateReady.signerChanged = true;
        updateReady.signerExpected = cfg().trustedSigner;
        runlog.log({ agent: 'sagitari', event: 'update_signer_missing', expected: cfg().trustedSigner });
      }
    } catch {}
    runlog.log({ agent: 'sagitari', event: 'update_downloaded', version: r.latest, verified });
    sendUpdate({ type: 'downloaded', version: r.latest, name: asset.name, verified, signed: updateReady.signed, signer: updateReady.signer, signerChanged: updateReady.signerChanged === true });
    return { ok: true, path: target.path, name: asset.name, version: r.latest, verified, signed: updateReady.signed, kind };
  } catch (e) {
    sendUpdate({ type: 'error', message: e.message });
    return { ok: false, error: e.message };
  }
});

/**
 * Lanza el instalador FUERA de la app y la cierra.
 *
 * Antes esto era un `cmd.exe /c "timeout … & start \"\" …"`: esa forma no
 * lanzaba nada (el intérprete de `cmd.exe` y el escapado de Node se comían las
 * comillas; comprobado con un señuelo, que nunca llegaba a ejecutarse), y el
 * usuario veía una ventana de consola aparecer y cerrarse sin más. Ahora el
 * instalador lo arranca un ayudante de PowerShell OCULTO que espera a que no
 * quede ninguna instancia de SAGITARI (por eso también desaparece la ventana de
 * terminal) y luego ejecuta el Setup en silencio. Que la app esté cerrada importa:
 * el instalador de electron-builder mira el proceso PADRE para decidir si hay
 * una app en ejecución, así que lanzado desde la propia app se saltaba esa
 * comprobación y se quedaba a medias con los ficheros en uso.
 */
async function lanzarInstalador(d) {
  const logPath = path.join(path.dirname(d.path), 'instalar.log');
  const comun = {
    name: path.basename(process.execPath, '.exe'),
    installer: d.path,
    // silencio total + «es una actualización, no una instalación nueva» + que la app
    // vuelva a abrirse al terminar (sin esto el usuario ve «se cierra y no pasa nada»
    // justo cuando SÍ ha pasado algo)
    args: '/S --updated --force-run',
    logPath,
  };
  // El diario del intento anterior confundiría la comprobación de abajo.
  try { await fsp.rm(logPath, { force: true }); } catch {}
  // Vía principal (3.3.4): el Programador de tareas ejecuta al ayudante en el
  // servicio del sistema, no como hijo de la app —sobrevive a su cierre por
  // construcción, que es justo lo que el cmd desligado no garantizaba—.
  let via = 'tarea programada';
  try {
    await updater.programarInstalacion({ dir: path.dirname(d.path), ...comun });
  } catch (e) {
    // Plan B: el cmd desligado de siempre. En las máquinas donde el árbol
    // sobrevive funciona (3/3 medido); donde no, el diario con latido dirá
    // hasta dónde llegó. Mejor intentarlo que dejar al usuario sin nada.
    via = 'clásica';
    runlog.log({ agent: 'sagitari', event: 'update_install_fallback', version: d.version, reason: e.message });
    const plan = updater.afterExitCommand(comun);
    let hijo;
    try {
      hijo = spawn(plan.file, plan.args, plan.spawnOpts);
      // desligado y sin referencia: el ayudante tiene que seguir ahí cuando la app ya
      // no esté (es justo lo que fallaba), y a Node no le toca esperarlo
      try { hijo.unref(); } catch {}
    } catch (e2) {
      return { ok: false, error: 'no se pudo preparar el instalador: ' + e2.message };
    }
    hijo.on('error', () => {});
  }
  /* LA comprobación que importa, y ANTES de cerrar la app: se espera a que el
     ASISTENTE escriba su primera línea en el diario.

     No se comprueba «¿sigue vivo el proceso que lancé?», y esa es justo la lección
     de este fallo: el ayudante estaba vivo, escribía su primera línea… y moría con la
     app, dejando el diario cortado para siempre y al usuario con la ventana cerrada y
     nada instalado. «Vivo» no prueba nada; lo que prueba algo es su rastro, y además
     que ese rastro llegue con la app todavía en marcha y el proceso ya desligado.

     El presupuesto es amplio a propósito: PowerShell en frío tarda en arrancar. */
  const arrancado = await new Promise((resolve) => {
    const t0 = Date.now();
    const mirar = async () => {
      try {
        const t = await fsp.readFile(logPath, 'utf8');
        if (t.includes('asistente iniciado')) return resolve(true);
      } catch {}
      if (Date.now() - t0 >= 30000) return resolve(false);
      setTimeout(mirar, 200);
    };
    setTimeout(mirar, 150);
  });
  if (!arrancado) {
    const reason = 'el asistente no llegó a arrancar (vía ' + via + ': sin PowerShell, tarea bloqueada o política del equipo)';
    runlog.log({ agent: 'sagitari', event: 'update_install_failed', version: d.version, reason });
    savePending({ version: d.version, path: d.path, expected: d.expected || null, signed: d.signed === true, at: new Date().toISOString() });
    const pendiente2 = pendingInfo();
    return { ok: false, error: 'no se pudo arrancar el asistente de instalación: ' + reason + '. Puedes instalar a mano: ' + d.path, pending: pendiente2 };
  }
  savePending({ version: d.version, path: d.path, expected: d.expected || null, signed: d.signed === true, at: new Date().toISOString() });
  const pendiente = pendingInfo();
  runlog.log({ agent: 'sagitari', event: 'update_install', version: d.version, log: logPath, via });
  // cierre ordenado (cierra Chrome, procesos de voz, tareas). El ayudante espera
  // a que la app desaparezca de verdad, así que no hace falta adivinar un margen.
  setTimeout(() => { try { app.quit(); } catch {} }, 500);
  return { ok: true, manual: false, pending: pendiente };
}

ipcMain.handle('update:install', async (e, opts) => {
  const d = updateReady;
  if (!d) return { ok: false, error: 'todavía no hay ninguna actualización descargada' };
  if (!fs.existsSync(d.path)) return { ok: false, error: 'el archivo descargado ya no está en su sitio' };
  if (d.kind === 'portable') {
    // un portable no puede reemplazarse a sí mismo mientras se ejecuta:
    // se deja al lado y se le enseña al usuario dónde está
    try { shell.showItemInFolder(d.path); } catch {}
    return { ok: true, manual: true, name: d.name, path: d.path };
  }
  if (d.kind === 'dev') return { ok: false, error: 'estás ejecutando desde el código fuente: instala con el instalador' };
  // Un binario sin verificar no se ejecuta nunca. Y el fichero vive en %TEMP%,
  // que cualquier proceso del usuario puede escribir: se vuelve a comprobar el
  // hash justo antes de lanzarlo para cerrar esa ventana (TOCTOU).
  if (d.verified !== true || !d.expected) return { ok: false, error: 'esta actualización no está verificada; descártala y vuelve a intentarlo' };
  // Puerta de binario sin firmar: el SHA-512 demuestra integridad pero no
  // autenticidad (un repo comprometido sirve binario y hash a la vez), y los
  // binarios actuales no llevan firma Authenticode. No se puede bloquear sin
  // romper las actualizaciones propias, así que se exige consentimiento ACTIVO:
  // la primera llamada vuelve con needsUnsignedConfirm y la instalación solo
  // arranca cuando la UI reintenta con confirmUnsigned. Un aviso pasivo en la
  // tarjeta no basta para ejecutar código arbitrario.
  if (d.signed !== true && !(opts && opts.confirmUnsigned === true)) {
    runlog.log({ agent: 'sagitari', event: 'update_unsigned_gate', version: d.version, signed: d.signed === true });
    return {
      ok: false, needsUnsignedConfirm: true,
      error: d.signed === false
        ? 'esta actualización NO está firmada digitalmente (solo verificada por SHA-512). Pulsa Instalar otra vez si aceptas instalarla igualmente.'
        : 'no se pudo comprobar la firma digital de esta actualización (solo verificada por SHA-512). Pulsa Instalar otra vez si aceptas instalarla igualmente.',
    };
  }
  /* Puerta de cambio de firmante (TOFU): si una release anterior vino firmada y
     esta trae otro firmante (o ninguno), no basta el consentimiento genérico de
     «sin firmar»: el mensaje dice QUÉ cambió para que el usuario decida informado.
     La UI reintenta con confirmSignerChange cuando el usuario acepta el cambio. */
  if (d.signerChanged === true && !(opts && (opts.confirmSignerChange === true || opts.confirmUnsigned === true))) {
    runlog.log({ agent: 'sagitari', event: 'update_signer_gate', version: d.version });
    return {
      ok: false, needsSignerConfirm: true,
      error: 'el firmante de esta actualización NO coincide con el de releases anteriores (esperado: ' + (d.signerExpected || 'desconocido') + '; recibido: ' + (d.signer || 'sin firma') + '). Si confías en el cambio, pulsa Instalar otra vez.',
    };
  }
  try {
    if (updater.sha512Of(d.path) !== d.expected) {
      await fsp.rm(d.path, { force: true }).catch(() => {});
      updateReady = null;
      runlog.log({ agent: 'sagitari', event: 'update_verify_failed', version: d.version, reason: 'hash cambiado antes de instalar' });
      sendUpdate({ type: 'error', message: 'El archivo descargado cambió después de verificarlo; se ha borrado.' });
      return { ok: false, error: 'el instalador ya no coincide con la firma: descartado' };
    }
  } catch (e) { return { ok: false, error: 'no se pudo verificar el instalador: ' + e.message }; }
  return lanzarInstalador(d);
});

// Reintento de una instalación que se quedó a medias (el caso «se cierra y no
// pasa nada»): se vuelve a comprobar el hash del fichero que quedó pendiente y
// solo entonces se lanza otra vez.
ipcMain.handle('update:retry', async (e, opts) => {
  const p = updatePending;
  if (!p) return { ok: false, error: 'no hay ninguna instalación pendiente', pending: null };
  if (!fs.existsSync(p.path)) {
    clearPending();
    return { ok: false, error: 'el instalador descargado ya no está en su sitio: vuelve a descargar la actualización', pending: null };
  }
  if (p.expected && updater.sha512Of(p.path) !== p.expected) {
    await fsp.rm(p.path, { force: true }).catch(() => {});
    clearPending();
    runlog.log({ agent: 'sagitari', event: 'update_verify_failed', version: p.version, reason: 'hash cambiado antes de reintentar' });
    return { ok: false, error: 'el instalador ya no coincide con la firma publicada: vuelve a descargar la actualización', pending: null };
  }
  // Misma puerta que update:install: lo pendiente de versiones anteriores no
  // trae estado de firma (signed undefined), y eso también exige confirmación.
  if (p.signed !== true && !(opts && opts.confirmUnsigned === true)) {
    runlog.log({ agent: 'sagitari', event: 'update_unsigned_gate', version: p.version, signed: false, retry: true });
    return {
      ok: false, needsUnsignedConfirm: true, pending: pendingInfo(),
      error: 'esta actualización NO está firmada digitalmente (solo verificada por SHA-512). Pulsa Reintentar otra vez si aceptas instalarla igualmente.',
    };
  }
  // el intento pudo volver a quedar a medias; la tarjeta se queda con lo que hay ahora
  const r = await lanzarInstalador({ path: p.path, version: p.version, expected: p.expected, signed: p.signed === true, kind: 'nsis', verified: true });
  return { ...r, pending: r.ok ? r.pending : pendingInfo() };
});

ipcMain.handle('update:page', async () => {
  const url = (lastUpdate && lastUpdate.url) || `https://github.com/${updater.REPO}/releases`;
  try { await shell.openExternal(url); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
  return {
    getLastUpdate: () => lastUpdate,
    getPending: () => updatePending,
    setPending: (p) => { updatePending = p; },
    readPending, clearPendingFile: () => { try { fs.rmSync(UPDATE_PENDING_FILE, { force: true }); } catch {} },
    checkUpdates, sendUpdate, pendingInfo,
  };
}

module.exports = { registerUpdateIpc };
