'use strict';

/* Motor de escuchar de Windows: envuelve main/voice.ps1.
 *
 * `voice.ps1` captura por su cuenta el micrófono predeterminado y decide dónde acaba
 * cada frase (su propio tiempo de silencio), así que este motor no recibe PCM: por eso
 * declara `level:false` (el nivel del orbe lo mide el renderer). Un motor de la fase 2
 * (Whisper) declarará `level:true` y sí recibirá PCM por push().
 *
 * Se inyecta `spawnFn` para poder probar el parseo del protocolo sin lanzar PowerShell.
 */
const path = require('path');
const { spawn } = require('child_process');
const { assertEngine, CAPACIDADES_BASE } = require('./contract');

const SEP = '\u001f';   // separador de unidad: no aparece en texto normal

function createSttWindows({ emit, lang = 'es-ES', spawnFn = spawn, scriptPath = path.join(__dirname, '..', 'voice.ps1'), forzarClasico: forzarClasicoInicial = false } = {}) {
  let proc = null;
  let buf = '';
  let info = { motor: '', idioma: '' };
  let detenido = false;   // lo pone stop(): un cierre pedido no es una muerte que avisar
  /* Rescate pedido por el renderer (y por Ajustes, manualmente): en algunas máquinas el
     motor moderno ARRANCA y declara que escucha, pero no recibe nunca audio del
     dispositivo (NVIDIA Broadcast y similares enganchan el camino de audio moderno; el
     clásico usa otro y sí oye). Se rearma el guion con -NoWinrt y el clásico toma la
     sesión. El valor inicial permite arrancar DIRECTAMENTE en clásico (Ajustes). */
  let forzarClasico = !!forzarClasicoInicial;
  /* Auto-rearranque: una muerte que nadie pidió (caída de PowerShell, micro cambiado en
     caliente) no puede dejar el modo voz sordo para el resto de la sesión — el usuario
     veía «Escuchando», hablaba y nada llegaba. Se reintenta un par de veces con calma;
     si el motor cae una y otra vez, ahí sí se avisa del fallo. */
  const MAX_REINTENTOS = 2;
  let reintentos = 0;
  let temporizador = null;

  function manejaLinea(linea) {
    if (linea.startsWith('PART::')) emit({ type: 'partial', text: linea.slice(6) });
    else if (linea.startsWith('FINAL::')) {
      const crudo = linea.slice(7);
      const corte = crudo.indexOf(SEP);
      const texto = (corte >= 0 ? crudo.slice(0, corte) : crudo).trim();
      const conf = corte >= 0 ? Number(crudo.slice(corte + 1)) : null;
      emit({ type: 'final', text: texto, confidence: Number.isFinite(conf) ? conf : null });
    } else if (linea.startsWith('MODE::')) {
      info.motor = linea.slice(6).trim();
      if (info.motor === 'sapi') {
        emit({ type: 'notice', text: 'Motor de voz clásico. Activa "Reconocimiento de voz en línea" en Windows (Privacidad › Voz) para máxima precisión.' });
      }
    } else if (linea.startsWith('READY::')) {
      info.idioma = linea.slice(7).trim();
      emit({ type: 'state', state: 'escuchando' });
    } else if (linea.startsWith('MotorAlterno::')) {
      /* Orden que llega DESDE dentro del guion: el motor moderno DEMOSTRÓ sordera (capturó
         cero audio en seis intentos) y el guion YA SE ESTÁ CAMBIANDO SOLO — sigue vivo, y
         su sección clásica arranca en el mismo proceso. Aquí no se rearma nada: respawnear
         mataría el proceso justo cuando se está rescatando a sí mismo (y añadiría otro
         ciclo entero de sordera). Sólo se recuerda la decisión — cualquier rearranque
         futuro (caída, reapertura) va directo al clásico con -NoWinrt — y se avisa. */
      forzarClasico = true;
      emit({ type: 'notice', text: 'El motor moderno no recibe audio en este dispositivo: cambio al motor clásico…' });
      if (!proc) arranque().catch(() => {});   // carrera imposible pero barata de cubrir
    } else if (linea.startsWith('HINT::')) {
      emit({ type: 'notice', text: linea.slice(6) });
    } else if (linea.startsWith('NOTE::')) {
      /* `voice.ps1` avisa por aquí de por qué cae al motor clásico (por ejemplo: WinRT no
         disponible). Es una explicación, no un fallo: viaja como aviso, igual que HINT::,
         para que el usuario sepa por qué oye peor sin ver un error en pantalla. */
      emit({ type: 'notice', text: linea.slice(6) });
    } else if (linea.startsWith('STOPPED::')) {
      /* El motor avisa de que se apaga él mismo: no es un fallo, pero hay que soltar
         el proceso para que un arranque posterior no herede nada de este. */
      stop();
    } else if (linea.startsWith('ERROR::')) {
      const texto = linea.slice(7).trim();
      const fix = /micr[oó]fono/i.test(texto) ? 'Abre Sonido en Windows (ms-settings:sound) y elige el micrófono correcto como predeterminado.'
        : /reconocimiento de voz en l[ií]nea/i.test(texto) ? 'Actívalo en ms-settings:privacy-speech y vuelve a abrir el modo voz.'
        : 'Vuelve a abrir el modo voz; si sigue, revisa el micrófono en ms-settings:sound.';
      emit({ type: 'error', text: texto, fix });
    }
  }

  function start() {
    /* Un start() explícito rearma los reintentos: es el usuario volviendo a abrir el modo,
       con derecho de nuevo a los dos reintentos. La preferencia clásica (Ajustes o
       rescate) se conserva: no se reabre el modo para volver a perder el tiempo. */
    reintentos = 0;
    return arranque();
  }

  function arranque() {
    return new Promise((resolve, reject) => {
      /* Un arranque rearma el estado: si había un motor anterior se cierra antes de
         arrancar otro (si no, el PowerShell viejo seguiría con el micrófono abierto) y
         se tira el búfer a medias. `proc = null` va ANTES de matarlo para que su 'exit'
         tardío no pise la referencia al proceso nuevo. */
      if (proc) { const viejo = proc; proc = null; try { viejo.kill(); } catch {} }
      buf = '';
      info = { motor: '', idioma: '' };
      detenido = false;
      let p;
      try {
        /* El motor moderno de Windows (WinRT) NO se capa por defecto: da parciales y
           confianza, y voice.ps1 ya sabe caer al clásico si en la máquina no hay idioma
           offline. Sólo el rescate del renderer (-NoWinrt) lo fuerza al clásico. */
        const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Lang', lang];
        if (forzarClasico) args.push('-NoWinrt');
        p = spawnFn('powershell.exe', args, { windowsHide: true });
      } catch (e) { reject(e); return; }
      proc = p;
      p.stdout.on('data', (d) => {
        if (p !== proc) return;   // proceso ya reemplazado: su salida no interesa
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const linea = buf.slice(0, i).replace(/\r$/, '').trim();
          buf = buf.slice(i + 1);
          if (linea) manejaLinea(linea);
        }
      });
      p.stderr.on('data', (d) => {
        if (p !== proc) return;
        const msg = d.toString('utf8').trim();
        if (msg) emit({ type: 'error', text: 'El motor de voz falló: ' + msg.slice(0, 200), fix: 'Cierra el modo voz y vuelve a abrirlo.' });
      });
      /* `spawn` no lanza cuando no puede arrancar (ENOENT, EACCES): avisa por el evento
         'error' y sin listener Node lo relanzaría como excepción no capturada, capaz de
         tumbar el proceso principal. En este caso puede no llegar ningún 'exit'. */
      p.on('error', (e) => {
        if (p !== proc) return;
        proc = null;
        emit({ type: 'error', text: 'No se pudo arrancar el motor de voz: ' + e.message, fix: 'Vuelve a abrir el modo voz.' });
      });
      p.on('exit', () => {
        if (p !== proc) return;   // el que sale no es el vigente: no se toca `proc`
        proc = null;
        /* Muerte que nadie pidió (caída, kill externo, entrada estándar cerrada por
           fuera): sin esto el consumidor se queda en «escuchando» y el usuario habla
           al vacío. Antes solo se avisaba: el aviso no devuelve el oído, así que ahora
           se rearranca solo unas veces y el aviso queda para la caída insistente. */
        if (detenido) return;
        if (reintentos < MAX_REINTENTOS) {
          reintentos += 1;
          emit({ type: 'notice', text: 'El motor de voz se ha reiniciado; sigue hablando.' });
          if (temporizador) clearTimeout(temporizador);
          temporizador = setTimeout(() => {
            temporizador = null;
            if (detenido || proc) return;   // mientras tanto llegó un cierre o un arranque nuevo
            arranque().catch(() => emit({ type: 'error', text: 'El motor de voz no ha podido rearrancar.', fix: 'Vuelve a abrir el modo voz.' }));
          }, 1200);
          return;
        }
        emit({ type: 'error', text: 'El motor de voz se cerró solo.', fix: 'Vuelve a abrir el modo voz.' });
      });
      resolve();
    });
  }

  /* Rescate: rearma el motor con el clásico. Si ya está en él, no toca nada (un
     rearranque aquí sólo cortaría la escucha un par de segundos para nada). */
  async function motorAlternativo() {
    if (forzarClasico) return;
    forzarClasico = true;
    await start();
  }

  /* Interruptor manual de Ajustes: fuerza el clásico aunque el moderno funcione, y
     reorganiza la escucha PARA APLICARLO YA (a diferencia del rescate, aquí un rearranque
     con el clásico ya en marcha es intencional: el usuario acaba de pulsar el interruptor
     o el motor estaba sordo). */
  function usarClasico() {
    forzarClasico = true;
    return start();
  }

  function stop() {
    return new Promise((resolve) => {
      detenido = true;
      if (temporizador) { clearTimeout(temporizador); temporizador = null; }   // un rearranque pendiente ya no procede
      const p = proc;
      proc = null;
      if (!p) { resolve(); return; }
      try { p.stdin.end(); } catch {}
      try { p.kill(); } catch {}
      resolve();
    });
  }

  const engine = { nombre: 'windows', capacidades: { ...CAPACIDADES_BASE, partials: true, confidence: true }, start, push: () => {}, stop, motorAlternativo, usarClasico, info: () => ({ ...info }) };
  assertEngine(engine);
  return engine;
}

module.exports = { createSttWindows };
