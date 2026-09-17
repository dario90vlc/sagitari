'use strict';

/* Motor de hablar LOCAL: Piper (VITS neuronal, 100% offline, CPU en tiempo real).
 *
 * Por qué existe: las voces de escritorio de Windows (Helena/Laura/Pablo Desktop)
 * son SAPI robóticas; las naturales OneCore exigen descarga desde Windows y no
 * están en todas las máquinas. Piper davefx-medium es-ES (60 MB) suena a persona,
 * corre en ~600 ms por frase de 6 s (RTF 0.05 medido) y vive bajo DATA_DIR como
 * Whisper: sin red tras instalar, sin nube, sin cuentas.
 *
 * Integración (espejo de whisper.js): binario + voz bajo <dataDir>/voice-engine/tts,
 * un spawn por frase (carga de voz ~240 ms, inferencia ~300 ms), WAV 22050 Hz que el
 * renderer ya sabe reproducir. Contrato idéntico a tts-windows: sintetizar() →
 * { wav, voz, ms, natural, error }. `natural: true` porque es neuronal, no SAPI.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { CAPACIDADES_BASE } = require('./contract');

const VOZ_NOMBRE = 'Piper davefx (es-ES)';
const VOZ_ARCHIVO = 'voz-davefx.onnx';
const VOZ_CFG = 'voz-davefx.onnx.json';
const EXE_CANDIDATOS = ['piper.exe', path.join('piper', 'piper.exe')];

function createTtsLocal({ spawnFn = spawn, dataDir = os.tmpdir(), rate = 0 } = {}) {
  const dir = path.join(dataDir, 'voice-engine', 'tts');
  let carpetaLista = false;
  const carpeta = () => {
    if (carpetaLista) return dir;
    try { fs.mkdirSync(dir, { recursive: true }); carpetaLista = true; return dir; } catch { return os.tmpdir(); }
  };

  /* Dónde están el binario y la voz. Se resuelve en CADA síntesis (no solo en
     start): la instalación por demanda llega a mitad de sesión y un `exe` fijado
     al nacer quedaría null para siempre. */
  function resolver() {
    const base = carpeta();
    let exe = null;
    for (const c of EXE_CANDIDATOS) {
      const p = path.join(base, c);
      try { if (fs.existsSync(p)) { exe = p; break; } } catch {}
    }
    let voz = null;
    try {
      const p = path.join(base, VOZ_ARCHIVO);
      if (fs.existsSync(p) && fs.existsSync(path.join(base, VOZ_CFG))) voz = p;
    } catch {}
    return { exe, voz, dir: base };
  }

  function estado() {
    const r = resolver();
    return { disponible: !!(r.exe && r.voz), exe: r.exe, voz: r.voz };
  }

  function sintetizar(texto, { voice = '', lang = 'es-ES', rate: r } = {}) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const { exe, voz } = resolver();
      if (!exe || !voz) {
        resolve({ wav: null, voz: '', ms: 0, natural: true, error: 'voz local no instalada' });
        return;
      }
      const base = carpeta();
      const sello = Date.now() + '-' + Math.random().toString(36).slice(2);
      const tmpIn = path.join(base, 'sagi-piper-' + sello + '.txt');
      const tmpWav = path.join(base, 'sagi-piper-' + sello + '.wav');
      const limpio = () => { try { fs.unlinkSync(tmpIn); } catch {} };
      try { fs.writeFileSync(tmpIn, String(texto || ''), 'utf8'); } catch (e) {
        resolve({ wav: null, voz: VOZ_NOMBRE, ms: 0, natural: true, error: e.message });
        return;
      }
      /* Piper lee la frase por stdin (UTF-8) y escribe el WAV a -f. El rate de la
         app (+40..-40) mapea a length_scale 0.7..1.4 (1.0 = natural): rate alto =
         length bajo = más rápido. Sin stdin.end() el proceso no termina. */
      const tasa = r ?? rate ?? 0;
      const length = Math.max(0.5, Math.min(2.0, 1.0 - (Number(tasa) || 0) / 100));
      let proc;
      try {
        proc = spawnFn(exe, ['-m', voz, '-f', tmpWav, '--length_scale', String(length),
          '--sentence_silence', '0.15', '--espeak_data',
          path.join(path.dirname(exe), 'espeak-ng-data')], { windowsHide: true });
      } catch (e) {
        limpio();
        resolve({ wav: null, voz: VOZ_NOMBRE, ms: 0, natural: true, error: e.message });
        return;
      }
      let errTxt = '';
      const killTimer = setTimeout(() => {
        errTxt = errTxt || 'la síntesis local tardó demasiado';
        try { proc.kill(); } catch {}
      }, 60000);
      proc.on('error', (e) => {
        clearTimeout(killTimer);
        limpio();
        resolve({ wav: null, voz: VOZ_NOMBRE, ms: 0, natural: true, error: e.message });
      });
      try {
        proc.stdin.write(fs.readFileSync(tmpIn));
        proc.stdin.end();
      } catch {}
      proc.stderr.on('data', (d) => { if (!errTxt && /error|fail/i.test(d.toString('utf8'))) errTxt = d.toString('utf8').trim().slice(0, 200); });
      proc.on('exit', (code) => {
        clearTimeout(killTimer);
        limpio();
        if (code !== 0 || !fs.existsSync(tmpWav)) {
          resolve({ wav: null, voz: VOZ_NOMBRE, ms: Date.now() - t0, natural: true, error: errTxt || 'piper salió con código ' + code });
          return;
        }
        let wav;
        try { wav = fs.readFileSync(tmpWav); } catch (e) {
          try { fs.unlinkSync(tmpWav); } catch {}
          resolve({ wav: null, voz: VOZ_NOMBRE, ms: Date.now() - t0, natural: true, error: e.message });
          return;
        }
        try { fs.unlinkSync(tmpWav); } catch {}
        resolve({ wav, voz: VOZ_NOMBRE, ms: Date.now() - t0, natural: true, error: '' });
      });
    });
  }

  async function listarVoces() {
    const e = estado();
    return e.disponible ? [{ nombre: VOZ_NOMBRE, idioma: 'es-ES', natural: true }] : [];
  }

  function dispose() {
    carpetaLista = false;
  }

  return { nombre: 'piper-local', capacidades: { ...CAPACIDADES_BASE }, estado, sintetizar, listarVoces, dispose };
}

/* ¿Toca sintetizar con la voz LOCAL (Piper)?
 *
 * Por qué es una función y no tres líneas dentro del wrapper de main: la decisión tiene
 * tres casos y sólo uno es discutible, así que conviene tenerlos escritos y probados.
 *  - No está instalada → no hay nada que decidir.
 *  - Sin voz guardada, o con la voz local guardada → la local manda: es la única voz
 *    neuronal del equipo, y sin ella la lectura vuelve a depender del almacén de Windows
 *    (que en la mayoría de máquinas sólo tiene voces de escritorio robóticas).
 *  - Con OTRA voz guardada por el usuario → manda su elección, porque cambiársela sería
 *    pisarle un ajuste a mano. Por eso el ajuste guardado viaja con `fijo`: la voz que
 *    elige la propia app (la primera natural del idioma, la que se autoasigna al
 *    instalar) NO es una elección del usuario y no puede condenar a la voz buena a no
 *    sonar nunca. */
function usarVozLocal({ disponible = false, voice = '', fijo = false } = {}) {
  if (!disponible) return false;
  const v = String(voice || '').trim();
  if (!v) return true;
  if (/^piper/i.test(v)) return true;
  return !fijo;
}

module.exports = { createTtsLocal, VOZ_NOMBRE, usarVozLocal };
