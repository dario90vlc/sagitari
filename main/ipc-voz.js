'use strict';

/* ipc-voz.js — router IPC del dominio voz/TTS/dictado.
 *
 * Quinto router de la fase 4: dictado clásico (voice.ps1), síntesis SAPI,
 * modo voz (WinRT/SAPI/whisper.cpp/Piper), instalaciones con progreso y
 * telemetría del tap PCM. Todo lo que toca de main.js viaja en `ctx`:
 *   - config: el objeto vivo (se lee fresco vía getter, los ajustes se reemplazan)
 *   - isHeadless(): true en arranques automatizados (la app NUNCA habla ahí)
 *   - getWin(): ventana de chat (o null si está destruida)
 *   - DATA_DIR: directorio de datos (raíz de voice-engine)
 * Devuelve { cerrar }: lo usa el before-quit de main para desarmar el reintento
 * del dictado y soltar motores/procesos.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { app, session } = require('electron');
const runlog = require('../agent/runlog');

/* Descomprime un zip con Expand-Archive SIN shell: las rutas viajan por entorno
 ($env:SAGITARI_ZIP / $env:SAGITARI_DEST), nunca interpoladas en la línea de
 comandos. Antes iban entre comillas simples dentro de un execSync con texto
 concatenado: una ruta con `'` o `;` podía romper la cita e inyectar comandos.
 Devuelve null si fue bien, o el mensaje de error. */
function expandirZip(zip, destino, { timeoutMs = 120000 } = {}) {
try {
  const { spawnSync } = require('child_process');
  const ps = "Expand-Archive -LiteralPath $env:SAGITARI_ZIP -DestinationPath $env:SAGITARI_DEST -Force";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    windowsHide: true, timeout: timeoutMs, encoding: 'utf8',
    env: { ...process.env, SAGITARI_ZIP: zip, SAGITARI_DEST: destino },
  });
  if (r.error) return String(r.error.message || r.error);
  if (r.status !== 0) return 'Expand-Archive falló (código ' + r.status + '): ' + String(r.stderr || '').trim().slice(0, 300);
  return null;
} catch (e) { return String((e && e.message) || e); }
}
function registerVozIpc(ipcMain, ctx) {
  // config es un getter (() => config de main): el objeto es único y vivo,
  // se lee fresco en cada handler para no capturar una foto vieja.
  const cfg = () => (typeof ctx.config === 'function' ? ctx.config() : ctx.config);
  const getWin = () => ctx.getWin();
  const DATA_DIR = ctx.DATA_DIR;

// ---- voice (Windows dictation: WinRT engine + SAPI fallback, UTF-8 protocol) ----
/* El protocolo de línea (`PREFIJO::cuerpo`) se interpreta en `voice/protocolo.js`, que
   es donde está probado: aquí se traducía con un `slice()` a mano por prefijo y la mitad
   de los números estaban mal (ver la cabecera de ese módulo). */
const { partirLinea } = require('./voice/protocolo');
/* `powershell.exe -File` no puede leer dentro de `app.asar`: en la app instalada el
   dictado clásico apuntaba a `…/app.asar/main/voice.ps1` y PowerShell lo rechazaba.
   El resolver devuelve la ruta desempaquetada (o una copia real) — ver voice/ruta-script.js. */
const { rutaScriptReal } = require('./voice/ruta-script');

ipcMain.handle('voice:start', async () => {
  if (whisper) return { ok: true, note: 'Ya estaba escuchando' };
  dictando = true;                       // hay intención de dictar: la muerte del motor tiene reintento
  whisperBuf = '';
  arrancarDictado();
  return { ok: true };
});

/* ¿Quiere el usuario que el dictado siga vivo? Lo pone `voice:start` y lo quita
   `voice:stop` (ambos son acciones suyas): el reintento automático no puede revivir un
   dictado que ya se cerró, ni arrancar uno durante el cierre de la app. */
let dictando = false;
let estadoCierre = { saliendo: false };

/* Arranca el proceso de dictado y cablea sus listeners. Va en su propia función para que
   el reintento automático (el 'exit' no pedido) pueda relanzar el MISMO arranque sin
   duplicar el cableado. */
function arrancarDictado() {
  const lang = cfg().settings.voiceLang || 'es-ES';
  // El handle del proceso vive en `p`: cada listener comprueba identidad antes de
  // tocar `whisper`, para que el 'exit' tardío de un proceso viejo no anule la
  // referencia al nuevo.
  /* Sin `-NoWinrt`: el motor moderno de Windows (WinRT) es el que reconoce de verdad
     el dictado libre, y es el único que oye bien en español. La versión anterior lo
     capaba aquí y dejaba al usuario con el clásico (SAPI 8.0), mucho peor: `voice.ps1`
     ya sabe caer solo al clásico —y decir por qué— cuando WinRT no está disponible,
     así que caparlo aquí era perder precisión sin ganar fiabilidad ninguna. */
  /* El PARSEO del protocolo vive en `voice/protocolo.js` (mismo módulo que el modo voz):
     aquí había una segunda copia a mano con los mismos `slice()` mal contados que ya se
     corrigieron allí. Dos fuentes de verdad para el mismo protocolo es un bug futuro. */
  const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', rutaScriptReal(path.join(__dirname, 'voice.ps1')), '-Lang', lang], { windowsHide: true });
  whisper = p;
  p.stdout.on('data', (d) => {
    if (whisper !== p) return;   // proceso ya reemplazado: su salida no interesa
    whisperBuf += d.toString('utf8');
    let idx;
    while ((idx = whisperBuf.indexOf('\n')) >= 0) {
      const line = whisperBuf.slice(0, idx).replace(/\r$/, '').trim(); whisperBuf = whisperBuf.slice(idx + 1);
      if (!line) continue;
      const parte = partirLinea(line);
      if (parte) {
        const { prefijo, cuerpo } = parte;
        const vivo = getWin() && !getWin().isDestroyed();
        switch (prefijo) {
          case 'PART::': if (vivo) getWin().webContents.send('voice:partial', cuerpo); break;
          case 'FINAL::': if (vivo) getWin().webContents.send('voice:final', cuerpo); break;
          case 'MODE::': if (vivo) getWin().webContents.send('voice:mode', cuerpo); break;
          /* `NOTE::` es la explicación del motor (por qué cae al clásico): viaja como
             aviso, igual que en el motor del modo voz, en vez de perderse. */
          case 'HINT::': case 'NOTE::': if (vivo) getWin().webContents.send('voice:hint', cuerpo); break;
          case 'READY::': if (vivo) getWin().webContents.send('voice:ready', cuerpo); break;
          default: if (vivo) getWin().webContents.send('voice:error', cuerpo); break;
        }
        /* Un ERROR:: de este motor NO se toma como «el proceso ha muerto»: los avisos
           que importan (política de voz en línea, por ejemplo) los dice y sigue vivo,
           bajando al motor clásico. Matarlo aquí dejaba al usuario sin dictado justo
           después de haberle prometido que seguiría escuchando. Si de verdad se cae,
           sale por su propio `exit` y lo cuenta el listener de abajo. */
        if (prefijo === 'ERROR::') {
          console.error('[SAGITARI] voz: ' + cuerpo);
          try { runlog.log({ agent: 'voice', event: 'error', message: cuerpo.slice(0, 300) }); } catch {}
        }
        continue;
      }
      if (line.startsWith('STOPPED::')) {
        try { p.kill(); } catch {}
        if (whisper === p) whisper = null;
      }
    }
  });
  // El stderr deja de descartarse: un fallo de PowerShell (binding, ejecución,
  // permisos) se perdía en silencio y el dictado parecía «no hacer nada».
  let errBuf = '';
  p.stderr.on('data', (d) => {
    const chunk = d.toString('utf8');
    errBuf = (errBuf + chunk).slice(-2000);
    const msg = chunk.trim();
    if (!msg) return;
    console.error('[SAGITARI] voice.ps1: ' + msg.slice(0, 500));
    try { runlog.log({ agent: 'voice', event: 'stderr', message: msg.slice(0, 300) }); } catch {}
  });
  p.on('exit', () => {
    const current = whisper === p;
    if (current) whisper = null;
    // solo el proceso vigente puede reportar el error de su arranque
    if (current && errBuf.trim() && getWin() && !getWin().isDestroyed()) getWin().webContents.send('voice:error', errBuf.trim().slice(0, 500));
    if (getWin() && !getWin().isDestroyed()) getWin().webContents.send('voice:stopped');
    /* Red de seguridad del DICTADO: si el motor muere sin que nadie lo pidiera (crash de
       PowerShell, cierre del micro por el sistema), el dictado no se queda muerto para
       siempre: UN intento tras 2 s, solo si el usuario sigue queriendo dictar y no hay
       otro motor en pie. Si el entorno rompe el motor de nuevo, martillarlo con más
       intentos solo llenaría el log: el usuario ya ve el aviso y puede reabrir el micro. */
    if (current && dictando && !estadoCierre.saliendo) {
      setTimeout(() => { if (dictando && !whisper && !estadoCierre.saliendo) arrancarDictado(); }, 2000);
    }
  });
}

ipcMain.handle('voice:stop', async () => {
  dictando = false;   // un cierre pedido desarma el reintento automático
  const p = whisper;
  if (p) { whisper = null; try { p.kill(); } catch {} }
  return { ok: true };
});

// ---- TTS (SAPI, Spanish voice if available) ----
const { createTtsWindows } = require('./voice/tts-windows');
/* Una sola tubería de voz: el VoiceManager trocea y sintetiza por frases; el renderer las
   reproduce (tiene el analizador de audio para el orbe y puede cortar al instante). El
   manager se crea aquí si hace falta: hablar no necesita el modo voz abierto.
   Se conserva el nombre `tts:speak` y su contrato de silencio en arranques automatizados:
   hay una comprobación de ui-check que depende de eso. */
ipcMain.handle('tts:speak', async (e, text, opts) => {
  /* Un arranque automatizado (--smoke/--hidden/--test) NUNCA habla. Los bancos de
     prueba conducen conversaciones simuladas —el modelo de ui-check contesta «listo»—
     con la ventana OCULTA, así que la voz salía por los altavoces del usuario sin nada
     en pantalla que la explicase: parecía que la app saludaba sola al arrancar. Es la
     misma regla que ya rige el glow al arrancar (!HIDDEN), pero aquí pesa más porque el
     sonido sale del equipo. */
  if (ctx.isHeadless()) return { ok: false };
  if (!text) return { ok: false };
  /* El ajuste de Ajustes no manda cuando el modo voz lo pide con `forzar`: es un modo de
     oído y negarse a hablar ahí sería absurdo. El permiso viaja por el canal porque quien
     conoce los ajustes es el renderer; el silencio de los arranques de prueba va ANTES y
     no se toca. */
  if (!cfg().settings.ttsEnabled && !(opts && opts.forzar)) return { ok: false };
  try {
    const voz = managerDeVoz();
    /* Una lectura nueva CORTA la anterior (lo mismo que hacía el proceso viejo al morir):
       sin esto, tras dos turnos seguidos el usuario oiría entera la respuesta anterior
       antes de la nueva y la cola crecería turno a turno.
       `encolar` es el otro caso, y es el que hace que la voz suene como la de un asistente
       de verdad: la respuesta se lee POR FRASES según el modelo la va escribiendo, y cada
       frase nueva se AÑADE a la cola en vez de cortar la que está sonando (si la cortara,
       sólo se oiría el final de cada frase). */
    if (!(opts && opts.encolar)) voz.stopSpeaking();
    voz.say(String(text));
    return { ok: true };
  } catch { return { ok: false }; }
});

/* Motor de síntesis del sistema. La síntesis por frases la orquesta el VoiceManager
   (tarea 5) y el audio lo reproduce el renderer (tarea 9); aquí solo se expone. */
let ttsEngine = null;
function sintetizador() {
  if (!ttsEngine) ttsEngine = createTtsWindows({ dataDir: DATA_DIR });
  return ttsEngine;
}

ipcMain.handle('tts:list', async () => {
  try { return { ok: true, voices: await sintetizador().listarVoces() }; } catch { return { ok: false, voices: [] }; }
});

// ---- modo voz (fase 1: motores de Windows) ----
const { createVoiceManager } = require('./voice/manager');
const { createSttWindows } = require('./voice/stt-windows');
/* Motor de dictado LOCAL de alta precisión (whisper.cpp): se construye perezoso y avisa
   él solo si falta instalarlo — no tumba los motores de Windows, que siguen de relevo. */
const { createWhisper } = require('./voice/whisper');
/* Voz local ligera de alta calidad (Piper): binario + voz es-ES bajo DATA_DIR, mismo
   contrato que el motor de Windows y con este de relevo por frase. */
const { createTtsLocal, usarVozLocal } = require('./voice/tts-local');

let voiceManager = null;
/* Motor de dictado LOCAL (Whisper) y quién está de guardia. Viven AQUÍ, al nivel de los
   handlers de IPC: varios (voice:open, voice:pcm, voice:installStatus) tienen que
   leerlos — declararlos dentro de managerDeVoz() los dejaba inaccesibles y cada apertura
   del modo voz moría con «motorActual is not defined». */
let motorWhisper = null;
let motorActual = 'windows';
let motorWindows = null;   // el motor de Windows de guardia (winrt o clásico)

/* El permiso de micrófono se concede SOLO a nuestra propia página. Hoy el renderer es
   un fichero local nuestro, pero la comprobación deja escrito el límite: si mañana
   carga contenido de fuera, ese contenido no hereda el micrófono del usuario. */
function esNuestraPagina(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'file:' && decodeURIComponent(u.pathname).toLowerCase().endsWith('renderer/index.html');
  } catch { return false; }
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    /* OJO: lo que NO sea 'media' se deja como estaba. Escribir aquí
       `cb(permission === 'media' && …)` deniega permisos que Electron aprueba por defecto
       (notificaciones, pantalla completa…): es un fallo que la revisión cazó en el plan. */
    if (permission !== 'media') { cb(true); return; }
    const url = (details && details.requestingUrl) || wc.getURL();
    const soloAudio = !details || !details.mediaTypes || details.mediaTypes.every((t) => t === 'audio');
    cb(soloAudio && esNuestraPagina(url));
  });
  /* El de comprobación responde a las consultas internas de Chromium: solo se limita
     'media' (lo demás sigue como estaba) para no romper nada más. */
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) => {
    if (permission !== 'media') return true;
    const url = (details && details.requestingUrl) || origin || '';
    return esNuestraPagina(url) && (!details || !details.mediaType || details.mediaType === 'audio');
  });
});

function emitVoz(ev) { try { if (getWin() && !getWin().isDestroyed()) getWin().webContents.send('voice:event', ev); } catch {} }

/* El único sitio donde nace el manager. Hablar NO necesita micrófono: la lectura del chat
   también pasa por aquí (una sola tubería de frases), así que se crea de forma perezosa
   desde `tts:speak` y no solo al abrir el modo voz. El constructor no arranca ningún motor
   —el micrófono lo pide `open()` y la síntesis, la primera frase—, así que tenerlo vivo sin
   modo voz no cuesta nada. */
function managerDeVoz() {
  if (voiceManager) return voiceManager;
  /* La voz LOCAL (Piper) manda si está instalada: es la ligera de alta calidad y no
     depende del almacén de Windows. Si falta (o falla una frase), el motor de Windows
     sigue de relevo: el wrapper lo decide por frase, no por sesión. */
  const winTts = createTtsWindows({ dataDir: DATA_DIR });
  const localTts = createTtsLocal({ dataDir: DATA_DIR });
  ttsEngine = {
    nombre: 'auto',
    capacidades: winTts.capacidades,
    sintetizar: async (texto, opts) => {
      const est = (() => { try { return localTts.estado(); } catch { return { disponible: false }; } })();
      /* La decisión vive en tts-local.js (con sus tres casos escritos y sus pruebas):
         aquí sólo se le dan los datos, incluido si la voz guardada la eligió el usuario. */
      const quiereLocal = usarVozLocal({
        disponible: !!est.disponible,
        voice: (opts && opts.voice) || '',
        fijo: !!cfg().settings.ttsVoiceFijo,
      });
      if (quiereLocal) {
        const r = await localTts.sintetizar(texto, opts);
        if (r && r.wav) return r;
      }
      return winTts.sintetizar(texto, opts);
    },
    listarVoces: async () => {
      const a = await localTts.listarVoces().catch(() => []);
      const b = await winTts.listarVoces().catch(() => []);
      return [...a, ...b];
    },
    dispose: () => { try { localTts.dispose(); } catch {} try { winTts.dispose(); } catch {} },
  };
  /* El motor de escuchar nace la primera vez que se ABRE el modo, no al crear el manager:
     el manager también nace solo para leer el chat (sin micrófono) y, si se construyera
     aquí, se quedaría con el idioma que hubiera en los ajustes en ese momento. `stop()` sin
     motor no hace nada (no hay proceso que parar). */
  const motorEscucha = () => {
    /* El Ajuste «motor de escucha clásico» (sttClasico) arranca DIRECTAMENTE en clásico:
       para las máquinas donde el moderno nunca recibe audio, hacer que el usuario espere
       al vigilante (voz sin texto → rescate) era un minuto de panel sordo cada vez que
       abría el modo. Con el ajuste, desde la primera frase. */
    if (!motorWindows) motorWindows = createSttWindows({ emit: (ev) => voiceManager.ingest(ev), lang: cfg().settings.voiceLang || 'es-ES', forzarClasico: !!cfg().settings.sttClasico });
    return motorWindows;
  };
  const motorLocal = () => {
    /* La raíz del motor local es SIEMPRE la del instalador (voice-engine junto a los
       datos del usuario): dos raíces distintas harían una instalación que el motor
       nunca encontraría. */
    if (!motorWhisper) motorWhisper = createWhisper({ emit: (ev) => voiceManager.ingest(ev), lang: cfg().settings.voiceLang || 'es-ES', dirRaiz: path.join(DATA_DIR, 'voice-engine') });
    return motorWhisper;
  };
  /* La ELECCIÓN de motor: whisper si está instalado (o si el usuario lo fijó con
     motor='whisper'); windows si no. El wrapper desvía start/push/stop al motor
     elegido; motorAlternativo/usarClasico son señales de los motores de Windows
     (sordera de WinRT/SAPI) y no aplican si el activo es whisper. */
  const sttWrapper = {
    start: async () => {
      const w = motorLocal();
      if (w.estado().disponible || cfg().settings.motor === 'whisper') { motorActual = 'whisper'; return w.start(); }
      motorActual = 'windows';
      return motorEscucha().start();
    },
    push: (pcm) => { if (motorActual === 'whisper' && motorWhisper) motorWhisper.push(pcm); },
    stop: async () => {
      if (motorWhisper) await motorWhisper.stop();
      return motorWindows ? motorWindows.stop() : Promise.resolve();
    },
    motorAlternativo: () => (motorActual === 'windows' ? motorEscucha().motorAlternativo() : Promise.resolve()),
    usarClasico: () => (motorActual === 'windows' ? motorEscucha().usarClasico() : Promise.resolve()),
  };
  voiceManager = createVoiceManager({
    emit: emitVoz,
    stt: sttWrapper,
    tts: ttsEngine,
    onPhrase: (p) => { try { if (getWin() && !getWin().isDestroyed()) getWin().webContents.send('tts:phrase', p); } catch {} },
    /* Los ajustes van EN VIVO: se guardan reemplazando el objeto, así que el manager tiene
       que leerlos cada vez (voz, velocidad e idioma) y no quedarse con una copia. */
    settings: () => cfg().settings,
  });
  return voiceManager;
}

ipcMain.handle('voice:open', async () => {
  try {
    await managerDeVoz().open();
    const escuchar = (motorActual === 'whisper') ? 'whisper' : ((cfg().settings.sttClasico || sttInfo().motor === 'sapi') ? 'windows-clasico' : 'windows-moderno');
    /* Qué voz va a sonar: se pregunta al motor local de verdad (si está instalado, la
       lectura NO pasa por Windows, así que decir «windows» aquí era mentira). */
    let hablar = 'windows';
    try {
      const local = createTtsLocal({ dataDir: DATA_DIR }).estado();
      if (usarVozLocal({ disponible: !!local.disponible, voice: cfg().settings.ttsVoice || '', fijo: !!cfg().settings.ttsVoiceFijo })) hablar = 'piper';
    } catch {}
    return { ok: true, motores: { escuchar, hablar } };
  } catch (e) { return { ok: false, error: e.message }; }
});

/* Motor que está de guardia (para el panel: whisper / windows-moderno / windows-clasico). */
function sttInfo() {
  if (motorActual === 'whisper') return { motor: 'whisper', idioma: '' };
  return motorWindows ? motorWindows.info() : {};
}

ipcMain.handle('voice:close', async () => {
  try { if (voiceManager) await voiceManager.close(); } catch {}
  voiceManager = null;
  ttsEngine = null;
  return { ok: true };
});

/* Rescate del motor de escucha: el renderer detectó voz real del micrófono sin NINGÚN
   texto (motor sordo: NVIDIA Broadcast y similares enganchan el camino de audio moderno
   que usa WinRT; el clásico usa otro y sí oye) y pide el cambio. Es idempotente —si ya
   está en el clásico, el motor no toca nada— y devuelve ok aunque no hubiera manager
   (no hay rescate posible sin modo voz, pero tampoco nada que reportar). */
/* ¿El tap de audio del renderer se está consumiendo? Lo pregunta el renderer cada vez
   que abre el modo (o cada pocos segundos mientras está abierto) para decidir si manda
   PCM — evita copiar audio que nadie va a usar. */
ipcMain.handle('voice:pcmActivo', () => !!(voiceManager && motorActual === 'whisper'));

/* Estado del dictado local para Ajustes y para la franja del panel: qué hay instalado,
   si está transcribiendo y qué motor de escucha está DE GUARDIA ahora mismo. */
ipcMain.handle('voice:installStatus', () => {
  try {
    const w = motorWhisper ? motorWhisper.estado() : null;
    let piper = { disponible: false };
    try { piper = createTtsLocal({ dataDir: DATA_DIR }).estado(); } catch {}
    return {
      ok: true,
      instalando: !!instalandoVoz || !!instalandoPiper,
      disponible: !!(w && w.disponible),
      modeloNombre: (w && w.modeloNombre) || '',
      transcribiendo: !!(w && w.transcribiendo),
      motor: motorActual === 'whisper' ? 'whisper' : (motorWindows ? motorWindows.info().motor : ''),
      /* Telemetría del tap: cuánto audio real ha llegado por voice:pcm y hace cuánto. */
      pcmMs: Math.round(pcmMs),
      pcmMsAgo: pcmUltimo ? Date.now() - pcmUltimo : -1,
      rescatesTap,
      piperDisponible: !!piper.disponible,
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('voice:rescue', async () => {
  try {
    if (voiceManager && voiceManager.rescatarMotor) await voiceManager.rescatarMotor();
    /* Con whisper de guardia, el rescate real es REABRIR el tap del renderer (su captura
       es la única fuente del motor local): la orden viaja como evento y el renderer
       reconecta su capturador sin tocar la sesión del panel. */
    if (motorActual === 'whisper' && getWin() && !getWin().isDestroyed()) {
      rescatesTap++;
      getWin().webContents.send('voice:event', { type: 'reabrir-tap' });
    }
  } catch {}
  return { ok: true, rescatesTap };
});

ipcMain.on('voice:event', (e, ev) => { if (voiceManager) voiceManager.ingest(ev); });

/* Audio crudo del micrófono (Int16 mono 16 kHz, trozos pequeños): es lo que consume el
   motor local de dictado (whisper). Lo envía el tap del AudioWorklet del renderer, el
   único camino de captura sano en todas las máquinas probadas. Ignorado si el activo no
   es whisper — los motores de Windows capturan por su cuenta. Contar MILISEGUNDOS de
   audio recibido es el único termómetro honesto del tap: «orbe se mueve y no hay
   texto» era indistinguible a distancia de «tap muerto». */
let pcmMs = 0, pcmUltimo = 0, rescatesTap = 0;
ipcMain.on('voice:pcm', (e, pcm) => {
  try {
    if (motorActual === 'whisper' && motorWhisper) {
      const b = Buffer.from(pcm);
      pcmMs += (b.length / 2 / 16000) * 1000;
      pcmUltimo = Date.now();
      motorWhisper.push(b);
    }
  } catch {}
});



/* Instalación del motor local (whisper.cpp): binario + modelo, con progreso al renderer.
   Sin dependencias: descarga directa de las URLs estables del proyecto. El handler espera
   el final de la instalación y el progreso en vivo viaja por 'voice:installProgress' —
   el botón de Ajustes pinta esa marcha mientras el invoke sigue abierto. */
let instalandoVoz = null;
const TAM_BINARIO = 8.6 * 1024 * 1024;        // referencias para el porcentaje del binario (medido: 8,2 MB)
/* El modelo que se instala es large-v3-turbo cuantizado q5_0 (574 MB): muy por
   delante del small en español y aún rápido en CPU. El small/base se quedan como
   respaldo si ya estaban instalados — el motor los usa sólo cuando no hay turbo. */
const MODELO_ARCHIVO = 'ggml-large-v3-turbo-q5_0.bin';
const MODELO_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/' + MODELO_ARCHIVO;
const TAM_MODELO = 574 * 1024 * 1024;         // referencia del proyecto para el porcentaje
const MIN_MODELO = 500 * 1024 * 1024;         // por debajo de esto la descarga está cortada
/* La release «latest» de whisper.cpp NO adjunta binarios: los publican en tags de build
   (b5130, b5127, …). Se pregunta a la API cuál de las últimas los trae y se toma su URL
   de descarga — inmutable a que muevan o renombren tags. */
function urlBinarioWhisper() {
  return new Promise((resolve, reject) => {
    const https = require('https');
    https.get('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=10', { headers: { 'User-Agent': 'SAGITARI-voice', 'Accept': 'application/vnd.github+json' } }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try {
          const releases = JSON.parse(d);
          for (const r of releases || []) {
            const a = (r.assets || []).find((x) => x.name === 'whisper-bin-x64.zip');
            if (a && a.browser_download_url) { resolve(a.browser_download_url); return; }
          }
          reject(new Error('ninguna release reciente trae whisper-bin-x64.zip'));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}
ipcMain.handle('voice:install', async () => {
  if (instalandoVoz) return { ok: false, error: 'ya se está instalando' };
  const fsPromises = require('fs/promises');
  const https = require('https');
  /* La raíz es el MISMO directorio de datos que usa el motor en whisper.js: dos raíces
     distintas harían una instalación que el motor nunca encontraría. */
  const raiz = path.join(DATA_DIR, 'voice-engine');
  const dirBin = path.join(raiz, 'bin');
  const dirModelos = path.join(raiz, 'models');
  try { fs.mkdirSync(dirBin, { recursive: true }); fs.mkdirSync(dirModelos, { recursive: true }); } catch (err) { return { ok: false, error: err.message }; }
  const bajar = (url, destino, tamRef, tipo) => new Promise((resolve, reject) => {
    const archivo = fs.createWriteStream(destino);
    let recibido = 0;
    let total = tamRef;
    const pedir = (u) => {
      https.get(u, { headers: { 'User-Agent': 'SAGITARI-voice' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return pedir(res.headers.location); }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' descargando ' + path.basename(destino))); }
        const cl = Number(res.headers['content-length']);
        if (Number.isFinite(cl) && cl > 0) total = cl;
        res.on('data', (c) => {
          recibido += c.length;
          try { if (getWin() && !getWin().isDestroyed()) getWin().webContents.send('voice:installProgress', { tipo, recibido, total }); } catch {}
        });
        res.pipe(archivo);
      }).on('error', reject);
    };
    archivo.on('error', reject);
    archivo.on('finish', () => resolve());
    pedir(url);
  });
  instalandoVoz = (async () => {
    try {
      const zipBin = path.join(raiz, 'whisper-bin.zip');
      await bajar(await urlBinarioWhisper(), zipBin, TAM_BINARIO, 'binario');
      // Un zip a medias (conexión cortada) o anómalo no se extrae: whisper.cpp
      // publica zips de ~8 MB; fuera de [1 MB, 60 MB] algo va mal y se dice.
      try {
        const tamZip = fs.statSync(zipBin).size;
        if (tamZip < 1024 * 1024 || tamZip > 60 * 1024 * 1024) {
          await fsPromises.unlink(zipBin).catch(() => {});
          throw new Error('el binario de dictado llegó con un tamaño anómalo (' + Math.round(tamZip / 1024) + ' KB): vuelve a intentarlo');
        }
      } catch (e) { if (/anómalo/.test(e.message)) throw e; }
      try { if (getWin() && !getWin().isDestroyed()) getWin().webContents.send('voice:installProgress', { tipo: 'extrayendo' }); } catch {}
      const falloZip = expandirZip(zipBin, dirBin);
      if (falloZip) throw new Error('no se pudo extraer el binario de dictado: ' + falloZip);
      await fsPromises.unlink(zipBin).catch(() => {});
      // whisper.cpp mete los ejecutables dentro de subcarpetas (Release/, o el nombre de
      // la build): se aplana hasta que el binario quede junto a sus DLL — whisper.js
      // busca en bin/ sin profundidad.
      try {
        for (let nivel = 0; nivel < 4; nivel++) {
          const carpetas = fs.readdirSync(dirBin).filter((n) => fs.statSync(path.join(dirBin, n)).isDirectory());
          if (!carpetas.length) break;
          for (const c of carpetas) {
            for (const f of fs.readdirSync(path.join(dirBin, c))) {
              const destino = path.join(dirBin, f);
              if (fs.existsSync(destino)) continue;   // nunca se pisa un binario con otro
              fs.renameSync(path.join(dirBin, c, f), destino);
            }
            fs.rmdirSync(path.join(dirBin, c));
          }
        }
      } catch {}
      const modeloPath = path.join(dirModelos, MODELO_ARCHIVO);
      await bajar(MODELO_URL, modeloPath, TAM_MODELO, 'modelo');
      /* Un modelo a medias (proxy que corta la conexión, disco lleno) no es un modelo:
         whisper.cpp cargaría un archivo truncado y devolvería basura en cada frase, que
         se ve exactamente como «el dictado local no acierta». Antes de darlo por bueno
         se mira el tamaño y, si no cuadra, se borra y se dice. */
      let tamModelo = 0;
      try { tamModelo = fs.statSync(modeloPath).size; } catch {}
      if (tamModelo < MIN_MODELO) {
        await fsPromises.unlink(modeloPath).catch(() => {});
        throw new Error('el modelo de dictado llegó incompleto (' + Math.round(tamModelo / 1024 / 1024) + ' MB de ~574 MB): vuelve a intentarlo');
      }
      // Listo: si el modo voz está abierto, el motor local toma la escucha ya.
      try {
        if (voiceManager && motorWhisper) { motorWhisper.resolver(); if (motorActual === 'whisper' || motorWhisper.estado().disponible) motorActual = 'whisper'; }
      } catch {}
      try { if (getWin() && !getWin().isDestroyed()) getWin().webContents.send('voice:installProgress', { tipo: 'listo' }); } catch {}
      return { ok: true };
    } catch (err) {
      try { if (getWin() && !getWin().isDestroyed()) getWin().webContents.send('voice:installProgress', { tipo: 'error', error: err.message }); } catch {}
      return { ok: false, error: err.message };
    } finally { instalandoVoz = null; }
  })();
});
/* Voz local (Piper sharvard es-ES): binario getWin()-x64 (~21 MB) + voz (~77 MB). Misma
   raíz que el motor en tts-local.js: dos raíces harían una instalación que el motor
   nunca encontraría. El zip de Piper trae subcarpeta `piper/`: se aplana igual que
   el binario de Whisper para que piper.exe quede junto a sus DLL y espeak-ng-data. */
let instalandoPiper = null;
const TAM_PIPER_BIN = 22 * 1024 * 1024;
const TAM_PIPER_VOZ = 78 * 1024 * 1024;
ipcMain.handle('tts:install', async () => {
  if (instalandoPiper) return { ok: false, error: 'ya se está instalando' };
  const fsPromises = require('fs/promises');
  const https = require('https');
  const raiz = path.join(DATA_DIR, 'voice-engine', 'tts');
  try { fs.mkdirSync(raiz, { recursive: true }); } catch (err) { return { ok: false, error: err.message }; }
  const bajar = (url, destino, tamRef, tipo) => new Promise((resolve, reject) => {
    const archivo = fs.createWriteStream(destino);
    let recibido = 0;
    let total = tamRef;
    const pedir = (u) => {
      https.get(u, { headers: { 'User-Agent': 'SAGITARI-voice' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return pedir(res.headers.location); }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' descargando ' + path.basename(destino))); }
        const cl = Number(res.headers['content-length']);
        if (Number.isFinite(cl) && cl > 0) total = cl;
        res.on('data', (c) => {
          recibido += c.length;
          try { if (getWin() && !getWin().isDestroyed()) getWin().webContents.send('tts:installProgress', { tipo, recibido, total }); } catch {}
        });
        res.pipe(archivo);
      }).on('error', reject);
    };
    archivo.on('error', reject);
    archivo.on('finish', () => resolve());
    pedir(url);
  });
  instalandoPiper = (async () => {
    try {
      const zipBin = path.join(raiz, 'piper-bin.zip');
      await bajar('https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip', zipBin, TAM_PIPER_BIN, 'binario');
      // Misma guarda que en voice:install: un zip anómalo (~22 MB esperados) no se extrae.
      try {
        const tamZip = fs.statSync(zipBin).size;
        if (tamZip < 1024 * 1024 || tamZip > 80 * 1024 * 1024) {
          await fsPromises.unlink(zipBin).catch(() => {});
          throw new Error('la voz llegó con un tamaño anómalo (' + Math.round(tamZip / 1024) + ' KB): vuelve a intentarlo');
        }
      } catch (e) { if (/anómalo/.test(e.message)) throw e; }
      try { if (getWin() && !getWin().isDestroyed()) getWin().webContents.send('tts:installProgress', { tipo: 'extrayendo' }); } catch {}
      const falloPiper = expandirZip(zipBin, raiz);
      if (falloPiper) throw new Error('no se pudo extraer la voz: ' + falloPiper);
      await fsPromises.unlink(zipBin).catch(() => {});
      try {
        for (let nivel = 0; nivel < 4; nivel++) {
          const carpetas = fs.readdirSync(raiz).filter((n) => fs.statSync(path.join(raiz, n)).isDirectory());
          if (!carpetas.length) break;
          for (const c of carpetas) {
            if (c === 'piper' && nivel === 0) {
              for (const f of fs.readdirSync(path.join(raiz, c))) {
                const destino = path.join(raiz, f);
                if (fs.existsSync(destino)) continue;
                fs.renameSync(path.join(raiz, c, f), destino);
              }
              try { fs.rmdirSync(path.join(raiz, c)); } catch {}
              break;
            }
          }
          break;
        }
      } catch {}
      await bajar('https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_ES/sharvard/medium/es_ES-sharvard-medium.onnx?download=true', path.join(raiz, 'voz-sharvard.onnx'), TAM_PIPER_VOZ, 'voz');
      await bajar('https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_ES/sharvard/medium/es_ES-sharvard-medium.onnx.json', path.join(raiz, 'voz-sharvard.onnx.json'), 8192, 'config');
      // Limpieza de la voz anterior (davefx): su .onnx actual es incompatible con
      // el binario (peta al cargar) y sólo ocuparía 63 MB rotos en el disco.
      for (const resto of ['voz-davefx.onnx', 'voz-davefx.onnx.json']) {
        try { await fsPromises.unlink(path.join(raiz, resto)); } catch {}
      }
      try { if (getWin() && !getWin().isDestroyed()) getWin().webContents.send('tts:installProgress', { tipo: 'listo' }); } catch {}
      return { ok: true };
    } catch (err) {
      try { if (getWin() && !getWin().isDestroyed()) getWin().webContents.send('tts:installProgress', { tipo: 'error', error: err.message }); } catch {}
      return { ok: false, error: err.message };
    } finally { instalandoPiper = null; }
  })();
  const rp = await instalandoPiper;
  return rp;
});
ipcMain.on('tts:played', (e, id) => {
  if (!voiceManager) return;
  voiceManager.spoken(id);
  /* El fin de la lectura, que es el aviso del que depende que el glow vuelva a su calma
     en el renderer: el manager se queda en «escuchando» cuando vacía su cola de frases.
     Antes lo emitía la salida del proceso de PowerShell de `tts:speak`, que ya no existe
     porque la lectura entera la orquesta el manager. */
  if (voiceManager.estado() === 'escuchando') { try { if (getWin() && !getWin().isDestroyed()) getWin().webContents.send('tts:done'); } catch {} }
});
ipcMain.on('tts:stop', () => { if (voiceManager) voiceManager.stopSpeaking(); });
/* «Habla el usuario»: interrumpir deja de tirar la cola (stopSpeaking) pero el contador
   de frases seguía donde estaba. La frase siguiente a la interrupción recibía un id de
   UNA sesión anterior, el renderer la tocaba y al terminar su aviso se descartaba en
   `spoken()` («no es la que suena») y la cola se detenía: se oía la primera frase de la
   respuesta siguiente y el resto de la respuesta enmudecía para siempre. Reiniciar el
   contador arranca la nueva secuencia en 1 de nuevo. */
ipcMain.on('tts:reset', () => {
  /* La interrupción sólo necesita reiniciar el contador de frases; el motor de dictado y
     el de síntesis tienen que seguir vivos. Antes se destría y nacía otro manager: el close
     apagaba el motor de dictado con el micrófono abierto —nadie traducía su audio— y el modo
     voz quedaba sordo hasta cerrarlo y reabrirlo; y el stt nuevo heredaba el idioma de los
     ajustes del momento, no el de la sesión. El manager expone `reiniciar()`: seq vuelve a 0
     y el renderer vuelve a mandar `ttsPlayed` para cada frase nueva (el método devuelve ese
     primer id: nadie más necesita saberlo). */
  if (!voiceManager) return;
  try { voiceManager.reiniciar(); } catch {}
});


  // Cierre de la app: desarma el reintento del dictado y suelta motores/procesos.
  async function cerrar() {
    estadoCierre.saliendo = true;   // el reintento del dictado no debe arrancar nada durante el cierre
    dictando = false;
    if (whisper) { try { whisper.kill(); } catch {} }   // dictado en marcha
    /* Modo voz: cierra también el proceso de escuchar (su PowerShell) y el motor de
       síntesis —la lectura en curso, si la había, se corta ahí y su PowerShell no queda
       huérfano—. close() resuelve en microtareas (mata y libera, sin esperar a nadie). */
    try { if (voiceManager) await voiceManager.close(); } catch {}
    voiceManager = null;
  }

  return { cerrar };
}

module.exports = { registerVozIpc, expandirZip };
