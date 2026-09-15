'use strict';

/* Dueño del estado del modo voz y punto ÚNICO de entrada de eventos.
 *
 * Vive en el proceso principal porque aquí están los motores; el estado que ve el
 * usuario lo pinta el renderer con los mismos eventos que salen de aquí (mismo
 * vocabulario: el contrato). No sabe nada de Electron: recibe `emit` y `onPhrase`.
 */
const { assertEvent } = require('./contract');
const { esBasura } = require('./junk');

/* Trocea para sintetizar: se corta en final de frase y en saltos de línea, y NADA MÁS.
   Una versión anterior fusionaba frases cortas («Hecho.» se pegaba a la siguiente), lo que
   rompe la síntesis por frases —que es justo lo que da la sensación de inmediatez— y
   contradecía el test de esta tarea. Lo cazó el reconocimiento previo del plan. */
function trocear(texto) {
  const limpio = String(texto || '').replace(/```[\s\S]*?```/g, ' (código) ').replace(/\s+/g, ' ').trim();
  if (!limpio) return [];
  return (limpio.match(/[^.!?…]+[.!?…]*/g) || [limpio]).map((f) => f.trim()).filter(Boolean);
}

function createVoiceManager({ emit, stt, tts, onPhrase = () => {}, settings = {} } = {}) {
  let estado = 'escuchando';
  let cola = [];
  let hablando = null;
  let seq = 0;
  let abierto = false;

  const pon = (e) => { assertEvent(e); emit(e); };
  const setEstado = (s) => { if (estado !== s) { estado = s; pon({ type: 'state', state: s }); } };

  async function open() {
    await stt.start();
    abierto = true;
    setEstado('escuchando');
  }

  async function close() {
    abierto = false;
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
    if (!frase || !abierto) { hablando = null; setEstado('escuchando'); return; }
    hablando = frase;
    setEstado('hablando');
    let r;
    try { r = await tts.sintetizar(frase, { lang: settings.voiceLang || 'es-ES', voice: settings.ttsVoice || '', rate: settings.ttsRate || 0 }); }
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
