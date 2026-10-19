# Auditoría de SAGITARI — 19 de octubre de 2026

**Alcance:** revisión de código de `main/`, `agent/`, `renderer/`, `scripts/`, `test/` y
`.github/` (90 archivos de runtime, ~54.000 líneas propias) **más** la verificación
ejecutada sobre el árbol antes y después de los arreglos (partiendo del commit `017fbae`,
versión 5.0.1, árbol limpio).

**Método:** nueve revisiones dirigidas por subsistema (bucle del agente y modos,
herramientas y permisos, skills y recursos, MCP, memoria e historial, navegador y equipo,
proceso principal e IPC, interfaz, y la superficie de publicación), cada una con lectura
del código y sondas de solo lectura, más la ejecución de la batería que ya trae el
proyecto y la comprobación del paquete real compilado. Cada hallazgo lleva archivo:línea y
el fragmento que lo evidencia; los tres Altos de más impacto se reprodujeron y se
verificaron también a mano antes de dar por bueno el arreglo. Lo que se comprobó y salió
bien se dice también, para que el informe no insinúe problemas que no existen.

**Fuera de alcance (no medido aquí):** `npm run uicheck` (la app del usuario estaba
abierta: el script se niega a lanzar una segunda instancia, y con razón), la firma digital
del instalador, `scripts/verificar-actualizador.js` (su escenario no se puede crear en el
entorno de pruebas: `EPERM` al escribir en el directorio del guion), y el comportamiento
bajo carga real.

---

## 1. Verificación ejecutada

| Comprobación | Comando | Antes (5.0.1) | Después (5.0.2) |
| --- | --- | --- | --- |
| Lint (ESLint 9, config propia) | `npm run lint` | 0 errores | **0 errores** |
| Sintaxis de todos los módulos (como la CI) | `node --check` | 0 fallos | **0 fallos** |
| Pruebas unitarias | `npm test` | **458 en verde** | **510 en verde** |
| Pruebas de renderer (jsdom) | `npm run test:renderer` | **744 en verde** (50 archivos) | **840 en verde** (51 archivos) |
| Contraste WCAG 2.1 AA | `npm run contraste` | 0 de 54 pares por debajo de 4,5:1 | **0 de 54** |
| Arranque real de la app | `npm run smoke` | ventana abierta | **ventana abierta** |
| Navegador real | `npm run navcheck` | 0 fallos | **0 fallos** |
| Interfaz real | `npm run uicheck` | — | **no ejecutable: otra instancia abierta** |
| Dependencias (runtime) | `npm audit --omit=dev` | 0 vulnerabilidades | **0 vulnerabilidades** |
| Dependencias (todo) | `npm audit` | 12 avisos (9 moderados, 3 altos), todos del toolchain de desarrollo | **igual** (pendiente, ver §5) |
| Paquete real | `npx electron-builder --win --dir` + inspección del `app.asar` | `node_modules/` solo con `ws` | **`undici` y `agent/terceros.js` incluidos**; `web.traer()` desde el asar devuelve 200 |

---

## 2. Resumen de hallazgos

Los 50 hallazgos de esta pasada quedaron **cerrados**, cada uno con la prueba que falla si
se quita el arreglo (ciclo rojo-verde comprobado, con la salida literal en el informe del
arreglo). Los siete que siguen abiertos están en §5.

| # | Sev. | Área | Hallazgo |
| --- | --- | --- | --- |
| 1 | **Alta** | Web | `web_fetch` no funciona en la app instalada: `require('undici')` (arreglo del TOCTOU de la 5.0.1) no está declarado y el paquete solo lleva dependencias de producción |
| 2 | **Alta** | Contexto | El recorte de contexto podía dejar el envío con SOLO el prompt del sistema: se perdía la pregunta del usuario |
| 3 | **Alta** | Cierre | La rama de Python pisaba los comandos de Node en `proyecto.detectar`: el cierre corría `python -m unittest` (0 pruebas, salida 0) y marcaba el turno «verificado» |
| 4 | **Alta** | MCP | Una URL con credenciales no podía conectar nunca (la Fetch API prohíbe el userinfo) y el error filtraba el token al log y a la vista |
| 5 | **Alta** | MCP | Tras reiniciar, el agente no veía ninguna herramienta MCP: el arranque solo conectaba los `autoStart` y ese campo no lo pone nadie |
| 6 | **Alta** | Memoria | La migración v1→v2 fusionaba hechos DISTINTOS y los perdía («prefiero el café» desaparecía al llegar «prefiero el té») |
| 7 | **Alta** | Memoria | Un `memory.json` ilegible que no se pudo conservar (EPERM/EBUSY) se pisaba en la siguiente escritura |
| 8 | **Alta** | Equipo | `_crearCompanero` recibía la CLAVE del especialista donde esperaba el objeto: eventos sin `subagent` (el texto del compañero se colaba en la burbuja del líder) y `maxSteps` ignorado |
| 9 | **Alta** | Cierre | Las puertas de verificación y revisión no veían el trabajo delegado: un turno que trabaja delegando cerraba sin comprobar nada |
| 10 | **Alta** | Permisos | La lista de comandos PROHIBIDOS se evadía escribiendo el ejecutable con su extensión o la unidad entre comillas |
| 11 | **Alta** | Interfaz | Los eventos `team_*` de OTRA conversación se pintaban en el hilo a la vista (burbuja y tarjeta incluidas) |
| 12 | **Alta** | Ajustes | El tope de gasto (`#grCost`) se guardaba redondeado a 0, y 0 es «sin tope»: el guardarraíl que el usuario creía activo estaba apagado |
| 13 | **Alta** | Config | Toda clave que SÍ se descifraba se marcaba como ilegible: el aviso «no se pudo descifrar, vuelve a escribirla» salía en cada arranque y el flag quedaba escrito en `config.json` |
| 14 | **Alta** | Tareas | El modo por tarea (Act/Plan/Think) se guardaba y no se aplicaba: una tarea encolada en PLAN corría en ACT y escribía archivos |
| 15 | **Alta** | Publicación | La suite de la interfaz (744 pruebas) no la corría ningún automatismo, aunque las notas de la release y el README publican que está verde |
| 16 | Media | Memoria | El recurso por similitud borraba hechos distintos sin papelera («pnpm» se perdía al llegar «npm») |
| 17 | Media | Memoria | Una negación convivía con el hecho contradictorio (los tres hechos viajaban al prompt) |
| 18 | Media | Skills | `createSkill` pisaba una skill existente sin avisar (la importación sí se protegía) |
| 19 | Media | Skills | Una skill de serie borrada reaparecía al reiniciar (la siembra corría en cada arranque) |
| 20 | Media | Skills | Un `SKILL.md` con BOM o en UTF-16 (corriente en Windows) desaparecía en silencio del índice y del prompt |
| 21 | Media | Aislamiento | La fusión de un árbol aislado no se deshacía cuando el espacio de trabajo era una subcarpeta del repositorio, y el aviso lo callaba |
| 22 | Media | Ficheros | `apply_patch` leía en UTF-8 y reescribía archivos ANSI/CP1252 con «�» en todo el archivo; la pre-imagen del Deshacer salía igual de rota |
| 23 | Media | Agente | Contenido de la web y de la página entraba al prompt sin delimitar como datos de terceros (las skills sí) |
| 24 | Media | Navegador | Con la tubería de depuración, un Chrome huérfano no se podía ni detectar ni cerrar: el navegador quedaba inservible hasta cerrar la ventana a mano |
| 25 | Media | Equipo | Un compañero cortado por tope de pasos se reportaba `ok: true` y la interfaz lo pintaba como terminado |
| 26 | Media | Equipo | Un mensaje del buzón que llegaba en la última llamada al modelo del compañero se perdía |
| 27 | Media | Historial | El texto completo de los adjuntos se guardaba en `conversations.json` (justo lo que decía el comentario de al lado) |
| 28 | Media | IPC | Los canales de espacio de trabajo, modo y `shell:openPath` respondían «hecho» aunque el guardado en disco hubiera fallado |
| 29 | Media | Actualizador | TOCTOU del instalador: la huella del `.exe` se comprobaba antes de cerrar la app y no antes de ejecutarlo; `$vivo` se calculaba y no se usaba |
| 30 | Media | Traza | El rastro del turno guardaba resultados y razonamiento sin la redacción de secretos del log |
| 31 | Media | MCP | `mergeSecrets` conservaba los secretos del servidor anterior y los mandaba al host nuevo |
| 32 | Media | MCP | `fetch` seguía redirecciones: un 302 se llevaba las cabeceras secretas a otro origen, fuera del «solo https» |
| 33 | Media | MCP | Sin tope de tamaño de mensaje/cuerpo: un servidor roto podía agotar la memoria del proceso principal |
| 34 | Media | MCP | Un servidor que no pasaba la validación se descartaba en memoria y el siguiente guardado lo borraba del disco, sin log ni aviso |
| 35 | Media | Permisos | «Aceptar todos los cambios» decidía por prefijo textual de la ruta: un junction dentro del espacio de trabajo escribía fuera sin tarjeta |
| 36 | Media | Adjuntos | La guarda del directorio de datos comparaba una ruta ya resuelta (`realpath`) con un directorio sin resolver |
| 37 | Media | Interfaz | Volver a una conversación que seguía trabajando DUPLICABA el texto final en el hilo |
| 38 | Media | Interfaz | Las órdenes `/` no se despachaban: `/cost` viajaba al modelo como mensaje normal |
| 39 | Media | Modos | PLAN anunciaba que ejecutaría el plan (su prompt y su cara) mientras el código prohíbe escribir |
| 40 | Media | Modos | Agotar el cupo de llamadas a herramientas no cortaba el turno: avisos y rondas hasta el tope de pasos |
| 41 | Media | Arranque | `autoResume()` corre una sola vez al arrancar: una tarea interrumpida cuyo backoff vencía dentro de la sesión no se reintentaba |
| 42 | Baja | Publicación | `npm run navcheck` daba verde (código 0) al saltarse por no haber Chrome ni Edge |
| 43 | Baja | Publicación | `npm run lint` no corría en CI ni en la release (los dos pasos añadidos); `npm run format:check` sigue sin correr y hay 6 archivos con formato pendiente (ver §5-G) |
| 44 | Baja | Persistencia | El arreglo del hallazgo 9 de la auditoría anterior quedó incompleto: con una sola copia real que no se podía borrar, `remove()` devolvía `ok: true` |
| 45 | Baja | Ajustes | «Detectar modelos» del pie llamaba al sondeo sin `format`/`providerId` (401 en bases Anthropic de terceros) |
| 46 | Baja | Proveedores | `claveGuardadaPara` comparaba la `baseUrl` byte a byte: una barra final dejaba el sondeo sin credencial |
| 47 | Baja | Docs | `Alt+M` documentado como ciclo de tres modos (cicla cuatro) y recuentos de pruebas desfasados |
| 48 | Baja | Scripts | `make-assets.js` documentaba una ejecución que falla (la fuente no está en el repo) y su salida no estaba ignorada |
| 49 | Baja | Modos | `MODE_PROFILES.maxSteps` no se aplicaba en ninguna parte mientras `chatkit` prometía modos con distinto presupuesto de pasos |
| 50 | Baja | Skills | La paleta `/` anunciaba `clear`, `new` y `model`, que no existen detrás (respondían «orden desconocida») |

---

## 3. Detalle de los cinco Altos que cambian el comportamiento que el usuario ve

### 1 · `web_fetch` roto en la app instalada
`agent/web.js:279` hacía `require('undici')` para fijar la IP ya validada (el cierre del
TOCTOU del hallazgo 8 de la auditoría anterior). `package.json` solo declaraba `ws`, y
`undici` estaba en el árbol únicamente como dependencia transitiva de desarrollo
(`electron-builder` → `node-gyp`), así que en el paquete real el `require` lanzaba
`MODULE_NOT_FOUND` y `web_fetch` respondía «Cannot find module 'undici'» con **cualquier**
URL con nombre. Comprobado sobre el `app.asar` de la app instalada (`node_modules/` solo
contenía `ws`) y reproducido con el `require` bloqueado. **Arreglo:** `undici` declarado
como dependencia de producción (versión exacta) y una prueba que cierra la clase entera
(`test/43-sistema-hardening.js`: cada `require` de runtime es builtin, `electron` o está
declarado). Verificado también **dentro del paquete**: `web.traer()` desde el `app.asar`
del build devuelve 200 en https y sigue la redirección de http→https con la IP fijada.

### 2 · El recorte de contexto podía enviar el turno sin la pregunta
`agent/contexto.js:134-151`: el guardián `bloques.length - i > minimo` estaba solo en el
bucle exterior y el interior purgaba bloques hasta encontrar uno que empezara por el
usuario, sin tope. Sonda: 22 mensajes (un solo turno de usuario y diez pasos de
herramientas) → `quitados: 11`, `messages: [system]`: al modelo le llegaba la conversación
**sin la pregunta**. **Arreglo:** el último bloque que trae una petición del usuario es el
turno en curso y no se suelta (dos pruebas nuevas).

### 3 · Cierre «verificado» con el comando de otro lenguaje
`agent/proyecto.js:136-142`: la rama de Python asignaba `p.tests` y `p.lint` directamente,
pisando lo que la rama de Node ya había encontrado en `package.json`. En un proyecto mixto,
el cierre corría `python -m unittest`, que sin pruebas imprime «Ran 0 tests» y **sale con
0**, así que el turno quedaba verificado sin haber ejecutado la suite real. **Arreglo:**
ninguna rama pisa lo que ya encontró otra (`p.X = p.X || …`), con las cuatro combinaciones
probadas (Node+Python, solo Python, pytest) y el resto de ramas repasadas.

### 4 · Una URL de MCP con credenciales no conectaba (y el token se filtraba)
`agent/mcp-transport.js:373,401` validaba la URL y la pasaba tal cual a `fetch`. La Fetch
API prohíbe el userinfo (`new Request('https://usuario:token@host/mcp')` lanza), así que
todas las peticiones caían en el `catch` y el mensaje viajaba al log y a la vista **con el
token dentro**, aunque el resto del producto soporta y cifra esa forma. **Arreglo:** el
userinfo se traduce a `Authorization: Basic …` y la URL viaja limpia (una cabecera puesta a
mano manda), con la prueba que comprueba además que la credencial NO aparece en la URL que
ve `fetch`.

### 5 · Tras reiniciar, el agente no veía ninguna herramienta MCP
`main/main.js` (arranque) e `main/ipc-mcp.js` (reencendido) conectaban solo los servidores
con `autoStart`, y `main/mcp-config.js:59` lo guardaba como `autoStart === true`: al no
venir del formulario (no hay ningún control) quedaba `false` para siempre. Como el catálogo
del modelo solo ofrece servidores `ready`, cada arranque dejaba MCP en «sin probar» hasta
que el usuario probaba cada servidor a mano. **Arreglo:** el interruptor por servidor es
`enabled` (el arranque conecta todos los habilitados y válidos) y `autoStart` es verdadero
por defecto. Verificado en el arranque real con dos servidores sembrados.

---

## 4. Lo verificado y OK

- **Confinamiento de rutas y clasificación de comandos**: bloqueo del directorio de datos
  (comparando ruta normalizada **y** camino real), carpetas del sistema y raíz de unidad;
  `read_file`/`view_image` con tope de tamaño; `edit_file` que se niega a corromper archivos
  no-UTF-8 (y ahora `apply_patch` también); comandos prohibidos/sensibles con lista blanca
  que solo aplica a órdenes simples.
- **Aislamiento de subagentes**: los que escriben trabajan en un árbol de git y su cambio
  vuelve como parche verificado; sin git, el equipo lo dice en vez de fingir aislamiento.
- **IPC**: ningún canal escribe `workspace`, rutas ni secretos fuera de su vía dedicada
  (`settings:set` filtra por lista blanca; `workspace:set`/`workspace:pick`/`shell:openPath`
  pasan por la validación de rutas); `preload.js` no expone de más; el remitente de cada
  canal se valida y los permisos del sistema se deniegan por defecto.
- **Saneado del markdown del modelo**: lista blanca de etiquetas y atributos, parseo en
  documento inerte y URLs restringidas. No apareció ningún punto sin escapar con datos del
  modelo, de una skill, de un archivo o de una respuesta IPC.
- **Secretos**: claves de API y secretos de MCP cifrados en disco, enmascarados en la vista
  y redactados en el log (y desde esta versión también en el rastro guardado).
- **Escrituras atómicas** en config, conversaciones, memoria y tareas, con copia `.bak`,
  cuarentena de fichero ilegible y recuperación desde la copia.
- **Ciclo de vida**: instancia única, aviso de cierre con un turno en marcha, parada del
  agente y cierre de procesos hijos; el actualizador comprueba la firma del `latest.yml` y
  cada binario declara su SHA-256.
- **Interfaz**: todos los controles de Ajustes guardan la clave que dicen (el único que
  guardaba otro valor era `#grCost`, corregido) y ninguna clave queda fuera de la lista
  permitida en `main/ipc-config.js`; los atajos no disparan sobre campos de texto y las
  confirmaciones no enfocan «Permitir».
- **Publicación**: el gate del tag (aborta si el tag no coincide con `package.json`), la
  extracción de la sección de notas (`awk`, probada con la 5.0.2) y la verificación de
  artefactos + `latest-yml --check` impiden publicar la versión equivocada o a medias.
- **Sistema de skills**: validación de identidad y de contenido al importar, topes de
  tamaño, y ahora también BOM/UTF-16 y prohibición de pisar una skill existente.

---

## 5. Hallazgos abiertos y pendientes

| # | Sev. | Área | Qué queda |
| --- | --- | --- | --- |
| A | Baja | Ventana | `window-all-closed` y la recuperación del renderer cuando la ventana se destruye: revisado, sin arreglo discreto; conviene decidirlo antes de publicar |
| B | Baja | Navegador | `action=logs` y `action=eval` del navegador siguen sin delimitar como contenido de terceros (los bytes vienen de la página); el envoltorio llegó a `web_fetch` y a `action=content` |
| C | Baja | Skills | `agent/cambios.js:121` tiene su propio `dentroDelEspacio` textual; ahí el error va en la dirección conservadora (rechaza restaurar), no abarata escrituras |
| D | Baja | Modos | `MODE_PROFILES.maxSteps` se retiró en vez de aplicarse: el presupuesto de pasos lo fija el usuario (coherente con `PRODUCT.md`), y los textos que prometían otra cosa se corrigieron |
| E | Baja | Herramientas | `sudo -u root <comando prohibido>` queda en «sensible» (confirmación) y no en «prohibido»: sin una tabla de opciones por lanzador no se puede saber cuántos valores consume cada bandera |
| F | Baja | Publicación | 12 avisos de `npm audit`, todos en el toolchain de desarrollo (no se distribuyen); el único de runtime es `ws` y no aparece en ningún aviso |
| G | Baja | Publicación | `prettier --check` marca 6 archivos (`agent/agent.js`, `agent/subagents.js`, `renderer/10-chat.js`, `renderer/20-app.js`, `renderer/30-ajustes.js`, `test/40-agente.js`); no corre en CI y no se tocó para no ensuciar el diff de esta release |
| H | Baja | Memoria | Una contradicción escrita con prefijo conversacional («Recuerda que no me gusta el té») no se reconoce contra el hecho canónico del mismo objeto: `mismoHecho` no la ve porque las palabras del valor pierden los términos cortos, así que conviven las dos. La causa está en `tokenizarRaiz`/`valorPalabras` (`agent/memoria-v2.js`); las formas canónicas sí se resuelven |

Fuera de estos ocho, no queda ningún hallazgo de esta pasada sin cerrar.

---

## 6. Prioridad sugerida

1. **Publicar la 5.0.2** con lo que ya está: los cinco Altos afectan a cosas que el usuario
   ve a diario (`web_fetch`, MCP, la cola de tareas, el cierre del turno, la memoria).
2. **Decidir A** (recuperación de la ventana) antes de etiquetar si se quiere cerrar también
   ese flanco.
3. **§5 E y §5 B** en una pasada de endurecimiento (opciones de lanzadores y el resto de
   acciones del navegador).
4. **§5 F** (subir el toolchain de desarrollo) como cambio aparte, con la batería delante:
   no es riesgo para el usuario, pero conviene no mezclarlo con una release de correcciones.

---

## 7. Revisión final del diff completo (misma fecha, antes de publicar)

Antes de mover el tag se revisó el diff entero `017fbae..11e72c6` con **cuatro revisiones
independientes** (agente y modos, datos y red, interfaz y publicación, y las pruebas). No
dieron por bueno el informe: leyeron el código. Encontraron **once defectos más**, dos de
ellos en arreglos de esta misma auditoría que estaban **incompletos o mal**, y uno de ellos
bloqueante. Todos quedaron cerrados con su prueba (ciclo rojo-verde) antes de etiquetar:

| Sev. | Qué encontraron | Cómo se cerró |
| --- | --- | --- |
| **Bloqueante** | El arreglo del hallazgo 2 (`agent/contexto.js`) estaba mal en los dos sentidos: en una conversación de VARIOS turnos seguía vaciando el envío hasta dejar solo el prompt del sistema, y en un turno único no recortaba nada | El índice del turno en curso se recalcula en cada vuelta y el turno en curso también se recorta por sus pasos ya cerrados (sin partir una llamada de sus resultados) |
| Importante | La barrera de comandos prohibidos, al re-anclarse a `^`, se evadía anteponiendo palabras: `start`, `@`, `>nul`, `if`, `for…do`, `ftype x=`, `start "" /b`, `%COMSPEC% /c`, `FOO=1` | `desnudar()` quita decoradores y construcciones antes de mirar la orden (17 formas de evasión cubiertas y 7 menciones inocentes que siguen normales) |
| Importante | Un compañero de EQUIPO que cierra su encargo con `team_done` seguía recibiendo rondas hasta agotar su presupuesto, y la vuelta acababa cortada: la tarjeta salía en rojo aunque el trabajo estuviera hecho (lo cazó la puerta de `ui-check` al ejecutarla por primera vez) | El bucle termina cuando el compañero cierra; solo son fallo el corte y un FAILED explícito |
| Importante | El `autoResume()` del tick resucitaba turnos del CHAT (el que acababa de decir «me he detenido») y `_start` no respetaba `isRunBusy` | La recuperación automática es solo para tareas; `_start` no arranca un run que el chat sigue ejecutando |
| Importante | Las puertas de cierre solo veían el trabajo delegado CON árbol aislado (sin git o con aislamiento apagado, el líder acababa con 0 escrituras) | Sin árbol se cuenta lo que el delegado escribió (foto del diff antes/después) |
| Importante | `add()` de la memoria había perdido la consolidación del MISMO dato escrito de otra forma («El usuario se llama Darío» + «Recuerda que me llamo Dario» quedaban como dos hechos) | El recurso sin clave usa `mismoHecho` (por valor), no la huella a secas: el duplicado se consolida y «pnpm»/«npm» siguen sin fusionarse |
| Importante | `mergeUrl` reinyectaba la credencial guardada aunque cambiara el HOST del servidor MCP | La credencial solo se restaura si la URL sin credenciales coincide |
| Menor | `mode:set` dejaba interfaz y motor discrepando en silencio cuando el guardado fallaba (y el comentario decía que había un aviso que no existía) | El renderer avisa y vuelve al modo anterior |
| Menor | `/cost` se rechazaba con un turno en marcha y su línea podía acabar en otra conversación | La rama de `cost` va antes de la guarda de ocupado y la línea se pinta en el hilo que lanzó la orden |
| Menor | El fallo al guardar el espacio de trabajo no revertía el valor en memoria; la ficha de un adjunto prometía algo imposible | Se revierte el valor y la ficha dice lo que de verdad se puede hacer |
| Menor | Cuatro pruebas no probaban lo que decían (un campo muerto, la migración del nombre, la idempotencia de la migración) y una cláusula de `ui-check` era tautológica | Se reescribieron para que fallen sin el arreglo; la cláusula comprueba ahora que toda orden de la paleta se explica |
| **Importante** | La puerta nueva (la suite de interfaz en la CI) encontró dos defectos que solo salían en el runner. Uno de producto: el ayudante de instalación calculaba la huella con `Get-FileHash`, un cmdlet que PowerShell 5.1 puede no encontrar si hereda el `PSModulePath` de PowerShell 7 — el diario del runner lo dejó escrito: `el instalador NO coincide con la huella SHA-512 publicada (real=)`. Una app lanzada desde PowerShell 7 habría dicho «la huella no coincide» sobre un instalador correcto y **no se habría actualizado nunca**. | El SHA-512 se calcula ahora con `System.Security.Cryptography` (sin depender de ningún módulo). Verificado en el runner |
| Menor | La prueba de `taskTimePlus` usaba un instante UTC fijo y la función devuelve hora LOCAL: en el runner (UTC) daba 10:05 y aquí 11:05 | La base se construye en hora local: el caso no depende del huso |
| Menor | La puerta de la interfaz comprobaba el archivo del compañero con un `existsSync` inmediato, antes de que se fusionara su árbol: en un runner cargado la fusión llegaba después y la comprobación se caía sola (pasó una vez y la siguiente no) | Espera acotada (hasta 10 s) en vez de una sola mirada |

Con esto, la frase de las notas —«cada uno con la prueba que falla sin el arreglo»— es
verdad también para los hallazgos 5, 43 y 47.
