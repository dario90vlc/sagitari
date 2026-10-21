# Narrativa de scroll

## Animación de scroll en landing pages

En landing pages, páginas de marca, páginas de lanzamiento de producto y páginas de exposición, la animación de scroll se valida junto con las tres animaciones básicas de [Animación](motion.md); los documentos, artículos, herramientas y paneles de administración no la usan. Impleméntala con una biblioteca de animación madura; consulta «Bibliotecas de animación» más abajo.

**Debe haber dos cosas**: los bloques por debajo de la primera pantalla aparecen según el contenido; y al menos un tramo de narrativa accionada por el desplazamiento, en el que el protagonista cambia de forma evidente al hacer scroll. **Elige la técnica según la página**: profundidad de la primera pantalla, el logotipo recogiéndose en la navegación, plano secuencia, transición de cámara entre capítulos, fondo que cambia de color con el capítulo, manifiesto que se ilumina palabra por palabra; elige entre la imagen principal y el contenido de la página la más adecuada, escríbela en el guion gráfico y explica el motivo; no fijes y escales la primera pantalla por defecto en todas las páginas.

### Profundidad de la primera pantalla (adecuada para páginas cuya primera pantalla tiene una separación clara entre primer plano y fondo)

La primera pantalla es un escenario fijo, y el scroll acciona directamente el cambio de capas en su interior; al desplazarse hacia atrás, se invierte:

- Fija la primera pantalla durante 100–200 vh de recorrido de scroll; en pantalla estrecha puede reducirse a 80–120 vh.
- Al menos dos capas cambian con velocidades o direcciones distintas, por ejemplo el primer plano se acerca y el fondo se mueve despacio, o la imagen principal y el gran titular abren una diferencia de escala; la capa de fondo es la que menos se mueve y el primer plano el que más.
- La amplitud debe notarse de un vistazo en una grabación de pantalla: la capa principal escala al menos un 15 %, o su desplazamiento es de al menos 15 vh. Por debajo de esa amplitud, lo que se ve es una página con scroll normal.
- El gran titular es capa gráfica y puede escalar y tener paralaje; el cuerpo de texto, los botones y los formularios no escalan ni hacen paralaje, y permanecen legibles y pulsables tras la fijación.
- El estado final debe enlazar con la sección siguiente: la imagen principal se encoge hasta la posición de la siguiente sección, el titular retrocede a textura de fondo, o el plano cede un hueco al protagonista de la siguiente sección. No dejes que al terminar la fijación todo el bloque salga empujado sin más.

Cuando la primera pantalla es un logotipo de marca a página completa, usa el «Logotipo recogiéndose en la navegación» de más abajo. Cuando la primera pantalla es otro texto a página completa, una interfaz de producto o pura composición tipográfica, puede no convenir la profundidad; puedes colocar la narrativa accionada por el desplazamiento más adelante.

### Logotipo recogiéndose en la navegación (adecuado para páginas cuya primera pantalla es el logotipo de marca a página completa)

La primera pantalla es el nombre de marca en sí, y al hacer scroll se encoge hasta el logotipo de la barra de navegación. Un solo elemento cumple a la vez la función de esqueleto tipográfico a página completa y un tramo de narrativa accionada por el desplazamiento; es adecuado para estudios, marcas y portafolios con nombres de marca cortos y formas de glifo con carácter:

- La primera pantalla contiene solo este logotipo, que ocupa todo el ancho del área de composición y se mantiene en una línea ocupándolo también en pantalla estrecha; en la navegación no se coloca un segundo logotipo.
- Accionado por el desplazamiento: al recorrer 60–100 vh, el logotipo se encoge por una trayectoria hasta la posición y el tamaño del logotipo de la navegación, y al desplazarse hacia atrás se agranda de nuevo. El estado final es el logotipo de la navegación, con posición y tamaño medidos sobre la navegación real, sin saltos en el enlace.
- Para escalar el mismo elemento se usa una transformación, no se anima el tamaño de letra; el logotipo se hace en SVG, o con un tamaño de letra calculado a partir del ancho del contenedor.
- Mientras el logotipo cede la primera pantalla, el contenido de la sección siguiente ya ha entrado en el plano, sin dejar una pantalla entera en blanco.
- Que el logotipo pase de página completa a logotipo de navegación es un cambio de escala evidente del protagonista y un enlace, y cuenta como un tramo de narrativa accionada por el desplazamiento; no hagas además profundidad de primera pantalla en la misma página.
- Con movimiento reducido, el logotipo se queda en la primera pantalla sin escalar y la navegación muestra el logotipo desde el principio.

### Bloques que aparecen según el contenido (obligatorio, accionado por el scroll)

Cada bloque por debajo de la primera pantalla aparece una vez cuando llega a su posición, y no se reproduce al desplazarse hacia atrás. La forma de aparición se deduce del contenido y el material de ese bloque y sigue la intuición física: lo que tiene peso cae y se estabiliza con un rebasamiento, lo ligero encuentra resistencia del aire, lo mecánico encaja con un clic.

| Contenido del bloque | Forma de aparición |
| --- | --- |
| Tarjetas, objetos físicos, carteles de precio | Caída con peso y estabilización posterior; la amplitud del rebasamiento, en «Tacto» de [Animación](motion.md); cada pieza arrastra a la siguiente |
| Listas, líneas de tiempo, pasos | Se despliegan en orden siguiendo la dirección de lectura; las líneas de conexión se dibujan primero y los nodos se asientan después |
| Números, métricas | Cuentan hasta el valor objetivo: los dígitos altos se detienen antes y los últimos después; si no parten de 0, arrancan desde el valor original |
| Líneas, gráficos, trazados | Se trazan en la dirección de los datos o del flujo, y el extremo hace un pequeño aumento al asentarse |
| Imágenes, fotografías | La máscara se abre desde la dirección del sujeto del plano y la imagen se reduce a la vez de 1,08 a 1 |
| Papel, tela, etiquetas | Rápido al principio y lento al final, con una ligera rotación que se endereza, como si se depositara sobre la mesa |
| Metal, mecánica, hardware | Llegada breve y seca, sin rebote blando, con una posible vibración de retorno muy pequeña |
| Grandes titulares, eslóganes | Suben desde una máscara por palabras o por líneas, con el espaciado entre letras pasando de algo holgado a cerrado |

Reglas:
- La aparición de cada bloque se escribe en el guion gráfico: los bloques destacados diseñan su aparición según el contenido y los normales mantienen un ritmo sobrio y uniforme; no apliques el mismo fundido y desplazamiento hacia arriba de principio a fin de la página.
- Usa curvas de muelle o inercia, con los parámetros tomados por material de la tabla «Tacto» de [Animación](motion.md), no un ease por defecto.
- El protagonista llega primero y el resto es arrastrado, con intervalos de 40–80 ms; la aparición completa de un bloque no supera los 900 ms.

### Narrativa accionada por el desplazamiento (al menos un tramo, obligatorio)

Puede ser la profundidad de la primera pantalla, el logotipo recogiéndose en la navegación, o un plano secuencia en la parte central de la página; las reglas están en la sección siguiente. El protagonista debe cambiar de forma evidente al hacer scroll: escala, desmontaje, transformación, atravesar o relevo de formas. Que un punto pequeño avance por una línea o que los nodos se iluminen uno a uno solo cuenta como un detalle dentro de la narrativa principal, no como la narrativa principal por sí solo.

### Guion gráfico

Antes de empezar, escribe el guion de scroll en el apartado «Animación» de la tarjeta de dirección: qué técnicas has elegido y por qué, cuánto recorrido de scroll ocupa cada tramo, quién es el protagonista, qué hay en el plano de cada toma, qué se mueve, en qué dirección y cuándo aparece el texto. Desglosa primero el ritmo de scroll de dos landing pages de primer nivel del mismo tipo como referencia, deja claro qué se mueve en cada tramo de cada una, y después escribe el tuyo.

## Paralaje y plano secuencia

- **Plano secuencia.** Todo el tramo es una toma sin cortes. Un protagonista recorre de principio a fin, puede ser un producto, una línea, una forma o una palabra, y cada paso crece, se transforma o cede el paso al siguiente plano: acercarse para ver el detalle, alejarse para ver el conjunto, girar para ver el reverso, atravesar para entrar en la escena siguiente.
- **Busca el protagonista dentro del producto.** El protagonista es aquello que trata este producto, y recorre su propio proceso durante el scroll. Si no encuentras un protagonista propio de este producto, recurre a las técnicas de transición de más abajo, sin usar geometría flotante genérica.
- **Detente antes de hablar.** Deja un tramo de quietud en cada toma, y que el texto aparezca durante la quietud; leer mientras todo se mueve cansa.
- **El paralaje necesita una profundidad real.** Úsalo solo cuando el plano ya tiene niveles de distancia: objetos en primer plano, plano medio, fondo lejano; cuanto más cerca, más se mueve, y la diferencia debe ser pequeña. El cuerpo de texto, los botones y los formularios no hacen paralaje; el gran titular, como capa gráfica, se trata según la profundidad de primera pantalla de más arriba.
- **La transición también es una toma.** Un círculo se expande desde un punto y trae la sección siguiente; se empuja una imagen y se la atraviesa hasta llegar a la sección siguiente; el color de fondo cambia despacio entre capítulos al ritmo de la lectura; un manifiesto se ilumina palabra por palabra con el scroll. Cada técnica se usa una sola vez por página.
- **También funciona al desplazarse hacia atrás.** Cada fotograma se determina solo por la posición del scroll, de modo que hacia atrás se invierte de forma natural, y al refrescar o saltar al medio la imagen correcta aparece de inmediato. No te apoderes del scroll del usuario.
- **Deja una salida.** Antes de los tramos largos, ofrece una entrada para saltar; con movimiento reducido, ordena cada imagen estática en secuencia como bloques normales.
- **Lo que el código no puede hacer, déjalo al vídeo.** Si el usuario quiere una animación de primera pantalla muy potente y el efecto solo puede lograrse con vídeo generado o fotogramas en secuencia, por ejemplo un personaje girándose, un producto desmontándose o una cámara atravesando una escena, puedes indicarle que lo haga con [oil-motion](https://github.com/oil-oil/oil-motion). Lo que CSS, SVG o los shaders pueden resolver lo sigues haciendo tú; menciónalo una sola vez en la misma conversación.

## Dos modos de interacción con el scroll

Los cambios que produce el scroll se dividen en dos modos:

- **Accionado por desplazamiento (Scroll-Driven).** El progreso de la animación se mapea estrictamente 1:1 con la distancia de scroll (scrub). Si el usuario se detiene, la animación se detiene; si vuelve atrás, se invierte. La profundidad de la primera pantalla, el plano secuencia, las transformaciones de perspectiva 3D y la deconstrucción de modelos usan solo el modo accionado por desplazamiento; salvo la profundidad de primera pantalla, el plano secuencia se usa como máximo un tramo por página.
- **Accionado por el paso por el viewport (Scroll-Triggered).** Cuando el elemento entra en el umbral del viewport, se dispara una animación independiente que se reproduce con su propia duración (por ejemplo, la entrada de tarjetas o el ascenso de cifras). Cuándo termina lo decide el código, no la barra de scroll.
  - **Por defecto, unidireccional y de una sola vez (Once).** Tras el disparo, el estilo queda fijo; si el usuario vuelve a subir, no se reproduce ni se reinicia, y el contenido no entra volando ni parpadea repetidamente a mitad de la lectura.
  - **Reinicio al salir (Reset on Leave).** Solo las páginas puramente expositivas de ritmo fuerte pueden reiniciarse tras salir del todo del viewport; no dispares repetidamente en el límite del viewport.

## Scroll suave y segmentación a pantalla completa

- **El scroll suave solo busca que el desplazamiento sea fluido; no cuenta como animación.** Bibliotecas como Lenis sirven para eliminar el salto de una muesca de la rueda del ratón y para que las animaciones accionadas por desplazamiento y el paralaje avancen de forma uniforme. Los paneles de administración, los cuadros de mando, los formularios y los documentos largos no activan scroll suave global; mantienen la respuesta inmediata del scroll nativo.
- **Usa con prudencia el scroll segmentado a pantalla completa (Snap Scroll).** Ocultar la barra de scroll y cambiar una pantalla entera por gesto solo encaja en salas de exposición a pantalla completa y portadas de obra concretas; no lo uses en negocio habitual ni en texto largo.

## Bibliotecas de animación

La animación de scroll de las landing pages debe usar una biblioteca de animación madura; no escribas a mano escuchadores de scroll ni cálculos por fotograma:

- **Páginas sin framework**: GSAP, con ScrollTrigger para el scroll (`scrub` para accionado por desplazamiento, `once` para accionado por paso por viewport, `pin` para fijar el escenario), SplitText para dividir los titulares y Flip para cambiar de posición los elementos. Para scroll suave, Lenis, conectado al reloj de GSAP: `lenis.on('scroll', ScrollTrigger.update)`, `gsap.ticker.add((t) => lenis.raf(t * 1000))`, `gsap.ticker.lagSmoothing(0)`. GSAP y sus plugins pueden usarse gratis.
- **Proyectos React, Vue, etc.**: mantén la biblioteca de animación que ya use el proyecto (Motion, GSAP, etc.); si no tiene, añade GSAP, sin escribir además una propia.
- **Obras que deben abrirse sin conexión**: coloca los archivos de la biblioteca en el directorio de la obra con una versión fija y referéncialos en local, sin depender de un CDN.
- **Movimiento reducido**: separa dos conjuntos con `gsap.matchMedia()`: con movimiento reducido no se fija ni se escala nada, todos los bloques llegan directamente a su sitio y la narrativa principal se ordena como imágenes estáticas en secuencia.
- Anima solo transformaciones, opacidad y filtros. La altura exterior del escenario fijo es la distancia de scroll de ese tramo; las animaciones fuera de pantalla las pausa la biblioteca automáticamente. En pantalla estrecha puedes acortar la distancia y reducir la amplitud, pero conservando todas las técnicas elegidas.

## Comprobación

Recorre de principio a fin y vuelve a subir, mirando cada vez: si al retroceder se invierte, si al refrescar en un punto intermedio la imagen es correcta, si el texto aparece durante la quietud, si están todas las técnicas elegidas para pantalla estrecha y si con «movimiento reducido» activado todo el contenido es legible directamente.
