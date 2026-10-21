# Lenguaje visual

## Navegación del índice

- [Del conjunto al detalle](#del-conjunto-al-detalle)
- [Foco y espacio](#foco-y-espacio)
- [Tipografía y contenido](#tipografía-y-contenido) (incluye [La legibilidad es un umbral de entrega](#la-legibilidad-es-un-umbral-de-entrega))
- [Color y superficies](#color-y-superficies)
- [Controles e iconos](#controles-e-iconos)

## Del conjunto al detalle

Primero mira el foco de la información, la composición y la densidad del contenido; después ajusta el espacio, la tipografía, el color y el detalle. Si el paso anterior ya resolvió el problema, no añadas estilos encima solo para parecer cuidadoso.

Si el proyecto ya tiene variables visuales, componentes y referencias, úsalos. Cuando no exista un estándar previo, define únicamente los pocos tamaños de texto, colores y espaciados que necesites ahora, sin inventar de la nada un sistema de diseño completo.

Cada modificación debe poder decir: qué elemento visible tiene un problema, con qué relación de ese elemento se origina, cómo piensas ajustarlo y en qué debería mejorar tras el ajuste. Leer el código fuente puede demostrar una incoherencia de estilos, pero no puede demostrar que la imagen haya mejorado.

## Foco y espacio

- Cada zona debe dejar claro de un vistazo cuál es la información o la acción más importante; el resto de la información retrocede mediante texto más pequeño, pesos más ligeros, menor contraste o una posición hacia el borde; no dejes que varios énfasis se disputen la atención a la vez.
- Usa el mismo espaciado para el mismo tipo de relación: más apretado dentro de un grupo, más holgado entre grupos. Primero levanta la estructura con alineación y espacio en blanco; después valora si necesitas contenedores o líneas divisorias.
- El espacio en blanco sirve para agrupar, destacar y controlar el ritmo. Las interfaces de herramientas no recortan información necesaria solo por parecer despejadas, y las páginas de marca tampoco tienen que llenar la primera pantalla.
- Las composiciones asimétricas, las formas que se salen del borde y los textos muy grandes pueden expresar la dirección elegida, pero lo local debe quedar alineado y el orden de lectura debe ser claro; una asimetría intencionada no se corrige como si fuera un error.
- Cómo se disponen las zonas entre sí lo gobierna el layout padre; el componente solo gestiona el espacio de su interior. Una misma distancia no debe sumarse varias veces desde distintas capas de estilos.
- Coloca primero el contenido directamente sobre el lienzo y organízalo con alineación, tamaño de letra y espacio en blanco. Añade contenedores solo cuando de verdad necesites agrupar, indicar selección, separar el fondo por contraste o delimitar un área de acción; no anides página, módulo, elemento y descripción del elemento en capas de tarjetas.
- No dupliques líneas divisorias ni bordes. Cada línea hace una sola cosa: en el mismo punto no superpongas línea doble ni añadas un marco a una línea simple; donde el espacio en blanco ya separa, no añadas línea; no dibujes líneas en todos los niveles. El grosor de la línea corresponde a la jerarquía: por ejemplo, línea gruesa separa planas de página y línea fina separa columnas, de forma coherente en toda la página. Cuando la línea forma parte del estilo, consérvala igualmente; elimina solo las repetidas.

## Tipografía y contenido

- Divide el texto en varios roles —títulos, cuerpo, información auxiliar, etiquetas y datos— y fija el estilo de cada rol; la diferencia entre niveles debe ser suficiente. Si hay salto de línea y cuánto espacio se reserva se decide según la longitud del contenido real.
- Revisa las formas de los glifos, los pesos y las fuentes de respaldo con el idioma real del producto. Una muestra en inglés que se ve bien no garantiza que el texto en chino se componga igual; en composiciones mixtas chino-inglés, comprueba si las líneas base están alineadas y si las dos tipografías parecen tener el mismo peso.
- La longitud de línea y la interlínea del cuerpo se deciden por la comodidad de lectura; las tablas densas están para escanear y comparar, así que no copies la composición de un artículo. Usa cifras de ancho fijo para números que se comparan en vertical o cambian al hacer scroll; para cifras sueltas grandes y campos de importe centrados, elige según la belleza de las formas.
- No recortes nombres y descripciones importantes con una altura fija. Cuando de verdad haya que truncar, deja una entrada para ver el contenido completo y evita que nombres parecidos sean indistinguibles después del truncado.
- Escribe primero el contenido concreto del producto y después ajusta el layout. En los botones escribe qué ocurre al pulsarlos; al explicar en qué destaca el producto, describe usos reales, sin consignas vacías, avales inventados ni inglés sin sentido para rellenar la página.

### La legibilidad es un umbral de entrega

El tamaño de letra y la interlínea se juzgan en el viewport real, con la fuente real y a tamaño de lectura del 100 %; las miniaturas solo sirven para juzgar la composición. En páginas de lectura, el cuerpo en chino suele partir de 16–18 px; en interfaces de producto, el cuerpo va de 14–16 px; las herramientas de alta densidad que se usan muchas horas al día pueden llegar a 13–14 px; la interlínea del cuerpo sin unidad va de 1.6–1.75; el texto de acciones suele ir de 14–16 px. Son puntos de partida, no reglas rígidas válidas para todos los productos. No busques un aire «refinado» con notas de 9–12 px, texto fino de bajo contraste o interlíneas comprimidas. Si hay demasiada información, primero elimina lo redundante, ajusta la jerarquía o recompón.

Los títulos multilínea en chino suelen empezar con una interlínea de 1.2–1.35, comprobada con las formas reales de los glifos. No copies la interlínea extremadamente apretada de los carteles en mayúsculas inglesas, no fijes la altura del título a una sola línea y no comprimas el contenido posterior con márgenes negativos. Cuando el texto de exhibición necesite de verdad ir más apretado, revisa el salto de línea real en cada viewport soportado y confirma que los glifos no colisionan.

El corte de línea en chino se controla activamente: `text-wrap: pretty` o `balance` solo reducen las palabras huérfanas, no las eliminan. Los números con su unidad (38 segundos, 47 minutos) y las palabras que no se pueden partir como «no» se envuelven con no-break; los párrafos cortos como la explicación de la primera pantalla o las notas al margen se cortan a mano según el sentido. Que al final de una línea queden solo una o dos caracteres, o que una palabra se parta en dos líneas, cuenta como defecto.

**Texto de exhibición estrecho (Condensed / Compressed)**: úsalo solo para títulos de exhibición y etiquetas de numeración muy cortas; sacrifica la legibilidad horizontal, así que el cuerpo y la lectura larga usan una tipografía de ancho normal.

En la aceptación, revisa títulos largos, cuerpos de dos a tres líneas, composición mixta chino-inglés, números con unidad y fuentes de respaldo; en pantalla estrecha y con lectura ampliada, revisa el interlineado, los bloques superiores e inferiores y el interior de los botones. Que el texto se solape, que se trunque información clave o que quede tapado por una zona contigua significa que está sin terminar. Corrige primero la interlínea, la altura guiada por el contenido y la elasticidad del contenedor; solo después plantea reducir el tamaño de letra.

### Los datos de ejemplo deben parecer reales

Los datos de ejemplo delatan la sensación de plantilla, incluso cuando la capa visual ya está bien. Evita: métricas redondas (1.000 usuarios, +10 %), nombres tipo Juan Pérez y empresas de ejemplo, que todo diga «hace 2 horas», textos de relleno como «Título» y «Descripción», y el «Saber más» o «Empezar ahora» que se repiten por la página. Los datos reales son irregulares: 1.238 usuarios, +1,83 %; las horas incluyen «ahora mismo», «ayer 16:12», «14 de marzo»; los nombres son unos largos y otros cortos, lo que de paso verifica la composición de nombres largos. Los botones dicen la acción concreta, por ejemplo «Guardar borrador», «Enviar el martes». Cuando una página tiene muchas demostraciones (catálogo de componentes, biblioteca de plantillas, muestra de funciones), haz que compartan un mismo escenario ficticio concreto: el mismo producto, las mismas personas, el mismo conjunto de archivos y números; que las demostraciones se respondan entre sí resulta mucho más creíble que inventar para cada una su «Título de ejemplo»; no uses nombres de bibliotecas ni stacks técnicos como contenido de la demostración.

## Color y superficies

Cada color tiene un uso fijo: texto, fondo, acción, selección o estado. El color de marca y los colores de estado pueden coexistir, pero los estados importantes no pueden distinguirse solo por el color.

Bordes, sombras, materiales y degradados deben ir en la misma dirección y ayudar de verdad: separar niveles, aportar ambiente o hacer reconocible la marca. El morado, las esquinas redondeadas y los degradados no están prohibidos; el problema es repetirlos por todas partes sin motivo, no distinguir lo principal de lo secundario o que no encajen con la tarea.

No pongas a cada tarjeta normal un color de énfasis, un borde grueso y una sombra pesada distintos. Lo que está en el mismo nivel debe parecer igual de pesado; el contorno que va dentro debe armonizar con el contenedor que lo envuelve.

Los niveles de superficie pueden distinguirse por desplazamientos de temperatura y tono, no solo por claridad y oscuridad. Para elegir la paleta, consulta «Definir el color» en [Dirección de diseño](design-direction.md); esta sección solo trata de cómo usar el color.

La textura se toma según el grado de acabado del tono, sin mezclar:
- Extremo refinado: tolerancias pequeñas, niveles finos; los medios concretos se buscan en el motor de generación de esta dirección.
- Extremo tosco: huellas de lo manual y de la impresión; se buscan en el motor de generación de esta dirección, sin aplicar un juego fijo de recursos.

**Sistemas monocromáticos y bicromáticos**: además de varios grises neutros más un color de énfasis, también puedes usar en toda la página solo un color principal y un color de fondo, con la información secundaria, los bordes y los estados deshabilitados derivados del color principal mediante opacidad o mezcla con el color de fondo.

**Alternancia de bloques en positivo y negativo**: en páginas largas, los bloques pueden alternar entre fondo oscuro con texto claro y fondo claro con texto oscuro con un corte de borde duro, sin transición de degradado, creando pausas claras entre secciones.

Comprueba sobre el fondo real si el texto, los límites de los controles, el foco y el estado de selección se ven con claridad; especialmente cuando el fondo es una imagen, es semitransparente o se mueve. Si el proyecto ya tiene requisitos de accesibilidad, cúmplelos; leer el contenido y realizar las operaciones básicas no debe obligar a adivinar.

## Controles e iconos

Los iconos de una misma interfaz se dibujan con el mismo trazo, parecen del mismo tamaño y se alinean con el texto contiguo. Para los iconos genéricos, prioriza una biblioteca de iconos madura; las ilustraciones propias de la marca se dibujan aparte, sin forzar un icono para cada título.

Lo que se puede pulsar debe verse pulsable y debe dar respuesta al pulsarse. Por defecto, pulsado, enfocado, seleccionado, deshabilitado y en proceso son significados distintos y deben verse distintos; las entradas que solo aparecen al pasar el ratón también deben ser alcanzables en pantalla táctil y con teclado. Cuando cambia el estado, el área de clic no crece ni se encoge, ni desplaza el layout contiguo.

Los controles son una gramática: el radio de esquina, el contorno, el peso de letra, la sombra, el desplazamiento al pulsar, la expresión de la selección y los iconos de estado usan la misma lógica entre botones, entradas, etiquetas, interruptores y estados vacíos. La dirección no solo atraviesa la página entera, también cada control. Si los botones y los campos de entrada siguen con el aspecto por defecto de la biblioteca de componentes y, al cambiar el color principal, siguen sin reconocerse de qué producto son, significa que los controles aún no han entrado en la dirección.

Los iconos desconocidos llevan texto visible; los botones solo con icono necesitan igualmente un nombre accesible. Los símbolos de flecha tienen significado: ↗ indica apertura de una página nueva o de un enlace externo; las acciones en el lugar como enviar o comprobar no lo usan. Las etiquetas estáticas y los adornos no deben disfrazarse de botones, y los botones en línea no deben activar por error la acción de la tarjeta contenedora.

### Las bibliotecas de iconos también convergen

El valor por defecto del modelo es Lucide o Heroicons: 24 px, trazo de 2 px, extremos redondeados. La biblioteca no tiene ningún problema; el problema es que todas las direcciones usen la misma y con la misma disposición. Los iconos, como la tipografía, forman parte de la dirección: indica en la tarjeta de dirección qué conjunto usar, con qué grosor y extremos, o no uses ninguno.

| Carácter de la dirección | Opciones a considerar | Rasgos |
| --- | --- | --- |
| Refinado, editorial, lujo | Phosphor Thin o Light, Iconoir | Trazo fino, con serif o sans de peso ligero |
| Industrial, instrumental, herramienta empresarial | Carbon, Material Symbols Sharp, Radix Icons | Extremos rectos, retícula estricta; Radix está diseñado para interfaces compactas de 15 px |
| Amable, redondeado, consumo | Phosphor Fill o Duotone, MingCute | Extremos redondeados, macizo o dúo |
| Producto en chino con necesidad de muchos iconos de negocio | IconPark, Remix Icon | Cobertura amplia; IconPark permite ajustar grosor de trazo, extremos y tema |
| Necesidad de ajustar continuamente grosor y relleno | Material Symbols | Fuente variable: relleno, peso y tamaño óptico ajustables de forma continua |
| Píxel, juego, retro | Pixelarticons | Retícula de píxeles |
| Logotipos de marca | Simple Icons | Formas vectoriales de los logotipos de cada marca |

Con Iconify puedes obtener el SVG individual de la mayoría de las bibliotecas anteriores por nombre.

- **Un solo conjunto por producto.** Cuando necesites cubrir un hueco, elige el que coincida en trazo, extremos y esquinas redondeadas, y unifícalo a la misma medida de lienzo y ancho de trazo.
- **El grosor sigue al peso de la letra.** El trazo del icono se aproxima al grosor del trazo del cuerpo de texto del mismo tamaño: letra fina con 1–1,5 px, negrita gruesa con 2 px o más o macizo. El tamaño del icono es aproximadamente 1–1,25 veces el cuerpo de letra, alineado con el texto por el centro visual, no por el marco exterior.
- **Si puedes no usarlos, no los uses.** Las direcciones editoriales suelen usar los propios caracteres: → ↗ ※ §, numeración, abreviaturas. Usa iconos solo donde aceleren el reconocimiento.
- **Dibuja a mano en los momentos de marca.** En unos pocos lugares como la acción principal o el estado vacío, puedes dibujar iconos de línea o pequeñas ilustraciones propias con el lenguaje de líneas de la dirección; las acciones genéricas siguen usando la biblioteca. Las imágenes principales como personajes, objetos y escenas no se resuelven con SVG dibujado a mano; consulta [Materiales](media.md).
- **Muestras en línea.** Las muestras autocontenidas solo incluyen en línea los SVG que usan, sin referenciar fuentes de iconos ni CDN. Los proyectos existentes mantienen la biblioteca que ya tienen; cambiar de biblioteca es una renovación.
- **Verifica la licencia.** La mayoría son MIT, Apache o ISC; SF Symbols solo puede usarse en interfaces de plataformas Apple, no en web; las bibliotecas que exigen atribución deben acreditarse según sus requisitos.
