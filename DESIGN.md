# DESIGN.md — SAGITARI · Deck nocturno

Mundo visual vigente desde la ronda impeccable `d86c67ca` (challenger
cassette-futurism-deck, vence al caer el compromiso holo). El glow reactivo del
marco se conserva; el cristal, los degradados de neón y la niebla, no.

## Tokens

- Acento y glow: triplets `--acc-rgb / --acc2-rgb / --acc3-rgb / --glow-rgb /
  --glow-a/b/c-rgb` + `--glow-str`. Seis paletas en `PALETTES` (violeta,
  magenta, cian, esmeralda, ámbar, hielo); los fondos derivan con la misma
  luminancia relativa. Semánticos fijos: `--ok #34d399`, `--warn #fbbf24`,
  `--danger #fb7185`, `--cyan #22d3ee`, `--mag #d946ef`.
- Modos: ACT `--mode-rgb 52,211,153`, PLAN `167,139,250`, THINK `125,180,255`.
- Chasis: `rgb(var(--bg0-rgb))` con cepillado de 1px y viñeta (materia, no color).
  Paneles: `rgba(var(--panel-rgb), .72)`.
- Contador LED: `#ffc857` fijo con halo.
- Voz: Chakra Petch autoalojada (`--font-deck`, OFL al lado) en titulares,
  puertas, contadores y teclas; Space Grotesk en texto corrido; Sora en el logo.
- Momento firma: `scope.js` — canvas de torre en vivo tras el estado vacío
  (anillos, barrido con estela cónica, ecos que se apagan, acento del tema;
  se pausa solo; quieto con movimiento reducido).

## Gramática

- **Mecanizado**: filo de luz `inset 0 1px 0 rgba(255,255,255,.05–.07)` + base
  `inset 0 -2px 0 rgba(0,0,0,.4–.5)` + peso `0 3px 10px rgba(0,0,0,.35)` en
  `.rcard .setcard .tooltray`. Radios 6–8px en paneles y filas; lámparas
  (pills, LEDs, knobs) siguen redondas.
- **Grabado**: versales separadas con `text-shadow: 0 1px 0 rgba(0,0,0,.85)`
  (regla única: `.navgroup::before .tt-head .sc-head b .toolsgroup .field label
  .sub2 .live2 .tgroup-head b .sm-head .codeblock-head .dcard-status`).
- **Puertas**: `.navitem .nl::before` numera 01–09 como los atajos Alt+1…9
  (MCP `–`, sin atajo). Activa = tecla retroiluminada plana.
- **Monitor**: `.board-clock` (reloj ámbar, `tickBoardClock` cada 1s),
  `.bigring` como corona de segmentos LED, filas `.fitem/.ragent` planas que
  entran con `flap-in` (parpadeo de lámpara en 3 pasos).
- **Mandos**: `.btn` teclas en versales; `.primary` retroiluminado plano;
  `.sw` palanca cromada sobre ranura fresada (contrato `.on` intacto);
  `.glowslider` pista fresada + mando moleteado.
- **Prohibido**: degradados decorativos y halos exteriores de color (el aura del
  marco es la única luz ambiental). El metal funcional (palancas, mandos) sí
  usa degradado: es material, no decoración.

## Movimiento

Un momento autoral: el parpadeo de lámpara al llegar trabajo nuevo + la
respiración del aura por estado. Todo lo demás, transiciones ≤.2s. Se apaga en
`prefers-reduced-motion` (incluye `.fitem/.ragent`).

## Accesibilidad

Contrastes medidos: puertas 7,1:1 · reloj/horas ≥15:1 · primario 4,44:1 ·
tenue 5,8–6,9:1. Foco visible global + halo en botones. `hidden` gana siempre.
