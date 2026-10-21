# Herramientas

Los programas que incluye este directorio no requieren leer el código fuente; en los comandos, sustituye `<skill>` por el directorio de instalación de esta skill. Aquí solo se indica cuándo usar cada herramienta y los comandos más habituales; todas las opciones, la sintaxis de las acciones y los archivos de salida están en el `--help` de cada una, y cuando escribes algo mal el error ofrece la forma exacta que puedes copiar.

Cuando el host tiene sus propias herramientas de navegador, úsalas como siempre para ver páginas y recorrer flujos. Cuando haya que entregar evidencia, prioriza la herramienta de captura de aquí: abre un navegador temporal independiente y no toca los datos del navegador del usuario. Si en la máquina falta Node 22, o no hay Chrome, Chromium ni Edge, recurre a las herramientas del host y entrega la misma evidencia. Si la tarea o el proyecto ya especifica una herramienta de captura, úsala.

## Capturas de pantalla y grabación de pantalla

### Cuándo capturar y cuánto capturar

Las capturas tienen dos usos y no deben mezclarse:

- **Echar un vistazo**: tras cambiar un lote, quieres ver el resultado. Captura solo la pantalla actual, con un comando. Acumula los cambios de un lote y captura al terminar, no captures tras cada cambio; si la página no ha cambiado, no repitas la captura.
- **Aportar evidencia**: con `--evidence` se recogen de una vez las imágenes de estado, las comparativas, las de texto tapado, las de 2× y la grabación. Solo se hace en dos momentos: antes de enviar a revisión y antes de entregar. En la ronda de primera pantalla de direcciones se captura una sola imagen por dirección, sin evidencia.

En cada ronda de revisión, vuelve a tomar solo la evidencia afectada por los cambios de esa ronda. Los estados y animaciones que no se han tocado reutilizan los archivos de la ronda anterior, y al entregar indica cuáles se han reutilizado; si dudas de si algo se ha visto afectado, por ejemplo porque has cambiado estilos compartidos, vuelve a tomar ese elemento.

### Comandos habituales

```text
node <skill>/scripts/shoot.mjs <dirección de la página, archivo HTML o directorio de candidatos> [opciones]
```

| Qué necesitas | Qué añadir |
| --- | --- |
| Ver el resultado de escritorio | `--size desktop`; si no se indica, es móvil 390x844; para ver solo la composición general puedes añadir `--thumb` (captura a 0,5×) |
| Capturar varios candidatos de una vez y generar una comparativa | Pasa directamente el directorio de candidatos (por ejemplo `explore`) o varios archivos HTML; se capturan en la misma sesión de navegador y se genera `sheet.png` automáticamente |
| Ver solo un componente o zona modificados | `--selector ".card"`, que desplaza automáticamente al viewport y captura solo el área de ese elemento |
| Realizar unos pasos antes de capturar | `--steps "click .open; wait 300"` |
| Recoger evidencia antes de revisión o entrega | `--evidence --states idle,done --steps "send: click .send"` (la última línea del resumen imprime directamente las rutas del manual de revisión y del directorio de evidencia) |
| Grabar un recorrido de la landing page de principio a fin | `--record --steps "scroll 600; scroll 600; scroll 600"`, con tantos pasos como longitud tenga la página |
| Reproducir una captura: comparar con una imagen de referencia | `--compare referencia.png --size <tamaño lógico de la referencia>` |
| Señalar problemas al usuario: dibujar marcos y numerar sobre los elementos | `--mark "1=.page-head .btn; 2=.toggle-row" --full` |
| Ver con claridad una transición | Añade `--frames 8` al grabar, y se genera además una secuencia de imágenes por fotograma con marcas de tiempo |
| Unir varias imágenes en una comparativa, sin página | `--stitch a.png --label antes --stitch b.png --label después` |

Se puede entrar en un estado directamente mediante parámetros de la URL, o bien partir de la dirección del servicio en ejecución y operar hasta el estado objetivo. Los parámetros de URL son la vía más sencilla: si la página puede abrirse con `?state=<nombre>`, pásalo directamente; si necesitas una operación real, pasa la dirección del servicio y llega al estado con `--steps "click .open; fill #name \"contenido\"; drag .card 120 0"`. Para el resto de opciones, la sintaxis de selectores y acciones, los archivos de salida y la estructura de `report.json`: ejecuta `node <skill>/scripts/shoot.mjs --help`. Si dudas de la sintaxis, añade primero `--dry-run` para comprobarla, sin lanzar el navegador. Si se agota el tiempo, se amplía automáticamente el límite y se reintenta una vez; si vuelve a fallar, repite el comando que indica el error.

### Buscar y descargar materiales reales

Ejecuta en el directorio de trabajo del proyecto, y también los comandos siguientes en el mismo directorio, para que la numeración de los resultados de búsqueda sea coherente:

```text
node <skill>/scripts/curate-media.mjs search "<palabra clave>" --kind texture --limit 6 --sheet --dir candidates
node <skill>/scripts/curate-media.mjs search "<un grupo de palabras> | <otro grupo de palabras>" --sheet --dir candidates
node <skill>/scripts/curate-media.mjs preview V1,T2 --sheet --dir candidates
node <skill>/scripts/curate-media.mjs fetch C1,T2 --dir assets --sheet
node <skill>/scripts/curate-media.mjs fetch V3 --dir <directorio de imágenes de referencia que no se publica>
node <skill>/scripts/curate-media.mjs fetch T2 --maps all --resolution 1k --dir assets
```

`--kind` admite `all|texture|design|photo|blueprint|map|plate|science|video`. Las fuentes incluyen bibliotecas de materiales, fondos de museos y bibliotecas de Europa, Estados Unidos y Japón, y la NASA; qué fuentes corresponden a cada categoría está en `--help`. `all` toma las fuentes de forma intercalada; con `|` puedes buscar varios grupos de palabras a la vez. Usa palabras clave preferentemente en inglés; para temas de Asia Oriental puedes usar directamente chino o japonés, y si en chino simplificado no encuentras resultados, prueba la escritura tradicional o el japonés.

Los resultados se guardan en `.curate-cache.json`, y la numeración se conserva entre búsquedas. Cada elemento tiene un `use` que indica su utilidad: `page` puede incluirse en la página (CC BY/BY-SA requiere atribución), `check` requiere mirar antes la página de origen, y `reference` no puede incluirse en la página; `--use page` deja solo el primer tipo.

`search --sheet` y `preview` generan un PNG de hoja de contactos con numeración, uso y tamaño de la imagen original; lee directamente esa imagen para elegir, no te fíes solo del título; además calcula `look` para cada elemento (colores de los cuatro bordes, si el fondo es papel claro, qué zonas están limpias para superponer texto, etc.) y genera una hoja de contactos HTML. `fetch --sheet` genera una hoja de contactos local y comprueba las dimensiones reales y la decodificación completa; en los vídeos se captura automáticamente el primer fotograma como poster.

Las texturas se descargan por defecto en 1k Diffuse; `--maps all` obtiene Diffuse, Roughness y OpenGL Normal JPG, y valida tamaño y MD5; el uso y la licencia están en [Imágenes](media.md#texturas-reales-y-material-científico-y-de-ingeniería). Las descargas y los posters se escriben automáticamente en `SOURCES.md` en el mismo directorio, con compatibilidad con `fetch "<URL>" --out assets/<nombre de archivo> --note "descripción de la fuente"`. Todas las opciones están en `node <skill>/scripts/curate-media.mjs --help`.

### Revisar los resultados

Antes de entregar a revisión, míralo tú mismo: si el estado por defecto ya ha terminado de cargar y si la versión con texto tapado ha tapado también los gráficos. Si la evidencia es incorrecta, vuelve a capturarla antes de entregarla a revisión. Cuando el resumen indique incoherencias entre la grabación y las capturas, prevalece la captura para el estado final estático, y vuelve a grabar ese tramo por separado para comprobar la transición. Una captura de WebGL con la imagen vacía no sirve como evidencia.

En cada captura se comprueba además un conjunto de problemas que pueden juzgarse directamente desde los estilos de la página, y la salida del comando los lista como «avisos de práctica por defecto»:

- **Problemas de legibilidad que hay que corregir**: contraste de texto insuficiente, cuerpo de texto menor de 13 px, interlínea demasiado apretada en cuerpos multilínea, contenido que se queda en estado transparente en la primera pantalla.
- **Corregir o justificar**: texto gris sobre fondo de color, líneas de texto demasiado largas, y las prácticas por defecto del modelo: antetítulo y etiquetas numeradas sobre los títulos, línea lateral de color en un solo lado, texto con degradado, tarjetas dentro de tarjetas, emojis como iconos, etiquetas en mayúsculas inglesas en interfaces en chino, títulos más cerca del texto anterior que del posterior. En los elementos que conserves, explica en la nota de entrega cómo sirven a la dirección.
La comprobación produce falsos positivos, por ejemplo numeraciones de pasos reales o etiquetas que de verdad se necesitan; escribe una línea sobre los falsos positivos en la nota de entrega. Solo reconoce la forma de escribir, no puede juzgar si queda bien: una vez a cero los avisos, sigue mirando tú mismo las capturas. Cuando la comprobación informe de errores ajenos al aspecto como 401 o 404 de una interfaz, anótalo en una línea de la nota de entrega, sin modificar código de negocio como el inicio de sesión o las interfaces para que la comprobación pase.

## Escribir muestras operables

La primera pantalla de la fase de exploración de direcciones no lleva interacción, así que esta sección no se usa; se usa al hacer la página completa tras elegir la dirección. En proyectos existentes, usa el stack técnico propio del proyecto.

Entrega un HTML de entrada y cambia de estado en la misma página mediante parámetros de URL, sin duplicar páginas. Separa los estilos, los scripts y los bloques grandes de datos en archivos `.css` y `.js` en el mismo directorio; cuando la página crezca, sigue dividiendo por funcionalidad. Define primero los colores, tamaños de letra, espaciados y radios de esquina como una decena de variables CSS, y a partir de ahí referencia siempre las variables, sin introducir herramientas que requieran compilación. Los estados como formularios, conmutadores y desplegables se escriben con Alpine.js en atributos HTML: copia `<skill>/assets/vendor/alpine.min.js` al `vendor/` del directorio de la tarea y referéncialo, concentra el estado en un único `x-data` y lee el estado inicial de los parámetros de URL. Los gestos que siguen al dedo, la simulación física, el dibujo en Canvas y WebGL van en módulos JS separados, y los datos que se actualizan en cada fotograma no se guardan en el estado de Alpine.
