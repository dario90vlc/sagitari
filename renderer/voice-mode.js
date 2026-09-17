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
  /* Suelo de ruido de la sala y cuánto se ha medido ya. Se mide SOLO del micrófono y
     SOLO mientras el asistente no habla, y se congela: antes se adaptaba sin fin y
     con la fuente que estuviera sonando, así que la propia voz del asistente lo iba
     subiendo y el umbral de interrupción se iba con él hasta no dispararse nunca. */
  let sueloRuido = 0.01, mediciones = 0;
  let reducido = false;
  /* La calibración dura ~1,5 s (90 fotogramas a 60 Hz): suficiente para medir el
     ambiente y corta para que el orbe no tarde en reaccionar. */
  const MEDICIONES_SUELO = 90;
  /* Un ambiente más ruidoso que esto no debe seguir subiendo el umbral: si no, en una
     sala con aire acondicionado el umbral se come la voz del usuario. */
  const SUELO_MAX = 0.05;
  /* Porción del nivel que está sonando por debajo de la cual el micrófono solo está
     recogiendo el eco de los altavoces, no una voz que se superpone (ver
     `vigilarInterrupcion`). */
  const ECO = 0.6;
  /* Confirmación en curso ({ si, no }) o null. Se declara aquí arriba y no junto a
     `pedirConfirmacion` porque `setEstado` (que respeta una confirmación viva) la consulta
     y vive antes en el fichero. */
  let confirmacion = null;

  const $vm = (s) => document.querySelector(s);
  let ENVIAR = () => {};
  let HABLAR = () => {};
  /* Parar el turno en curso y saber si lo hay: los pone la app (es ella la que conoce el
     estado del agente). Con el panel abierto el chat está tapado, así que el botón de
     Detener del compositor queda detrás: esta es la ÚNICA puerta para parar. */
  let PARAR = () => {};
  let HAY_TRABAJO = () => false;
  /* Interrupción del usuario (barge-in): la app deja de leer el resto de la respuesta. */
  let AL_INTERRUMPIR = () => {};

  function setEstado(s) {
    if (!ESTADOS[s] || estado === s) return;
    estado = s;
    const el = $vm('#vmEstado');
    if (el) el.textContent = ESTADOS[s];
    /* Los estados que no son «confirmando» esconden la caja …salvo que haya una
       confirmación VIVA pendiente. Con el panel abierto la caja es la única puerta con
       ratón para contestar el permiso, y el motor de voz cambia de estado a cada frase
       oída —«oyendo»— con el permiso todavía en el aire: esconderla ahí dejaba al usuario
       sin nada que pulsar (y el turno esperando). Cuando la confirmación se contesta o se
       olvida, `confirmacion` queda a null y el siguiente cambio de estado la esconde. */
    if (!confirmacion && (s === 'escuchando' || s === 'oyendo' || s === 'pensando' || s === 'error')) {
      const c = $vm('#vmConfirm'); if (c) c.hidden = true;
    }
    /* El botón de parar sólo tiene sentido mientras hay algo que parar: pensando (el agente
       trabaja) o hablando (está leyendo). En los demás estados no hay nada que detener y un
       botón inerte invita a pulsarlo sin que pase nada. */
    const parar = $vm('#vmParar');
    if (parar) parar.hidden = !(s === 'pensando' || s === 'hablando');
  }

  /* Punto único: todo lo que ocurre en el modo voz entra por aquí. */
  function handle(ev) {
    if (!ev || !ev.type) return;
    if (ev.type === 'state') { setEstado(ev.state); return; }
    if (ev.type === 'level') { objetivo = Math.max(0, Math.min(1, ev.value)); return; }
    if (ev.type === 'partial') {
      textoVisto = true;   // para el vigía: texto del motor = no está sordo
      setEstado('oyendo');
      const p = $vm('#vmParcial'); if (p) p.textContent = ev.text;
      return;
    }
    if (ev.type === 'final') {
      textoVisto = true;   // para el vigía: el motor oyó algo de verdad
      const p = $vm('#vmParcial'); if (p) p.textContent = '';
      /* Antes de mandar nada al agente hay tres cosas que se atienden aquí:
         1) la respuesta a una confirmación pendiente («sí»/«no»);
         2) la orden de salir («adiós», «cierra»);
         3) lo demás, que sí es una petición. */
      if (responder(ev.text)) return;
      /* Parar lo que está haciendo: con el agente trabajando, «para»/«detente»/«cancela» es
         una orden sobre el TURNO EN CURSO, no una petición nueva. Va DESPUÉS de
         `responder`: con un permiso pendiente, «para» significa denegarlo (que es lo que el
         usuario quiere), no abortar el turno entero. */
      if (HAY_TRABAJO() && /^(para|p[aá]rate|detente|det[eé]n|cancela|aborta|basta|olv[ií]dalo)\b/i.test(String(ev.text).trim())) {
        escribir('Tú', ev.text, ev.confidence);
        escribir('Sagitari', 'Vale, lo dejo.');
        pista('Deteniendo lo que estaba haciendo…');
        setEstado('pensando');
        PARAR();
        return;
      }
      /* Sólo se cierra con frases QUE HABLAN del modo («cierra el modo voz»): un «cierra
         la ventana» o un «cierra el navegador» es una ORDEN para el agente y tenía que
         llegarle — el prefijo suelto «cierra» se comía todas esas peticiones y el usuario
         veía cómo su dictado apagaba el panel en vez de hacer el trabajo. */
      if (/^(adi[oó]s|hasta luego|salir|cierra|cerrar|para|apaga)\s+(el\s+|la\s+)?(modo\s+)?(voz|dictado)\b/i.test(String(ev.text).trim())
        || /^(adi[oó]s|hasta luego|salir)\b/i.test(String(ev.text).trim())) { cerrar(); return; }
      /* La confianza se muestra: con menos de 0,5 la frase queda marcada y se puede
         corregir pinchando en ella. El motor falla sobre todo en nombres propios. */
      escribir('Tú', ev.text, ev.confidence);
      setEstado('pensando');
      ENVIAR(ev.text);
      return;
    }
    /* Los avisos van a la franja; si el usuario ha pedido oírlos, el renderer los habla
       (aquí no se decide: el panel no conoce los ajustes). */
    if (ev.type === 'notice') {
      /* La basura («No te he entendido…») prueba que el motor SÍ oyó audio: para el
         vigía cuenta como texto visto. Los HINT del guion no (los suelta un motor sordo). */
      if (/no te he entendido/i.test(ev.text)) textoVisto = true;
      pista(ev.text); HABLAR(ev.text); return;
    }
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
  /* Esconde la confirmación sin contestarla: la llama la app cuando el permiso ya se ha
     resuelto por la otra puerta (la barra del chat, que el panel tapa) o cuando el turno
     se acabó. Sin esto la caja seguiría a la vista con sus botones armados, y pulsarlos
     contestaría —con una decisión que el usuario no tomó para ella— la confirmación
     siguiente de la cola. */
  function olvidarConfirmacion() {
    if (!confirmacion) return;
    confirmacion = null;
    const caja = $vm('#vmConfirm'); if (caja) caja.hidden = true;
    setEstado('pensando');
  }
  function responder(texto) {
    if (!confirmacion) return false;
    const t = String(texto || '').toLowerCase().trim();
    /* Reconocimiento natural y robusto de confirmación («sí»/«no») en español:
       acepta variantes coloquiales y compuestas («sí por favor», «claro», «adelante», «cancela», etc.) */
    const si = /^(s[ií]|vale|hazlo|adelante|confirma|de acuerdo|ok|correcto|claro|por supuesto|acepto|dale|ejecuta|procede|afirmativo|seguro)(?=$|[^\p{L}\p{N}_])/u.test(t);
    const no = /^(no|cancela|para|detente|mejor no|rechaza|deniega|alto|espera|ni de coña|no gracias|no lo hagas|negativo)(?=$|[^\p{L}\p{N}_])/u.test(t);
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
  /* Botón de parar del panel: la misma orden que decir «para» (y la misma que el botón
     Detener del chat, que el panel tapa). */
  function cablearParar() {
    const b = $vm('#vmParar');
    if (b) b.onclick = () => { pista('Deteniendo lo que estaba haciendo…'); PARAR(); };
  }

  /* ---- Vigía del motor sordo ----
     El motor de dictado oye SIEMPRE el micrófono predeterminado de Windows, pero en
     algunas máquinas (NVIDIA Broadcast y similares) el camino de audio moderno que usa
     su motor WinRT no recibe nada: el motor arranca, declara que escucha… y no
     transcribe jamás. El renderer es el ÚNICO que sabe que hay voz real —su getUserMedia
     sí oye el micro, por eso el orbe late—, así que él detecta la paradoja y pide el
     rescate: rearma el motor con el clásico, que usa otro camino de audio y sí oye.
     La señal: voz NETA sobre el suelo del ruido, sostenida, sin que NINGÚN texto haya
     entrado del motor en toda la sesión (ni parciales ni finales ni basura — «No te he
     entendido» prueba que oyó audio). Ni barge-in (sólo se vigila mientras nadie
     habla) ni gracia al abrir: nadie habla en los primeros segundos por arte de magia. */
  const PRIMERA_FRASE_MS = 8000;    // margen de gracia tras abrir la sesión
  const MODO_CALMA_MS = 1500;       // voz sostenida mínima para juzgar (una palmada no)
  const VOZ_MAX_SIN_TEXTO = 45000;  // voz sostenida y NADA de texto: aviso humano
  let textoVisto = false;           // ¿llegó ya algún texto (parcial/final) del motor?
  let vozCalmaDesde = 0;            // acumulador de voz sostenida sobre el suelo
  let rescateHecho = false;         // el rescate se pide UNA vez por sesión
  let vozDeCada = 0;                // ms acumulados de voz sin ni un solo texto
  let vigia = 0;                    // id del intervalo de vigilancia
  let tAbierto = 0;                 // cuándo arrancó la sesión (para la gracia inicial)

  function vigilancia(ahora, nivelMicro) {
    if (ahora === undefined) ahora = Date.now();
    if (nivelMicro === undefined) nivelMicro = rms(analizadorMic);
    /* Mientras el asistente habla el micro recoge su propia voz: eso es barge-in, no
       prueba de sordera — fuera del alcance del vigía. */
    if (!abierto || !mic || estado === 'hablando') { vozCalmaDesde = 0; return; }
    if (ahora - tAbierto < PRIMERA_FRASE_MS) return;            // gracia al abrir
    if (textoVisto) { vozCalmaDesde = 0; vozDeCada = 0; return; } // hay texto: no está sordo
    const umbral = Math.max(0.02, sueloRuido * 3.5);
    if (!(nivelMicro > umbral)) { vozCalmaDesde = 0; return; }   // silencio: no se juzga
    if (!vozCalmaDesde) { vozCalmaDesde = ahora; return; }
    if (ahora - vozCalmaDesde < MODO_CALMA_MS) return;
    vozCalmaDesde = ahora;                    // recalibra: cada tramo sostenido cuenta una vez
    if (!rescateHecho) {
      rescateHecho = true;
      /* El dictado local (whisper) se alimenta del tap del RENDERER: si hay voz y el
         proceso principal no ve ni audio ni frase en marcha, el tap está muerto — se
         reabre (era la 2.ª causa de «orbe se mueve y no transcribe»). Los motores de
         Windows capturan por su cuenta: para ellos el rescate sigue siendo el clásico. */
      if (typeof window.__reabrirTap === 'function' && window.__tapEstado && !window.__tapEstado()) {
        pista('Reconectando el micrófono del dictado…');
        window.__reabrirTap().catch(() => {});
        return;
      }
      pista('Te oigo pero el motor no transcribe: cambio al motor clásico…');
      window.sagitari.voiceRescue().catch(() => {});
      return;
    }
    /* La sesión sigue sorda tras el rescate: se deja la preferencia ENCENDIDA para la
       siguiente (Ajustes › Personal › «Motor de escucha clásico») — este equipo arranca
       mejor con el clásico. La sesión actual ya va en clásico por el rescate; esto es
       para que la PRÓXIMA no repita el tramo sordo. */
    if (!window.__vigiaClasicoAvisado) {
      window.__vigiaClasicoAvisado = true;
      try { window.sagitari.setSettings({ sttClasico: true }); } catch {}
      const sw = document.querySelector('#swSttClasico');
      if (sw) sw.classList.add('on');
    }
    vozDeCada += MODO_CALMA_MS;
    if (vozDeCada >= VOZ_MAX_SIN_TEXTO) {
      vozDeCada = 0;
      error('Sigo oyendo tu voz pero el motor de voz no transcribe nada.',
        'Pon tu micrófono real como predeterminado en ms-settings:sound (si usas NVIDIA Broadcast u otro filtro, ese es el problema) y vuelve a abrir el modo voz.');
    }
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
    if (!r || !r.ok) {
      error('No he podido abrir el modo voz.', 'Cierra y vuelve a abrirlo; si sigue, revisa Ajustes › Voz.');
      /* Si el proceso principal no pudo arrancar sus motores, ABRIR el micrófono y el
         bucle del orbe era comprar micro para una tienda cerrada: el panel quedaba
         «Escuchando» para siempre y el micro del usuario capturando en vano. Se cierra
         el panel y se limpia, como haría un cierre. */
      pararBucle();
      document.removeEventListener('keydown', alTeclado, true);
      abierto = false;
      if (panel) panel.hidden = true;
      return;
    }
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
      sueloRuido = 0.01; mediciones = 0;
    }
    arrancarBucle();
    /* Hook simétrico al de cierre: la app engancha aquí sus recursos de sesión (el tap
       de micrófono del dictado local). Un único dueño del ciclo de vida — el panel —
       evita dos micros abiertos por dobles llamadas desde fuera. */
    if (typeof window.__alAbrirModoVoz === 'function') { try { window.__alAbrirModoVoz(); } catch {} }
    /* El vigía vive y muere con la sesión: se rearma aquí (apertura nueva, gracia nueva). */
    textoVisto = false; rescateHecho = false; vozDeCada = 0; vozCalmaDesde = 0;
    tAbierto = Date.now();
    if (vigia) clearInterval(vigia);
    vigia = setInterval(() => vigilancia(), 500);
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
    /* Hook de la app: el tap de micrófono del dictado local (y cualquier recurso que la
       app ate a la sesión) debe soltarse SIEMPRE que el panel se cierra — por su botón,
       por Esc o por despedida. Se llama primero, en cuanto se sabe que se cierra. */
    if (typeof window.__alCerrarModoVoz === 'function') { try { window.__alCerrarModoVoz(); } catch {} }
    pararBucle();
    if (vigia) { clearInterval(vigia); vigia = 0; }
    document.removeEventListener('keydown', alTeclado, true);
    cancelarEdicion();
    /* Al cerrar se suelta también la confirmación: con el panel fuera de la vista la barra
       del chat vuelve a verse y es ella la que manda, así que la copia del panel no puede
       seguir armada por si vuelve a sonar un «sí» en una sesión posterior. */
    olvidarConfirmacion();
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
         micrófono si estamos escuchando u oyendo. Cada analizador se lee UNA vez por
         fotograma: antes se leía el del micro dos veces más la salida en cada vuelta. */
      const nivelMicro = rms(analizadorMic);
      const nivelSalida = estado === 'hablando' ? rms(analizadorSalida) : 0;
      const fuente = estado === 'hablando' ? nivelSalida : nivelMicro;
      /* El suelo se mide del micrófono y solo mientras escuchamos: con la voz del
         asistente de por medio medía su propia respuesta, no el ambiente. */
      if (mic && mediciones < MEDICIONES_SUELO && (estado === 'escuchando' || estado === 'oyendo')) {
        mediciones++;
        sueloRuido = Math.min(SUELO_MAX, sueloRuido * 0.9 + nivelMicro * 0.1);
      }
      const objetivoReal = Math.max(objetivo, fuente * 2.2);
      nivel = window.OrbKit.smoothLevel(nivel, reducido ? window.OrbKit.nivelDeFondo(estado, t) : Math.max(objetivoReal, window.OrbKit.nivelDeFondo(estado, t)), dt);
      window.OrbKit.draw(ctx, c.width, c.height, nivel, estado, t);
      /* La interrupción la decide el MICRÓFONO, no lo que suena: mirando la salida, la
         propia voz del asistente cuenta como «el usuario está hablando» y bastan ~250 ms
         de su respuesta para que se corte a sí mismo. El nivel del orbe mientras habla SÍ
         sigue saliendo de la salida (eso no se toca). */
      if (estado === 'hablando') vigilarInterrupcion(nivelMicro, nivelSalida, now);
      else vozDesde = 0;   // la voz sostenida se cuenta dentro de una misma frase
      raf = requestAnimationFrame(paso);
    };
    raf = requestAnimationFrame(paso);
  }
  function pararBucle() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  /* Interrupción (barge-in): si hablas mientras el asistente habla, se calla. Dos
     condiciones, y las dos hacen falta. Voz sostenida —250 ms— para que un golpe de
     ruido no corte una respuesta; y que el micrófono SUPERe una porción de lo que está
     sonando, porque sin auriculares la voz del asistente sale por los altavoces y vuelve
     por el micrófono: sin esa segunda condición, el eco se tomaba por una persona
     hablando encima y la respuesta se cortaba sola. */
  let vozDesde = 0;
  function vigilarInterrupcion(nivelMicro, nivelSalida, now) {
    const umbral = Math.max(0.02, sueloRuido * 3.5);
    if (nivelMicro > umbral && nivelMicro > nivelSalida * ECO) {
      if (!vozDesde) vozDesde = now;
      if (now - vozDesde > 250) { vozDesde = 0; interrumpir(); }
    } else vozDesde = 0;
  }
  /* Interrumpir REINICIA el contador de frases del proceso principal: si no, la primera
     frase de la respuesta siguiente llevaba un id viejo, `spoken()` la descartaba al
     terminar y la cola se detenía — se oía una frase y la respuesta se cortaba. */
  async function interrumpir() {
    await pararAudio();
    window.sagitari.ttsStop();
    window.sagitari.ttsReset();
    setEstado('oyendo');
    /* Y el resto de la respuesta deja de leerse: esto corta la frase que suena, pero el
       texto sigue llegando mientras el agente trabaja — sin avisar a la app, la lectura
       continuaba con la frase siguiente y la interrupción se quedaba a medias. */
    try { AL_INTERRUMPIR(); } catch {}
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
  cablearParar();

  window.VoiceMode = {
    abrir, cerrar, handle, pasos, respuesta, pedirConfirmacion, olvidarConfirmacion, responder, interrumpir,
    estado: () => estado, abierto: () => abierto,
    /* Interno del banco de pruebas: estado del vigía y vigilancia inyectada (sin micro). */
    vigia: () => ({ textoVisto, rescateHecho, vozDeCada, calma: !!vozCalmaDesde, abierto }),
    probarRescate: (now, nivel) => vigilancia(now, nivel),
    audio: { reproducir, parar: pararAudio },
    setEnviar: (fn) => { ENVIAR = fn; },
    setHablar: (fn) => { HABLAR = fn; },
    setParar: (fn) => { PARAR = fn; },
    setOcupado: (fn) => { HAY_TRABAJO = fn; },
    setInterrumpido: (fn) => { AL_INTERRUMPIR = fn; },
  };
})();
