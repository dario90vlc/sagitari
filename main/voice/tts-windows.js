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
  /* Los temporales de una frase viven bajo NUESTRA carpeta, no sueltos en %TEMP%: así
     dispose() puede barrer de verdad lo que deje una síntesis interrumpida (si el proceso
     muere a mitad, el .txt con la frase del usuario y el .wav se quedaban huérfanos y sin
     nadie que los borrase). Si la carpeta no se puede crear —raíz de datos de solo
     lectura— se cae a %TEMP%: la voz nunca debe quedarse muda por eso. */
  const dir = path.join(dataDir, 'tts');
  let carpetaLista = false;
  const carpeta = () => {
    if (carpetaLista) return dir;
    try { fs.mkdirSync(dir, { recursive: true }); carpetaLista = true; return dir; } catch { return os.tmpdir(); }
  };

  function correr(args, texto) {
    return new Promise((resolve) => {
      const base = carpeta();
      const tmpText = path.join(base, 'sagi-tts-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.txt');
      const tmpWav = path.join(base, 'sagi-tts-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.wav');
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
      /* Red de seguridad, como en el `tts:speak` de siempre: `Await` del guion espera con
         Wait(-1) a una tarea de WinRT, así que una voz atascada dejaría esta promesa colgada
         para siempre (y el .txt con la frase del usuario, en el disco). */
      const killTimer = setTimeout(() => {
        salida.error = salida.error || 'la síntesis tardó demasiado';
        try { proc.kill(); } catch {}
      }, 60000);
      /* `spawn` no lanza cuando no puede arrancar (ENOENT, EACCES): avisa por el evento
         'error'. Sin listener, Node lo relanzaría como excepción no capturada y, como en
         ese caso no llega ningún 'exit', la promesa no resolvería y el .txt se quedaría. */
      proc.on('error', (e) => {
        clearTimeout(killTimer);   // sin desarmarlo, el temporizador mantendría el proceso vivo
        try { fs.unlinkSync(tmpText); } catch {}
        resolve({ ...salida, error: e.message });
      });
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
        clearTimeout(killTimer);
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
      /* Mismos dos seguros que en correr(): el 'error' del arranque (que no trae 'exit' y
         sin listener tumbaría el proceso) y un tope de tiempo, para que el desplegable de
         voces no se quede girando si PowerShell no contesta. */
      const killTimer = setTimeout(() => { try { proc.kill(); } catch {} }, 60000);
      proc.on('error', () => { clearTimeout(killTimer); resolve(l); });
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
      proc.on('exit', () => { clearTimeout(killTimer); resolve(l); });
    });
    return r;
  }

  /* dispose() sí tiene trabajo: la carpeta de temporales es nuestra. Se marca además para
     que, si alguien sintetiza después de dispose(), vuelva a crearla en vez de escribir en
     una carpeta que ya no existe. */
  function dispose() {
    carpetaLista = false;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  return { nombre: 'windows', capacidades: { ...CAPACIDADES_BASE }, listarVoces, sintetizar, dispose };
}

module.exports = { createTtsWindows };
