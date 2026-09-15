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

function createSttWindows({ emit, lang = 'es-ES', spawnFn = spawn, scriptPath = path.join(__dirname, '..', 'voice.ps1') } = {}) {
  let proc = null;
  let buf = '';
  let info = { motor: '', idioma: '' };

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
    } else if (linea.startsWith('HINT::')) {
      emit({ type: 'notice', text: linea.slice(6) });
    } else if (linea.startsWith('ERROR::')) {
      const texto = linea.slice(7).trim();
      const fix = /micr[oó]fono/i.test(texto) ? 'Abre Sonido en Windows (ms-settings:sound) y elige el micrófono correcto como predeterminado.'
        : /reconocimiento de voz en l[ií]nea/i.test(texto) ? 'Actívalo en ms-settings:privacy-speech y vuelve a abrir el modo voz.'
        : 'Vuelve a abrir el modo voz; si sigue, revisa el micrófono en ms-settings:sound.';
      emit({ type: 'error', text: texto, fix });
    }
  }

  function start() {
    return new Promise((resolve, reject) => {
      try {
        /* El motor moderno de Windows (WinRT) NO se capa: da parciales y confianza, y
           voice.ps1 ya sabe caer al clásico si en la máquina no hay idioma offline. */
        proc = spawnFn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Lang', lang], { windowsHide: true });
      } catch (e) { reject(e); return; }
      proc.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const linea = buf.slice(0, i).replace(/\r$/, '').trim();
          buf = buf.slice(i + 1);
          if (linea) manejaLinea(linea);
        }
      });
      proc.stderr.on('data', (d) => {
        const msg = d.toString('utf8').trim();
        if (msg) emit({ type: 'error', text: 'El motor de voz falló: ' + msg.slice(0, 200), fix: 'Cierra el modo voz y vuelve a abrirlo.' });
      });
      proc.on('exit', () => { proc = null; });
      resolve();
    });
  }

  function stop() {
    return new Promise((resolve) => {
      const p = proc;
      proc = null;
      if (!p) { resolve(); return; }
      try { p.stdin.end(); } catch {}
      try { p.kill(); } catch {}
      resolve();
    });
  }

  const engine = { nombre: 'windows', capacidades: { ...CAPACIDADES_BASE, partials: true, confidence: true }, start, push: () => {}, stop, info: () => ({ ...info }) };
  assertEngine(engine);
  return engine;
}

module.exports = { createSttWindows };
