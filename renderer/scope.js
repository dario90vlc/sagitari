/* SAGITARI · scope de torre (fondo del estado vacío del chat).
   Instrumento quieto, no decoración: anillos de alcance fijos que siguen el
   acento elegido (--acc2-rgb). Sin barrido: el radar giratorio queda prohibido.
   Sin dependencias: se autoarranca al cargar, antes o después que los scripts 1x. */
(function () {
  'use strict';
  var canvas = document.getElementById('scopeCanvas');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  var vacio = document.getElementById('chatEmpty');

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

  function aOjo() {
    if (document.hidden) return false;
    if (!vacio || vacio.hidden) return false;
    var vista = document.getElementById('view-chat');
    if (!vista || !vista.classList.contains('on')) return false;
    var msgs = document.getElementById('messages');
    if (msgs && msgs.children.length) return false; // con conversación, el scope descansa
    return true;
  }

  function pintar() {
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
    // rombo central: la torre
    ctx.fillStyle = A + '0.8)';
    ctx.save(); ctx.translate(CX, CY); ctx.rotate(Math.PI / 4); ctx.fillRect(-3.4, -3.4, 6.8, 6.8); ctx.restore();
  }

  function repintar() {
    leerAcento();
    if (aOjo()) pintar();
    else ctx.clearRect(0, 0, W, H);
  }

  medir();
  repintar();
  window.addEventListener('resize', function () { medir(); repintar(); });
  if (window.ResizeObserver && vacio) new ResizeObserver(function () { medir(); repintar(); }).observe(vacio);
  document.addEventListener('visibilitychange', repintar);
  // el vaciado del hilo (innerHTML) y los cambios de vista no avisan: sondear barato
  setInterval(repintar, 1500);
  repintar();
})();
