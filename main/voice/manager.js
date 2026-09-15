'use strict';

/* Dueño del estado del modo voz y punto ÚNICO de entrada de eventos.
 *
 * Vive en el proceso principal porque aquí están los motores; el estado que ve el
 * usuario lo pinta el renderer con los mismos eventos que salen de aquí (mismo
 * vocabulario: el contrato). No sabe nada de Electron: recibe `emit` y `onPhrase`.
 */
const { assertEvent } = require('./contract');
const { esBasura } = require('./junk');

/* Trocea para sintetizar. Primero por saltos de línea —una respuesta con lista se lee mucho
   mejor frase a frase que como un párrafo corrido— y luego por final de frase. NO se fusionan
   frases cortas: una versión anterior lo hacía y contradecía el test de la tarea. Se colapsan
   los espacios DESPUÉS de partir por líneas, que si no el colapso se come los saltos. */
function trocear(texto) {
  const limpio = String(texto || '').replace(/```[\s\S]*?```/g, ' (código) ').trim();
  if (!limpio) return [];
  const out = [];
  for (const linea of limpio.split(/\r?\n/)) {
    const l = linea.replace(/\s+/g, ' ').trim();
    if (!l) continue;
    for (const f of l.match(/[^.!?…]+[.!?…]*/g) || [l]) {
      const t = f.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/* `settings` es una FUNCIÓN, no el objeto de ajustes: `settings:set` reemplaza el objeto
   entero al guardar, así que guardarse una copia dejaría la voz, la velocidad y el idioma
   congelados en los que hubiera al crear el manager (y el manager nace también para leer el
   chat, antes de que el usuario toque Ajustes). Se lee en cada frase, que es cuando importa. */
function createVoiceManager({ emit, stt, tts, onPhrase = () => {}, settings = () => ({}) } = {}) {
  let estado = 'escuchando';
  let cola = [];
  let hablando = null;
  let seq = 0;

  const pon = (e) => { assertEvent(e); emit(e); };
  const setEstado = (s) => { if (estado !== s) { estado = s; pon({ type: 'state', state: s }); } };

  async function open() {
    await stt.start();
    setEstado('escuchando');
  }

  async function close() {
    stopSpeaking();
    try { await stt.stop(); } catch {}
    try { tts.dispose && tts.dispose(); } catch {}
  }

  /* Punto único: todo lo que ocurre en el modo voz entra por aquí. */
  function ingest(ev) {
    assertEvent(ev);
    if (ev.type === 'partial') { setEstado('oyendo'); emit(ev); return; }
    if (ev.type === 'final') {
      if (!ev.text || !ev.text.trim()) return;
      const j = esBasura(ev.text, ev.ms || 0);
      /* La basura NO toca el estado: es ruido que se inventa el motor, no algo que haya
         dicho el usuario. Pisarlo devolvería el orbe a «escuchando» mientras el agente
         sigue trabajando (o borraría el «oyendo» de la frase buena anterior), y el test de
         esta tarea exige «oyendo» tras un final limpio seguido de uno basura. Lo cazó la
         ejecución del brief; mismo caso que el ruling de la fusión de frases. */
      if (j.basura) { pon({ type: 'notice', text: 'No te he entendido (' + j.motivo + ').' }); return; }
      setEstado('oyendo');
      emit(ev);
      return;
    }
    emit(ev);
  }

  function say(texto) {
    const frases = trocear(texto);
    if (!frases.length) return;
    cola = cola.concat(frases);
    if (!hablando) siguiente();
  }

  async function siguiente() {
    const frase = cola.shift();
    /* Hablar no depende del micrófono: la cola de frases y su síntesis van aparte del modo
       voz (la lectura del chat entra por aquí con el modo cerrado). Si se exigiera «abierto»,
       `say()` encolaría frases que nadie sonaría nunca. */
    if (!frase) { hablando = null; setEstado('escuchando'); return; }
    hablando = frase;
    setEstado('hablando');
    const aj = settings() || {};
    let r;
    try { r = await tts.sintetizar(frase, { lang: aj.voiceLang || 'es-ES', voice: aj.ttsVoice || '', rate: aj.ttsRate || 0 }); }
    catch (e) { r = { wav: null, error: e.message }; }
    if (hablando !== frase) return;                      // la interrumpieron mientras sintetizaba
    if (!r || !r.wav) { pon({ type: 'notice', text: 'No he podido leer la respuesta en voz alta.' }); siguiente(); return; }
    seq += 1;
    onPhrase({ id: seq, bytes: r.wav, voz: r.voz });     // el renderer lo reproduce y avisa con spoken(id)
  }

  function spoken(id) {
    if (id !== seq) return;                              // una frase vieja que ya no importa
    siguiente();
  }

  function stopSpeaking() {
    cola = [];
    hablando = null;
    if (estado === 'hablando') setEstado('escuchando');
  }

  return { open, close, ingest, say, stopSpeaking, spoken, estado: () => estado };
}

module.exports = { createVoiceManager, trocear };
