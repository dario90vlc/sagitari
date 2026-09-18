# Orquestación y agentes v2.1 — diseño

Fecha: 2026-09-18 · Estado: implementado (tests y comprobación sobre la interfaz viva en
verde). Siguiente paso natural: publicarlo como 3.2.0 con una release propia.

## Objetivo

Que el agente **reparta el trabajo, lo compruebe y lo cierre** como un equipo: cada
subagente con su especialidad, su método y **sus skills**; el orquestador con contexto
suficiente para no repetir trabajo ni cerrar a ciegas.

Hasta ahora la delegación funcionaba (un solo camino de ejecución para herramientas,
permisos y guardarraíles compartido entre orquestador y subagentes, resultado
estructurado) pero tenía tres huecos reales:

1. **Las skills solo existían en el hilo principal.** Un subagente de código no recibía
   las reglas de código del usuario: el índice de skills vivía en el prompt del
   orquestador y nada más.
2. **El brief de una subtarea era pobre**: tarea + contexto. Sin criterio de éxito, sin
   lo que ya había hecho el equipo y sin presupuesto. El subagente no ve la conversación,
   así que lo que no viajara ahí no existía.
3. **El cierre no se comprobaba.** Un turno que cambiaba varios archivos podía terminar
   con «hecho» sin que nadie hubiera vuelto a leer lo escrito ni ejecutado nada.

## Qué se ha implementado

### 1. Skills dentro de cada agente (front-matter `agents:`)

- Cada `SKILL.md` puede declarar **a qué agentes pertenece** (`orchestrator`, `research`,
  `browser`, `coding`, `file`, `vision`, `verification`, o `'*'`). **Sin `agents:`, la
  skill aplica a todos** (compatibilidad total con las instaladas).
- `promptIndexSync(agent)` y `suggestSkillsFor(texto, { agent })` filtran por agente:
  menos ruido en el prompt, menos tokens y menos confusión (una skill de navegación no le
  sirve al verificador).
- `use_skill` está en el catálogo de **todos** los subagentes, así que el cuerpo completo
  se sigue cargando bajo demanda, dentro del agente que lo necesita.
- Las skills incluidas (`skills-starter/`) se reparten: `codigo` (orquestador, código,
  verificación), `investigacion` (orquestador, investigación), `navegacion` (navegador,
  investigación), `automatizacion` (orquestador, código, navegador, archivos), `diseno`
  (orquestador, código) y dos nuevas: **`orquestacion`** (cómo descomponer, repartir y
  cerrar) y **`verificacion`** (cómo refutar en vez de confirmar).

### 2. Subagentes con método y evidencia

Cada agente declara su procedimiento (4-5 pasos propios) y qué debe entregar, en vez de
una frase genérica igual para todos. Y el resultado estructurado pasa a ser:

```
RESULT: <1-3 líneas>
DETAILS: <datos: rutas, URLs, valores, comandos>
EVIDENCE: <la prueba concreta>
STATUS: OK | PARTIAL | FAILED
```

`parseSubagentResult` acepta etiquetas en español, bloques multilínea y varios bloques
(manda el último, que es el cierre real) y no rompe si el modelo ignora el formato. La
**evidencia** es lo que permite que el orquestador verifique en vez de creer.

### 3. Orquestación

- **Guía de delegación en el prompt del orquestador**: a quién delegar qué, qué NO
  delegar (lo de 1-3 herramientas, el trato con el usuario, la respuesta final), y la
  regla de verificar antes de cerrar. Es una guía viva (`DELEGATION_GUIDE`), no prosa
  suelta: el test comprueba que todo agente del registro aparece en ella.
- **Brief completo** (`buildSubagentBrief`): contexto del orquestador + **tablero** de lo
  que ya hizo el equipo en este turno + subtarea + **criterio de éxito** (`expect`, nuevo
  parámetro de `delegate`) + **presupuesto** de pasos.
- **Tablero de delegaciones** por turno: cada delegación deja `{agent, task, status,
  result}` y las siguientes la reciben resumida; el orquestador recibe el tablero en el
  resultado de la herramienta. Menos trabajo duplicado en tareas de varios subagentes.
- **Cierre verificado** (`_needsVerification`): si el turno cambió **dos o más archivos**
  (o un archivo y ejecutó un comando) y nada lo comprobó después, el agente recibe **una
  única** petición de comprobación antes de que se acepte el cierre: releer, reejecutar o
  delegar en `verification` con un criterio verificable. Lo que ya había respondido sigue
  en la burbuja y no se repite: solo añade la línea «Verificado: …». Un comando con éxito
  posterior a la última escritura cuenta como comprobación, así que un turno de código que
  ya corre sus tests no paga la vuelta extra. Interruptor en Ajustes ▸ Agente
  (**activado por defecto**), y desactivable con `verifyGate: false`.

### 4. La delegación en la interfaz (arreglos)

Al revisar el camino completo (núcleo → eventos → renderer) aparecieron tres defectos
reales, ya corregidos:

- **El texto del subagente se colaba en la respuesta.** Su stream viaja etiquetado con
  `subagent`, pero el caso `delta` del renderer no miraba esa etiqueta: su razonamiento
  interno —y su `RESULT/DETAILS/EVIDENCE`— acababa dentro de la burbuja del asistente y,
  con el modo voz, **se leía en voz alta**. Ahora se descarta antes de tocar la burbuja.
- **El verificador no tenía ficha en la interfaz**: el catálogo de etiquetas usaba `verify`
  y la clave real es `verification`, así que `subagent('verification')` devolvía null y
  leer `.label` sobre ese null lanzaba un TypeError en cada paso de verificación. Además,
  `subagent()` ya no devuelve null para una clave no vacía (un agente nuevo cae a su
  propio nombre en vez de romper el render).
- **El cierre de una delegación no se veía**: `delegate_done` no estaba manejado. Ahora
  hay una tarjeta por delegación con el nombre del agente, su estado (OK · PARCIAL · FALLÓ)
  y su resultado, detalles y **evidencia** plegables; en tareas de segundo plano aparece en
  el feed.

Los tres tienen guardia: dos tests unitarios/renderer, el registro completo de agentes
como aserción, y un escenario **de punta a punta en `ui-check`** (el modelo de mentira
puede guionizar respuestas, así que ahora se escenifica una delegación real y se comprueba
que la marca del texto interno del subagente NO aparece en la respuesta y SÍ en su tarjeta).

### 5. Bucle único, fallback y coste (v2.2)

Cinco mejoras de fondo, todas con guardia en la suite y en la app viva:

- **Un solo bucle.** El orquestador y los subagentes tenían una copia del bucle cada uno, y
  ya habían vuelto a divergir: el del subagente no detectaba estancamiento, no cerraba el
  cierre verificado y **nunca emitía `tool_result`**, así que sus tarjetas de herramienta se
  quedaban «en curso…» hasta el final del turno. Ahora hay un `_loop(messages, chain,
  signal, perfil)`: el orquestador corre con `account: true` (historial, hábitos, runlog,
  checkpoints, cierre verificado) y el subagente con el perfil silencioso (`onFinal` en vez
  de `assistant_done`). Un test comprueba que sigue habiendo **un** `while (true)` en el
  fichero, y el escenario de la app viva que el subagente cierra sus tarjetas.
- **Cadena de modelos también en el subagente.** Antes iba directo al modelo activo
  (`_streamOnce`): un 500 del proveedor tiraba la delegación entera —hasta 30 pasos de
  trabajo— mientras el hilo principal habría saltado al secundario. La cadena la construye
  ahora `_chainFor` para los dos.
- **Índice de skills en memoria.** Cada prompt releía y reparseaba el almacén entero (por
  turno, por delegación, más `use_skill` y la pantalla de Skills): cientos de lecturas y
  `JSON.parse` por turno en el hilo principal. Ahora hay **un** índice compartido, invalidado
  por las mutaciones del módulo (instalar, crear, borrar, activar, actualizar) y por una
  **firma barata** del almacén (nombres + mtime/tamaño) que detecta lo editado a mano fuera
  de la app —la carpeta está abierta al usuario desde Ajustes— sin leer ni parsear nada.
- **`use_skill` no repite el cuerpo.** Si el modelo vuelve a pedir una skill ya cargada en
  el turno, recibe un recordatorio corto: el cuerpo ya está en el contexto y repetirlo son
  miles de tokens por nada. Se recuerda por turno en el propio agente (`_skillsLoaded`).
- **Orden del prompt para el caché.** El prompt se compone en dos bloques: primero TODO lo
  estable (identidad, reglas, guía de delegación, índice de skills, espacio de trabajo,
  modo) y al final lo volátil (memoria, hábitos, skills sugeridas). Antes la memoria
  —que cambia en cada turno— iba casi al principio y rompía el prefijo cacheable desde la
  décima línea.

## Tanda 2.2: guardarraíles, imagen, contexto y modelo por agente

- **Tope de delegaciones por turno** (`maxDelegations`, 8 por defecto, `0` = sin tope).
  Los límites generales (60 pasos, 80 llamadas) frenan el total, pero no que un turno se
  vaya en delegar: cada subagente tiene su propio presupuesto, así que 80 llamadas pueden
  ser diez investigaciones. No corta el turno: el modelo recibe el motivo y termina él la
  tarea con lo que tiene. Configurable en Ajustes ▸ Delegación.
- **Criterio de éxito de reserva.** Si el orquestador omite `expect`, el subagente recibe
  como criterio la petición original del usuario, marcada como de reserva. Sin esto, una
  delegación sin `expect` trabajaba a ciegas, que es justo lo que el brief nuevo evita.
- **`view_image`: mirar una imagen del disco.** Antes solo existían la captura de pantalla
  y la página del navegador; «mira este PNG de mi carpeta» no se podía (y `read_file`
  rechaza binarios a propósito). La imagen vuelve como parte multimodal del resultado, el
  mismo camino que ya usaba `screenshot`; se valida por **bytes** (no por extensión) y se
  corta a 8 MB, porque por encima de eso la petición al modelo se dispara o la recorta el
  proveedor sin avisar. La tienen el orquestador, el de código, el de archivos y el de
  visión (que además ahora distingue «en pantalla» de «en disco»). De paso se corrigió
  un defecto que ya existía con las capturas: **todo resultado con imagen viaja en todas
  las peticiones siguientes del turno**, así que un turno con varias capturas (o varias
  imágenes del disco) hinchaba la petición hasta que el proveedor la rechazaba o la
  cobraba de más. Ahora solo siguen viajando las **tres últimas**; las anteriores quedan
  como texto con su aviso y su ruta, por si el modelo necesita volver a abrirlas.
- **Resumen rodante del contexto.** `trimHistory` cortaba el principio en seco: las
  decisiones antiguas desaparecían sin que nadie lo supiera. Ahora lo recortado se pliega
  en un resumen (qué pidió el usuario → en qué quedó) que abre el contexto como mensaje de
  usuario —los proveedores no aceptan un segundo `system` a mitad—, acotado a 12
  intercambios y a un máximo de caracteres, y se olvida al cambiar de conversación.
- **Tablero del equipo en el chat.** Una tira de chips sobre el grupo de herramientas: se
  pinta al EMPEZAR la delegación (con su subtarea y su criterio) y se resuelve al acabar
  con OK, «· a medias» o fallo; la cabecera dice cuántos siguen en marcha. Responde a
  «¿quién está trabajando ahora mismo?» sin leer todas las tarjetas, y la franja del modo
  voz cuenta la delegación con su subtarea.
- **Modelo por agente** (opcional, **apagado** por defecto). El router ya clasifica la
  tarea: con `agentRouting` activo, los subagentes que solo leen, mueven archivos o miran
  capturas usan el modelo más ligero de la lista real del proveedor (mini/flash/haiku…)
  y el que verifica se queda en el bueno. El chat mantiene SIEMPRE el modelo elegido por
  el usuario: hubo una queja legítima cuando el router lo cambiaba en silencio.

## Tanda 2.3: razonamiento visible y pulido del chat

- **Razonamiento del modelo, opcional y apagado por defecto** (Ajustes ▸ Agente ▸
  Conversación). Los tres protocolos lo capturan a su manera: Anthropic con razonamiento
  ampliado (`thinking_delta`, que hay que **habilitar** y cuesta tokens aparte), OpenAI en
  la API Responses (`reasoning.summary = 'auto'`, solo en modelos que lo soportan) y los
  compatibles con OpenAI en `reasoning_content` / `reasoning` / `thinking`, que mandan
  ellos solos. El agente lo PIDE solo donde hay que pedirlo y solo si el usuario lo
  activó; los subagentes nunca (su proceso es interno, y en Anthropic costaría dinero).
  Se emite por su propio canal (`thinking_delta` → `thinking_done` → `thinking_reset`),
  nunca por el del texto: la lectura por frases del modo voz no lo toca, copiar un mensaje
  o la conversación no lo incluye (tiene su propio botón) y el bloque se pliega solo al
  empezar la respuesta. Si el proveedor falla y la cadena salta de modelo, un
  `thinking_reset` vacía el bloque: lo que pensó el que falló no se mezcla con lo nuevo.
  Caveat asumido: el razonamiento ampliado de Anthropic se envía sin la cabecera beta de
  *interleaved thinking* (haría falta para pensar ENTRE llamadas a herramientas); el resto
  funciona igual, y si algún día se pide, es un añadido de cabeceras.
  Dos fallos cazados al comprobarlo en vivo, ambos ya cerrados y con guardia en los tests:
  (1) el pintado del bloque se apoyaba **solo** en `requestAnimationFrame`, y con la
  ventana minimizada u oculta —o en un arranque de prueba con `--hidden`— Chromium no
  dispara esos frames: el bloque existía con su texto guardado pero **vacío en pantalla**
  (el texto de la respuesta no lo sufre porque al cerrar el turno se repinta de forma
  síncrona; el razonamiento no tenía esa red). Ahora el cierre del bloque y el fin del
  turno pintan sí­ncronamente. (2) el último frame de un turno puede caer después de que
  el turno se cierre (`pendingTurn = null`), así que el frame recuerda el elemento en vez
  de buscarlo en el estado del turno.
- **Separador de día real.** Antes cada respuesta del agente estampaba «Hoy · 14:32» entre
  la pregunta y la respuesta —doce veces en una tarde— y se leía como un corte del hilo.
  Ahora sale al empezar y al **cambiar de día** (con la fecha de los mensajes al restaurar
  una conversación, no la de hoy), se marca como separador (etiqueta entre dos líneas) y
  la hora se queda donde toca: en cada mensaje.
- **Grupo de herramientas más informativo.** La cabecera dice cuántas van **en curso** (no
  solo «en curso…»), el tiempo total al cerrarse y, si algo falló, una píldora roja: con
  el grupo plegado, un fallo dentro era invisible hasta abrirlo a mano. Al llegar la
  respuesta, razonamiento y herramientas se pliegan (si el usuario no los abrió a mano: su
  decisión manda). Un turno interrumpido se deja tal cual: ahí los detalles SON el interés.
- **Selección de texto** con la paleta de la app (y el color del modo dentro del chat) en
  vez del azul del sistema, que sobre estas superficies oscuras deja el texto ilegible.

## v2.4 — que el código salga con red (perfil del proyecto, mapa, diff y revisor)

Esta tanda no añade «más agente», añade **comprobación**: hasta aquí el bucle evitaba mentir
sobre lo hecho, pero nadie miraba *cómo* estaba escrito ni si el proyecto se podía seguir
verificando. Seis piezas, en el orden en que se notan:

- **Perfil del proyecto (`agent/proyecto.js`).** Detecta con qué se ejecutan los tests, la
  compilación y el lint (Node con su gestor por *lockfile*, Python, Rust, Go, .NET…) y lo
  pone en el prompt como bloque PROYECTO —solo los comandos que **existen**: inventar un
  `npm test` en un proyecto sin tests es peor que callarse—. Es puro: decide *qué* comprobar;
  quien lo ejecuta es el ejecutor, que ya sabe matar procesos y usa el Node que trae la app.
- **Sintaxis al escribir.** Cada `write_file`/`edit_file`/`apply_patch` comprueba la sintaxis
  (o el JSON) de lo que acaba de escribir y, si no compila, el resultado llega como **FALLO**
  con el motivo: el modelo lo arregla en el mismo paso —cuando aún tiene el contexto— y la
  tarjeta del chat se marca en rojo en vez de dar el cambio por bueno.
- **Mapa del repositorio (`agent/repomap.js`).** Índice de archivos y símbolos con topes
  (nada de `node_modules`, binarios ni archivos enormes), cacheado por TTL de 2 min e
  invalidado al escribir. `repo_map` responde «¿qué hay en esta carpeta?» y `find_symbol`
  «¿dónde se define X?»; el prompt incluye un mapa corto solo si el proyecto es grande.
- **`apply_patch`.** Varias ediciones en varios archivos en una llamada y **atómicas**:
  primero se comprueba que todos los anclajes existen y son únicos y solo entonces se
  escribe. Antes un refactor de cinco archivos eran cinco llamadas y un proyecto a medias
  si la tercera fallaba.
- **Diff del turno (`agent/cambios.js`).** Cada escritura guarda su pre-imagen (también en
  los subagentes) y el turno se puede resumir en un diff con contexto; se olvida al empezar
  el turno siguiente.
- **Puerta de cierre en UNA ronda.** Al cerrar, el orquestador pasa por hasta dos
  comprobaciones: la **revisión del CAMBIO** (¿está bien lo escrito? — un `review` que lee
  el diff y busca contratos rotos, casos límite y restos del nombre viejo) y el **cierre
  verificado** (¿funciona? — leer, ejecutar, abrir). Cada una una sola vez por turno, solo
  si ha habido escrituras, y viajan en el **mismo** mensaje: cada vuelta extra es una
  llamada más y una espera más, así que dos comprobaciones cuestan una ronda. Un hallazgo
  BLOQUEANTE vuelve al modelo para que lo arregle en ese turno. Ajustable en Ajustes ▸
  Delegación («Revisar el cambio antes de cerrar», activa por defecto) y en
  `reviewGate: false`.

Dos cosas que salieron al hacerlo, y que es la razón de que existan los tests de este
repositorio: (1) en `apply_patch` la lista local se llamaba `cambios` y **sombreaba** el
módulo de pre-imágenes —`cambios.recordar` era un `TypeError` en cada parche—; ahora hay una
salvaguarda determinista sobre el propio código. (2) `resultadoEscritura` perdió el prefijo
`OK:` al centralizarse, y tres tests de escritura lo cazaron antes de que llegara a la app.
La comprobación de interfaz deja de escribir en el escritorio del usuario: la instancia de
prueba usa un espacio de trabajo temporal.

## v2.5 — navegador 2 y paralelismo con bloqueo por recurso

### Navegador 2 (`agent/browser.js`)

La v1.5 sabía lo justo: un inventario por coordenadas y cuatro acciones. Sobre webs de verdad
se quedaba corta en cinco sitios, y los cinco se han cerrado:

1. **Nombres.** El inventario usaba `innerText`: un botón de icono salía vacío y el modelo
   clicaba por índice a ciegas. Ahora se calcula el **nombre accesible** (aria-label,
   aria-labelledby, `<label for>`, alt, title, placeholder, data-testid, value de submit) con su
   rol inferido y su estado (deshabilitado, marcado, valor, obligatorio).
2. **Shadow DOM e iframes del mismo origen.** Se recorre el árbol con `shadowRoot` y
   `contentDocument`, y cada elemento dice en qué marco está (los de otro origen se cuentan y se
   declaran no legibles, en vez de desaparecer sin explicación).
3. **Fuera de pantalla.** Ya no se tiran: van marcados y el clic los trae a la vista.
4. **Estabilidad.** Antes de pulsar se vuelve a localizar el elemento **por su huella**
   (`rol|id|nombre`), se comprueba que no se mueve entre dos medidas y que `elementFromPoint`
   no devuelve otra cosa; si algo lo tapa, el error NOMBRA lo que tapa y `force` permite
   pulsarlo igual (clic por DOM).
5. **Esperas.** `wait_for` (texto, selector, url, título, o que algo desaparezca) con tiempo
   límite y, al agotarse, el estado de la página para poder replanificar.

Y lo que faltaba por completo: **diálogos** (`alert`/`confirm`/`prompt`): se detectan, se avisa
en el resultado de la acción y se contestan con `dialog`; mientras hay uno abierto, cualquier
otra acción falla al instante con ese motivo en vez de esperar al timeout de 30 s (antes
`Runtime.evaluate` se quedaba colgado porque la página está pausada, y un clic que abría un
`confirm` moría en «CDP timeout: Input.dispatchMouseEvent» porque el renderer no acusa recibo
con el diálogo encima: eso se descubrió con la comprobación real, no en el laboratorio).
También **consola y errores de red** (`logs`, con `Runtime.enable`/`Log.enable`/`Network.enable`
al adjuntar), **descargas** a una carpeta conocida que se dice en el resultado, **subida de
archivos** por `DOM.setFileInputFiles` (pidiendo permiso: subir un archivo manda datos del
usuario a una web), **atajos** (`hotkey` con modificadores reales), `select`, `check`, `hover`,
`back`/`forward`/`reload` sobre el historial real, captura de **un elemento** concreto y `type`
tecleando tecla a tecla en textos cortos y **devolviendo lo que quedó escrito**.

### Paralelismo con bloqueo por recurso (`agent/recursos.js`)

El ejecutor tenía **un solo hueco** de herramienta en vuelo (lo que hace que Detener mate el
comando en curso) y el navegador era una instancia compartida: paralelizar sin más habría roto
Detener, los logs y el inventario del navegador. Lo que se hizo:

- Un **semáforo por recurso** (`navegador: 1`, `disco: 1`, `terminal: 2`, `escritorio: 1`,
  `mcp: 2`, `general: 4`) con **orden de adquisición canónico** (alfabético) para que no haya
  interbloqueos entre tareas que piden los mismos recursos en distinto orden. Lo que no choca no
  espera: leer un archivo no bloquea a quien escribe.
- Las llamadas de **un mismo mensaje** se lanzan en paralelo (`_runToolCalls`, tope
  `parallelTools` = 3 por defecto, ajustable de 1 a 4 en Ajustes), con los guardarraíles
  consultados **en orden antes de lanzar**: un tope de llamadas o un bucle detectado no lanzan
  las que faltan (quedan como `null` y el bucle las cierra con un mensaje `tool` para que el
  historial siga siendo válido para la API). Los resultados se procesan en el orden pedido.
- **Detener mata todo**: `runningTools` (un killable por llamada) más los subagentes en
  paralelo; antes solo alcanzaba a la herramienta actual. Y **lo encolado no se ejecuta**: el
  semáforo no sabe nada del abort, así que al soltarse un turno la llamada que lo esperaba se
  ejecutaba *después* de Detener (hasta dos clics encolados detrás del navegador). Ahora, al
  conseguir el turno, la llamada mira `signal.aborted` y devuelve `aborted` sin ejecutar nada;
  la que ya estaba en vuelo sigue muriendo dentro de su propio ejecutor.
- La cola del navegador (`handle` está serializado) sigue ahí como segunda red: el semáforo es
  del EQUIPO, así que un subagente y el orquestador tampoco se pisan el navegador.

### Verificación de esta tanda

No todo se puede comprobar en el laboratorio: el corazón del navegador 2 es código que corre
DENTRO de la página, y un fallo ahí solo se ve con un navegador delante. `npm run navcheck`
(`scripts/navegador-check.js`) abre Chrome con un **perfil aparte**, carga una página local de
prueba —componentes web, iframe del mismo origen, botón tapado, botón fuera de pantalla, menú
que se despliega al pasar el ratón, `confirm()`, errores de consola y una imagen rota— y
comprueba 29 cosas de punta a punta. Encontró tres fallos reales: el clic tapado por un overlay
(que ahora se explica en vez de pulsar a ciegas), el cuelgue con los diálogos y el aviso del
diálogo que se perdía por componerse el resultado antes de que llegara el evento. El paso está
en `probar.bat` y se salta solo si el equipo no tiene Chrome ni Edge.

## Qué NO se ha hecho (a propósito)

- **Delegación en paralelo.** El ejecutor guarda la herramienta en vuelo en **un solo
  hueco** (`this.runningTool`), que es lo que permite que Detener mate el comando en
  curso; y el navegador es **una instancia compartida**. Paralelizar sin resolver eso
  antes rompería Detener, los logs y el inventario del navegador. Es la mejora grande
  pendiente, y necesita bloqueo por recurso (navegador, disco, terminal), no un `Promise.all`.
- **MCP dentro de subagentes** (fuera de alcance desde la v1.4).
- **Reintento automático de una delegación fallida**: hoy decide el orquestador (regla 5
  de la guía). Automatizarlo sin presupuesto claro es la forma más fácil de gastar tokens
  en bucle.

## Camino para estar por delante (siguiente iteración)

Hecho ya de esta lista: el costo por turno (índice de skills, `use_skill` y orden del
prompt), el fallback del subagente, el bucle único, el tablero en la interfaz y el modelo
por agente. Sigue pendiente:

1. **Paralelismo con recursos bloqueados**: registro de recursos (navegador, disco,
   terminal) con cola por recurso + lista de herramientas en vuelo (no un hueco) para que
   Detener siga matando todo. Es lo que más se nota en tareas largas.
2. **Memoria de subagente**: los hallazgos útiles de una investigación (fuentes buenas,
   rutas del proyecto) deberían quedar en memoria, no morir con el run. El resumen rodante
   del contexto es el sitio natural para lo que aprende el equipo dentro de un hilo, pero
   no sobrevive a la conversación.
3. ~~**Agente de revisión (review)**~~: **hecho en la v2.4**, junto con el diff del turno,
   el perfil del proyecto, el mapa del repositorio y `apply_patch`.
4. **Métricas por agente**: runs, pasos, tokens y tasa de PARTIAL/FAILED por subagente
   para poder mejorarlos con datos en vez de a ojo.
5. **Presupuesto por delegación** (pasos y coste): es el paso previo para reintentar una
   delegación fallida sin riesgo de gastar tokens en bucle.
