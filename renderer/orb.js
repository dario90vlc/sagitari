'use strict';

/* El orbe: una malla de puntos que late con la voz.
 *
 * Reglas de dibujo que ya se validaron en las maquetas (y que no son gusto, son fallos
 * vistos y corregidos): el lienzo NO pinta fondo propio (si lo pinta, se ve el bloque
 * cuadrado sobre el panel); el halo termina DENTRO del lienzo (si llega al borde se
 * corta y aparece un cuadrado tenue); la malla se desvanece hacia el borde (si corta en
 * seco se ve el círculo); y el remolino se apaga en el centro (si no, queda un hueco
 * negro en medio). El halo vibra con `nivel`, que va suavizado: ataque rápido, caída
 * lenta, como un vúmetro bueno.
 */
(function () {
  const CLARO = '255,255,255', MEDIO = '196,181,253', BASE = '139,92,246';
  const ESTADOS = ['escuchando', 'oyendo', 'pensando', 'hablando', 'confirmando', 'error'];
  const ATAQUE = 18, CAIDA = 3.2;

  function smoothLevel(v, objetivo, dt) {
    const k = objetivo > v ? ATAQUE : CAIDA;
    const siguiente = v + (objetivo - v) * Math.min(1, k * dt);
    return siguiente < 0.012 ? 0.012 : siguiente;
  }

  /* Cuánta energía muestra cada estado cuando NO hay voz (el orbe nunca está muerto). */
  function nivelDeFondo(estado, t) {
    if (estado === 'escuchando') return 0.05 + 0.03 * Math.sin(t / 1.4);
    if (estado === 'pensando') return 0.30 + 0.06 * Math.sin(t / 0.9);
    if (estado === 'confirmando') return 0.18;
    if (estado === 'error') return 0.06;
    return 0.05;
  }

  function draw(ctx, w, h, nivel, estado, t) {
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.40, N = 19;
    ctx.clearRect(0, 0, w, h);
    const tono = estado === 'hablando' ? CLARO : MEDIO;
    const RH = R * 1.12;                              // dentro del lienzo, con margen
    const halo = ctx.createRadialGradient(cx, cy, 1, cx, cy, RH);
    halo.addColorStop(0, 'rgba(' + BASE + ',' + (0.14 + 0.28 * nivel) + ')');
    halo.addColorStop(0.5, 'rgba(' + BASE + ',0.06)');
    halo.addColorStop(1, 'rgba(' + BASE + ',0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, RH, 0, 7); ctx.fill();

    const paso = (R * 2) / (N - 1);
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const x = cx - R + i * paso, y = cy - R + j * paso;
        const d = Math.hypot(x - cx, y - cy) / R;
        const caida = Math.max(0, Math.min(1, (1.06 - d) / 0.34));
        if (caida <= 0) continue;
        const borde = 1 - d * d;
        const ang = Math.atan2(y - cy, x - cx);
        let onda;
        if (estado === 'escuchando') onda = Math.sin(t * 1.1 - d * 2.2) * 0.5 + 0.5;
        else if (estado === 'pensando') onda = Math.sin(t * 2.6 - d * 5.5 + ang * 0.8) * 0.5 + 0.5;
        else {
          const radial = Math.sin(d * 7 - t * 3.4);
          const remolino = Math.cos(ang * 3 + t) * Math.min(1, d * 1.8);
          onda = 0.5 + 0.5 * (0.75 * radial + 0.35 * remolino);
        }
        const quieto = estado === 'confirmando' || estado === 'error';
        const fuerza = quieto ? 0.25 : estado === 'escuchando' ? 0.35 : estado === 'pensando' ? 0.75 : 1.15;
        const des = (2 + 9 * onda) * borde * (0.35 + nivel) * fuerza;
        const px = x + Math.cos(ang) * des, py = y + Math.sin(ang) * des;
        const e = quieto ? 0.7 : estado === 'escuchando' ? 0.55 : estado === 'pensando' ? 0.8 : 1;
        const a = (0.12 + 0.75 * borde * (0.45 + 0.55 * nivel)) * e * caida;
        ctx.fillStyle = 'rgba(' + (borde > 0.72 ? tono : MEDIO) + ',' + a + ')';
        ctx.beginPath(); ctx.arc(px, py, 0.8 + 1.5 * borde + 1.1 * nivel * e, 0, 7); ctx.fill();
      }
    }
  }

  window.OrbKit = { smoothLevel, draw, ESTADOS, nivelDeFondo };
})();
