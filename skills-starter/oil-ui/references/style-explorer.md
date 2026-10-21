# Página de comparación de estilos

Coloca varios candidatos en la misma página para compararlos en paralelo y que el usuario elija. El usuario puede verlos en paralelo o uno a uno, a tamaño real, y seleccionar y copiar una dirección. El armazón de la página de comparación solo sirve para comparar y elegir: no tiene inclinación de estilo propio ni sirve de referencia para los candidatos.

Los candidatos comparten el contenido central, la acción principal y el usuario objetivo; lo que cambia es la composición, cómo se organiza la información, el carácter de la tipografía, las relaciones de color, la densidad y el modo de usar imágenes. Pon los candidatos que haya, según cuántos pida el usuario y cuántos sean realmente distintos; no copies el producto entero para inflar el número.

## Preparar las entradas

Genera una sola página de comparación por ronda. Si los candidatos se pueden ejecutar, usa las páginas reales: las muestras HTML escritas aparte se incrustan directamente, y las propuestas dentro de un proyecto se sirven con la dirección local; usa capturas solo cuando no haya página ejecutable. Una pantalla por propuesta: en un proyecto existente elige la entrada o el paso con mayor diferencia, y para una propuesta de sitio completo pon solo la página representativa.

Reúne los HTML candidatos en un directorio y pasa el directorio, o pasa directamente varios archivos HTML. El nombre visible se toma de `<title>`; sin título, del nombre del archivo. Si en el mismo directorio hay un `manifest.json`, se lee para completar la información de dirección; sin manifest también se puede generar.

`manifest.json` mínimo:

```json
{
  "candidates": [
    {"source": "a.html"},
    {"source": "b.html"}
  ]
}
```

| Caso especial | Añadir en el manifest |
| --- | --- |
| Interfaz de lienzo fijo | `"nativeViewport": "ancho x alto"` en el nivel superior o en el candidato |
| Muestra interactiva escrita por ti | `"interactive": true` en el candidato |
| Página que necesita un servidor para verse | `"kind": "url"` y `url` local en el candidato; en el nivel superior se puede añadir `serve` con las instrucciones de arranque |
| Modificación de una página existente | Incluye también el estado actual y añade `"baseline": true` |
| Solo capturas | `"kind": "image"` en el candidato, con `source` apuntando a la captura |

Los candidatos HTML y de imagen solo necesitan `source`; los candidatos de dirección local rellenan `url` según la tabla anterior. Cuando los candidatos provienen de tarjetas de dirección, añade además a cada uno `name`, `concept` (la frase de la estrella polar), `typography`, `palette` (array de valores de color) y `traits`; la página de comparación los muestra junto con la imagen y el usuario se apoya en ellos para elegir; los campos omitidos no se muestran. Para el resto de campos, consulta `--help` del generador.

## Generar y abrir

```text
python3 <skill>/scripts/build_explorer.py <directorio de candidatos>
```

También puedes pasar varios archivos HTML o pasar `manifest.json`. Si no existe el comando `python3`, usa `python` o `py -3`. La página de comparación se genera por defecto junto a la entrada, con el nombre de archivo `style-explorer.html`. Después de modificar los candidatos, añade `--force` para regenerarla; de lo contrario se abre la imagen antigua. El generador enumera de una vez los puntos que hay que corregir. Si no puedes ejecutar el generador, deja los candidatos para que el usuario los vea directamente y explica que la página de comparación aún no está montada, sin improvisar otro conjunto de herramientas.

Cuando haya candidatos de dirección local, deja el servidor de desarrollo en marcha al entregar. Si el usuario dice después "abre la página de comparación": lee `serve` del manifest, ejecuta `command` en segundo plano dentro de `cwd` y abre la página de comparación cuando `url` sea accesible.

## Registrar la elección

Al pulsar "Seleccionar", el usuario copia una frase, por ejemplo "<ronda>: elige 03 <nombre de la dirección>". Cuando la pegue o diga su elección directamente, contrasta la ronda y el número con el manifest actual, confirma que corresponde a esta ronda, actualiza la elección y las notas en las notas de diseño, y vuelve al flujo que genera esta página de comparación para continuar. La página de comparación no escribe en ningún archivo ni envía mensajes automáticamente al agente.

Antes de entregar, ejecuta una vez sobre el directorio de candidatos `node <skill>/scripts/shoot.mjs <directorio del manifest> --size desktop --thumb --out shots/explore` (genera de una vez las miniaturas de todos los candidatos y la vista general en paralelo `sheet.png`) para comprobar los candidatos: que cada pantalla coincida con la página, el estado y el viewport escritos en el manifest, y que la tipografía china se haya renderizado de verdad. Para juzgar el tamaño del texto y el detalle, usa "tamaño real 100 %" de la vista individual; una imagen reducida para ajustarse a la ventana no sirve como aprobación de legibilidad. La funcionalidad de la propia página de comparación está garantizada por las pruebas que incluye la skill; no la verifiques en la tarea ni leas el código de la plantilla.
