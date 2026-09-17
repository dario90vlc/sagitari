'use strict';

/* Motor de dictado LOCAL de alta precisión: Whisper (whisper.cpp), fase 2 del contrato.
 *
 * Por qué existe: el motor moderno de Windows (WinRT) puede estar roto a nivel de
 * sistema (congela, oye y no reconoce) y el clásico (SAPI 8.0) transcribe el habla
 * libre con muchos errores. Whisper corre EN este equipo, sobre el audio crudo que le
 * manda el renderer — el ÚNICO camino de captura que se ha demostrado sano en todas
 * las máquinas problemáticas (es el mismo que mueve el orbe).
 *
 * Diseño:
 *  - `push(pcm)` recibe PCM Int16 mono 16 kHz del renderer (AudioWorklet, tap del micro).
 *  - Un detector de voz propio (energía sobre suelo adaptativo) corta la frase: ~0,6 s
 *    de silencio cierra lo dictado; máximo 20 s por trozo.
 *  - Cada frase final se escribe como WAV temporal y se transcribe con whisper-cli
 *    (ggml, en español, con prompt en español para evitar alucinaciones en inglés).
 *  - Vista previa: mientras la frase sigue abierta se transcribe lo acumulado cada
 *    ~1,3 s y se emite como `partial`, para que el panel enseñe el texto mientras el
 *    usuario habla (lo que hacen los dictados de los asistentes de voz) en vez de no
 *    enseñar nada hasta el silencio. NUNCA pisa al final: si hay una transcripción final
 *    en marcha, o si ya hay una previa corriendo, este turno se salta — la frase que se
 *    cierra es lo que de verdad se envía, y su latencia es lo primero.
 *  - El spawn no se pisa: si llega una frase mientras transcribe, se encola.
 *  - Whisper alucina con el silencio («Thank you», subtítulos de series): el filtro
 *    de basura (esBasura) ya existe aguas abajo; aquí se tumban los trozos con menos
 *    de dos letras o sin ninguna vocal.
 *
 * Contrato: mismo vocabulario que los demás motores (contract.js) — partials:true (la
 * vista previa de arriba; el texto DEFINITIVO sigue saliendo sólo por `final`),
 * confidence:true, level:false (el nivel del orbe lo mide el renderer).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { assertEngine, CAPACIDADES_BASE } = require('./contract');
const { esBasura } = require('./junk');

/* Tamaños y umbrales del detector de voz. El renderer envía chunks de 128 muestras
   (~8 ms); se acumulan en marcos de 30 ms (480 muestras), el tamaño clásico de VAD. */
const MARCO = 480;              // muestras por marco de decisión (30 ms a 16 kHz)
const SUELO_INICIAL = 300;      // energía RMS inicial (Int16) hasta calibrar
const FACTOR_VOZ = 3.0;         // un marco es voz si supera suelo * FACTOR_VOZ
const DISPARO = 3;              // marcos de voz seguidos para ABRIR frase (~90 ms)
const FACTOR_TI_BIO = 1.6;      // habla tenue: micros de poca ganancia no llegan a 3× suelo
const DISPARO_TI_BIO = 12;      // …pero 12 marcos tenues seguidos (~360 ms) sí son habla
const COLA_SILENCIO = 20;       // marcos de silencio para CERRAR frase (~600 ms)
const MAX_TROZO_MARCOS = 667;   // tope de frase: 667 * 30 ms = 20 s
const PRE_RODADURA = 10;        // marcos previos al disparo que se conservan (~300 ms)

/* Vista previa: cada cuánto se intenta, y a partir de cuánto audio tiene sentido (con
   menos de ~1,2 s whisper no tiene nada que decir y sólo gasta CPU). */
const PREVIA_MS = 1300;         // cadencia entre vistas previas
const PREVIA_MIN_MARCOS = 40;   // 1,2 s de audio acumulado
const PREVIA_MAX_MS = 20000;    // tope de una previa atascada

const SAMPLERATE = 16000;       // whisper consume WAV PCM16 a 16 kHz

function createWhisper({ emit, lang = 'es-ES', spawnFn = spawn, dirRaiz = null, tmpDir = null } = {}) {
  const raiz = dirRaiz || path.join(__dirname, '..', '..', 'voice-engine');
  const dirBin = path.join(raiz, 'bin');
  const dirModelos = path.join(raiz, 'models');
  let dirTmp = tmpDir;   // perezoso: sólo se crea cuando hay una frase que escribir

  let cli = null;          // ruta del ejecutable resuelto (whisper-cli|main|.exe)
  let modelo = null;       // ruta del modelo resuelto (ggml-base|small.bin)
  let modeloNombre = '';
  let proc = null;         // transcripción DEFINITIVA en curso
  let cola = [];           // WAVs pendientes mientras uno transcribe
  let previaProc = null;   // vista previa en curso (proceso aparte del final)
  let previaGen = 0;       // cuántas previas se han descartado (la última ya no debe emitir)
  let previaLimpiar = null;// cómo se limpia la previa en curso (se invoca al matarla)
  let previaTope = null;   // temporizador de tope de la previa en curso
  let ultimaPrevia = 0;    // cuándo se lanzó la última vista previa

  /* --- estado del VAD --- */
  let buf = Buffer.alloc(0);          // PCM entrante sin enmarcar
  let suelo = SUELO_INICIAL;
  let calibrado = false;
  let marcosVozSeguidos = 0;
  let marcosSilencioSeguidos = 0;
  let grabando = false;
  let trozo = [];                     // marcos (Int16Array) de la frase en curso
  let preRodadura = [];
  let abiertaEn = 0;

  const energia = (marco) => {
    let s = 0;
    for (let i = 0; i < marco.length; i++) { const v = marco[i] / 32768; s += v * v; }
    return Math.sqrt(s / marco.length) * 32768;
  };

  function estado() {
    return {
      disponible: !!(cli && modelo),
      cli, modelo, modeloNombre,
      transcribiendo: !!proc,
      previa: !!previaProc,
      cola: cola.length,
    };
  }

  /* Resuelve binario y modelo una vez por sesión (llamado en start() y tras instalar). */
  function resolver() {
    cli = null; modelo = null; modeloNombre = '';
    try {
      for (const nombre of ['whisper-cli.exe', 'whisper-cli', 'main.exe', 'main']) {
        const p = path.join(dirBin, nombre);
        if (fs.existsSync(p)) { cli = p; break; }
      }
      /* En orden de precisión: el q5_1 (181 MB) es el que se instala y se midió; los otros
         dos se aceptan porque una instalación anterior los dejó ahí y usar CUALQUIER modelo
         es mejor que quedarse sin dictado local. */
      for (const nombre of ['ggml-small-q5_1.bin', 'ggml-small.bin', 'ggml-base.bin']) {
        const p = path.join(dirModelos, nombre);
        if (fs.existsSync(p)) { modelo = p; modeloNombre = path.basename(nombre, '.bin'); break; }
      }
    } catch {}
    return estado();
  }

  /* WAV PCM16 mono: cabecera de 44 bytes + datos. */
  function wavDe(muestras) {
    const datos = Buffer.alloc(muestras.length * 2);
    for (let i = 0; i < muestras.length; i++) datos.writeInt16LE(Math.max(-32768, Math.min(32767, muestras[i])), i * 2);
    const cab = Buffer.alloc(44);
    cab.write('RIFF', 0); cab.writeUInt32LE(36 + datos.length, 4); cab.write('WAVE', 8);
    cab.write('fmt ', 12); cab.writeUInt32LE(16, 16); cab.writeUInt16LE(1, 20); cab.writeUInt16LE(1, 22);
    cab.writeUInt32LE(SAMPLERATE, 24); cab.writeUInt32LE(SAMPLERATE * 2, 28); cab.writeUInt16LE(2, 32); cab.writeUInt16LE(16, 34);
    cab.write('data', 36); cab.writeUInt32LE(datos.length, 40);
    return Buffer.concat([cab, datos]);
  }

  /* Transcribe un WAV ya escrito. El idioma fija el decoder.
  * SIN confianza real: este build del CLI no expone probabilidades por token
  * (el JSON de -oj trae segmentos sin tokens). La confianza llega null y el
  * panel marca la frase como normal. */
  function transcribir(wavPath, ms) {
    return new Promise((resolve) => {
      const idioma = (lang || 'es-ES').split('-')[0];
      const args = ['-m', modelo, '-l', idioma, '-nt', '-f', wavPath];
      let texto = '';
      let terminado = false;
      const p = spawnFn(cli, args, { windowsHide: true });
      proc = p;
      p.stdout.on('data', (d) => { texto += d.toString('utf8'); });
      p.stderr.on('data', () => {});
      const fin = (ok) => {
        if (terminado) return;
        terminado = true;
        proc = null;
        try { fs.unlinkSync(wavPath); } catch {}
        if (!ok) { emit({ type: 'error', text: 'Whisper falló al transcribir la frase.', fix: 'Revisa la carpeta voice-engine (binario y modelo).' }); }
        resolve({ texto, confianza: null });
      };
      /* Un modelo atascado no puede colgar la sesión: tope generoso de 30 s. */
      const tope = setTimeout(() => { try { p.kill(); } catch {}; fin(false); }, 30000);
      p.on('exit', () => { clearTimeout(tope); fin(true); });
      p.on('error', () => { clearTimeout(tope); fin(false); });
    });
  }

  /* Filtro de alucinación barato: Whisper con silencio suelta frases tipo «Thank
     you for watching». Aguas abajo esBasura() ya filtra; aquí se tumban las que ni
     siquiera parecen habla (menos de 2 letras o ninguna vocal). */
  const pareceHabla = (t) => {
    const s = String(t || '').trim();
    if (s.length < 2) return false;
    return /[aeiouáéíóúü]/i.test(s);
  };

  async function drenarCola() {
    if (proc || !cola.length) return;
    const { wavPath, ms } = cola.shift();
    const r = await transcribir(wavPath, ms);
    const limpio = String(r.texto || '').replace(/\s+/g, ' ').trim();
    if (pareceHabla(limpio)) {
      emit({ type: 'final', text: limpio, confidence: r.confianza, ms: Math.round(ms) });
    }
    drenarCola();
  }

  /* Mata la vista previa en curso y la marca como descartada: lo que devuelva ya no
     interesa (el texto definitivo está en camino). El contador de generación es lo que
     evita que un `exit` tardío pinte un parcial viejo ENCIMA del final ya emitido. */
  function matarPrevia() {
    previaGen++;
    const p = previaProc;
    const limpiar = previaLimpiar;
    previaProc = null;
    previaLimpiar = null;
    /* El tope y la limpieza se cancelan AQUÍ y no en el `exit` de un proceso al que se
       está matando: si el hijo muere sin emitir 'exit' (o tarda en hacerlo), el
       temporizador dejaría el proceso de la app vivo y el WAV temporal en el disco. */
    if (previaTope) { clearTimeout(previaTope); previaTope = null; }
    if (limpiar) { try { limpiar(); } catch {} }
    if (p) { try { p.kill(); } catch {} }
  }

  /* Vista previa en vivo del trozo que se está grabando (ver la cabecera del módulo).
     Barata y honesta a propósito: no pisa al final, no se solapa consigo misma, no habla
     antes de tener audio suficiente y no enseña alucinaciones de silencio. */
  function intentarPrevia() {
    if (!cli || !modelo || proc || previaProc || cola.length) return;
    if (trozo.length < PREVIA_MIN_MARCOS) return;
    if (Date.now() - ultimaPrevia < PREVIA_MS) return;
    ultimaPrevia = Date.now();
    if (!dirTmp) { try { dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sagi-whisper-')); } catch { return; } }
    const marcos = trozo.slice();   // copia: la grabación sigue y el trozo se vacía al cerrar
    const plano = new Int16Array(marcos.length * MARCO);
    marcos.forEach((m, i) => plano.set(m, i * MARCO));
    const wavPath = path.join(dirTmp, 'p-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.wav');
    try { fs.writeFileSync(wavPath, wavDe(plano)); } catch { return; }
    const gen = previaGen;
    let p;
    try {
      p = spawnFn(cli, ['-m', modelo, '-l', (lang || 'es-ES').split('-')[0], '-nt', '-f', wavPath], { windowsHide: true });
    } catch { try { fs.unlinkSync(wavPath); } catch {}; return; }
    previaProc = p;
    let texto = '';
    const limpiar = () => {
      if (previaProc === p) previaProc = null;
      if (previaTope) { clearTimeout(previaTope); previaTope = null; }
      if (previaLimpiar === limpiar) previaLimpiar = null;
      try { fs.unlinkSync(wavPath); } catch {}
    };
    previaLimpiar = limpiar;
    p.stdout.on('data', (d) => { texto += d.toString('utf8'); });
    p.stderr.on('data', () => {});
    p.on('error', () => limpiar());
    /* Una previa atascada no puede quedarse con el modelo cargado: tope y a la basura. */
    previaTope = setTimeout(() => { try { p.kill(); } catch {}; limpiar(); }, PREVIA_MAX_MS);
    p.on('exit', () => {
      limpiar();
      if (gen !== previaGen) return;   // descartada: el final ya salió
      if (!grabando) return;
      const limpio = String(texto || '').replace(/\s+/g, ' ').trim();
      if (!pareceHabla(limpio) || esBasura(limpio, 0).basura) return;
      emit({ type: 'partial', text: limpio });
    });
  }

  /* Cierra la frase en curso: WAV → cola → transcribir (sin pisar spawns). */
  function cerrarFrase() {
    matarPrevia();   // la frase cerrada manda: la previa ya no aporta
    if (!trozo.length) { grabando = false; return; }
    const marcos = trozo;
    const ms = marcos.length * 30;
    trozo = [];
    grabando = false;
    marcosVozSeguidos = 0;
    marcosSilencioSeguidos = 0;
    if (!cli || !modelo) return;
    if (!dirTmp) { try { dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sagi-whisper-')); } catch { return; } }
    const plano = new Int16Array(marcos.length * MARCO);
    marcos.forEach((m, i) => plano.set(m, i * MARCO));
    const wavPath = path.join(dirTmp, 'f-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.wav');
    try { fs.writeFileSync(wavPath, wavDe(plano)); } catch { return; }
    cola.push({ wavPath, ms });
    drenarCola();
  }

  /* PCM crudo del renderer (Buffer de Int16 mono 16 kHz). Es la ÚNICA entrada de audio. */
  function push(pcm) {
    if (!Buffer.isBuffer(pcm) || pcm.length === 0) return;
    buf = Buffer.concat([buf, pcm]);
    while (buf.length >= MARCO * 2) {
      const marco = new Int16Array(MARCO);
      for (let i = 0; i < MARCO; i++) marco[i] = buf.readInt16LE(i * 2);
      buf = buf.slice(MARCO * 2);
      const e = energia(marco);
      /* Suelo adaptativo: sólo con marcos bajos y hasta tener una calibración — la voz
         NO debe subir el suelo (con voz continua, el suelo la acabaría tragando). */
      if (!grabando && (!calibrado || e < suelo * 1.5)) {
        suelo = suelo * 0.98 + e * 0.02;
        if (!calibrado && suelo < SUELO_INICIAL * 1.05 && suelo > SUELO_INICIAL * 0.4) calibrado = true;
      }
      const esVoz = e > suelo * FACTOR_VOZ;
      if (!grabando) {
        /* Dos puertas de entrada: voz clara (3× suelo, 3 marcos) y habla tenue
           sostenida (1,6× suelo, 12 marcos) — con micros de ganancia baja la voz
           del usuario no llega al umbral fuerte y el motor jamás abría una frase.
           Una palmada no supera 360 ms seguidos: la puerta tenue no la abre. */
        const tibio = !esVoz && e > suelo * FACTOR_TI_BIO;
        if (esVoz || tibio) {
          marcosVozSeguidos++;
          preRodadura.push(marco);
          if (preRodadura.length > PRE_RODADURA) preRodadura.shift();
          if (marcosVozSeguidos >= DISPARO || (tibio && marcosVozSeguidos >= DISPARO_TI_BIO)) {
            grabando = true;
            trozo = preRodadura.slice();
            preRodadura = [];
            marcosSilencioSeguidos = 0;
            abiertaEn = Date.now();
          }
        } else {
          marcosVozSeguidos = 0;
          preRodadura = [];
        }
      } else {
        trozo.push(marco);
        if (esVoz || e > suelo * FACTOR_TI_BIO) { marcosSilencioSeguidos = 0; marcosVozSeguidos++; }
        else {
          marcosSilencioSeguidos++;
          marcosVozSeguidos = 0;
          if (marcosSilencioSeguidos >= COLA_SILENCIO) cerrarFrase();
        }
        if (trozo.length >= MAX_TROZO_MARCOS) cerrarFrase();
        else intentarPrevia();
      }
    }
  }

  async function start() {
    resolver();
    if (!cli || !modelo) {
      emit({ type: 'notice', text: 'Whisper no está instalado todavía (Ajustes › Dictado local). Mientras, se usa el motor de Windows.' });
      return;
    }
    emit({ type: 'state', state: 'escuchando' });
  }

  function stop() {
    try { if (proc) proc.kill(); } catch {}
    proc = null;
    matarPrevia();
    cola = [];
    buf = Buffer.alloc(0);
    grabando = false; trozo = []; preRodadura = [];
    marcosVozSeguidos = 0; marcosSilencioSeguidos = 0;
    return Promise.resolve();
  }

  const engine = {
    nombre: 'whisper',
    capacidades: { ...CAPACIDADES_BASE, partials: true, confidence: true, level: false, pcm: true },
    start, push, stop, estado,
    resolver,
  };
  assertEngine(engine);
  /* La disponibilidad se decide en el NACIMIENTO: quien elige motor pregunta por
     estado() ANTES de llamar a start() — resolver sólo en start() haría que la primera
     elección viera siempre «no instalado» y nunca se elegiría este motor. */
  resolver();
  return engine;
}

module.exports = { createWhisper };
