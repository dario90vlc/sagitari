'use strict';

/* Motor de hablar de Windows: sintetiza UNA frase a un WAV y devuelve los bytes.
 *
 * Por qué por WinRT y no por SAPI: las voces buenas de Windows 11 («Pablo», «Laura»,
 * «Helena» modernas) solo existen en el almacén moderno; System.Speech únicamente ve
 * «Helena Desktop», que es la robótica. tts.ps1 intenta WinRT y cae a SAPI solo si
 * aquello falla, así que aquí no hay dos caminos: hay uno con respaldo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { CAPACIDADES_BASE } = require('./contract');

function createTtsWindows({ spawnFn = spawn, dataDir = os.tmpdir(), scriptPath = path.join(__dirname, '..', 'tts.ps1'), rate = 0 } = {}) {
  const dir = path.join(dataDir, 'tts');

  function correr(args, texto) {
    return new Promise((resolve) => {
      const tmpText = path.join(os.tmpdir(), 'sagi-tts-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.txt');
      const tmpWav = path.join(os.tmpdir(), 'sagi-tts-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.wav');
      fs.writeFileSync(tmpText, String(texto || ''), 'utf8');
      const salida = { voz: '', ms: 0, error: '', file: tmpWav };
      let proc;
      try {
        proc = spawnFn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
          '-Lang', args.lang || 'es-ES', '-Voice', args.voice || '', '-TextFile', tmpText, '-OutFile', tmpWav, '-Rate', String(args.rate ?? rate)], { windowsHide: true });
      } catch (e) {
        try { fs.unlinkSync(tmpText); } catch {}
        resolve({ ...salida, error: e.message });
        return;
      }
      /* Cerrar la entrada de PowerShell NO es cosmético: con la tubería de stdin abierta,
         powershell.exe no termina al acabar el guion (se queda esperando el fin de la
         entrada) y la promesa de aquí abajo no resolvía nunca: la frase se sintetizaba
         pero nadie la recibía. Medido con una sonda: sin esto, ni «-List» ni la síntesis
         devolvían el control, con la salida ya escrita en el pipe. */
      try { proc.stdin.end(); } catch {}
      let buf = '';
      proc.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const linea = buf.slice(0, i).replace(/\r$/, '').trim();
          buf = buf.slice(i + 1);
          if (linea.startsWith('VOICEUSED::')) salida.voz = linea.slice(11).trim();
          else if (linea.startsWith('OK::')) salida.ms = Number(linea.split('|')[1]) || 0;
          else if (linea.startsWith('ERROR::')) salida.error = linea.slice(7).trim();
        }
      });
      proc.stderr.on('data', (d) => { if (!salida.error) salida.error = d.toString('utf8').trim().slice(0, 200); });
      proc.on('exit', () => {
        try { fs.unlinkSync(tmpText); } catch {}
        resolve(salida);
      });
    });
  }

  async function sintetizar(texto, { voice = '', lang = 'es-ES', rate: r } = {}) {
    const r1 = await correr({ lang, voice, rate: r }, texto);
    const limpio = () => { try { fs.unlinkSync(r1.file); } catch {} };
    if (r1.error || !fs.existsSync(r1.file)) { limpio(); return { wav: null, voz: r1.voz, ms: r1.ms, error: r1.error || 'sin audio' }; }
    const wav = fs.readFileSync(r1.file);
    limpio();
    return { wav, voz: r1.voz, ms: r1.ms, error: '' };
  }

  async function listarVoces() {
    const r = await new Promise((resolve) => {
      const l = [];
      let proc;
      try { proc = spawnFn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-List'], { windowsHide: true }); }
      catch { resolve(l); return; }
      try { proc.stdin.end(); } catch {}   // sin esto PowerShell no termina: ver la nota de correr()
      let buf = '';
      proc.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const linea = buf.slice(0, i).replace(/\r$/, '').trim();
          buf = buf.slice(i + 1);
          if (linea.startsWith('VOICE::')) { const [nombre, idioma] = linea.slice(7).split('|'); l.push({ nombre, idioma }); }
        }
      });
      proc.on('exit', () => resolve(l));
    });
    return r;
  }

  return { nombre: 'windows', capacidades: { ...CAPACIDADES_BASE }, listarVoces, sintetizar, dispose: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

module.exports = { createTtsWindows };
