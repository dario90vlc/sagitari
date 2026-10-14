# DESIGN.md — SAGITARI · Holo con momentos

Mundo visual vigente: la identidad holográfica hecha a mano (el filo vivo de las
superficies, seis paletas, modos ACT/PLAN/THINK con su color) más los momentos con
entidad propia: el recorrido, las cáusticas, el slider de vidrio, las puertas y el
reloj. La ronda del deck mate se revirtió a petición del usuario: el
mate plano dejaba la UI muerta y la Chakra Petch envejecía.

## Tokens

- Acento y glow: triplets `--acc-rgb / --acc2-rgb / --acc3-rgb / --glow-rgb /
--glow-a/b/c-rgb` + `--glow-str`. Seis paletas en `PALETTES`; fondos derivados
  con la misma luminancia relativa. Semánticos fijos: `--ok #34d399`,
  `--warn #fbbf24`, `--danger #fb7185`, `--cyan #22d3ee`, `--mag #d946ef`.
- Modos: ACT `--mode-rgb 52,211,153`, PLAN `167,139,250`, THINK `125,180,255`,
  EQUIPO `245,158,66` (ámbar; el punto no estrena vocabulario: `.dot.a-y`).
- Tipos: Sora (display/logo), Space Grotesk (UI), Cascadia Mono/Consolas (código).
  Sin fuentes ajenas: todo autoalojado con su OFL.

## Momentos

- **Borde vivo** (`.filo`, `#shell.glow-*`): la luz deja de ser un aura que rodea la
  ventana y pasa a ser el FILO de las superficies que importan —panel lateral, compositor,
  tarjetas del rail, la tarjeta que corre su herramienta y la puerta activa del nav—. Cada
  estado escribe **cuatro niveles** (`--live-window/side/com/rail`) y un tono (`--live-rgb`)
  en `#shell`, y cada superficie lee el suyo: el mapa estado→superficie vive en un solo
  sitio. El estado se lee en QUÉ superficie está encendida —**pensar** el panel lateral,
  **trabajar** el compositor y la tarjeta concreta— y la
  ventana conserva una hairline de 1px que sólo se enciende mientras hay trabajo. El filo
  es un degradado ESTÁTICO dentro de la superficie (anillo de 1px + bloom corto, ambos
  `inset`) y el nivel lo aplica la `opacity`, que el compositor resuelve sin repintar.
- **El recorrido** (el momento autoral del borde vivo): al CAMBIAR de estado un reflejo
  recorre UNA vez el filo de la superficie implicada (~450 ms) y se posa —baja por el panel
  lateral al pensar, cruza el compositor por abajo al trabajar—. Nada gira, nada late de forma
  permanente y ninguna superficie entra igual que otra; el acuse de `Ctrl+Shift+G` es una
  veta del espectro que cruza la ventana una sola vez. No hay capa a pantalla completa ni
  degradado re-rasterizado por frame.
- **Cáusticas**: luz arriba-izquierda + sombra abajo-derecha en el vidrio
  héroe (borde oscurecido + highlight).
- **Slider de vidrio** (`#glassTint`, `--glass` 0,4–1,3): de ultra claro a
  tintado. Vive en Ajustes ▸ Apariencia.
- **Puertas**: `.navitem .nl::before` numera 01-09 como los atajos Alt+1...9
  (Equipo y MCP no llevan número: los Alt+N llegan a nueve). Pequeño y tenue: el
  nombre manda.
- **Reloj** (`#boardClock`, `tickBoardClock` cada 1s): hora local tabular junto
  a «Actividad en vivo».

## Componentes v4.2–4.3

- **Panel de revisión del cambio** (`#diffPanel`): no es un diálogo modal, es una
  superficie dentro del chat; una tarjeta por archivo con contadores `+n/−n`, hunks
  con número de línea y filas de contexto/añadido/borrado, y vuelta atrás de un solo
  archivo. Un archivo sin pre-imagen decía que no se puede revertir solo: nunca un
  botón que mienta.
- **Medidor de contexto** (`#ctxMeter`): barra fina + porcentaje en el compositor, con
  el nivel en `data-estado` (`hola` / `ajustado` / `apretado`, las palabras del motor)
  y los semánticos `--dim` / `--warn` / `--danger`. Suplementa al aviso de presión,
  no lo sustituye.
- **Línea de sistema** (`.sysline`): lo que dice la interfaz sobre sí misma (resultado
  de `/compact`, `/cost`, `/help`). No es una burbuja y no entra en la conversación.
- **Avisos apilados** (`#toastStack`): columna en la parte alta; hasta tres, el más
  viejo cae primero. El contenedor no intercepta clics.
- **Paleta de `/`**: grupo **ÓRDENES** sobre el de skills, misma fila y mismo
  teclado; las órdenes salen de una sola lista (`ChatKit.COMMANDS`), de la que también
  sale la ayuda.

## Movimiento

Un momento autoral (el recorrido del filo al cambiar de estado, ~450 ms) y
transiciones cortas en el resto: el nivel del filo se asienta, no late.
`prefers-reduced-motion` quita el recorrido y CONSERVA el filo, que es la
información; sin foco (`body.nofocus`) no hay luz —salvo el acuse de
`Ctrl+Shift+G`, que es un atajo global y existe justo para cuando no miras—.

## Accesibilidad

Contrastes medidos (tenue 5,8–6,9:1; el filo ENCENDIDO, **4,7:1** contra el
relleno del panel lateral y **~4,0:1** contra el del compositor —medido sobre la
app en marcha, píxel a píxel; en reposo baja a 1,57:1 a propósito, porque ahí el
filo no es señal—), foco visible global, `hidden` ganador, uso completo por
teclado. Objetivo WCAG 2.1 AA.
