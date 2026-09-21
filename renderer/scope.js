/* SAGITARI · scope de torre (fondo vivo del estado vacío del chat).
   Instrumento, no decoración: anillos de alcance, barrido con estela y ecos que se
   apagan. Sigue el acento elegido (--acc2-rgb) y se pausa solo cuando nadie lo mira
   (vista oculta, chat con mensajes o ventana sin foco). Sin dependencias: se
   autoarranca al cargar, antes o después que app.js. */
(function () {
  'use strict';
  var canvas = document.getElementById('scopeCanvas');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  var vacio = document.getElementById('chatEmpty');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var W = 0, H = 0, CX = 0, CY = 0, R = 0, DPR = 1;
  function medir() {
    var r = canvas.getBoundingClientRect();
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    canvas.width = W * DPR; canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    CX = W / 2; CY = H * 0.46; R = Math.min(W, H) * 0.42;
  }

  var acento = [118, 95, 245];
  function leerAcento() {
    var v = getComputedStyle(document.documentElement).getPropertyValue('--acc2-rgb').trim();
    var m = v.match(/(\d+)\D+(\d+)\D+(\d+)/);
    if (m) acento = [+m[1], +m[2], +m[3]];
  }
  leerAcento();
  // el usuario puede cambiar de paleta en caliente: releer de vez en cuando
  var ticksAcento = 0;

  var barrido = Math.random() * Math.PI * 2;
  var ecos = []; // {a: ángulo, d: radio 0..1, vida: 1..0}
  var ultimoEco = 0;

  function aOjo() {
    if (document.hidden) return false;
    if (!vacio || vacio.hidden) return false;
    var vista = document.getElementById('view-chat');
    if (!vista || !vista.classList.contains('on')) return false;
    var msgs = document.getElementById('messages');
    if (msgs && msgs.children.length) return false; // con conversación, el scope descansa
    return true;
  }

  function pintar(t) {
    ctx.clearRect(0, 0, W, H);
    var A = 'rgba(' + acento[0] + ',' + acento[1] + ',' + acento[2] + ',';
    // anillos de alcance + cruz
    ctx.lineWidth = 1;
    for (var i = 1; i <= 3; i++) {
      ctx.strokeStyle = A + (0.16 - i * 0.03) + ')';
      ctx.beginPath(); ctx.arc(CX, CY, (R * i) / 3, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.strokeStyle = A + '0.10)';
    ctx.beginPath();
    ctx.moveTo(CX - R, CY); ctx.lineTo(CX + R, CY);
    ctx.moveTo(CX, CY - R); ctx.lineTo(CX, CY + R);
    ctx.stroke();
    // marcas de rumbo cada 30°
    ctx.strokeStyle = A + '0.22)';
    for (var g = 0; g < 12; g++) {
      var a = (g * Math.PI) / 6;
      var c = Math.cos(a), s = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(CX + c * (R - 7), CY + s * (R - 7));
      ctx.lineTo(CX + c * R, CY + s * R);
      ctx.stroke();
    }
    // barrido con estela
    var estela = ctx.createConicGradient
      ? (function () {
          var gr = ctx.createConicGradient(barrido, CX, CY);
          gr.addColorStop(0, A + '0.55)');
          gr.addColorStop(0.12, A + '0.12)');
          gr.addColorStop(0.25, A + '0)');
          gr.addColorStop(1, A + '0)');
          return gr;
        })()
      : A + '0.10)';
    ctx.fillStyle = estela;
    ctx.beginPath(); ctx.moveTo(CX, CY); ctx.arc(CX, CY, R, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = A + '0.6)';
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.lineTo(CX + Math.cos(barrido) * R, CY + Math.sin(barrido) * R);
    ctx.stroke();
    // ecos: brillan al pasar el barrido y se apagan
    for (var e = 0; e < ecos.length; e++) {
      var eco = ecos[e];
      var dif = Math.abs(((eco.a - barrido) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
      var brillo = Math.max(0, 1 - dif / 1.2) * eco.vida;
      if (brillo <= 0.02) continue;
      var x = CX + Math.cos(eco.a) * eco.d * R, y = CY + Math.sin(eco.a) * eco.d * R;
      ctx.fillStyle = A + (0.25 + brillo * 0.75) + ')';
      ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = A + (brillo * 0.5) + ')';
      ctx.beginPath(); ctx.arc(x, y, 2.4 + (1 - eco.vida) * 14, 0, Math.PI * 2); ctx.stroke();
    }
    // rombo central: la torre
    ctx.fillStyle = A + '0.8)';
    ctx.save(); ctx.translate(CX, CY); ctx.rotate(Math.PI / 4); ctx.fillRect(-3.4, -3.4, 6.8, 6.8); ctx.restore();
  }

  var enMarcha = false, raf = 0, ultimoT = 0;
  function cuadro(t) {
    if (!aOjo()) { enMarcha = false; return; }
    raf = requestAnimationFrame(cuadro);
    var dt = Math.min(0.05, (t - ultimoT) / 1000 || 0.016);
    ultimoT = t;
    barrido += dt * 0.9;
    if (++ticksAcento % 240 === 0) leerAcento();
    // un eco nuevo de vez en cuando, en cualquier rumbo y distancia
    if (t - ultimoEco > 1400 && ecos.length < 9) {
      ultimoEco = t;
      ecos.push({ a: Math.random() * Math.PI * 2, d: 0.25 + Math.random() * 0.7, vida: 1 });
    }
    for (var i = ecos.length - 1; i >= 0; i--) {
      ecos[i].vida -= dt * 0.12;
      if (ecos[i].vida <= 0) ecos.splice(i, 1);
    }
    pintar(t);
  }
  function vigilar() {
    if (!enMarcha && aOjo()) { enMarcha = true; ultimoT = performance.now(); raf = requestAnimationFrame(cuadro); }
    if (!enMarcha) pintar(0); // un fotograma quieto al arrancar o al volver
  }

  medir();
  if (reduce) { pintar(0); return; } // movimiento reducido: instrumento quieto
  window.addEventListener('resize', medir);
  if (window.ResizeObserver && vacio) new ResizeObserver(medir).observe(vacio);
  document.addEventListener('visibilitychange', vigilar);
  // el vaciado del hilo (innerHTML) y los cambios de vista no avisan: sondear barato
  setInterval(vigilar, 1500);
  vigilar();
})();
