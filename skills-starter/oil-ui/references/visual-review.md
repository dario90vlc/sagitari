# Protocolo de envío a revisión visual (solo para el agente principal)

El agente principal usa este archivo para enviar revisiones independientes. Los criterios de puntuación y las reglas de comprobación están en el [Manual de revisión](reviewer-manual.md), que lee el revisor; el agente principal no lo lee y se limita a entregar según la lista siguiente.

## 1. ¿Cuándo hay que enviar? ¿Qué modo se activa?

Cuando termines una página clave, un diseño o un cambio, activa el subagente de revisión correspondiente según esta lista:

| Qué cambio has hecho | Plantilla del prompt del subagente |
| --- | --- |
| Has explorado una interfaz nueva, o has desechado el estado actual para rediseñar (renovación) | `Lee references/reviewer-manual.md, revisa estas capturas conforme al estándar [Revisión de interfaz completamente nueva y rediseño] y da una puntuación de 1-10.` |
| **Revisión de una interfaz existente**: ordenar, mejorar, pulir o ampliar sobre una interfaz ya existente | `Lee references/reviewer-manual.md, revisa conforme al estándar [Revisión de pulido de interfaz existente], compara con la especificación actual que se proporciona e indica los puntos de desviación. Sin puntuación.` |
| Cambios pequeños, ajuste puntual de espaciado o color | **No hace falta enviar un subagente**; el agente principal lo comprueba con el contexto. |

Sustituye las rutas de la plantilla por rutas absolutas dentro del directorio de esta skill: el directorio de trabajo del subagente no es este directorio.

## 2. La «lista de entrega» que debe preparar el agente principal antes de enviar

Al invocar la capacidad de ejecución aislada que ofrece el host, debes proporcionar los siguientes materiales:
- **Obligatorio**: capturas o grabación de la versión actual (indicando el viewport del dispositivo), la tarea original del usuario, los límites y restricciones de diseño; si hay tarjeta de dirección, además la frase del norte. Otras restricciones duras de la tarjeta de dirección que el revisor deba conocer, por ejemplo que la marca exija el logotipo en cada pantalla, se resumen en una frase dentro de las restricciones; no entregues la tarjeta de dirección completa.
- **Si existen**: la especificación de color del proyecto actual y las restricciones de componentes (obligatorio en proyectos antiguos existentes); el registro de selección de color de la tarjeta de dirección, es decir, la frase del apartado «Color» que dice de qué parte de este producto procede el color; si el proyecto tiene `DESIGN.md` o un documento de diseño equivalente, en la revisión de pulido de interfaz existente se entrega completo y se usa como estándar, y en la revisión de interfaz nueva y rediseño solo se resumen en las restricciones los activos de marca y los «no hacer».
- **Avisos de práctica por defecto de la herramienta de captura**: entrega tal cual los avisos del campo `lint` de `report.json`; para cada elemento que decidas conservar, añade una frase con el motivo.
- **No entregar**: código fuente, explicaciones que defiendan tus propias decisiones, ni puntuaciones de revisiones anteriores (la evaluación debe ser independiente).

Las capturas deben corresponder a la versión actual y ser accesibles para el revisor; los estados y animaciones que no se han modificado en esta ronda pueden reutilizar los archivos de evidencia de la ronda anterior, indicando al entregar cuáles se reutilizan. En páginas largas, ofrece a la vez la página completa y las partes locales necesarias; una imagen de detalle no sustituye la composición general.

No hace falta preparar evidencia para cada animación: basta con entregar al revisor la grabación de la toma de evidencia. Si el revisor puede abrir la página por sí mismo, dale también la dirección de la página; lo que no se vea bien en la grabación lo comprobará operando él mismo.
Cuando no haya un ejecutor aislado que pueda ver imágenes, el agente principal se autoevalúa con el mismo manual y especifica en la entrega «sin revisión independiente»; sin imágenes reales no se da puntuación visual.

## 3. Cómo procesa el agente principal la respuesta del subagente

Cuando el subagente devuelva el informe, modifica según estos principios:
- **Lo primero es «rehacer»**: vuelve a la tarjeta de dirección, redefine el esqueleto o la imagen principal del bloque señalado, sin parchear punto por punto.
- **Corrige en el orden de la lista**: ve corrigiendo la lista de problemas desde el que más impacto tiene; anota la línea de «conservar» en la nota de diseño y compárala al corregir, sin aplanarla.
- **Las propuestas de mejora también se hacen**: las mejoras de refinamiento, sentido del diseño y animación no son sugerencias opcionales, sino que se ejecutan como los problemas siguiendo la lista; lo que no puedas hacer, indica el motivo en la nota de entrega.
- **Elimina por defecto**: el «texto inútil que puede borrarse directamente» que enumere el subagente se borra tal cual, salvo que genere ambigüedad funcional.
- **Baja a ajustes concretos**: convierte las exigencias generales del subagente (por ejemplo «está muy apretado», «la jerarquía no está clara») en ajustes reales de espaciado, tamaño de letra y sombra. Si el subagente propone cambiar el color de marca o el marco general que el usuario ha fijado, escribe una frase con el motivo y no lo adoptes.
- **Evita el bucle infinito**: si las opiniones estéticas de ambas partes quedan en un punto muerto, yendo y viniendo sin beneficio visible, conserva la versión que consideres mejor y detén el ciclo.
