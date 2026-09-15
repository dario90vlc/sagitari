'use strict';

/* El panel del modo voz: dueño del estado que ve el usuario y punto ÚNICO de entrada
   del renderer. Habla el mismo vocabulario que el proceso principal (el contrato de
   main/voice/contract.js), así que el banco de pruebas puede inyectar voz sintética
   por handle() y probar todo esto sin micrófono.
 *
 * El nivel del orbe sale de DOS sitios, y es a propósito: mientras escucha, del
 * micrófono (que captura el renderer); mientras habla, del audio que está sonando. Así
 * el orbe siempre late con la voz que importa en ese momento.
 */
(function () {
  const ESTADOS = { escuchando: 'Escuchando', oyendo: 'Oyendo', pensando: 'Pensando', hablando: 'Hablando', confirmando: 'Esperando tu permiso', error: 'Atención' };
  let abierto = false;
  let estado = 'escuchando';
  let nivel = 0, objetivo = 0;
  let raf = 0, t0 = 0, prev = 0;
  let mic = null, ctxAudio = null, analizadorMic = null;
  let reproductor = null, analizadorSalida = null, fraseActual = null;
  let sueloRuido = 0.01, calibrado = false;
  let reducido = false;

  const $vm = (s) => document.querySelector(s);
  let ENVIAR = () => {};
  let HABLAR = () => {};

  function setEstado(s) {
    if (!ESTADOS[s] || estado === s) return;
    estado = s;
    const el = $vm('#vmEstado');
    if (el) el.textContent = ESTADOS[s];
    if (s === 'escuchando' || s === 'oyendo' || s === 'pensando' || s === 'error') {
      const c = $vm('#vmConfirm'); if (c) c.hidden = true;
    }
  }

  /* Punto único: todo lo que ocurre en el modo voz entra por aquí. */
  function handle(ev) {
    if (!ev || !ev.type) return;
    if (ev.type === 'state') { setEstado(ev.state); return; }
    if (ev.type === 'level') { objetivo = Math.max(0, Math.min(1, ev.value)); return; }
    if (ev.type === 'partial') {
      setEstado('oyendo');
      const p = $vm('#vmParcial'); if (p) p.textContent = ev.text;
      return;
    }
    if (ev.type === 'final') {
      const p = $vm('#vmParcial'); if (p) p.textContent = '';
      /* Antes de mandar nada al agente hay tres cosas que se atienden aquí:
         1) la respuesta a una confirmación pendiente («sí»/«no»);
         2) la orden de salir («adiós», «cierra»);
         3) lo demás, que sí es una petición. */
      if (responder(ev.text)) return;
      if (/^(adi[oó]s|hasta luego|cierra|para el modo voz)\b/i.test(String(ev.text).trim())) { cerrar(); return; }
      /* La confianza se muestra: con menos de 0,5 la frase queda marcada y se puede
         corregir pinchando en ella. El motor falla sobre todo en nombres propios. */
      escribir('Tú', ev.text, ev.confidence);
      setEstado('pensando');
      ENVIAR(ev.text);
      return;
    }
    /* Los avisos van a la franja; si el usuario ha pedido oírlos, el renderer los habla
       (aquí no se decide: el panel no conoce los ajustes). */
    if (ev.type === 'notice') { pista(ev.text); HABLAR(ev.text); return; }
    if (ev.type === 'error') { error(ev.text, ev.fix || ''); return; }
  }

  function escribir(quien, texto, confianza) {
    const h = $vm('#vmHistorial');
    if (!h) return;
    const fila = document.createElement('div');
    fila.className = 'vm-fila vm-' + (quien === 'Tú' ? 'tu' : 'sagitari');
    if (quien === 'Tú' && typeof confianza === 'number' && confianza < 0.5) fila.classList.add('vm-dudoso');
    const q = document.createElement('span'); q.className = 'vm-quien'; q.textContent = quien;
    const t = document.createElement('span'); t.className = 'vm-dice'; t.textContent = texto;
    if (quien === 'Tú') { t.title = 'Pincha para corregir; Enter reenvía'; t.onclick = () => editar(t, texto); }
    fila.appendChild(q); fila.appendChild(t);
    h.appendChild(fila);
    /* Quien desborda y tiene el `overflow: auto` es la caja de texto, no la lista:
       desplazar la lista no movía nada y la frase recién dictada quedaba fuera de la vista. */
    const caja = h.closest('.vm-texto') || h;
    caja.scrollTop = caja.scrollHeight;
  }

  /* Corregir lo dictado: se pincha la frase, se arregla y Enter la reenvía por el MISMO
     camino (es la red de seguridad frente a un nombre propio mal oído). */
  let edicion = null;   // { campo, nodo, original } mientras hay una corrección en curso
  function editar(nodo, original) {
    const campo = document.createElement('input');
    campo.className = 'vm-editar'; campo.type = 'text'; campo.value = original;
    nodo.replaceWith(campo);
    campo.focus(); campo.select();
    edicion = { campo, nodo, original };
    campo.onkeydown = (e) => {
      if (e.key === 'Enter') {
        const nuevo = campo.value.trim();
        edicion = null;
        nodo.textContent = nuevo || original;
        campo.replaceWith(nodo);
        if (nuevo && nuevo !== original) { setEstado('pensando'); ENVIAR(nuevo); }
      } else if (e.key === 'Escape') {
        /* Normalmente ya lo ha cancelado alTeclado (va en captura, antes que esto); se
           repite aquí para que la edición siga siendo cancelable sin el panel montado. */
        cancelarEdicion();
      }
    };
    /* Si el foco se va a otro sitio, la corrección se abandona: dejar el campo vivo sin
       foco haría que el siguiente Esc cancelase una edición que el usuario ya no ve. */
    campo.onblur = () => { if (edicion && edicion.campo === campo) cancelarEdicion(); };
  }
  function cancelarEdicion() {
    if (!edicion) return;
    const { campo, nodo, original } = edicion;
    edicion = null;
    nodo.textContent = original;
    if (campo.parentNode) campo.replaceWith(nodo);
  }

  function pista(texto) { const p = $vm('#vmPista'); if (p) p.textContent = texto; }
  function error(texto, fix) {
    setEstado('error');
    const caja = $vm('#vmError'); if (!caja) return;
    caja.hidden = false;
    $vm('#vmErrorTexto').textContent = texto;
    $vm('#vmErrorFix').textContent = fix || '';
  }
  /* Apaga el aviso de error. Se llama al abrir: si el permiso de micrófono se denegó, al
     cerrar y volver a abrir seguía a la vista el aviso de la sesión anterior. */
  function olvidarError() {
    const caja = $vm('#vmError'); if (caja) caja.hidden = true;
    const t = $vm('#vmErrorTexto'); if (t) t.textContent = '';
    const f = $vm('#vmErrorFix'); if (f) f.textContent = '';
  }

  function pasos(lista) {
    const c = $vm('#vmPasos');
    if (!c) return;
    c.innerHTML = '';
    for (const p of lista || []) {
      const d = document.createElement('div');
      d.className = 'vm-paso';
      d.textContent = (p.ok === false ? '✗ ' : '▸ ') + (p.label || '');
      c.appendChild(d);
    }
  }

  /* Confirmación (permiso de una herramienta): se contesta con el ratón o diciendo
     «sí»/«no», que llega como un `final` normal y se reconoce aquí. Las dos formas de
     contestar acaban en el MISMO sitio (contestar), para que no haya dos maneras distintas
     de resolver el permiso. */
  let confirmacion = null;
  function pedirConfirmacion({ texto, si, no }) {
    setEstado('confirmando');
    confirmacion = { si, no };
    const caja = $vm('#vmConfirm'); if (!caja) return;
    $vm('#vmConfirmTexto').textContent = texto;
    caja.hidden = false;
  }
  /* Cierra la confirmación y ejecuta la decisión elegida. */
  function contestar(cual) {
    const fn = confirmacion && confirmacion[cual];
    confirmacion = null;
    const caja = $vm('#vmConfirm'); if (caja) caja.hidden = true;
    setEstado('pensando');
    if (fn) fn();
  }
  function responder(texto) {
    if (!confirmacion) return false;
    const t = String(texto || '').toLowerCase().trim();
    /* La frontera NO puede ser `\b`: en JavaScript la «í» no cuenta como carácter de
       palabra, así que «sí» —la respuesta natural— no hacía frontera y se colaba al
       agente como si fuera una petición. Se exige final o un carácter que no sea letra,
       número ni guion bajo detrás, con `u` para que el acento se trate como letra. */
    const si = /^(s[ií]|vale|hazlo|adelante|confirma|de acuerdo|ok)(?=$|[^\p{L}\p{N}_])/u.test(t);
    const no = /^(no|cancela|para|detente|mejor no)(?=$|[^\p{L}\p{N}_])/u.test(t);
    if (!si && !no) return false;
    contestar(si ? 'si' : 'no');
    return true;
  }
  /* Los botones de la confirmación hacen lo mismo que decir «sí» o «no»: llaman a su
     callback, esconden la caja y el estado pasa a `pensando`. Sin confirmación pendiente
     no hacen nada (la caja no está a la vista, así que no hay nada que contestar). */
  function cablearConfirmacion() {
    const bSi = $vm('#vmSi'), bNo = $vm('#vmNo');
    if (bSi) bSi.onclick = () => { if (confirmacion) contestar('si'); };
    if (bNo) bNo.onclick = () => { if (confirmacion) contestar('no'); };
  }

  /* Cada apertura lleva su número. Con el flag `abierto` no basta: si se cierra y se vuelve
     a abrir mientras la primera espera sigue viva, `abierto` vuelve a ser `true` y esa
     apertura abandonada ya no vería el cierre —seguiría adelante y dejaría un micrófono y
     un bucle huérfanos que nadie puede parar—. */
  let apertura = 0;
  const vigente = (gen) => abierto && gen === apertura;

  async function abrir() {
    if (abierto) return;
    abierto = true;
    const gen = ++apertura;
    reducido = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const panel = $vm('#voiceMode');
    if (panel) panel.hidden = false;
    olvidarError();
    setEstado('escuchando');
    document.addEventListener('keydown', alTeclado, true);
    const r = await window.sagitari.voiceOpen().catch(() => null);
    /* El usuario puede haber pulsado Esc (o haber cerrado y reabierto) mientras esto se
       abría. Entonces ya no hay nada que abrir: seguir hasta el final adquiriría un
       micrófono y un bucle de dibujo para un modo cerrado, así que se abandona aquí. */
    if (!vigente(gen)) return;
    if (!r || !r.ok) { error('No he podido abrir el modo voz.', 'Cierra y vuelve a abrirlo; si sigue, revisa Ajustes › Voz.'); }
    let rec = null;
    try { rec = await pedirMicro(); } catch (e) { rec = null; }
    /* Mismo caso, ahora con el micrófono ya pedido: si mientras se concedía el permiso se
       cerró (o se cerró y se reabrió), esto ya no es la apertura vigente. Se deja el audio
       como lo dejaría un cierre —primero se para la reproducción, que comparte el
       `AudioContext`, para no cortarle la frase a nadie sin avisar— y se suelta lo que se
       acaba de adquirir: sólo eso, porque el micrófono bueno puede ser el de la apertura
       nueva y pisárselo la dejaría sin micro. */
    if (!vigente(gen)) { await pararAudio(); soltar(rec); return; }
    if (!rec) { error('No tengo acceso al micrófono.', 'Revisa el permiso en ms-settings:privacy-microphone y vuelve a abrir el modo voz.'); }
    else {
      mic = rec.stream; ctxAudio = rec.ctx; analizadorMic = rec.analizador;
      sueloRuido = 0.01;
    }
    arrancarBucle();
  }

  /* Suelta un micrófono concreto (el de una apertura que se abandonó) sin tocar los
     compartidos: cerrar a ciegas los de la sesión viva la dejaría sin micro y sin audio. */
  function soltar(rec) {
    if (!rec) return;
    if (rec.stream) { try { rec.stream.getTracks().forEach((t) => t.stop()); } catch {} }
    if (rec.ctx && rec.ctx.state !== 'closed') { try { rec.ctx.close(); } catch {} }
  }

  /* Suelta el micrófono y el AudioContext de la sesión. */
  function soltarMicro() {
    soltar({ stream: mic, ctx: ctxAudio });
    mic = null; ctxAudio = null; analizadorMic = null;
  }

  async function cerrar() {
    if (!abierto) return;
    abierto = false;
    pararBucle();
    document.removeEventListener('keydown', alTeclado, true);
    cancelarEdicion();
    await pararAudio();
    soltarMicro();
    const panel = $vm('#voiceMode');
    if (panel) panel.hidden = true;
    try { await window.sagitari.voiceClose(); } catch {}
  }

  /* Esc sale del modo… salvo que haya una corrección en curso: ahí Esc cancela la
     corrección. El listener va en captura (antes que el del campo), así que es aquí donde
     se decide, o el campo nunca llegaría a ver su propio Escape. */
  function alTeclado(e) {
    if (e.key !== 'Escape' || !abierto) return;
    e.preventDefault();
    if (edicion) { cancelarEdicion(); return; }
    cerrar();
  }

  /* Micrófono del renderer: es la fuente del nivel del orbe y de la calibración de ruido.
     Devuelve lo adquirido SIN tocar el estado compartido: quien llama comprueba que su
     apertura sigue siendo la vigente antes de quedárselo. Si lo dejara ya puesto, una
     apertura abandonada tardía pisaría el micrófono bueno y nadie soltaría el suyo. */
  async function pedirMicro() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    let ctx = null;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const analizador = ctx.createAnalyser();
      analizador.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analizador);
      return { stream, ctx, analizador };
    } catch (e) {
      /* Si falla DESPUÉS de que el micrófono se conceda —por ejemplo al topar con el límite
         de `AudioContext` del navegador— las pistas se quedan capturando y aquí ya no hay
         estado compartido del que fiarse para pararlas, así que se sueltan estas. */
      soltar({ stream, ctx });
      throw e;
    }
  }

  function rms(analizador) {
    if (!analizador) return 0;
    const buf = new Uint8Array(analizador.fftSize);
    analizador.getByteTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; }
    return Math.sqrt(s / buf.length);
  }

  /* Audio de la respuesta: bytes del proceso principal → WebAudio. Va por WebAudio y no
     por un <audio src> a propósito: se decodifica en memoria (sin CSP de por medio) y se
     puede cortar en el acto, además de dar el nivel del orbe. */
  async function reproducir({ id, bytes }) {
    let mio = false;   // ¿la fuente que se está montando es la de ESTA llamada?
    try {
      if (!ctxAudio) ctxAudio = new (window.AudioContext || window.webkitAudioContext)();
      const datos = (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).buffer;
      const audio = await ctxAudio.decodeAudioData(datos.slice(0));
      await pararAudio();
      reproductor = ctxAudio.createBufferSource();
      mio = true;
      reproductor.buffer = audio;
      analizadorSalida = ctxAudio.createAnalyser();
      analizadorSalida.fftSize = 1024;
      reproductor.connect(analizadorSalida);
      analizadorSalida.connect(ctxAudio.destination);
      fraseActual = id;
      setEstado('hablando');
      reproductor.onended = () => {
        if (fraseActual !== id) return;
        fraseActual = null;
        window.sagitari.ttsPlayed(id);
      };
      reproductor.start();
    } catch (e) {
      pista('No he podido reproducir la voz.');
      /* La frase no va a sonar, así que se avisa SIEMPRE —también cuando el fallo ocurre
         ANTES de asignarla (unos bytes que `decodeAudioData` rechaza): sin ese aviso el
         proceso principal se queda esperando una frase que nunca termina y la cola de voz
         no avanza nunca. */
      if (mio) {
        /* Sólo se desmonta lo que montó esta llamada: si el que falla es el `decode`, la
           fuente que suena es todavía la de la frase anterior y cortarla en silencio
           dejaría a esa frase sin su aviso de «ya sonó». */
        try { reproductor.onended = null; reproductor.stop(); } catch {}
        reproductor = null; analizadorSalida = null;
      }
      if (fraseActual === id) fraseActual = null;
      window.sagitari.ttsPlayed(id);
    }
  }

  async function pararAudio() {
    if (reproductor) {
      const id = fraseActual;
      try { reproductor.onended = null; reproductor.stop(); } catch {}
      reproductor = null; analizadorSalida = null;
      /* Cortar de verdad: la frase que sonaba ya no va a terminar, así que se le dice al
         proceso principal que la dé por dicha para que no se quede esperando. */
      if (id !== null) window.sagitari.ttsPlayed(id);
      fraseActual = null;
    }
  }

  function arrancarBucle() {
    const c = $vm('#vmOrbe');
    if (!c || !window.OrbKit) return;
    const ctx = c.getContext('2d');
    t0 = performance.now(); prev = t0;
    const paso = (now) => {
      const t = (now - t0) / 1000;
      const dt = Math.min(0.05, (now - prev) / 1000); prev = now;
      /* El nivel que se pinta: el del audio que suena si estamos hablando, el del
         micrófono si estamos escuchando u oyendo. */
      const fuente = estado === 'hablando' ? rms(analizadorSalida) : rms(analizadorMic);
      if (fuente > 0 && !calibrado) { sueloRuido = sueloRuido * 0.9 + fuente * 0.1; }
      const objetivoReal = Math.max(objetivo, fuente * 2.2);
      nivel = window.OrbKit.smoothLevel(nivel, reducido ? window.OrbKit.nivelDeFondo(estado, t) : Math.max(objetivoReal, window.OrbKit.nivelDeFondo(estado, t)), dt);
      window.OrbKit.draw(ctx, c.width, c.height, nivel, estado, t);
      if (estado === 'hablando') vigilarInterrupcion(fuente, now);
      raf = requestAnimationFrame(paso);
    };
    raf = requestAnimationFrame(paso);
  }
  function pararBucle() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  /* Interrupción (barge-in): si hablas mientras el asistente habla, se calla. Se exige
     voz sostenida (250 ms) para que un golpe de ruido no corte una respuesta. */
  let vozDesde = 0;
  function vigilarInterrupcion(fuente, now) {
    const umbral = Math.max(0.02, sueloRuido * 3.5);
    if (fuente > umbral) {
      if (!vozDesde) vozDesde = now;
      if (now - vozDesde > 250) { vozDesde = 0; interrumpir(); }
    } else vozDesde = 0;
  }
  async function interrumpir() {
    await pararAudio();
    window.sagitari.ttsStop();
    setEstado('oyendo');
  }

  /* La respuesta del agente, en TEXTO. El panel es opaco y tapa el chat, así que mientras
     el modo está abierto lo único que se puede leer es esto: sin esta fila la respuesta
     sólo se oiría. La llama el renderer cuando llega la respuesta del agente (es el enganche
     que usará la tarea 9); aquí no se habla con el agente. */
  function respuesta(texto) {
    if (!texto) return;
    escribir('Sagitari', texto);
  }

  cablearConfirmacion();

  window.VoiceMode = {
    abrir, cerrar, handle, pasos, respuesta, pedirConfirmacion, responder,
    estado: () => estado, abierto: () => abierto,
    audio: { reproducir, parar: pararAudio },
    setEnviar: (fn) => { ENVIAR = fn; },
    setHablar: (fn) => { HABLAR = fn; },
  };
})();
