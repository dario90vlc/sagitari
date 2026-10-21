# Movimiento

## Tres movimientos primero en cada interfaz

Una interfaz completamente inmóvil es como una captura de pantalla: pulsar no produce respuesta, los cambios no tienen origen y el usuario solo puede adivinar qué acaba de ocurrir. En las interfaces nuevas y en aquellas cuyo flujo de operación se ha modificado, implementa primero estos tres puntos:

1. **La respuesta de la acción principal.** Al pulsar debe haber una respuesta inmediata y, al completarse, un resultado: el botón se hunde y vuelve, la marca de verificación se dibuja, la cifra rueda hasta el nuevo valor.
2. **El origen de un cambio de estado.** Al seleccionar, desplegar, cambiar de vista o añadir y quitar elementos de una lista, haz visible de dónde viene y a dónde va cada cosa; consulta «Transiciones de interfaz» más abajo.
3. **Una entrada en el primer acceso.** El protagonista llega primero y el resto le sigue en orden de lectura; solo se reproduce en el primer acceso.

Cualquier movimiento añadido más allá de estos tres debe asumir una de estas funciones: dar respuesta, guiar, aportar continuidad o expresar la marca; la aparición al desplazar, el paralaje, el seguimiento del ratón y los bucles decorativos son los que más fácilmente se convierten en interferencia.

| Objetivo | Enfoques que conviene considerar |
| --- | --- |
| Pulsar, enfocar, desplegar o un cambio de estado normal | Usa las transiciones nativas del navegador o las microtransiciones que ya traen los componentes existentes |
| Cambio entre vistas, cambio de posición de un elemento | Transición de elemento compartido; consulta «Transiciones de interfaz» más abajo |
| Arrastre, gestos, cambios de posición y tamaño, animaciones de varios elementos coordinados | Usa una biblioteca de movimiento consolidada que ya exista en el proyecto |
| Escenas de marca especiales, materiales, efectos físicos complejos | Imágenes, 3D, shaders o vídeo prerenderizado, según lo que exija el requisito; sobre cuándo usar 3D en tiempo real, consulta [Materiales](media.md) |
| Controlar el avance de una narración con ratón, táctil o desplazamiento | Haz que el progreso de la animación siga directamente la entrada y resuelve bien el desplazamiento hacia atrás y las acciones rápidas; consulta [Narrativa por desplazamiento](scroll-narrative.md) |

En las interfaces que necesitan controlar el estado con precisión, escribe la animación en código; cuando el modo en que cambia la imagen ya está decidido de antemano, puedes usar vídeo generado. Los controles que muestran datos en tiempo real y con los que la persona debe operar de verdad no pueden sustituirse por vídeo.

## Tacto

La sensación del movimiento se deriva del material y el tono de la dirección, y se nombra y se parametriza con «acción + objeto físico» (rigidez del muelle / amortiguación):

| Acción | Referencia física | Rigidez / amortiguación | Adecuado para |
| --- | --- | --- | --- |
| Chasquido | Imán que se pega, cierre a presión, interruptor basculante | 350–400 / 10–15 | Botones, interruptores, despliegue de menús |
| Deslizamiento | Cierrapuertas neumático, amortiguación de cajón | 250–300 / 20–25 | Paneles inferiores, cajones, plegado |
| Flujo | Miel que se vierte, niebla que se disipa | 150–200 / 30–40 | Transiciones de página, aparición del elemento principal |
| Golpe seco | Martillazo, objeto pesado sobre la mesa | 400–500 / 5–10 | Confirmación de selección, respuesta de finalización |
| Rebote | Pelota de goma, cama elástica | 300 / 8 | Avisos de celebración, público infantil y juegos |
| Flotación | Globo de helio, pelusa al aire | 100 / 25 | Meditación, escenas oníricas, bucles en reposo |

Los materiales pesados (piedra, metal, cerámica) tienden al chasquido y al golpe seco; los ligeros (papel, tela, niebla), a la flotación y al flujo. Las operaciones frecuentes usan movimientos breves; solo los momentos de marca poco habituales se permiten movimientos largos. Una dirección ruidosa y áspera puede usar cortes secos, saltos lineales de 80–150ms y animación a saltos de fotogramas como expresión de marca deliberada; lo único prohibido es la curva de aceleración por defecto que nadie ha considerado.

La amplitud del sobrepaso depende del área. En elementos de gran superficie, como una página completa o un panel, el sobrepaso no supera el 1–2%, o toda la imagen se tambalea; en objetos pequeños como insignias o marcas de verificación puede llegar al 10–20% y transmitir elasticidad. Los parámetros de amortiguación baja de la tabla se emplean solo en objetos pequeños.

En la web se puede expresar un muelle como curva de aceleración: integra numéricamente el desplazamiento según la rigidez y la amortiguación, toma 20–30 puntos de muestreo y escríbelos en `linear()`, usando como duración el instante en que el desplazamiento se estabiliza dentro del 0,5% del valor final. En los navegadores que no lo admiten, recurre a un `cubic-bezier` parecido.

## Correspondencia: encadenar unas acciones con otras

El cambio que provoca una acción se propaga por un mismo camino, y el final de un tramo es el inicio del siguiente; no dejes que el botón, el panel y la cifra se muevan cada uno por su cuenta.

- **Parte del lugar donde se actúa.** Al pulsar «Añadir a la bolsa», el producto se encoge en un punto y vuela hacia la bolsa, y la cifra de la bolsa da un salto; al eliminar una fila, esta se retira en dirección al botón de eliminar y las filas siguientes suben a ocupar su sitio.
- **Cada transición va en una sola dirección.** Si la tarjeta se desliza a la izquierda, el título, el número y el color de fondo también cambian hacia la izquierda; si la cifra rueda hacia arriba, el progreso también sube. Cuando las direcciones se mezclan, el resultado son varias animaciones inconexas.
- **El protagonista se mueve primero y arrastra al resto.** Lo afectado se incorpora 40–80ms después, con menor amplitud, como si el protagonista lo tirara de sí. Si todo arranca a la vez y con la misma amplitud, solo parece un parpadeo conjunto.
- **Relevo de formas.** El elemento de un estado se convierte en el elemento del estado siguiente: el botón se despliega en panel, el icono de búsqueda se alarga en campo de texto, la tecla de reproducción pasa a la de pausa. El usuario ve de un vistazo que son la misma cosa.
- **El movimiento y la imagen son del mismo material.** El peso, las pausas y el rebote de la acción se derivan del motor generativo y la sintaxis de controles de la ficha de dirección.

### El ingenio se busca en el producto

El ingenio consiste en hacer que un movimiento cuente algo propio de este producto, no en añadir más florituras. Formúlalo en una frase: qué cosa de este producto, a causa de qué acción del usuario, experimenta un cambio que solo podría ocurrir en él.

Si no encuentras tal acción, limítate a hacer bien los tres movimientos básicos y no fuerces nada. Como máximo, una o dos ideas ingeniosas por página; el resto del movimiento, silencioso y breve.

## Transiciones de interfaz

**Continuidad.** Lo que el usuario pulsa es el protagonista de la pantalla siguiente. Al pasar de una lista al detalle, el elemento pulsado se amplía hasta convertirse en el detalle y los demás se desvanecen; al volver, se encoge hasta su posición original y la página regresa a la posición de desplazamiento que tenía. Si la posición original ya no está en el área visible, desplázala primero a la vista y luego encógela.

**Dirección coherente.** El elemento siguiente entra por la derecha y el anterior por la izquierda; abrir y cerrar son procesos inversos; un panel lateral entra y sale por el lado en el que se encuentra. Una animación de dirección arbitraria confunde más que la ausencia de animación.

**Sin fundido cruzado cuando solo cambia la forma.** Al cambiar el área visible, filtrar, desplegar una explicación o escalar, el contenido sigue siendo la misma cosa y solo cambian el tamaño y la posición. Deja que el marco exterior se deforme directamente y que el contenido muestre de inmediato el nuevo estado. El fundido cruzado superpone dos imágenes escaladas de forma distinta y produce un doble contorno. Solo cuando el contenido mismo cambia se usa el fundido de entrada y salida.

**Salida, entrada y permanencia, por separado.** Lo eliminado se desvanece, lo añadido aparece y lo que permanece se desplaza a su nueva posición. Si los tres usan el mismo desvanecimiento, la lista parpadea entera.

**El indicador de selección es una pieza deslizante.** En los controles segmentados, las pestañas y el elemento actual de una lista, la misma base se desliza hasta la nueva posición en lugar de apagarse lo viejo y encenderse lo nuevo. Si las opciones tienen anchos distintos, el ancho también transiciona. En la primera aparición, al redimensionar la ventana y cuando terminan de cargarse las fuentes, colócalo directamente en su sitio; no lo hagas crecer desde un ancho de 0.

**Prepara antes el destino.** El contenido que el destino debe cargar, como imágenes o páginas incrustadas, debe estar cargado o prerrenderizado de antemano; de lo contrario, la animación termina sobre una pantalla en blanco. Las vistas entre las que se alterna deben prerrenderizarse y permanecer en la página, de modo que al cambiar solo se desplacen, sin volver a cargar. El contenido aparece con un fundido una vez cargado, sin un destello de fondo blanco previo.

**La salida es más rápida que la entrada.** La duración de la salida es aproximadamente el 60–70% de la de entrada, con una curva de aceleración; la entrada usa una curva de desaceleración o un muelle.

**Al llegar al extremo debe haber respuesta.** Cuando ya se está en el primer o el último elemento, da un empujón suave (10–15px de ida y vuelta) en lugar de no responder en absoluto.

### Compromisos de estabilidad en las transiciones de página completa

El cambio de página completa no es como la transición de un componente: la página antigua debe desmontarse y la nueva debe montarse. Según su estabilidad y su dificultad de implementación, se distinguen tres tipos:

- **Cortina (Curtain / Wipe).** Una superficie de color plano, textura o forma geométrica barre o cubre toda la pantalla y, mientras la oculta, desmonta la página antigua y monta la nueva. Es la más sencilla y la más estable; las estructuras de ambas páginas son independientes entre sí y sirve para la gran mayoría de las páginas.
- **Superpuesta (Overlapping).** Las dos páginas están en pantalla al mismo tiempo, desplazadas entre sí, empujándose o con un fundido cruzado por capas. Se ve continuo, pero el DOM de ambas páginas debe existir simultáneamente y hay que gestionar bien las capas y la memoria.
- **Elemento compartido (Shared Element).** Un elemento clave se transforma desde la página antigua hasta la nueva, por ejemplo una miniatura que se amplía hasta la imagen principal de la página de detalle. Es la más fluida y también la más propensa a fallos: el doble clic rápido del usuario, una interrupción a mitad de camino, el botón de retroceso o un cambio en el área visible provocan fácilmente desalineaciones y parpadeos, así que hay que dejar siempre una salida que muestre directamente el estado final cuando algo falle.

La pantalla de carga inicial del sitio (Splash) puede incluir un pequeño fragmento narrativo o de progreso mientras se cargan los archivos grandes; para la navegación entre páginas dentro del sitio, usa los valores de cambio de página completa de «Duración y amplitud» más abajo, y no dejes que la transición impida al usuario ver el contenido.

## Duración y amplitud

| Objeto | Duración | Puntos clave |
| --- | --- | --- |
| Pulsar, interruptor, indicador de selección | 150–300ms | Al pulsar, reduce a 0,96–0,98 y aplica el cambio de inmediato (unos 80ms); al soltar, vuelve |
| Desplegable, globo, aviso | 180–250ms | Se despliega desde la dirección del punto de activación; la escala parte de alrededor de 0,96, no de 0 |
| Panel, cajón, barra lateral | 250–400ms | Depende de la distancia recorrida: cuanto mayor, más larga |
| Cambio de página completa o de vista | 350–500ms | Más de 500ms hace esperar |
| Aparición escalonada en el primer acceso | 40–80ms entre elementos | Duración total no superior a 600ms; solo se reproduce en el primer acceso, no al volver a renderizar ni al restaurar el estado |

Esta tabla rige las operaciones de interfaz. Para la duración de las secuencias en juegos y sorteos, consulta [Juego](play.md).

Al pasar el cursor, eleva 2–4px y oscurece la sombra en consecuencia. Un efecto de hover con un desplazamiento superior a 20px resulta frívolo.

## Los resultados invisibles hay que decirlos

Cuando un clic produce un efecto secundario invisible, como copiar al portapapeles, guardar en segundo plano o enviar, di el resultado mismo con un aviso breve, por ejemplo «Copiado: …», en lugar de limitarte a «Hecho». Los momentos de confirmación, como una selección o una finalización, pueden usar una pequeña aparición que se reproduce solo la primera vez que cambia el estado y no se repite al pulsar de nuevo.

## Experiencia y rendimiento

Reutiliza primero el ritmo de movimiento y las capacidades de componentes que ya existen en el proyecto. En las operaciones frecuentes, da la respuesta de inmediato y no dejes que la animación retrase la tarea en sí.

La animación debe poder interrumpirse. Con operaciones rápidas y continuadas, la nueva animación continúa desde la posición actual y no salta al inicio para reproducirse de nuevo. Las transiciones CSS parten del valor actual, por lo que sirven para cambios de alta frecuencia; las animaciones por fotogramas clave se reproducen desde el principio, por lo que sirven para entradas puntuales. El estado del negocio se actualiza de inmediato, sin esperar a que termine la animación.

En la web, para animaciones continuas, anima preferentemente solo la transformación y la opacidad, y escribe en la transición únicamente las propiedades que cambian; los indicadores muy pequeños pueden transicionar directamente el ancho y el alto. El código que se ejecuta en cada fotograma debe tener condiciones para detenerse y limpiarse; no alternes continuamente entre leer y escribir el diseño. Detente cuando salga de la pantalla o no haya nada que hacer. Durante una transición de página completa, la página normalmente no responde al clic, así que las transiciones de página completa deben ser breves.

Donde haya desplazamientos, escalados o efectos de desplazamiento notables, atiende a los usuarios que han activado «Reducir movimiento»: en ese caso todos los estados pasan directamente a su posición final y el contenido está completo. La información necesaria y las acciones principales no pueden aparecer solo después de que termine la reproducción automática, el sonido o la animación.

## Revisar el movimiento

Recorre la interfaz a velocidad normal, vuelve atrás una vez y pulsa varias veces seguidas: no debe haber dobles contornos ni saltos, los elementos no deben aparecer de golpe, no deben llegar desde posiciones extrañas ni quedarse a medio camino. Con «Reducir movimiento» activado, el contenido debe ser legible de inmediato. Informa de la tasa de fotogramas o de mejoras de rendimiento solo tras medirlas realmente.

## Consejos de implementación web

- Las transiciones de vista nativas del navegador sirven para «el mismo objeto pasa de un sitio a otro»: asigna el mismo nombre de transición a los elementos que representan el mismo objeto en los dos estados, y ese nombre debe ser único en cada momento.
- En una transición que solo cambia la forma, oculta la instantánea antigua y muestra directamente el nuevo estado para evitar el doble contorno.
- Detrás de los pseudoelementos de transición solo pueden ir unas pocas pseudoclases, por ejemplo `:only-child`; escribir `:not(...)` invalida toda la regla. Cuando necesites distinguir reglas por escenario, añade un atributo al elemento raíz para alternarlas.
- Las páginas incrustadas y las imágenes se recortan como instantáneas durante la transición; si empiezas la transición antes de que el destino haya terminado de cargarse, esta terminará en blanco.
