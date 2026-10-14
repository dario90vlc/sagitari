# Memoria a largo plazo y contexto largo — diseño

Fecha: 2026-10-14. Estado: aprobado el diseño; pendiente el plan de implementación.
Decisión del usuario: **«lo mejor de lo mejor»** — que no haya que rehacerlo — con **todo
local** (sin coste por uso) y la opción semántica como fase aparte.

---

## 1. De dónde partimos (medido, no supuesto)

**Memoria**
- `agent/memory.js`: almacén JSON local con puntuación de relevancia (Jaccard + importancia +
  frescura), guardado atómico y cuarentena. Topes: `MAX_MEMORIES=300`, `MAX_IN_CONTEXT=30`.
  La relevancia se calcula sobre **los últimos 6 mensajes** del hilo.
- Se escribe **solo a mano**: la herramienta `remember` (importancia 0,6 por defecto) o la
  propia lista de la vista. **No hay extracción automática.**
- Datos reales del usuario: **2 entradas y son la misma** («El usuario se llama Darío» /
  «Recuerda que me llamo Dario»). Es decir: hoy la memoria no recuerda nada.
- `agent/habits.js` guarda aparte contadores de uso (herramientas, webs, modos, permisos
  aprobados/denegados) con decaimiento a 180 días, tope 5 por categoría y mínimo 2 usos. Datos
  ricos: 330 usos de navegador, 178 de comandos, 31 aprobaciones. **Apenas se aprovechan.**
- La vista «Memoria» (`renderer/40-vistas.js:346-409`) es una **lista plana** con un
  deslizador de importancia y una papelera; el resto de la configuración es un desplegable de
  sensibilidad en Ajustes. No dice qué sabe, ni de dónde salió, ni cuándo se usó.

**Contexto largo**
- **Dos presupuestos que no se hablan**: (a) recorte a `MAX_HISTORY=40` mensajes al entrar cada
  turno (`agent/historial.js`), con plegado extractivo a un resumen rodante
  (`agent/agent.js:293-331`) que **vive solo en memoria y se pierde al cerrar la app**; y (b) un
  recorte por estimación de caracteres (`CHARS_POR_TOKEN=3.6`, `agent/contexto.js`) que actúa en
  cada paso del bucle y **solo sobre lo que se envía**, no sobre el historial.
- La ventana del modelo es una **tabla por expresión regular** con un override
  (`cfg.contextWindow`) **sin interfaz**.
- `/compact` es manual, sin explicación y sin sugerencia.
- El medidor del chat (`#ctxMeter`) enseña el porcentaje y el estado
  (`hola`/`ajustado`/`apretado` a 0,6/0,85), pero no explica nada más.
- Persistencia: `conversations.json` (tope 300 conversaciones), checkpoints por tarea
  (`HISTORY_MAX=60`) y memoria. **El resumen rodante no se persiste.**
- Historial del usuario: 127 conversaciones, 276 mensajes, ~122k tokens en total. **Pequeño**:
  no necesita vectores para ir sobrado; sí necesita no perder nada y saber buscar.

---

## 2. Objetivo

Que SAGITARI **te conozca** (hechos duraderos, aplicados sin repetírselos) y **te recuerde**
(decisiones y conversaciones pasadas, encontrables en cualquier hilo), con un contexto largo
que no pierda el hilo ni dependa de trucos, y con una vista que una persona entienda sin
manual. Todo local y sin coste por uso.

---

## 3. Arquitectura: tres capas y una recuperación

### 3.1 Capa FICHA (hechos)

- Un hecho es: `id`, `texto`, `origen` (de dónde salió: mensaje, conversación, herramienta,
  hábitos), `creado`, `usadoUltima`, `usos`, `importancia` (alta/normal/baja), `etiquetas`,
  `origenTexto` (la frase literal de la que salió, para poder auditar), `hash` (deduplicación).
- **Escritura (extracción con puerta)**: al cerrar turno, un paso **heurístico y gratis** mira
  el mensaje del usuario y decide si «huele» a hecho duradero (patrones de identidad,
  preferencia, proyecto, ruta, corrección de algo anterior) y, solo entonces, propone una
  entrada. La herramienta `remember` sigue existiendo, con un prompt que la hace más proactiva
  ante correcciones del usuario. **El modelo no se usa para esto por defecto**; Ajustes podrá
  activar «extracción con el modelo» para quien prefiera calidad y acepte gastar tokens.
- **Aprobación**: toda entrada nueva va a **«Recién aprendido»** (bandeja). Guardar, editar o
  descartar. Se guarda sola **solo** si el usuario enciende «guardar sin preguntar».
- **Consolidación** (en vez de topes arbitrarios): al añadir, se busca un hecho equivalente o
  contradictorio por similitud (léxica, o vectorial en fase 4); si lo hay, **se fusiona**
  (texto más reciente + `usos` sumados + `origen` conservado) y se marca el cambio como
  deshacer-able. Corrige el caso real de los dos «me llamo Darío».
- **Olvido**: un hecho sin usarse en 180 días baja a importancia baja; sin usarse en 365 días
  pasa a **papelera** (recuperable 30 días) antes de borrarse. Nunca se borra silenciosamente.
- **Presupuesto de recuerdo**: por turno se inyectan los mejores hechos con un **tope de
  tokens** (no 30 fijos): relevancia = léxica (Jaccard mejorado) × importancia × frescura ×
  uso, con un mínimo de hechos «de identidad» siempre presentes (nombre, idioma).

### 3.2 Capa EPISODIOS (lo hablado)

- **Índice local** construido desde `conversations.json` (y mantenido al vuelo): por turno
  guarda `convId`, `fecha`, `rol`, extracto, herramientas usadas, proyecto/carpeta y un
  **vector de términos** (postings invertidos) para búsqueda léxica de calidad.
- **Resumen por conversación** (recap durable, ver 3.4) indexado también.
- **Búsqueda**: puntuación tipo BM25 (frecuencia de término con saturación, IDF, longitud) con
  raíz de palabra en español y frenado por frecuencia; filtros por fecha, proyecto y
  herramienta. En fase 4 se añade ranking semántico y fusión de resultados (RRF).
- **Reconstrucción**: si el índice falta o está corrupto, se regenera desde
  `conversations.json` (fuente de verdad); nunca es el único sitio donde vive nada.

### 3.3 Capa HÁBITOS (lo que ya se observa)

- Se conserva `habits.js` como está (contadores con decaimiento) y se **aprovecha**:
  - en el prompt, como hoy, pero con frases legibles («suele usar el navegador para X», «casi
    siempre aprueba los comandos de Y»);
  - en la vista, como etiquetas con recuento y un «olvidar» por categoría;
  - como **señal para la extracción**: un patrón repetido en hábitos puede proponer un hecho
    («trabajas siempre en `C:\...\APPS`») a la bandeja de aprobación.

### 3.4 Recuperación y transparencia

- Por turno, el agente pide a la memoria: «hechos relevantes» (tope de tokens) y, si el
  mensaje parece una pregunta sobre el pasado («¿qué decidimos…?», «¿qué te pedí…?»), una
  **búsqueda de episodios** con sus 3 mejores resultados (fragmento + fecha + conversación).
- Lo que se inyecta va en el **bloque volátil** del prompt (como hoy) para no romper la caché
  del prefijo.
- **En el chat, en voz baja**: cuando el turno usó memoria, una línea discreta «usando lo que
  sé de ti (2)» que al pulsarla enseña exactamente qué se usó y permite borrarlo en el sitio.

---

## 4. Contexto largo, de una pieza

### 4.1 Un solo planificador

Sustituye a los dos presupuestos actuales. En cada paso del bucle se compone **qué ve el
modelo**, en este orden de prioridad y con un presupuesto en tokens:

1. Sistema + instrucciones (estable, cacheable).
2. **Resumen durable** de lo antiguo (lo que ya no viaja completo).
3. Memoria (hechos relevantes) y fuentes inyectadas del turno.
4. Turnos recientes completos (los últimos N).
5. Margen reservado para la respuesta (**20 % de la ventana**, o el máximo de salida que
   declare el modelo si es mayor).

El planificador decide **una vez** y lo usan todos: el envío al modelo, el medidor de la
interfaz y el aviso al usuario. Nunca se recorta el historial guardado.

### 4.2 Resumen durable por conversación («Lo que llevamos»)

- Al superar el umbral de turnos que caben, el agente **pliega lo antiguo** en un resumen
  extractivo (como hoy) y **lo persiste** junto a la conversación (no se pierde al cerrar).
- Es **legible y editable** en la interfaz, con la fecha y el número de turnos que resume.
- Se regenera cuando crece; los turnos originales **siguen completos** en
  `conversations.json` y buscables en Episodios.

### 4.3 Ventanas reales y compactación

- **Ventana por modelo**: tabla interna + **la que declare el proveedor** cuando exista +
  **override visible** en el selector de modelo («8k · 128k · 200k»), con aviso si el modelo
  elegido es pequeño para el hilo abierto.
- `/compact` pasa a llamarse **«Resumir lo antiguo»**, con botón visible y **sugerencia
  automática** al llegar al 85 % (no se lanza solo: se propone).
- El medidor se explica: `62 % de 128k · 3 turnos resumidos · puedo resumir más`, y al pulsarlo
  abre el desglose (sistema, resumen, memoria, turnos, margen).

---

## 5. La vista Memoria (rediseño)

Secciones, en este orden; la primera es lo que el usuario viene a ver:

1. **Lo que sé de ti** — tarjetas por hecho: texto **editable en el sitio**, importancia en
   tres niveles (Alta / Normal / Baja, no un deslizador), **de dónde salió** («de tu frase del
   12 oct, en *Vuelos a Tánger*») y **cuándo se usó** («usado hace 3 días, 12 veces»); borrar
   con deshacer. Filtro por etiqueta y buscador propio.
2. **Recién aprendido** — la bandeja de aprobación (Guardar / Editar / Descartar), con el
   texto literal del que salió y por qué se propuso. Si está vacía, lo dice y explica cómo se
   llena.
3. **Cómo trabajas conmigo** — hábitos en lenguaje humano, agrupados (herramientas, webs,
   carpetas, modos, permisos), con «olvidar esta categoría».
4. **Buscar en lo que hemos hablado** — caja de búsqueda con resultados (fragmento subrayado,
   fecha, conversación) y «ir a esa conversación»; filtros por fecha y proyecto.
5. **Papelera** — lo olvidado, recuperable 30 días.
6. Pie: **un interruptor** («Que aprenda de nuestras conversaciones»), dos líneas de qué hace y
   qué no, y dos acciones claras: «Exportar mi memoria» (JSON legible) y **«Olvídalo todo»**
   (con confirmación escrita).

Estados: vacío (con explicación, no un panel en blanco), cargando, error de lectura del
almacén (con cuarentena visible y salida: «restaurar copia»), y todo el contenido navegable por
teclado con foco visible y nombres accesibles (objetivo WCAG 2.1 AA, como el resto).

---

## 6. Datos y compatibilidad

- `memory.json`: se **migra** al esquema v2 (añade `origen`, `origenTexto`, `hash`,
  `etiquetas`, `papelera`); las entradas v1 se conservan y se deduplican al migrar (los dos
  «me llamo Darío» se fusionan). Copia `.bak` antes de migrar; si algo falla, cuarentena y la
  app arranca con memoria vacía **diciéndolo**.
- `episodes.idx.json`: índice de episodios (regenerable; si falta, se reconstruye).
- El **resumen durable vive dentro de la conversación** (un campo `recap` en su objeto de
  `conversations.json`): una sola fuente de verdad para el hilo y su resumen, sin un fichero
  aparte que se pueda desincronizar.
- Nada sale del equipo. El motor semántico (fase 4) es un modelo local descargado a petición y
  el índice vectorial se guarda también en local.

---

## 7. Interfaces nuevas (nombres)

- **IPC**: `memory:tray` (listar/aceptar/descartar propuestas), `memory:episodes` (buscar),
  `memory:recap` (leer/editar el resumen durable), `memory:export`, `memory:wipe`,
  `memory:trash` (listar/restaurar), `ctx:plan` (desglose del presupuesto).
- **Herramientas del agente**: `remember` (mejorada), `recall` (buscar en episodios y hechos:
  la usa el propio agente cuando el usuario pregunta por el pasado), `recap` (leer el resumen
  de la conversación actual). Todas de riesgo `safe` y disponibles en modo PLAN (solo lectura
  las dos últimas).
- **Preload**: un puente por cada una, con el mismo estilo que el resto.

---

## 8. Manejo de errores

- Sin motor semántico → léxico (nunca un error de cara al usuario).
- Sin modelo para extracción → heurística y herramienta `remember` (que ya funciona).
- Índice de episodios ilegible → se reconstruye; si falla, la búsqueda se desactiva con un
  aviso claro y el resto de la memoria sigue.
- `memory.json` ilegible → cuarentena + memoria vacía + aviso con «restaurar copia».
- Presupuesto excedido → el planificador recorta por prioridad y lo dice; nunca rompe el turno.

---

## 9. Pruebas

- **Puras**: extracción (patrones y no-falsos-positivos), consolidación/fusión, decaimiento y
  papelera, puntuación léxica e IDF, planificador de contexto (prioridades y topes), migración
  v1→v2 con deduplicación.
- **Renderer**: la vista (secciones, edición en el sitio, bandeja, papelera, búsqueda) y sus
  estados (vacío, error).
- **Arnés sobre la app viva** (`ui-check`): un turno que aprende un hecho → aparece en «Recién
  aprendido» → se guarda → se usa en el turno siguiente y el chat lo dice; y una búsqueda en
  Episodios que devuelve el fragmento correcto.
- **De arquitectura**: que el planificador sea el **único** que decide el recorte (una prueba
  que falle si aparece un segundo presupuesto).

---

## 10. Fases (cada una usable por sí sola)

1. **Vista + ficha + hábitos**: migración, bandeja de aprobación, tarjetas, papelera, hábitos
   legibles, exportar/olvidar. Con la extracción heurística + `remember`.
   *Aceptación*: tus dos entradas actuales quedan fusionadas en una; una frase del tipo «me
   llamo X» dicha en un turno aparece en «Recién aprendido» y al guardarla se usa en el turno
   siguiente; borrar y restaurar de papelera funciona; nada se guarda sin aprobación (con el
   interruptor apagado).
2. **Contexto de una pieza**: planificador único, resumen durable persistido y editable,
   ventanas reales, medidor explicado, «Resumir lo antiguo».
   *Aceptación*: existe **un solo** sitio que decide el recorte (una prueba falla si aparece
   otro); el resumen sobrevive al reinicio y se puede leer y editar; el selector enseña la
   ventana de cada modelo; el medidor dice porcentaje, turnos resumidos y qué se puede hacer.
3. **Episodios**: índice, buscador en la vista, herramienta `recall`, recuerdo por turno con
   tope de tokens y aviso «usando lo que sé de ti».
   *Aceptación*: buscar «qué decidimos de X» devuelve el turno correcto con su fragmento y su
   hilo aunque sea de hace semanas; el índice se reconstruye solo si se borra; el recuerdo
   inyectado nunca pasa de su tope de tokens y el chat dice cuándo usó memoria.
4. **Motor semántico opcional**: embeddings locales, ranking y fusión, deduplicación
   semántica; siempre con el camino léxico como respaldo.
   *Aceptación*: con el motor instalado, una consulta sin las palabras literales encuentra el
   recuerdo correcto; sin él, todo lo de las fases 1-3 sigue funcionando igual y sin errores.

---

## 11. Fuera de alcance (explícito)

- Sincronizar la memoria entre equipos o en la nube.
- Memoria compartida entre usuarios.
- Vectores sobre cada token del historial (se indexa por turno, no por fragmento).
- Cambiar el formato de `conversations.json` (es la fuente de verdad y no se toca).

---

## 12. Decisiones ya tomadas

- Extracción **heurística por defecto**, con la opción de usar el modelo en Ajustes.
- Semántico como **fase 4 opcional** (descarga a petición), nunca requisito.
- Nada se recuerda sin que el usuario pueda verlo, editarlo y borrarlo.
