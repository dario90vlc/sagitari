# DESIGN.md — SAGITARI · Holo con momentos

Mundo visual vigente: la identidad holográfica hecha a mano (glow reactivo del
marco, seis paletas, modos ACT/PLAN/THINK con su color) más tres momentos con
entidad propia. La ronda del deck mate se revirtió a petición del usuario: el
mate plano dejaba la UI muerta y la Chakra Petch envejecía.

## Tokens

- Acento y glow: triplets `--acc-rgb / --acc2-rgb / --acc3-rgb / --glow-rgb /
  --glow-a/b/c-rgb` + `--glow-str`. Seis paletas en `PALETTES`; fondos derivados
  con la misma luminancia relativa. Semánticos fijos: `--ok #34d399`,
  `--warn #fbbf24`, `--danger #fb7185`, `--cyan #22d3ee`, `--mag #d946ef`.
- Modos: ACT `--mode-rgb 52,211,153`, PLAN `167,139,250`, THINK `125,180,255`.
- Tipos: Sora (display/logo), Space Grotesk (UI), Cascadia Mono/Consolas (código).
  Sin fuentes ajenas: todo autoalojado con su OFL.

## Momentos

- **Scope** (`scope.js` + `#scopeCanvas`): radar en vivo tras el estado vacío —
  anillos, barrido con estela cónica, ecos que se apagan, acento del tema en
  caliente. Se pausa solo (conversación abierta, vista oculta, sin foco) y queda
  quieto con movimiento reducido. Máscara radial: el texto manda en el centro.
- **Puertas**: `.navitem .nl::before` numera 01–09 como los atajos Alt+1…9
  (MCP `–`). Pequeño y tenue: el nombre manda.
- **Reloj** (`#boardClock`, `tickBoardClock` cada 1s): hora local tabular junto
  a «Actividad en vivo».

## Movimiento

Un momento autoral (scope + respiración del aura por estado); transiciones
cortas en el resto. `prefers-reduced-motion` apaga latidos y scope.

## Accesibilidad

Contrastes medidos (tenue 5,8–6,9:1), foco visible global, `hidden` ganador,
uso completo por teclado. Objetivo WCAG 2.1 AA.
