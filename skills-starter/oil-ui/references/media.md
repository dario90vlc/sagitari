# Material gráfico

De dónde salen las imágenes, qué función cumplen y cómo se integran con la página. Los personajes, objetos, coleccionables y atlas que necesitan los productos de juego, colección y crianza se tratan en "Conjuntos de material".

## Índice de navegación

- [Qué asume la imagen](#qué-asume-la-imagen)
- [Reutilizar, generar o delegar en código](#reutilizar-generar-o-delegar-en-código)
- [Hacer que la imagen cargue significado](#hacer-que-la-imagen-cargue-significado)
- [Escribir el prompt](#escribir-el-prompt)
- [Juzgar después de colocarla en la página](#juzgar-después-de-colocarla-en-la-página)
- [Integrar la imagen con la página](#integrar-la-imagen-con-la-página)
- [Usar una pintura como escenario](#usar-una-pintura-como-escenario)
- [Unificar material heterogéneo con monocromo](#unificar-material-heterogéneo-con-monocromo)
- [Derivar el visual principal de una técnica abstracta](#derivar-el-visual-principal-de-una-técnica-abstracta)
- [Conjuntos de material: personajes, objetos y atlas](#conjuntos-de-material-personajes-objetos-y-atlas)
- [Texturas reales y material científico y de ingeniería](#texturas-reales-y-material-científico-y-de-ingeniería)
- [3D en tiempo real](#3d-en-tiempo-real)
- [Ruta opcional de vídeo generado](#ruta-opcional-de-vídeo-generado)
- [Archivos y documentación](#archivos-y-documentación)

## Qué asume la imagen

El material es el punto de partida del diseño, no un adorno que se rellena cuando el maquetado ya está terminado. Pregunta primero: si solo conservaras una imagen, un título y una acción, ¿qué imagen merece ocupar ese lugar? Después decide si hacen falta más módulos.

- **Distingue de dónde viene la diferencia.** ¿Es un problema de información y composición, o falta de verdad una imagen capaz de expresar el producto y la marca? No tapes problemas de jerarquía con más imágenes, efectos de luz y animaciones, ni sustituyas las imágenes necesarias por degradados genéricos y formas geométricas solo porque el código es fácil de escribir.
- **Dale a cada imagen una frase de encargo.** ¿Muestra el objeto, explica una relación, o construye marca y emoción? ¿Qué debe entenderse de un vistazo? Si no sabes responderlo, no busques ni generes la imagen todavía. Lo que la imagen ya dice con claridad, el texto no lo repite.
- **El back office y las herramientas también requieren criterio.** La miniatura de un objeto ayuda a identificarlo, la portada de un contenido facilita la exploración, un mapa o una vista espacial ayuda a ubicarse, un esquema explica relaciones; pueden ser la parte más valiosa de la interfaz. Cuando una tarea puramente de datos no se beneficia de ello, conserva una expresión de datos clara y no fuerces imágenes ambientales.
- **La imagen se decide con la estrella polar, y la página después le responde.** Sujeto, punto de vista, escala, luz, color, material y espacio en blanco los decide la estrella polar del diseño; la tipografía, el fondo, el tratamiento de bordes y el movimiento de la página construyen la respuesta a partir de esa imagen, y también puede usarse un contraste controlado para destacar la acción principal. Las imágenes de un mismo grupo unifican escala del sujeto, punto de vista, luz y textura de bordes; no se les aplica el mismo filtro a todas.
- **La imagen es estructura, no una ilustración metida en una caja.** Déjala cruzar la división del maquetado, ocupar toda la primera pantalla o superponerse al texto; el procedimiento está en "Integrar la imagen con la página".
- **Colócala primero en la página real y mira una ronda antes de extenderla a otras zonas.** Mientras el material no esté resuelto, una revisión estética con marcadores de posición no cuenta como aprobación final.

## Reutilizar, generar o delegar en código

- **Si hay algo adecuado, reutilízalo.** Mira la imagen de verdad antes de citar sus rasgos; cuando ya existe buen material, diseña alrededor de él y no generes de nuevo solo para demostrar que usaste la herramienta.
- **Si no lo hay, créalo.** Cuando no exista material adecuado y el anfitrión pueda generar imágenes, produce activamente el material clave; no omitas este paso porque estés escribiendo código de front-end. Sigue las reglas de entrada y edición de la propia herramienta de generación del anfitrión. Además del producto principal, puedes incorporar al conjunto el entorno geográfico donde se ubica el producto, la textura de las materias primas y el detalle de los procesos, para que la página tenga un contexto completo y no solo unas cuantas fotos de estudio aisladas sobre fondo blanco. Cuando necesites materiales reales, objetos de diseño, fotografía histórica, cartografía de ingeniería, mapas antiguos, grabados científicos o material aeroespacial real, usa `curate-media.mjs` para buscar en Poly Haven, Wikimedia Commons, las colecciones abiertas de los grandes museos (incluidos los museos nacionales de Japón y la Biblioteca del Congreso de Japón), LOC, Wellcome y NASA, y descargar a `assets/` local. Las entradas cuya licencia no permite incluirlas en la página también sirven: descárgalas a un directorio que no se publica, úsalas como imagen de referencia para generar, toma de ellas pistas de tema, época, composición y material, y no dejes que el resultado generado copie la imagen original. Los comandos de descarga numerada, enlace directo a texturas, hoja de contactos y póster de vídeo están en [Herramientas](tools.md#buscar-y-descargar-materiales-reales); la descarga genera automáticamente `SOURCES.md`, con el que se conservan la licencia y la atribución de cada entrada.
- **Para objetos físicos que deban deformarse en tiempo real con la interacción, usa vector multinivel o renderizado en tiempo real junto con imágenes estáticas.** En zonas como selectores de configuración, cambio de especificaciones o despiece en sección que deben cambiar de proporción, pieza o tono al instante con cada clic del usuario, una única foto estática desconecta la interacción de la imagen. Reserva la imagen estática para la atmósfera, el entorno y los primeros planos de material; dibuja el sujeto que debe reaccionar en tiempo real con SVG en línea (con tres niveles de detalle: volumen iluminado del contorno, piezas de unión estructural y textura superficial; no como un icono plano de color uniforme) o con Canvas/3D, para que cada cambio se cumpla de inmediato en la imagen.
- **El texto y la interfaz van en código.** Textos, botones, formularios, etiquetas de datos y el maquetado habitual se componen siempre con HTML/CSS real; no los dibuja un modelo de generación de imágenes, ni se usa una captura completa como producto interactivo: los modelos escriben mal el texto, no se puede corregir y no se puede seleccionar ni leer con lector de pantalla. La imagen solo se encarga de objetos, materiales y luz.
- **Si no puedes hacerlo, deja un brief.** Sin red y sin capacidad de generación, dibuja con vector multinivel el objeto central y la sección con claridad y adjunta un brief de material. No instales herramientas automáticamente, no cambies a servicios de pago ni pidas al usuario pegar claves en la conversación.
- Para objetos que giran, tienen física o cambian con el punto de vista, consulta "3D en tiempo real"; para cambios continuos predeterminados, consulta "Ruta opcional de vídeo generado".

## Hacer que la imagen cargue significado

El fallo más común de una imagen generada no es que esté mal dibujada, sino que está demasiado llena: cuanto más rico es el detalle, más se parece a una foto de banco de imágenes, y al colocarla en el maquetado no tiene foco ni relación con la página.

Una "escena bonita" sin relación con el producto solo roba protagonismo dentro del maquetado; llenar de detalle cada rincón equivale a no tener foco. Al dibujar objetos reales o escenas reales, trabaja a fondo la textura y la luz del sujeto y deja limpios el fondo y la zona donde irá el texto; al dibujar funciones abstractas o cambios antes/después, puedes comprimir grandes superficies en monocromo, modelo blanco o desenfoque y dejar que solo unos pocos puntos clave muestren color, luz o detalle.

Elige un sujeto que pueda "conectarse" con la página:

- Un objeto único capaz de cruzar la división entre dos superficies de color.
- Un elemento lineal capaz de extenderse fuera del encuadre.
- Un espacio sobre el que se pueda anotar: un modelo, un mapa, una sección, una planta.

Un sujeto así puede después unirse con las líneas, anotaciones y bloques de la página; una foto de paisaje autosuficiente no lo consigue.

## Escribir el prompt

Escríbelo en un orden fijo, con una o dos frases por apartado:

1. **Sujeto y forma de representación**: qué es y en qué género se presenta (foto, ilustración, modelo o diagrama); el género se deduce de la dirección de la página.
2. **Composición y espacio en blanco**: posición y proporción del sujeto en el encuadre, y qué zona se deja libre para el texto. Escribe la región que ocupa el sujeto y su proporción según el esqueleto de primera pantalla ya elegido, y que el bloque reservado al texto quede completamente limpio. En la zona libre no debe haber brillos, reflejos ni texturas desordenadas, para garantizar que el texto sea claro y legible.
3. **Distancia de seguridad**: el sujeto, la peana y la sombra no deben tocar el borde del texto; deja un margen de alrededor del 10 % para evitar que el texto se monte sobre el objeto cuando la pantalla se estreche.
4. **Fondo**: escribe directamente el valor hexadecimal que usa realmente la página, o pide un fondo totalmente transparente. Con el color igualado, el borde se funde de forma natural en la web y no hace falta corregirlo con una máscara CSS adicional.
5. **Material y luz**: dirección de la luz principal, luz de relleno y textura. Las distintas imágenes de una misma página usan la misma dirección de luz. El reflejo del suelo se atenúa de forma natural hacia el lado libre y no barre la zona de texto.
6. **Exclusiones**: nada de texto, logotipos, pseudocódigo, capturas de interfaz ni objetos flotantes sobrantes; en iconos pequeños o imágenes transparentes indica "sin sombra proyectada en el suelo", y deja la sombra exterior al control del CSS del front-end con `filter: drop-shadow(...)`.

## Juzgar después de colocarla en la página

Mírala en la página real y a tamaño real, no la juzgues en el visor de imágenes. Una imagen que se ve muy bien sola, al entrar en el maquetado suele quedar con el sujeto demasiado lleno, con la orientación equivocada o con el espacio libre en el lugar incorrecto.

Si no funciona, corrige el prompt y vuelve a generar, y escribe con claridad qué hay que cambiar, por ejemplo "mueve el sujeto a la derecha y deja medio espacio libre a la izquierda" o "elimina el reflejo del suelo y cambia el fondo al valor de color de la página". No rehagas el maquetado alrededor de una imagen inadecuada. De un mismo lote, elige la que mejor se maqueta, no la que tiene más detalle.

## Integrar la imagen con la página

**Fusión con el fondo.** El visual principal y las imágenes grandes que deben fundirse con el fondo no llevan marco ni se encierran en una tarjeta redondeada: toma el color real de las cuatro esquinas de la imagen, usa el mismo valor en el fondo de la página, o difumina los cuatro bordes hasta el color de fondo con una máscara CSS o un degradado exportado. Con fondo de color plano, si el color base del prompt coincide con el de la web, el borde se une de forma natural.

**Imágenes transparentes.** Colócalas primero sobre el fondo final y revisa bordes, halos blancos y restos de cuadrícula; para comprobar el canal alfa hay que mirar los píxeles, no la extensión del archivo. La sombra no se hornea en la imagen: la añade la página según el fondo real, y así funciona también si cambia el fondo.

**Cruzar la estructura.** Coloca un objeto transparente sobre la línea que separa dos bloques de color o dos secciones, para que pertenezca a ambas a la vez.

**Relevo entre imagen y código.** La imagen generada se encarga de los materiales y la luz que el código no puede producir, como metal, cristal, modelos o haces de luz. El código se encarga de lo que debe ser preciso, editable y continuar, como líneas, trayectos y anotaciones que salen de la imagen. Si una parte de la imagen debería continuar en la página, recórtala y sigue dibujándola con vectores. Así puede atravesar el maquetado con exactitud, llevar texto real y volver a trazarse en distintos anchos.

**Anotaciones.** Anota sobre la imagen con líneas finas de llamada más texto, no con tarjetas de burbuja con fondo y sombra. El extremo de la línea debe apuntar a la posición real dentro de la imagen: la imagen ocupa una posición y un tamaño fijos en el maquetado, así que las coordenadas se convierten según sus píxeles. En pantallas estrechas oculta las anotaciones o conviértelas en una lista bajo la imagen, para que no se desplacen a posiciones equivocadas.

**Recorte en pantallas estrechas.** No reduzcas toda la escena grande de forma proporcional hasta volverla ilegible. Recorta de la imagen original la zona de foco y guárdala aparte para pantallas estrechas, o usa el posicionamiento de objeto para centrar el foco. Tanto el recorte de escritorio como el de móvil deben conservar los puntos que llevan la información.

**Una imagen, varios usos.** En el cierre u otra sección puedes usar un primer plano de la misma imagen; resulta más coherente que generar otra con luz y estilo que no encajan.

## Usar una pintura como escenario

Otro uso es el contrario: la imagen no informa, solo aporta atmósfera, la interfaz se mantiene sobria en blanco y negro y toda la página usa una única pintura con pincelada como única fuente de color.

- **La pintura es el escenario y la interfaz se presenta encima.** Coloca sobre la pintura una versión simplificada de la interfaz real, con la pintura asomando por los cuatro lados. Al hacer scroll la pintura queda fija y solo cambia el contenido de la interfaz delantera; encaja con la "narrativa por scroll".
- **Recorta con audacia.** Conserva solo una esquina o un fragmento de la pintura, casi abstracto, para no competir con la interfaz. El tema no tiene que estar literalmente relacionado con el producto, pero el carácter debe encajar.
- **Lo suelto y lo preciso se realzan.** Cuanto más suelta es la pintura, más precisa y limpia debe ser la interfaz; cuando aparecen juntas, ambas se ven mejor.
- **Úsala poco.** Una pintura recorre toda la página, o aparece solo en dos o tres lugares, como la parte superior de la tarjeta de precio y el pie; no pongas una por sección. Las pinturas de una misma página comparten técnica y pincelada.
- **Demuestra con una interfaz real simplificada.** Difumina o sustituye por esqueletos el contenido secundario y deja claro solo el punto que quieres explicar; dibuja las comparaciones de cifras directamente con elementos de interfaz, por ejemplo dos barras de progreso de longitud distinta, en lugar de crear otro gráfico aparte.

## Unificar material heterogéneo con monocromo

Al incorporar pinturas históricas, retratos escultóricos o material fotográfico externo, los mapas de bits en color chocan fácilmente con el color temático de la interfaz. Un tratamiento monocromo uniforme reúne material de distintos orígenes dentro de la dirección actual:

- **Mapeo monocromo**: convierte el material a blanco y negro de alto contraste y luego mapea las zonas oscuras y las claras al color principal y al color de fondo de la página.
- **Trama de puntos y tramado**: aplica semitono de trama o un sutil efecto de líneas de escaneo a las imágenes realistas, para disolver su textura fotográfica y permitir que convivan con la composición tipográfica y la retícula.

## Derivar el visual principal de una técnica abstracta

Cuando faltan capturas del producto, no recurras a la típica esfera luminosa de colores o al gran degradado. Busca entre lo que procesa el producto un objeto con forma: cómo son los datos que lee y escribe, cuál es la herramienta o el proceso al que sustituye, qué tiene a mano su usuario. La forma de representación debe cumplir dos condiciones: una amplia superficie de color con escalas estables sobre la que el texto se sostenga, y líneas y reglas en la imagen que el SVG/CSS pueda continuar. Si no encuentras un objeto con forma, deja el visual principal a la propia composición tipográfica.

## Conjuntos de material: personajes, objetos y atlas

Los productos de juego, colección y crianza no necesitan una ilustración, sino un conjunto completo de material que se colocará, girará y comparará una y otra vez.

- **Escribe primero la guía de estilo.** Una frase para cada punto: técnica, punto de vista, dirección de luz, material, proporción y paleta; todos los prompts del lote se escriben según ella.
- **Distingue la serie por la silueta.** Unifica proporción y dirección de luz y diferencia a cada individuo por rasgos de silueta como orejas, objetos o accesorios, no solo cambiando el color. Debe poder distinguirse de un vistazo al tamaño real de visualización.
- **Deriva los estados múltiples de la misma imagen.** Etapas de crecimiento, anverso y reverso, antes y después de abrir la cáscara, distintas acciones: edita variantes tomando la primera como imagen de referencia y mantén el mismo personaje; alinea el punto de apoyo de todos los estados sobre la misma línea de base.
- **Recorta el atlas transparente por la silueta.** Deja separación transparente entre celdas y recorta según el contorno real, no dividiendo la retícula por igual, porque de lo contrario cortarás copas de árbol y arrastrarás fragmentos de la celda vecina. Revisa los píxeles alfa, no el color de fondo de la vista previa, y comprueba después los bordes sobre el fondo final.
- **Al aplicarlo a un objeto debe funcionar por ambos lados.** El material que gira, cae o pasa de lado necesita anverso y reverso, con el borde cerrado según el contorno. La iluminación la aporta la escena; no hornees en la imagen luces y sombras con dirección contraria a la de la escena.

## Texturas reales y material científico y de ingeniería

Selecciona leyendo la hoja de contactos PNG que genera `--sheet`, y usa `imageUrl` para descargar; los colores de los cuatro bordes, el fondo de papel y las zonas limpias de `look` corresponden directamente a la fusión con el fondo, el modo multiplicar y la posición del texto descritos más abajo. En Poly Haven, `textureMaps.diffuse.url` es el mapa de color de superficie, mientras que `roughness` y `normal` se usan respectivamente para la rugosidad y la normal del material en tiempo real; las imágenes de esfera de render y las vistas previas de modelos no sirven para repetir en mosaico.

- Usa el JPG difuso como `background-repeat: repeat` de CSS o como `<pattern>` de SVG, y comprueba las costuras de los cuatro bordes y la frecuencia de repetición al tamaño final. Algunos materiales se repiten solo en un eje; no des por hecho que son perfectos en ambos ejes mirando solo la miniatura.
- En Three.js, el mapa de color usa sRGB y la rugosidad y la normal usan datos lineales; esta herramienta selecciona normales OpenGL, así que comprueba la dirección según las UV del modelo y la iluminación real. En materiales repetidos, activa RepeatWrapping en ambos ejes; las texturas UV que el modelo glTF toma del manifiesto se usan para ese modelo y no pueden tomarse como material repetible.
- De los resultados cartográficos, elige solo los recursos de planos hh de LOC, y examina por separado fotografías, memorias de estudio y planos. El tamaño de la imagen original IIIF de mapas y grabados puede diferir del tamaño descargado; usa el ancho y alto de la salida descargada para juzgar si soporta la ampliación y las anotaciones de la página.
- En la búsqueda de vídeo de NASA, excluye los elementos cuyo título o palabras clave indiquen claramente animación, simulación o visualización, y aun así revisa el metraje para confirmar que cumple el requisito de grabación real. El póster del primer fotograma es el respaldo estático; comprueba primero en la página real la reproducción de fondo, el bucle y el recorte.
- La licencia acompaña al registro del material. La salida de Poly Haven declara CC0 y la atribución de la fuente, Wellcome conserva la licencia de cada entrada; LOC no permite suponer que todas las entradas están libres de derechos. De Met, AIC, Cleveland y Rijksmuseum toma solo entradas de dominio público o CC0; de Japan Search toma solo CC0, dominio público, CC BY y CC BY-SA, y las imágenes de ColBase deben atribuirse como "Procedencia: ColBase" según sus requisitos; Commons se rige por la licencia de cada archivo, y si se recolorea o compone material BY-SA debe compartirse con la misma licencia. La API pública de V&A da acceso a imágenes de alta resolución, pero el acceso público no equivale a autorización para portada, uso comercial o publicación en alta resolución, por lo que se marca como `reference`. Las condiciones de uso de NASA conservan la atribución y las restricciones de terceros. Los términos oficiales se conservan junto con `SOURCES.md`; cuando haya que mostrar atribución, colócala en el pie o en las notas de material del proyecto.

## 3D en tiempo real

Se usa 3D en tiempo real en tres casos: objetos que el usuario quiere girar e inspeccionar; física como apilamiento, colisión, empuje u oscilación; y materiales que cambian con el punto de vista, como cristal, metal o plástico transparente. Lo que una imagen generada ya expresa, o lo que solo busca parecer sofisticado, no lo necesita.

- Usa un motor maduro como three.js, y añade una biblioteca de cuerpos rígidos cuando haga falta física. La imagen generada sirve como textura, sprite o fuente de luz ambiental; el código se encarga del espacio, el movimiento y las fuerzas.
- La aceptación se juzga por la imagen, no por haber usado una biblioteca: en un fotograma fijo se aprecian volumen, perspectiva, sombra de contacto y distinción de materiales; en la grabación de pantalla el movimiento es continuo y la fuerza se transmite al objeto empujado.
- En prototipos nuevos, descarga la biblioteca a `vendor/` dentro del directorio de la tarea y adjunta la licencia, sin referenciar CDN; en proyectos existentes, intégrala según el modo de dependencias que ya use el proyecto. Las páginas con importación por módulos y las texturas deben abrirse mediante un servidor local; si se requiere abrir con doble clic, empaqueta en un script normal con las texturas en línea o en el mismo directorio.
- Limita el device pixel ratio a 2; detén los fotogramas cuando la página se oculta o sale del viewport; si no hay WebGL disponible, muestra una imagen estática de la misma escena; con movimiento reducido, calcula el resultado igualmente y solo desactiva el balanceo de cámara y el espectáculo decorativo.
- Antes de capturar, confirma que el lienzo ha dibujado contenido de verdad; consulta [Herramientas](tools.md).

## Ruta opcional de vídeo generado

Cuando necesites un material que se reproduzca en bucle superpuesto a la página, revisa primero tres cosas: si el principio y el final empalman, si los bordes del sujeto están limpios y cómo está resuelto el fondo. Generar sobre un fondo monocromo y recortar después es solo una de las opciones que puedes probar: los objetos transparentes y reflectantes pueden perder el borde al recortarlos o conservar el color del fondo, así que compruébalos sobre el fondo final de la página.

Para encadenar varios vídeos en una narrativa, puedes usar el último fotograma del anterior como primer fotograma del siguiente, o planificar de antemano los fotogramas clave de todos los segmentos de forma unificada. Cuando el progreso de reproducción lo controlen el scroll o los gestos, comprueba el salto a cualquier fotograma, la reproducción inversa, la velocidad de carga y el consumo de memoria; no des por hecho que se puede decodificar el vídeo completo en una sucesión de imágenes grandes.

En objetos que necesitan refracción o transmisión de luz, como cristal o cuarzo, genera primero la imagen sobre el color de fondo de la página final para que la refracción y la sombra proyectada queden horneadas en el material, y luego elimina el fondo con un modelo de recorte de vídeo. Si generas directamente sobre croma verde y recortas después, la refracción arrastra verde. La refracción y la iluminación prerrenderizadas corresponden solo al fondo con el que se generaron; no prometas que producirán efectos físicos en tiempo real con cualquier contenido de la página.

El vídeo con fondo transparente, igual que las imágenes, puede cruzar la línea entre dos secciones; el procedimiento está en "Cruzar la estructura" más arriba.

## Archivos y documentación

- Exporta al doble del tamaño de visualización y no incrustes directamente la imagen original a tamaño completo. Usa JPEG o WebP para imágenes opacas y WebP o PNG para las transparentes; mantén cada archivo en unos cientos de KB. Al incrustarlo como data URL, el tamaño crece alrededor de un tercio más.
- Conserva los prompts, las imágenes originales y las versiones procesadas, y deja claro el origen, el uso y el tratamiento de cada imagen, distinguiendo reutilización, recorte, generación y posprocesado.
- Las imágenes generadas y el material sustituto no se hacen pasar por capturas reales del producto, lugares reales, personas reales ni pruebas del producto.
