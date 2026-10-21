# Diseño y viewport

## Reproducción precisa

Anota primero el tamaño de viewport al que corresponde la imagen de referencia o el tamaño conocido en píxeles, el alcance completo de la pantalla y qué zonas permanecen fijas. El número de píxeles de la imagen no equivale al tamaño del viewport; por ejemplo, una imagen a 2x se divide entre 2; si no puedes determinarlo, indica sobre qué suposición lo haces.

Mide qué proporción ocupa cada zona principal, qué elementos comparten una línea de alineación, qué tamaño tiene el texto, cómo se recortan las imágenes y qué relación hay entre los distintos espaciados. Ajusta primero la posición, las proporciones y la tipografía general, y después los bordes, las sombras y los detalles; una tarea de reproducción no vuelve a explorar estilos.

Compara las diferencias con el mismo viewport que la imagen de referencia y con un contenido parecido. Las pantallas estrechas y los demás estados que no aparecen en la referencia se añaden según lo que necesite el contenido, indicando cuáles se han reproducido siguiendo la referencia y cuáles son una extensión razonable propia.

Tu propio juicio sobre si la reproducción se parece suele ser demasiado optimista; además, con una sola miniatura de la página completa tampoco se ven las diferencias de tamaño de fuente, espaciado y alineación. Tras cada ronda de cambios, genera una imagen comparativa con `--compare` de la herramienta de captura (ver [Herramientas](tools.md)), corrige primero las celdas con mayores diferencias y luego comprueba en la imagen superpuesta las líneas de alineación, los tamaños de fuente y los recortes de imagen; no declares «ya está reproducido» por impresión.

## Puntos de validación

Revisa realmente el contenido muy largo, el contenido vacío y cada estado afectado por este cambio. En móvil, vigila los cambios de altura del viewport, el teclado que aparece y los márgenes seguros de la pantalla; la acción principal no puede quedar tapada por el teclado ni por una barra fija.

Comprueba además: si la página desborda horizontalmente sin querer, si el scroll ocurre en la zona que debe desplazarse, si el foco y los menús son visibles; y si, tras ampliar o cambiar la maquetación, el orden de lectura y de operación sigue siendo claro.
