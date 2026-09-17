'use strict';

/* Dueño del estado del modo voz y punto ÚNICO de entrada de eventos.
 *
 * Vive en el proceso principal porque aquí están los motores; el estado que ve el
 * usuario lo pinta el renderer con los mismos eventos que salen de aquí (mismo
 * vocabulario: el contrato). No sabe nada de Electron: recibe `emit` y `onPhrase`.
 */
const { assertEvent } = require('./contract');
const { esBasura } = require('./junk');
/* El troceado vive en protocolo.js, junto al del motor de dictado (mismo problema,
   una sola solución probada): la copia de aquí abajo partía los números decimales
   («versión 3.5» se leía como «versión tres» y «cinco») porque el punto de un decimal
   es indistinguible de un punto de frase. La versión compartida no parte un punto
   seguido de dígitos. */
const { trocear } = require('./protocolo');

/* `settings` es una FUNCIÓN, no el objeto de ajustes: `settings:set` reemplaza el objeto
   entero al guardar, así que guardarse una copia dejaría la voz, la velocidad y el idioma
   congelados en los que hubiera al crear el manager (y el manager nace también para leer el
   chat, antes de que el usuario toque Ajustes). Se lee en cada frase, que es cuando importa. */
/* Cola de eco: tiempo prudencial para descartar eco acústico residual justo tras el fin
   de una reproducción de TTS (evita que el micrófono capture el último milisegundo de los altavoces). */
const COLA_ECO_MS = 400;

function createVoiceManager({ emit, stt, tts, onPhrase = () => {}, settings = () => ({}) } = {}) {
  let estado = 'escuchando';
  let cola = [];
  let hablando = null;
  let seq = 0;
  let ultimoFin = 0;   // cuándo terminó de sonar la última frase (para la cola de eco)

  const pon = (e) => { assertEvent(e); emit(e); };
  const setEstado = (s) => { if (estado !== s) { estado = s; pon({ type: 'state', state: s }); } };

  async function open() {
    await stt.start();
    setEstado('escuchando');
  }

  /* Cierre del modo. `motores: false` SUELTA el manager sin tocar los procesos: es lo que
     pide la interrupción del chat (tts:reset), que sólo necesita reiniciar el contador de
     frases — cerrar aquí el motor de dictado dejaba el micrófono abierto con nadie escuchando
     (el renderer seguía con su getUserMedia) y el modo voz sordo hasta cerrarlo y reabrirlo.
     El cierre normal del modo voz sí apaga todo, como siempre. */
  async function close({ motores = true } = {}) {
    stopSpeaking();
    if (motores) {
      try { await stt.stop(); } catch {}
      try { tts.dispose && tts.dispose(); } catch {}
    }
  }

  /* Punto único: todo lo que ocurre en el modo voz entra por aquí. */
  function ingest(ev) {
    assertEvent(ev);
    if (ev.type === 'partial') {
      /* Mientras el asistente habla, un parcial sólo puede ser su propia voz entrando por el
         micrófono: el micrófono está abierto justo para poder interrumpirlo, así que el
         motor oye los altavoces. Se descarta como el eco del final —en vez de pintar
         «oyendo», que borraría la cara de «hablando» y el resaltado de la frase que está
         sonando—. Interrumpir de verdad sigue siendo cosa del nivel del micrófono en el
         panel, y en cuanto salta deja de haber «hablando». */
      if (estado === 'hablando') return;
      setEstado('oyendo'); emit(ev); return;
    }
    if (ev.type === 'final') {
      if (!ev.text || !ev.text.trim()) return;
      /* El asistente oyéndose a sí mismo: el micrófono está abierto justo mientras habla
         —es lo que permite interrumpirlo— y el motor de dictado no tiene cancelación de
         eco, así que lo que sale por los altavoces vuelve por el micro y se transcribe.
         Como la respuesta va troceada en frases, entre una y la siguiente hay silencio de
         sobra para que el motor cierre la frase que acaba de oír: sin este filtro el
         agente recibía sus propias palabras como una orden del usuario y se contestaba a
         sí mismo. Se tira en silencio y sin tocar el estado (el usuario no ha dicho nada).
         Interrumpir de verdad no pasa por aquí: la interrupción la decide el nivel del
         micrófono en el panel, y en cuanto suena deja de haber «hablando». */
      if (estado === 'hablando' || Date.now() - ultimoFin < COLA_ECO_MS) return;
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
    if (!r || !r.wav) {
      /* El motivo va en el aviso: «no he podido leer» sin más no dice si la voz falla
         siempre (voces sin instalar) o ha sido una frase puntual. */
      const motivo = r && r.error ? ' (' + r.error + ')' : '';
      pon({ type: 'notice', text: 'No he podido leer la respuesta en voz alta' + motivo + '.' });
      siguiente();
      return;
    }
    seq += 1;
    /* La voz usada viaja con la frase: el renderer enseña qué voz está sonando (natural
       o de escritorio) sin preguntar de nuevo al motor. */
    onPhrase({ id: seq, bytes: r.wav, voz: r.voz, natural: !!r.natural });   // el renderer lo reproduce y avisa con spoken(id)
  }

  function spoken(id) {
    if (id !== seq) return;                              // una frase vieja que ya no importa
    ultimoFin = Date.now();                              // desde aquí corre la cola de eco
    siguiente();
  }

  function stopSpeaking() {
    cola = [];
    hablando = null;
    ultimoFin = 0;
    if (estado === 'hablando') setEstado('escuchando');
  }

  /* Reset del contador de frases sin cerrar nada: lo llama la interrupción del usuario
     (barge-in). Una frase nueva recibirá id 1 de nuevo y el renderer la tocará al terminar;
     las frases viejas, de la secuencia anterior, se descartan solas en `spoken()`.
     Los motores NO se tocan: el dictado sigue oyendo y la síntesis sigue lista. */
  function reiniciar() {
    stopSpeaking();
    seq = 0;
  }

  /* Rescate del motor de escucha, pedido por el renderer: su detector (voz real del
     micrófono sin ningún texto) decide que el motor está sordo —arranca, declara que
     escucha, pero no recibe audio del dispositivo— y pide el cambio. Delega en el motor
     de escucha, que sabe rearman el guion con el motor clásico; un motor que no sabe
     (una mentira de prueba, una fase futura) no rompe nada. */
  async function rescatarMotor() {
    if (stt.motorAlternativo) await stt.motorAlternativo();
  }

  return { open, close, ingest, say, stopSpeaking, reiniciar, rescatarMotor, spoken, estado: () => estado };
}

module.exports = { createVoiceManager, trocear };