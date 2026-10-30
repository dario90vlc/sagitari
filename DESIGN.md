# DESIGN.md — SAGITARI · Holo con momentos

Mundo visual vigente: la identidad holográfica hecha a mano (el filo vivo de las
superficies, seis paletas, modos ACT/PLAN/THINK/EQUIPO con su color) más los momentos con
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

## Superficies

Tres alturas y una sola luz: el nivel se lee en la luz, no en el radio.

- **Lienzo**: sin caja; la separación la hace el espacio (notas de sección, filas
  dentro de un panel).
- **Panel** (`--s-panel`): un **velo de luz** que cae de arriba abajo (blanco al
  5,5 % arriba, 1,4 % abajo) sobre el tinte de la paleta, más hairline neutra
  (`--s-line`, blanco al 10 %) y un filo interior de 1 px. Es la estructura:
  `.setcard`, `.tooltray`, `.listempty`, `.acard`, `.memitem`, `.mcprow`, la lista
  de skills.
- **Flotante**: vidrio, blur y sombra larga. Solo el compositor, las burbujas, los
  menús y el rail: lo que de verdad está por encima del contenido.

**La altura en oscuro no la hace la sombra**: una sombra negra sobre un fondo casi
negro no existe. La primera versión de este sistema cambió el filo violeta por uno
neutro y añadió `box-shadow`; medido en la app, el panel y la página se quedaron a
1–2 niveles de 255 y la estructura se volvió más suave, no más nítida. La altura la
da el relleno: con el velo, el panel queda ~+15/+18 niveles sobre la página (medido
en Skills y Memoria) y la sombra larga queda reservada a lo que flota.

El acento deja de pintar la estructura y queda para estado y acción (nav activo,
modo, foco, enviar, vivo). Antes cada tarjeta llevaba su filo violeta, y siete
paneles del mismo nivel parecían siete cosas distintas.

La lista de skills es UNA superficie con filas separadas por hairline, no ocho
tarjetas: contar bordes no es contar skills. El título de vista sube a 30 px y
conserva el tracking negativo, para que el salto con el cuerpo (14 px) abra la vista.

## Aspectos

Tres pieles sobre la MISMA base —vistas, componentes, medidas— que cambian la materia:

- **Holo** (la de siempre): vidrio, refracción, filo vivo; Sora para titular y Space
  Grotesk para la interfaz. No lleva atributo: es la hoja base, así que la identidad de
  la casa no necesita saber que existen otras.
- **Consola**: negro neutro, esquinas casi rectas (8/6/4) y **monoespaciada en todo**
  (Cascadia Mono/Consolas), con el acento reservado al foco y al estado. El aire de un CLI
  de agente. La lectura baja a 15 px y sube a 1,68 de interlineado porque la mono ocupa más
  por carácter; el nav baja a 12,5 px para que «Espacio de trabajo» no se corte; y como la
  negrita pesa poco en mono, el énfasis se marca con color y un subrayado fino.
- **Lienzo**: gris plano, radios amplios (20/14/9) y **una sola voz** —la geométrica de la
  interfaz titula también—, con títulos a 34 px y tracking más cerrado, lectura a 17 px y
  más aire en tarjetas y nav. El acento solo aparece en lo activo.

El aspecto viaja como `data-skin` en `<html>` (lo pone `applyTheme`) y vive entero en
[`renderer/skins.css`](renderer/skins.css). Lo importante es lo que SUELTAN los dos planos,
no lo que añaden:

- el material se apaga desde sus tokens (`--lg-rim`, `--lg-blur`, `--blur`, `--lg-sat`) en
  vez de rehacer superficie por superficie;
- se retira el filo (`.filo`): en un plano no hay canto que iluminar;
- `applyTheme` **suelta la rampa de fondos del tema** (`removeProperty`) —Consola es negro
  neutro y Lienzo gris plano; dejar la rampa es teñir de violeta una interfaz llamada
  Consola— y pone `--glow-str` a 0 **sin tocar el valor guardado**, que vuelve al elegir Holo;
- el texto se neutraliza (`--txt` / `--dim`): el blanco de Holo está lavado de violeta a
  propósito, y en un plano se lee como un tinte sucio.

Las filas de luz y vidrio de Ajustes (`[data-solo-holo]`) se retiran en un aspecto plano: no
se ofrecen controles que no hacen nada. La paleta elegida NO se pierde: en los tres aspectos
sigue siendo el acento (estado, foco, acción).

## Traza del turno

El turno del agente es una **columna de bloques en orden de aparición**, no una burbuja con
prosa: cada tramo de respuesta (`.seg`), cada tanda de herramientas (`.tgroup` con sus
`.tcard`) y cada ráfaga de razonamiento (`.thinkblock`) es una pieza con su propia piel,
colocada donde ocurrió. La burbuja contenedora (`.bubble.blocks`) pierde fondo, borde y
relleno: se lee el paso, no el envoltorio.

- **En vivo**: cada llamada a herramienta congela el tramo de narración anterior y abre su
tanda; el texto que llega después abre un bloque NUEVO debajo. El razonamiento se pinta en
vivo y se pliega a una línea cuando empieza la respuesta.
- **Al terminar**, las herramientas **se quedan a la vista** (antes se plegaban solas). La
cabecera del grupo las pliega si el usuario quiere; el defecto es que se lea lo que hizo.
- **Guardado**: el proceso principal acumula las mismas piezas como `parts`
  (`text`/`think`/`tool`/`delegate`/`todos`) en `main/traza.js` y viaja con el mensaje. Al
  reabrir, `restaurarPartes` repinta la misma secuencia. Los mensajes guardados antes de
  este cambio caen al rastro compacto de siempre (razonamiento, tanda de herramientas y
  texto), así que nada viejo se queda sin pintar.
- **Topes**: 120 partes por turno, 6.000 caracteres por tramo y 24.000 por turno. El texto
  completo sigue en `content` (lo que se envía al modelo); `parts` es lo que se ve.

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
