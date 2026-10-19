# SAGITARI 5.0.3

**De un vistazo:** un turno ya no muere cuando el modelo no respeta el protocolo de herramientas · si escribe la llamada como texto, se le corrige una vez y, si insiste, se dice qué pasa y qué hacer · unos argumentos rotos dejan de envenenar la conversación · los errores de formato del proveedor dicen qué ocurre en vez de «El turno falló» · 513 pruebas y 842 de interfaz, en verde. / **At a glance:** a turn no longer dies when the model breaks the tool protocol · if it writes the call as text, it is corrected once and, if it insists, the user is told what happened and what to do · malformed arguments no longer poison the conversation · provider format errors say what happened instead of "The turn failed" · 513 tests and 842 interface tests, all green.

**Dos fallos con el mismo síntoma: el turno se quedaba a medias y había que reintentar.** El primero: un `arguments` de herramienta que no era JSON válido (una coma de más, la cadena cortada) se quedaba guardado en el historial y el proveedor rechazaba la petición entera; el turno fallaba con un mensaje genérico y, como el mensaje seguía en el hilo, los turnos siguientes también. Ahora lo que se envía y se guarda lleva argumentos válidos, la llamada original se ejecuta igual y al modelo se le dice que la reenvíe bien. El segundo: algunos modelos —los «free» de algunos proveedores— escriben la llamada a la herramienta como TEXTO (`</constrain>assistant to=browser_control…`) en vez de usarla, y el turno acababa con ese texto como respuesta. Ahora se le pide UNA vez que use la herramienta de verdad y, si insiste, el turno cierra con una explicación («cambia de modelo») en lugar de con basura. Y los errores de formato del proveedor (400, argumentos) ya no caen en «El turno falló»: dicen qué pasa y qué hacer.

### Correcciones / Fixes

- **Argumentos de herramienta rotos:** no viajan al proveedor ni quedan en el historial (se sanean a `{}` en lo que se envía); el modelo recibe el error y puede reenviar la llamada. Antes, un solo argumento roto mataba el turno y dejaba el hilo inservible. / **Broken tool arguments:** they neither travel to the provider nor stay in the history (sanitized to `{}` in what is sent); the model gets the error and can resend. A single broken argument used to kill the turn and leave the thread unusable.
- **Llamada escrita como texto:** se detecta (fuera de bloques de código) y se corrige una vez; si el modelo insiste, el turno cierra diciendo qué pasa y que cambie de modelo, y queda registrado en la salud del modelo. / **Tool call written as text:** detected (outside code blocks) and corrected once; if the model insists, the turn closes explaining what happened and to change model, and it is recorded in model health.
- **Errores del proveedor:** los rechazos por formato (400/argumentos) y el formato de herramientas tienen su propio mensaje y su pista, en vez del genérico «El turno falló». / **Provider errors:** format rejections (400/arguments) and tool-format failures have their own message and hint instead of the generic "The turn failed".
- **Recuentos:** 513 pruebas en `npm test` y 842 en `npm run test:renderer` (51 archivos). / **Counts:** 513 tests in `npm test` and 842 in `npm run test:renderer` (51 files).

# SAGITARI 5.0.2

**De un vistazo:** segunda pasada de auditoría (19 de octubre): 50 defectos reales cerrados (15 Altos, 26 Medios, 9 Bajos) y los 11 que cazó después la revisión del diff completo, cada uno con la prueba que falla sin el arreglo · `web_fetch` vuelve a funcionar en la app instalada · un turno que trabaja delegando ya no cierra sin verificación ni revisión · una tarea encolada en PLAN deja de escribir · el recorte de contexto ya no se lleva la pregunta del usuario · el navegador se recupera de un Chrome huérfano · la suite de la interfaz y el lint corren en CI y en la release · 510 pruebas y 840 de interfaz, en verde. / **At a glance:** second audit pass (19 October): 50 real defects closed (15 High, 26 Medium, 9 Low) plus the 11 the full-diff review caught before publishing, each with the test that fails without the fix · web_fetch works again in the installed app · a turn that works by delegating no longer closes without verification or review · a task queued in PLAN stops writing · context trimming no longer drops the user's request · the browser recovers from an orphaned Chrome · the UI suite and the linter now run in CI and in the release · 510 tests and 840 interface tests, all green.

**Esta versión no trae funciones nuevas: trae lo que ya prometía funcionando.** El informe completo, con archivo y línea de cada cosa y lo que se comprobó y salió bien, está en `docs/AUDITORIA-2026-10-19.md`. Lo más visible para quien la usa: `web_fetch` volvía a fallar en la app instalada (devolvía el error crudo de Node, no una página) porque el cierre del TOCTOU de la 5.0.1 usaba un paquete que solo existía en el árbol de desarrollo; una tarea de la cola encolada en PLAN escribía archivos porque su modo se guardaba y nunca se aplicaba; un turno largo podía enviarse al modelo **sin la pregunta del usuario** (el recorte de contexto vaciaba el envío hasta dejar solo el prompt del sistema); y el tope de gasto del panel se guardaba como 0 —o sea, sin tope— aunque la interfaz enseñara el número que habías escrito.

### Correcciones / Fixes

- **Web:** `web_fetch` funcionaba en desarrollo y fallaba en la app instalada (`undici` no estaba declarado como dependencia de producción). Declarado, con un test que cierra la clase entera: lo que el código pide en tiempo de ejecución está declarado o es builtin. / **Web:** `web_fetch` worked in development and failed in the installed app (`undici` was not declared as a production dependency). Declared, plus a test that closes the whole class.
- **Cierre del turno:** la comprobación de cierre podía ejecutar `python -m unittest` (0 pruebas, salida 0) en un proyecto de Node y dar el turno por **verificado**; y un turno que trabaja delegando no disparaba ni la verificación ni la revisión. / **Turn close:** the close check could run `python -m unittest` (0 tests, exit 0) in a Node project and mark the turn **verified**; and a turn that works by delegating tripped neither verification nor review.
- **Memoria:** la migración v1→v2 fusionaba hechos distintos («prefiero el café» desaparecía al llegar «prefiero el té») y el almacén podía pisar un `memory.json` ilegible que no se había podido conservar; el recurso por parecido de texto ya no borra valores distintos y una negación retira el hecho contradictorio. / **Memory:** the v1→v2 migration merged distinct facts; an unreadable `memory.json` that could not be quarantined could be overwritten; similarity no longer deletes distinct values and a negation retires the contradicting fact.
- **Modos:** PLAN ya no promete ejecutar lo que el código prohíbe; el modo elegido al encolar una tarea (Act/Plan/Think) se aplica de verdad; agotar el cupo de llamadas cierra el turno con un solo aviso en vez de girar hasta el tope de pasos. / **Modes:** PLAN no longer promises to run what the code forbids; a task's chosen mode is applied; exhausting the tool-call quota closes the turn with a single warning.
- **Equipo:** el compañero recibe su especialista de verdad (sus eventos van etiquetados y su presupuesto de pasos se respeta), un compañero cortado ya no se reporta como terminado y un mensaje del buzón que llega al final no se pierde. / **Team:** teammates get their specialist (events labelled, step budget respected), a cut teammate is no longer reported as finished, and a mailbox message arriving at the end is not lost.
- **Contexto:** el recorte de un turno largo soltaba bloques hasta dejar SOLO el prompt del sistema. / **Context:** trimming a long turn could leave ONLY the system prompt.
- **Navegador:** con la tubería de depuración, un Chrome huérfano dejaba el navegador inservible hasta cerrar la ventana a mano; ahora se localiza por su perfil y se cierra antes de lanzar. El contenido de la web y de la página entra al prompt delimitado como datos de terceros, igual que las skills. / **Browser:** with the debugging pipe an orphaned Chrome left the browser unusable; it is now found by profile and closed before launching. Web and page content enters the prompt delimited as third-party data, like skills.
- **MCP:** una URL con credenciales no podía conectar nunca (y el token se filtraba en el error), `fetch` seguía redirecciones con las cabeceras secretas, no había tope de tamaño de mensaje y reemplazar un servidor conservaba los secretos del anterior; además los servidores habilitados se conectan al arrancar (antes el catálogo MCP nacía vacío en cada arranque). / **MCP:** a URL with credentials could never connect (and the token leaked in the error), fetch followed redirects carrying secret headers, there was no message size cap, replacing a server kept the previous secrets; enabled servers now connect at startup.
- **Permisos:** la barrera de comandos prohibidos se evadía escribiendo el ejecutable con su extensión o la unidad entre comillas; «aceptar todos los cambios» se fiaba de prefijos de texto, así que un enlace dentro del proyecto escribía fuera sin tarjeta. / **Permissions:** the forbidden-command barrier was evaded with an extension or quotes; "accept all changes" trusted textual path prefixes, so a link inside the project wrote outside without a card.
- **Interfaz:** los eventos del equipo de otra pestaña se pintaban en el hilo a la vista; el texto final se duplicaba al volver a una conversación que seguía trabajando; las órdenes `/` no se despachaban (y la paleta anunciaba tres que no existían); el tope de gasto se guardaba redondeado a 0. / **Interface:** another tab's team events were painted in the visible thread; the final text was duplicated when returning to a running conversation; `/` commands were not dispatched (and the palette advertised three that did not exist); the spend cap was saved rounded to 0.
- **Instalador:** la huella SHA-512 del `.exe` se comprobaba una sola vez, antes de cerrar la app; ahora se comprueba justo antes de ejecutarlo y no se lanza si la app sigue viva. Y se calcula con .NET en vez de con el cmdlet `Get-FileHash`: una app lanzada desde PowerShell 7 lo habría heredado roto y la actualización habría dicho «la huella no coincide» sobre un instalador correcto. / **Installer:** the `.exe` SHA-512 was checked only once; now it is checked right before running it and nothing launches while the app is alive. It is computed with .NET instead of the `Get-FileHash` cmdlet, which a PowerShell 7 parent can leave unusable.
- **Datos y ficheros:** un `apply_patch` sobre un archivo ANSI/CP1252 lo reescribía con «�» en todos los acentos (y la pre-imagen del Deshacer salía igual de rota); el borrado de una tarea podía decir «eliminada» sin haberla borrado; el rastro guardaba secretos sin redactar; los adjuntos se guardaban enteros en el historial. / **Data and files:** `apply_patch` on an ANSI/CP1252 file rewrote it with replacement characters (and the undo pre-image was just as broken); deleting a task could say "deleted" without deleting; the turn trace stored secrets unredacted; attachments were stored in full in the history.
- **Arranque y ajustes:** toda clave guardada se marcaba como ilegible y el usuario veía «vuelve a escribirla» en cada arranque aunque la clave funcionara; un servidor MCP inválido se borraba del disco en el siguiente guardado; los canales de espacio de trabajo/modo podían decir «hecho» con el guardado fallido; «Detectar modelos» podía salir en 401 con la clave guardada. / **Startup and settings:** every stored key was flagged unreadable and the user saw "write it again" on every boot; an invalid MCP server was erased from disk on the next save; workspace/mode channels could answer "done" on a failed save; "Detect models" could return 401 with the key stored.
- **Verificación automática:** la suite de la interfaz (840 pruebas) no la corría ningún automatismo aunque las notas y el README publicaban que estaba verde, y el lint tampoco; `npm run navcheck` daba verde al saltarse sin probar nada. / **Automated verification:** the UI suite (840 tests) was run by no automation although the notes and README published it as green, and neither was the linter; `npm run navcheck` passed green while skipping.
- **Recuentos:** 510 pruebas en `npm test` y 840 en `npm run test:renderer` (51 archivos). / **Counts:** 510 tests in `npm test` and 840 in `npm run test:renderer` (51 files).

# SAGITARI 5.0.1

**De un vistazo:** cierra los 12 hallazgos de la auditoría del 17 de octubre (3 Altos, 4 Medios, 5 Bajos) · el navegador pasa a la tubería de depuración · el gasto de los subagentes cuenta para el tope y lo detiene · 456 pruebas y 743 de interfaz, en verde. / **At a glance:** closes the 12 findings of the 17 October audit (3 High, 4 Medium, 5 Low) · the browser moves to the debugging pipe · subagent spend counts against the cap and stops the turn · 456 tests and 743 interface tests, all green.

**La respuesta de una conversación ya no se cuela en la pestaña de otra.** Este parche cierra las 12 correcciones de la auditoría del 17 de octubre, con una prueba por arreglo. Lo más visible: cada evento del turno viaja con su conversación. Por dentro: `run_command` declara el fallo real (exit ≠ 0) y el bucle lo honra; una vuelta de subagente cortada (tope de pasos o Detener) ya no puede salir `OK` ni verificar el turno; el navegador automatizado usa la tubería de depuración de Chrome (sin puerto TCP) y un Chrome huérfano se cierra; el gasto de los subagentes cuenta para el tope de presupuesto y, al rebasarlo, detiene el turno; y `web_fetch` conecta a la IP ya validada (sin ventana TOCTOU). Además, se valida el remitente de cada canal IPC y se deniegan por defecto los permisos del sistema (cámara, micrófono, geolocalización). / **One conversation's reply no longer leaks into another tab.** This patch closes the 12 fixes of the 17 October audit, one test per fix. The most visible: every turn event now carries its conversation. Under the hood: `run_command` declares the real failure (exit ≠ 0) and the loop honours it; a cut subagent round (step cap or Stop) can no longer come out `OK` nor verify the turn; the automated browser uses Chrome's debugging pipe (no TCP port) and an orphan Chrome is closed; subagent spend counts against the budget cap and, when exceeded, stops the turn; and `web_fetch` connects to the already-validated IP (no TOCTOU window). Also, every IPC channel validates its sender and system permissions (camera, microphone, geolocation) are denied by default.

### Correcciones / Fixes

- **Chat:** la respuesta de una conversación ya no se pinta en la pestaña de otra. / **Chat:** one conversation's reply is no longer painted in another tab.
- **Agente:** `run_command` dice si el comando falló (exit ≠ 0) y un comando en rojo no cuenta como comprobación. / **Agent:** `run_command` says whether the command failed (exit ≠ 0) and a red command does not count as a check.
- **Subagentes:** una vuelta cortada (tope de pasos o Detener) sale `PARTIAL`, no `OK`, y no verifica el turno. / **Subagents:** a cut round (step cap or Stop) comes out `PARTIAL`, not `OK`, and does not verify the turn.
- **Navegador:** transporte por la tubería de depuración de Chrome; un Chrome huérfano se cierra y un lanzamiento que no responde se mata. / **Browser:** transport over Chrome's debugging pipe; an orphan Chrome is closed and a launch that does not answer is killed.
- **Presupuesto:** el gasto delegado cuenta para el tope global y, al rebasarlo, detiene el turno; el cupo de delegaciones cuenta igual en `delegate` y `team_spawn`. / **Budget:** delegated spend counts against the global cap and, when exceeded, stops the turn; the delegation quota counts the same in `delegate` and `team_spawn`.
- **Árboles:** un agente del usuario con `run_command` se aísla en su árbol git; el `git` de los árboles se mata con `killTree`. / **Worktrees:** a user agent with `run_command` is isolated in its git worktree; worktree `git` processes are killed with `killTree`.
- **Red:** `web_fetch` fija la IP ya validada (cierra la ventana TOCTOU); el borrado de tareas devuelve error si falla. / **Network:** `web_fetch` pins the already-validated IP (closes the TOCTOU window); task deletion returns an error on failure.
- **Electron:** se valida el remitente de cada canal IPC y se deniegan por defecto los permisos del sistema; las cadenas IPC del renderer llevan su `.catch`. / **Electron:** every IPC channel validates its sender and system permissions are denied by default; the renderer's IPC chains carry their `.catch`.
- **Registro:** la carpeta de logs respeta su tope aunque Windows tarde en soltar el fichero anterior; la poda reintenta hasta 10 s y las pruebas dejan de depender del reloj. / **Logs:** the logs folder keeps to its cap even when Windows is slow to release the previous file; the prune retries for up to 10 s and the tests no longer depend on the clock.

Recuento de pruebas: 456 en `npm test` y 743 en `npm run test:renderer` (50 archivos). / Test count: 456 in `npm test` and 743 in `npm run test:renderer` (50 files).

# SAGITARI 5.0.0

**De un vistazo:** memoria con aprobación y papelera recuperable · **modo Equipo**: tu encargo repartido entre compañeros que trabajan a la vez · 39 correcciones de la auditoría · se retira el modo voz · 450 pruebas y 737 de interfaz, en verde. / **At a glance:** memory with approval and a recoverable trash · **Team mode**: your order split between teammates working at once · 39 audit fixes · voice mode retired · 450 tests and 737 interface tests, all green.

**La memoria deja de ser una lista y pasa a ser una ficha de hechos que apruebas tú.** La vista **Memoria** (`Alt+5`) enseña lo que el agente sabe de ti como fichas con procedencia («de tu frase del 12 de octubre»), importancia en tres niveles y veces usada; lo que aprende de un turno no se guarda solo: cae en **«Recién aprendido»** y espera tu Guardar, Editar o Descartar. Olvidar ya no borra —hay **papelera recuperable** con deshacer—, los hábitos se olvidan de uno en uno, y el pie de la vista lleva **Exportar mi memoria** y un olvídalo-todo de verdad. La misma versión cierra la auditoría completa de la app (39 defectos reales corregidos) y **retira el modo voz** con su micrófono, sus motores, sus ajustes y sus atajos. / **Memory stops being a list and becomes a card file of facts you approve.** The **Memory** view (`Alt+5`) shows what the agent knows about you as cards with provenance ("from your message on 12 October"), three importance levels and a use count; what it learns from a turn is not saved on its own: it lands in the approval tray and waits for your Save, Edit or Discard. Forgetting no longer deletes — there is a **recoverable trash** with undo — habits are forgotten one category at a time, and the view's footer carries **Export my memory** and a real forget-it-all. The same release closes the full audit of the app (39 real defects fixed) and **retires voice mode** with its microphone, its engines, its settings and its shortcuts.

### Cambios completos desde la 4.1.0 (la última publicada)

**Equipo:**

- **Tu encargo, repartido entre compañeros que trabajan a la vez.** Cuarto modo del compositor, junto a ACT / PLAN / THINK (`Alt+M` cicla las cuatro): el agente pasa a **líder**, trocea la orden, levanta hasta **4 compañeros** —los especialistas de serie o los que tú definas en disco— y los pone a trabajar **en paralelo**, cada uno con su modelo, sus herramientas y su propio permiso. / **Your order, split between teammates working at the same time.** The composer's fourth mode, next to ACT / PLAN / THINK (`Alt+M` cycles the four): the agent becomes a **leader**, cuts the order up, lifts up to **4 teammates** — the built-in specialists or the ones you define on disk — and puts them to work **in parallel**, each with its own model, tools and permission.
- **Se hablan y dejan constancia.** Se escriben por un **buzón** (a quien está trabajando le llega en su siguiente paso) y apuntan lo que hacen en un **tablero compartido**; la vista **Equipo** enseña a cada compañero con su estado, el buzón y el tablero. Cada permiso dice de qué compañero es, y si el líder ya cerró su parte, un compañero que esperaba tu respuesta la puede contestar igual. / **They talk to each other and leave a record.** They write through a **mailbox** (someone who is working gets it on its next step) and note what they do on a **shared board**; the **Team** view shows each teammate with its state, the mailbox and the board. Every permission says which teammate it belongs to, and if the leader has already closed its part, a teammate waiting for your answer can still be answered.
- **Aislamiento y presupuesto.** El compañero que escribe trabaja en un **árbol de trabajo aislado** por vuelta, con fusión verificada —y sin git el equipo lo dice, en vez de fingir aislamiento—, y el equipo tiene su propio tope de presupuesto. / **Isolation and budget.** A teammate that writes works in an **isolated worktree** per round with a verified merge — and without git the team says so instead of pretending isolation — and the team has its own budget cap.

**También nuevo desde la 4.1.0 (la última que se publicó):**

- **Varias conversaciones a la vez:** un turno en marcha ya no bloquea la app; cada conversación tiene su propio agente y sus herramientas, corriendo de verdad en paralelo, y la que sigue trabajando se marca en su pestaña. / **Several conversations at once:** a running turn no longer blocks the app; each conversation has its own agent and tools, really running in parallel, and the one still working is marked on its tab.
- **El cambio del turno, archivo por archivo:** el panel de revisión enseña exactamente lo que el agente tocó, con una tarjeta por archivo y sus añadidos y borrados, en vez de un «todo o nada». / **The turn's change, file by file:** the review panel shows exactly what the agent touched, with a card per file and its additions and deletions, instead of an all-or-nothing.
- **Catorce proveedores nuevos** —Gemini, DeepSeek, xAI, Mistral, Kimi, Cerebras, NVIDIA NIM y SambaNova, más seis runtimes locales— y la **luz como filo** de las superficies que están trabajando, con su protocolo forzable por proveedor. / **Fourteen new providers** — Gemini, DeepSeek, xAI, Mistral, Kimi, Cerebras, NVIDIA NIM and SambaNova, plus six local runtimes — and the **light as the edge** of the surfaces doing the work, with a provider-forced protocol.

**Memoria:**

- **Memoria de largo plazo, con ficha y aprobación.** La memoria deja de ser una lista plana y pasa a ser una ficha de hechos duraderos con procedencia («de tu frase del 12 de octubre»), importancia en tres niveles y recuento de uso. Lo que el agente aprende de un turno no se guarda: cae en **«Recién aprendido»** y espera tu Guardar / Editar / Descartar. Con el interruptor de aprendizaje apagado no se propone nada, y la extracción es heurística, gratis y corre al cerrar el turno —no en cada paso— con guardas contra los falsos positivos: preguntas, condicionales, negaciones, citas de terceros y código no proponen nada. / **Long-term memory, as a card file with approval.** Memory stops being a flat list and becomes a card file of durable facts with provenance ("from your message on 12 October"), three importance levels and a use count. What the agent learns from a turn is not saved: it lands in an approval tray and waits for your Save / Edit / Discard. With the learning switch off, nothing is proposed at all, and extraction is heuristic, free and runs when the turn closes — not on every step — with guards against false positives: questions, conditionals, negations, third-party quotes and code propose nothing.
- **Nada se borra en silencio.** Olvidar un hecho lo manda a una **papelera recuperable** (30 días, con deshacer en el momento); un hecho sin usarse baja de importancia a los 180 días y llega a la papelera al año; los duplicados **se fusionan** en uno —tus dos «me llamo Darío» quedan en un solo hecho con los usos sumados— y una corrección («en realidad…», «mejor dicho…») sustituye al dato viejo en vez de convivir con él. Y la fusión compara **por valor, no por parecido de texto**: «prefiero el té» y «prefiero el café» son dos datos ciertos y ya no se pisan; una clave de predicado + valor separa «el mismo dato dicho de otra forma» («me llamo Darío» / «me llamo Dario») de «otro dato» y de una contradicción. / **Nothing is deleted in silence.** Forgetting a fact sends it to a recoverable trash (30 days, with an immediate undo); a fact that goes unused fades to low importance after 180 days and reaches the trash after a year; duplicates **merge** into one — your two "me llamo Darío" entries become a single fact with the use counts added — and a correction ("actually…") replaces the old fact instead of living beside it. And the merge compares **by value, not by textual similarity**: "I prefer tea" and "I prefer coffee" are two true facts and no longer overwrite each other; a predicate + value key separates "the same fact said differently" ("me llamo Darío" / "me llamo Dario") from "another fact", and from a contradiction.
- **Los hábitos, legibles y olvidables de uno en uno:** herramientas, aplicaciones, comandos, carpetas, webs, modos y permisos, cada categoría con su cuenta y su «olvidar», más un olvidar-todo. Antes había un solo botón para el perfil entero, así que no se podía olvidar una categoría sin perderlas todas. / **Habits you can read and forget one category at a time:** tools, apps, commands, folders, sites, modes and permissions, each with its count and its own "forget", plus a forget-everything. There used to be a single button for the whole profile, so a category could not be forgotten without losing them all.
- **La vista Memoria, de una pieza:** fichas editables en el sitio con sus etiquetas y su buscador, la bandeja de aprobación, los hábitos, la papelera y un pie con el interruptor de aprendizaje, **Exportar mi memoria** y **Olvídalo todo** (con confirmación escrita). Todo vive en un fichero de tu carpeta de datos. La búsqueda de conversaciones espera a la fase 3 (índice de episodios) y lo dice, en vez de fingirlo. / **The Memory view, in one piece:** cards edited in place with their tags and its own filter box, the approval tray, habits, the trash, and a footer carrying the learning switch, **Export my memory** and **Forget it all** (with typed confirmation). Everything lives in a file inside your data folder. The conversation search waits for phase 3 (episode index) and says so instead of pretending.
- **Migración con copia.** Esquema v2 de `memory.json`, con migración automática al cargar y copia `memory.bak-v1`: el fichero viejo nunca se pierde y la migración fusiona los duplicados que ya había (probado con el perfil real: dos entradas → un hecho con los usos sumados). El esquema, la similitud, la fusión y la heurística viven en un módulo puro (`agent/memoria-v2.js`) y el almacén (`agent/memory.js`) sigue siendo el único que toca disco. / **Migration with a copy.** A v2 schema for `memory.json`, with automatic migration on load and a `memory.bak-v1` copy: the old file is never lost and the migration merges the duplicates that were already there (proven against the real profile: two entries → one fact with the use counts added). The schema, similarity, merging and heuristic live in a pure module (`agent/memoria-v2.js`) and the store (`agent/memory.js`) is still the only thing that touches disk.

**Auditoría y correcciones:**

- **El cierre automático ya no ejecuta un manifiesto que ha escrito el modelo.** La comprobación de cierre sale del manifiesto del proyecto (`package.json` y compañía) y ese manifiesto lo puede reescribir el propio agente: comparar el **texto** del comando no bastaba —dejar `npm test` llamando a otro cuerpo, o colar un `pretest`/`posttest`, ejecutaba igual el script recién escrito—, así que ahora, además del comando, se mira si el manifiesto del que sale el plan se ha tocado **en este turno**, con la misma lista de archivos que usa el comprobador por archivo; si lo fue, la puerta se cierra y no se ejecuta nada. / **The automatic close no longer runs a manifest the model has written.** The close check comes from the project's manifest (`package.json` and friends) and that manifest can be rewritten by the agent itself: comparing the command's **text** was not enough — leaving `npm test` pointing at another body, or slipping in a `pretest`/`posttest`, ran the freshly written script all the same — so the gate now also looks at whether the manifest the plan comes from was touched **this turn**, with the same file list the per-file checker uses; if it was, the gate stays shut and nothing runs.
- **«Aceptar todos los cambios» solo abarata escribir DENTRO de tu proyecto.** El ajuste promete los archivos del proyecto, y eso es lo único que salta la tarjeta: una ruta de fuera del espacio de trabajo —o una que no se puede resolver— conserva su confirmación, que es donde ves el destino. / **"Accept all changes" only makes writing INSIDE your project cheaper.** The setting promises your project's files, and that is the only thing that skips the card: a path outside the workspace — or one that cannot be resolved — keeps its confirmation, which is where you see the destination.
- **El borrado de tareas valida el identificador antes de tocar el disco.** El `runId` que llega de la interfaz acababa dentro de una ruta (`tasks/<id>/run.json`) sobre la que se borra en recursivo: `..`, separadores, rutas absolutas y nombres vacíos se rechazan ahora en el router, con la misma guarda que usa el almacén. / **Deleting a task validates the identifier before touching disk.** The `runId` coming from the interface ended up inside a path (`tasks/<id>/run.json`) that is recursively deleted: `..`, separators, absolute paths and empty names are now rejected at the router, with the same guard the store uses.
- **Un historial ilegible se conserva y te lo dice.** Si `conversations.json` no se puede leer, se aparta en cuarentena (`conversations.corrupt-<fecha>.json`), se intenta la copia `.bak` y se avisa diciendo qué fichero se ha conservado, en vez de empezar de cero en silencio y de pisar la copia buena al primer guardado. Un JSON válido con otra forma (`{}`, un número) es tan ilegible como uno roto. / **An unreadable history is kept and it tells you.** If `conversations.json` cannot be read, it is quarantined (`conversations.corrupt-<date>.json`), the `.bak` copy is tried, and a notice names the file that was kept, instead of starting from scratch in silence and overwriting the good copy on the first save. A valid JSON with another shape (`{}`, a number) is as unreadable as a broken one.
- **El asistente de primer uso ya no deja fuera a quien empieza.** Elige el proveedor sobre el catálogo real —antes era una lista copiada a mano con 7 de los 22 presets, así que quien usara Gemini, DeepSeek, Mistral o un endpoint propio no lo encontraba— y conserva lo que escribes (Base URL, clave y protocolo) al ir y volver entre pasos, en vez de perderlo al cambiar de pantalla. / **The first-run wizard no longer leaves a beginner out.** It picks the provider from the real catalogue — it used to be a hand-copied list with 7 of the 22 presets, so anyone on Gemini, DeepSeek, Mistral or their own endpoint could not find theirs — and it keeps what you typed (base URL, key and protocol) when you move back and forth between steps instead of losing it on the way.
- **La memoria no se vacía ni se pisa cuando su fichero no se puede leer.** Un `memory.json` ilegible se aparta en cuarentena con marca de tiempo, la vista lo avisa y ningún guardado posterior reescribe el almacén con lo poco de esa sesión; **Restaurar copia** busca la copia más fresca, guarda lo roto aparte y recarga sin reiniciar la app. El histórico de salud de los modelos recibe el mismo trato. / **Memory is neither emptied nor overwritten when its file cannot be read.** An unreadable `memory.json` is quarantined with a timestamp, the view says so, and no later save rewrites the store with whatever little that session had; **Restore backup** looks for the freshest copy, keeps the broken file aside and reloads without restarting the app. Model health history gets the same treatment.
- **El gasto del equipo se cuenta una vez por vuelta.** El uso acumulado de un compañero se sumaba entero en cada vuelta, así que el gasto —y el tope de presupuesto— contaba de más: 300 tokens en vez de 200 con dos vueltas de 100. / **Team spend is counted once per round.** A teammate's accumulated usage was added in full on every round, so the spend — and the budget cap — counted too much: 300 tokens instead of 200 for two rounds of 100.
- **Detener ya no cuenta como fallo del modelo.** Si paras a mano, el intento no se registra en la salud del modelo: antes sumaba un error —la píldora quedaba en «con errores» por una acción tuya— y apuntaba un relevo (`model_fallback`) que no existió. / **Stop no longer counts as a model failure.** If you stop by hand, the attempt is not recorded in model health: it used to add an error — leaving the pill on "with errors" because of your own action — and logged a fallback (`model_fallback`) that never happened.
- **Las promesas de privacidad de la vista ahora dicen la verdad.** La vista de la memoria ya no insinúa que nada sale del equipo: dice que los recuerdos y los hábitos que encajan con la conversación **se envían al modelo que tengas configurado**, igual que el resto del mensaje, y que nada entra sin tu aprobación (salvo que enciendas «guardar sin preguntar»). / **The view's privacy promises now tell the truth.** The memory view no longer hints that nothing leaves the machine: it says that the memories and habits that match the conversation **are sent to the model you have configured**, like the rest of the message, and that nothing enters without your approval (unless you turn on "save without asking").
- **Se retira el modo voz.** Fuera el dictado y la respuesta hablada, con su micrófono, sus motores (Windows, Piper, Whisper), sus ajustes y sus atajos: esta versión no promete lo que ya no hace. / **Voice mode is retired.** Dictation and spoken answers are gone, with their microphone, their engines (Windows, Piper, Whisper), their settings and their shortcuts: this release does not promise what it no longer does.

Recuento de pruebas: 450 en `npm test` y 737 en `npm run test:renderer` (49 archivos). / Test count: 450 in `npm test` and 737 in `npm run test:renderer` (49 files).

# SAGITARI 4.4.0

**Modo EQUIPO: tu encargo, repartido entre varios compañeros que trabajan a la vez.** Cuarta opción del compositor, junto a ACT / PLAN / THINK (`Alt+M` cicla las cuatro). En EQUIPO el agente pasa a ser **líder**: trocea la orden, levanta hasta **4 compañeros** —los especialistas del registro, de serie o los que tú definas en disco— y los pone a trabajar **en paralelo**, cada uno con su modelo, sus herramientas y su propio permiso. Se **hablan entre ellos** por un buzón asíncrono (a un compañero que está trabajando el mensaje le llega en su siguiente paso; a uno que ya terminó, se le despierta con él) y todos apuntan lo que hacen en un **tablero compartido**. La vista **Equipo** enseña a cada compañero con su estado, el buzón (quién escribe a quién) y el tablero; el chat lleva una tarjeta de equipo con el reparto del líder y el resultado agregado; y el rail avisa, por compañero, de quién está esperando un permiso. Con tope de 4 a la vez y un **presupuesto** editable que, al agotarse, para al equipo y lo dice en vez de seguir gastando. / **TEAM mode: your order, split across several teammates working at once.** A fourth option in the composer beside ACT / PLAN / THINK (`Alt+M` cycles all four). In TEAM the agent becomes the **leader**: it breaks the order down, lifts up to **4 teammates** — the registry's specialists, built-in or ones you define on disk — and puts them to work **in parallel**, each with its own model, its own tools and its own permission prompt. They **talk to each other** through an async mailbox (a teammate that is working gets the message on its next step; one that already finished is woken up with it) and everyone writes to a **shared board**. The **Equipo** view shows each teammate with its state, the mailbox (who writes to whom) and the board; the chat carries a team card with the leader's assignment and the aggregated result; and the rail flags, per teammate, who is waiting for a permission. Capped at 4 at a time plus an editable **budget** that stops the team and says so instead of burning through it.

### Cambios completos desde la 4.3.0

**EQUIPO:**

- Cuarto modo (`equipo`) en el segmento del compositor, en el del estado vacío y en la píldora del pie, con su color ámbar propio y su icono propio (Agentes y Equipo ya no comparten dibujo). / Fourth mode (`equipo`) in the composer segment, the empty state and the footer pill, with its own amber colour and its own icon (Agents and Team no longer share a drawing).
- Motor nuevo (`agent/equipo.js`): compañeros vivos con su propio agent, buzón, tablero, tope de 4 y presupuesto. No conoce el modelo ni el bucle: recibe la fábrica de agentes por inyección, así que se prueba con una fábrica falsa (42 pruebas puras). / New engine (`agent/equipo.js`): live teammates with their own agent, mailbox, board, a cap of 4 and a budget. It knows nothing about the model or the loop: the agent factory is injected, so it is tested with a fake factory (42 pure tests).
- El permiso de un compañero **se puede contestar aunque el líder ya haya cerrado su parte**: su vuelta sigue viva y la respuesta que espera es del usuario, no del líder. Antes el cierre del turno paraba al compañero que estaba esperando —su insignia se quedaba en «1 permiso» para siempre y la barra desaparecía—: el usuario podía autorizar y no pasaba nada. Se sigue parando cuando el turno muere de verdad (Detener, un guardarraíl, una excepción): ahí ya no hay nada que autorizar. / A teammate's permission **can be answered even after the leader has closed its part**: its round is still alive and the answer it waits for is the user's, not the leader's. The turn's close used to stop the waiting teammate — its badge stayed at "1 permiso" forever and the bar disappeared — so the user could authorize and nothing happened. It is still stopped when the turn really dies (Stop, a guardrail, an exception): there is nothing left to authorize then.
- El cierre del equipo lleva el **estado real de cada compañero**, y la interfaz lo pinta tal cual: a quien sigue esperando al usuario no se le llama «interrumpido» ni se le borra la insignia del permiso que queda por contestar. / The team's close carries **each teammate's real state** and the interface paints it as it is: whoever is still waiting for the user is not labelled "interrupted" nor stripped of the badge for the permission that is yet to be answered.
- La **tarjeta del equipo sigue viva después del turno**: un compañero puede contestar un permiso y terminar su parte con el líder ya fuera, y la tarjeta lo cuenta (antes se quedaba congelada en «esperando» y con la insignia puesta). / The **team card stays live after the turn**: a teammate can answer a permission and finish its part with the leader already gone, and the card says so (it used to freeze at "esperando" with the badge still on).
- El fin del turno ya no descarta la confirmación de un compañero —igual que una tarea en segundo plano—: descartarla dejaba al compañero esperando una respuesta que ya nadie podía dar. / The turn's end no longer discards a teammate's confirmation — same as a background task: discarding it left the teammate waiting for an answer nobody could give.
- Cinco herramientas nuevas: `team_spawn`, `team_send`, `team_wait`, `team_board`, `team_done` (35 nativas en total). El líder las tiene todas; un compañero solo puede hablar, apuntar y cerrar su encargo — no levanta más gente. / Five new tools: `team_spawn`, `team_send`, `team_wait`, `team_board`, `team_done` (35 natively in total). The leader has all of them; a teammate can only talk, write to the board and close its assignment — it cannot lift more people.
- El buzón se entrega de verdad: se inyecta en el prompt del compañero en cada paso (en el bloque volátil, sin romper la caché del prefijo) y se vacía al leerlo. / The mailbox really delivers: it is injected into the teammate's prompt on every step (in the volatile block, without breaking prefix caching) and emptied on read.
- Árbol de trabajo aislado **por vuelta** de cada compañero que escribe, con fusión verificada; sin git el equipo lo dice en vez de fingir aislamiento. / An isolated worktree **per round** for each teammate that writes, with verified merge; without git the team says so instead of pretending isolation.
- Permisos atribuidos: cada confirmación dice de qué compañero es, su estado pasa a «esperando» mientras está pendiente y el rail lleva la cuenta de pendientes por miembro. / Attributed permissions: every confirmation says which teammate it belongs to, its state becomes "waiting" while it is pending, and the rail keeps the per-member pending count.
- Topes de conversación entre compañeros (12 por miembro, 40 por equipo) con error accionable, y corte por presupuesto que para a todos y no toca el tablero. / Caps on teammate chatter (12 per member, 40 per team) with an actionable error, and a budget cut that stops everyone and leaves the board alone.
- Ajuste nuevo `equipoPresupuestoUsd` (0–50, por defecto 0 = sin tope propio) en Ajustes ▸ Agente, con la copia diciendo qué pasa al agotarse. / New setting `equipoPresupuestoUsd` (0–50, default 0 = no cap of its own) in Settings ▸ Agent, with copy saying what happens when it runs out.
- Once secciones en el sidebar (Equipo entra en TRABAJO, sin atajo propio: los Alt+N llegan a nueve). / Eleven sections in the sidebar (Team joins TRABAJO, with no hotkey of its own: the Alt+N run to nine).

**Por dentro:**

- El arnés de interfaz enruta el proveedor de mentira **por petición**, así que un encargo de equipo con dos compañeros en paralelo es determinista: el líder y cada compañero tienen su propio guion. Con la cola lineal, las respuestas se repartían por orden de llegada. / The interface harness routes the fake provider **per request**, so a team order with two teammates in parallel is deterministic: the leader and each teammate have their own script. With the linear queue, answers were handed out in arrival order.
- El runner de las pruebas del renderer **espera la promesa** de un archivo asíncrono (antes exigía archivos síncronos: uno con `await` no llegaba a informar de su recuento). / The renderer test runner **awaits** the promise of an async file (it used to require synchronous files: one with `await` never reported its count).
- El espacio de trabajo temporal del arnés se barre al arrancar y está ignorado por git, lint y formateo: una ejecución cortada dejaba una carpeta dentro del repositorio. / The harness's temporary workspace is swept on start and ignored by git, lint and formatting: an interrupted run used to leave a folder inside the repository.
- Los **árboles de trabajo aislados** ya no dejan registros fantasma dentro del repositorio del usuario: si el desmontaje no podía correr (el espacio de trabajo había desaparecido, git no estaba en el PATH, la carpeta estaba bloqueada), el registro del árbol se quedaba en `.git/worktrees/` para siempre y `git worktree list` acumulaba entradas `prunable`. Ahora se reintenta contra el **directorio de git** —que sigue en pie aunque el espacio de trabajo se haya ido— y, ya sin carpeta que conservar, se poda. / **Isolated worktrees** no longer leave phantom records inside the user's repository: if the teardown could not run (the workspace had vanished, git was not on the PATH, the folder was locked), the tree's record stayed in `.git/worktrees/` forever and `git worktree list` piled up `prunable` entries. It is now retried against the **git dir** — which survives even when the workspace is gone — and, with no folder left to keep, pruned.
- Las herramientas de equipo no piden plaza en el semáforo (no tocan navegador, disco, terminal ni escritorio): antes un `team_wait` del líder competía por una de las cuatro plazas de «general» con sus propios compañeros. / Team tools do not claim a semaphore slot (they touch no browser, disk, terminal or desktop): a leader's `team_wait` used to compete for one of the four "general" slots with its own teammates.
- El arnés de interfaz **contesta el permiso de un compañero en vivo**: comprueba que la barra dice de quién es, que su fila lleva la insignia y el estado «esperando», que al concederlo el archivo se escribe de verdad en el disco y que la tarjeta lo cierra. Es la comprobación que destapó que el permiso de un compañero no se podía contestar. / The interface harness **answers a teammate's permission live**: it checks that the bar says who it belongs to, that its row carries the badge and the "esperando" state, that granting it really writes the file to disk and that the card closes it. It is the check that uncovered that a teammate's permission could not be answered.
- Recuento de pruebas: 400 en `npm test` y 678 en `npm run test:renderer` (43 archivos). / Test count: 400 in `npm test` and 678 in `npm run test:renderer` (43 files).

# SAGITARI 4.3.0

**Varias conversaciones a la vez.** Un turno en marcha ya no bloquea la app: la cabecera del chat tiene una tira de pestañas y puedes abrir tantas conversaciones como quieras, cada una con su propio turno, sus herramientas y su propia conversación con el modelo, corriendo de verdad en paralelo. La que sigue trabajando se marca en su pestaña y en el Historial, y al volver la encuentras tal y como la dejaste. Cerrar una pestaña no borra la conversación. Por dentro es una migración de fondo: cada conversación tiene su propio agente y su propio rastro del turno, y hasta la revisión del cambio distingue de qué conversación es cada archivo (en la 4.2, dos conversaciones en la misma carpeta se borraban los cambios la una a la otra). / **Several conversations at once.** A running turn no longer locks the app: the chat header now carries a tab strip and you can open as many conversations as you want, each with its own turn, its own tools and its own exchange with the model, genuinely running in parallel. The one that is still working is marked in its tab and in History, and coming back finds it exactly as you left it. Closing a tab does not delete the conversation. Underneath this is a real migration: each conversation owns its agent and its own turn trace, and even the change review knows which conversation each file belongs to (in 4.2, two conversations in the same folder erased each other's changes).

**La luz pasa a ser el filo de la interfaz.** El glow deja de ser una banda alrededor de la ventana: ahora es el filo de 1px de las superficies que están haciendo el trabajo —el panel lateral cuando piensa, el compositor cuando trabaja, la tarjeta concreta mientras corre su herramienta— y la ventana conserva una hairline que solo se enciende mientras hay trabajo. Al cambiar de estado un reflejo recorre ese filo una vez y se posa: nada gira y nada late de forma permanente. Sale más barato que lo que había (el degradado se rasteriza una vez y el nivel va en opacidad, así que el compositor solo mezcla) y el color y la intensidad siguen siendo tuyos. / **The light becomes the edge of the interface.** The glow stops being a band around the window: it is now the 1px edge of the surfaces doing the work — the sidebar when it thinks, the composer when it works, the specific card while its tool runs — and the window keeps a hairline that lights only while there is work. A state change sends one highlight along that edge and it settles: nothing spins and nothing pulses on its own. It is cheaper than what it replaces (the gradient is rasterised once and the level rides on opacity, so the compositor just blends) and the colour and intensity are still yours.

**Catorce proveedores nuevos, con el endpoint verificado contra su propia documentación.** Se suman Google Gemini (capa de compatibilidad OpenAI), DeepSeek, xAI (Grok), Mistral, Moonshot (Kimi), Cerebras, NVIDIA NIM y SambaNova, más seis runtimes locales (llama.cpp, vLLM, Jan, KoboldCpp, text-generation-webui y LocalAI, con sus puertos por defecto). Y tres fallos que impedían configurar proveedores: la detección de modelos sondaba `/models` con la cabecera equivocada en cualquier base compatible con Anthropic que no fuera `anthropic.com` (DeepSeek, Z.ai, Moonshot, Fireworks), así que el proveedor no se podía ni guardar; tres modelos vivos de OpenCode Go (`claude-haiku-5-5`, `grok-4.7`, `gpt-6-luna`) se enrutaban al endpoint equivocado; y el asistente de primer uso ofrecía cinco de los presets y guardaba siempre el protocolo en automático. / **Fourteen new providers, each endpoint verified against its vendor's documentation.** Google Gemini (OpenAI compatibility layer), DeepSeek, xAI (Grok), Mistral, Moonshot (Kimi), Cerebras, NVIDIA NIM and SambaNova, plus six local runtimes (llama.cpp, vLLM, Jan, KoboldCpp, text-generation-webui and LocalAI, with their default ports). And three defects that made providers unconfigurable: model detection probed `/models` with the wrong header on any Anthropic-compatible base other than `anthropic.com` (DeepSeek, Z.ai, Moonshot, Fireworks), so the provider could not even be saved; three live OpenCode Go models (`claude-haiku-5-5`, `grok-4.7`, `gpt-6-luna`) were routed to the wrong endpoint; and the first-run wizard offered five of the presets and always saved the protocol as automatic.

**Ajustes, reordenados y corregidos.** Seis paneles con lo básico delante y lo avanzado plegado en su tarjeta: Modelo, Apariencia, Seguridad, Agente, Datos y Acerca de. Y dos fallos reales que salieron de la auditoría: «Tu nombre» decía que el modelo lo usa para dirigirse a ti y no llegaba a recibirlo; y la lista de permisos por herramienta enseñaba 8 de las 30 claves reales, con el nombre interno a la vista. / **Settings, reordered and fixed.** Six panels with the basics first and the advanced controls folded into their own card: Model, Appearance, Security, Agent, Data and About. And two real defects the audit turned up: "Your name" claimed the model uses it to address you and never reached it; and the per-tool permission list showed 8 of the 30 real keys, with the internal name on display.

### Cambios completos desde la 4.2.0

**Conversaciones:**

- Un agente por conversación, con su historial, su resumen plegado, su lista de tareas y su rastro del turno. / One agent per conversation, with its own history, folded summary, todo list and turn trace.
- Tira de pestañas en la cabecera del chat, con indicador de trabajo en curso, cierre de pestaña sin borrar y tope de 8 abiertas (se descarta la menos usada que no esté trabajando). / Tab strip in the chat header with a busy indicator, close-without-delete and a cap of 8 open tabs (the least recently used idle one is dropped).
- Cambiar de conversación ya no está prohibido mientras el agente trabaja. / Switching conversation is no longer forbidden while the agent works.
- El aviso de permiso y la barra de «Deshacer» pertenecen a la conversación que los pide. / The permission prompt and the "Undo" bar belong to the conversation that asked for them.
- La revisión del cambio y las pre-imágenes del turno se guardan por conversación: dos conversaciones en la misma carpeta ya no se pisan. / Change review and turn pre-images are stored per conversation: two conversations in the same folder no longer overwrite each other.
- Al escribir el historial completo tampoco se puede perder una conversación que esté abierta en una pestaña. / The full-history write can no longer drop a conversation that is open in a tab.

**Proveedores:**

- 22 presets en total, cada uno con el endpoint de su fabricante y una pista que dice por qué elegirlo. / 22 presets in total, each with its vendor's endpoint and a hint saying why to pick it.
- El protocolo de la API se puede forzar y ahora se guarda al cambiarlo. / The API protocol can be forced and now persists when you change it.
- La detección de modelos ve el protocolo y el identificador del proveedor, no solo la URL. / Model detection sees the protocol and provider id, not just the URL.
- El asistente de primer uso usa la lista real de presets. / The first-run wizard uses the real preset list.

**Interfaz:**

- Glow «borde vivo»: el filo de las superficies funcionales, con un solo recorrido al cambiar de estado, sin banda ni halos girando. / "Borde vivo" glow: the edge of the functional surfaces, with a single highlight on state change, no band and no spinning halos.
- El recorrido vive DENTRO de su superficie: sin recorte, la barra arrancaba fuera del compositor y se veía un trazo de luz flotando al lado al cambiar de estado. / The highlight lives INSIDE its surface: unclipped, the bar started outside the composer and a light streak appeared floating beside it on every state change.
- Una respuesta ya no puede quedarse CORTADA en pantalla: el texto del turno se acumula en cada evento pero se pintaba por frames, así que si el último frame no llegaba (ventana sin foco: Chromium no repinta) el cierre dejaba el trozo pintado — y el mensaje guardado, entero. Ahora el cierre reescribe el tramo completo. / An answer can no longer stay CUT OFF on screen: the turn's text accumulates on every event but was painted per frame, so if the last frame never arrived (window without focus: Chromium does not repaint) the close kept the painted fragment — while the stored message was whole. The close now rewrites the whole segment.
- El nombre del modelo ya no se corta en el pie: cuando no caben los tres rótulos, cede el del MODO (su píldora ACT/PLAN/THINK ya está en el compositor) y el del modelo se queda entero. / The model name is no longer cut in the footer: when the three labels do not fit, the MODE one yields (its ACT/PLAN/THINK pill is already in the composer) and the model name stays whole.
- El mismo estado repetido ya no rehace nada: el proceso principal emite «trabajando» en CADA herramienta del turno, y sin esta guarda el recorrido volvía a empezar y el filo se hundía un momento en cada paso. / A repeated state no longer re-runs anything: the main process emits "working" on EVERY tool of a turn, and without this guard the highlight restarted and the edge dipped for a moment on every step.
- Al acabar el turno la luz vuelve a la calma (antes quedaba en «pensando» y el panel lateral se quedaba encendido como si el agente siguiera trabajando). / When the turn ends the light returns to calm (it used to stay on "thinking" and the sidebar stayed lit as if the agent were still working).
- Sin foco no hay luz (y el pulso de `Ctrl+Shift+G` sigue funcionando); con movimiento reducido el filo se queda y el recorrido desaparece. / No focus, no light (the `Ctrl+Shift+G` pulse still works); with reduced motion the edge stays and the travel is gone.
- Ajustes reordenados en siete paneles, con lo avanzado separado y cada control diciendo qué hace. / Settings reordered into seven panels, advanced controls separated, every control saying what it does.
- Un comentario metido dentro de un selector en el CSS del compositor, que hacía creer que la regla del foco era otra. / A comment living inside a CSS selector in the composer, which made the focus rule look like a different one.

**Por dentro:**

- 417 pruebas en `npm test` y 521 en `npm run test:renderer`, todas en verde. / 417 tests in `npm test` and 521 in `npm run test:renderer`, all green.
- El arnés de interfaz arranca con el historial limpio y mira la conversación en pantalla: dos comprobaciones del chat medían antes el hilo equivocado. / The interface harness starts from a clean history and looks at the conversation on screen: two chat checks used to measure the wrong thread.
- `main/runtimes.js`: el registro de agentes por conversación. / `main/runtimes.js`: the per-conversation agent registry.

# SAGITARI 4.2.0

**El cambio del turno ya no es «todo o nada».** El panel de revisión enseña exactamente lo que el agente tocó: una tarjeta por archivo con sus `+añadidos / −borrados`, los hunks con números de línea y un botón para devolver **ese archivo solo** sin arrastrar los demás. Los que no se pueden restaurar por separado lo dicen en vez de aparentarlo. Antes solo existía «Deshacer el cambio»: el turno entero, y a ciegas. / **The turn's change is no longer all-or-nothing.** The review panel shows exactly what the agent touched: one card per file with its `+adds / −dels`, the hunks with line numbers, and a button to put back **that one file** without dragging the rest along. Files that cannot be restored on their own say so instead of pretending. Before there was only "Undo the change": the whole turn, blind.

**Órdenes de barra, y un PLAN que no toca nada.** `/` abre ahora una paleta de órdenes por encima de tus skills: `/compact` hace que el modelo resuma el hilo para que una sesión larga siga, `/cost` dice tokens y gasto de la conversación, `/clear` y `/new` empiezan de cero, `/model` cambia de modelo y `/help` las lista. Y el modo PLAN pasa a ser **solo lectura de verdad**: el catálogo que se le ofrece al modelo se recorta a las herramientas de inspección y cualquier escritura se rechaza también al ejecutarla, no solo en el prompt. / **Slash commands, and a PLAN that touches nothing.** `/` now opens a command palette above your skills: `/compact` has the model summarize the thread so a long session keeps going, `/cost` reports the conversation's tokens and spend, `/clear` and `/new` start over, `/model` switches model and `/help` lists them. And PLAN becomes **genuinely read-only**: the catalogue offered to the model is cut to inspection tools and any write is refused at execution time too, not just in the prompt.

**El agente habla git y lee la web sin navegador.** Seis herramientas nuevas: `git_status`, `git_diff`, `git_log`, `git_branch`, `git_commit` y `web_fetch`. Git se ejecuta con un array de argumentos y sin shell, siempre sobre tu espacio de trabajo, y las operaciones que reescriben historia (reset, push forzado, rebase, amend) no se exponen a propósito: esas siguen pasando por `run_command` y su confirmación. `web_fetch` trae una página y la reduce a texto, con una barrera SSRF sobre la dirección RESUELTA (bucle local, rangos privados, enlace local y metadatos) y la comprobación repetida en cada redirección. / **The agent speaks git and reads the web without a browser.** Six new tools: `git_status`, `git_diff`, `git_log`, `git_branch`, `git_commit` and `web_fetch`. Git runs through an argument array with no shell, always on your workspace, and history-rewriting operations (reset, force-push, rebase, amend) are deliberately not exposed: those still go through `run_command` and its prompt. `web_fetch` pulls a page and reduces it to text, with an SSRF gate on the RESOLVED address (loopback, private ranges, link-local, metadata) re-checked at every redirect. No se envía `web_search`: los buscadores sin clave devuelven respuestas vacías o se rompen solos, así que haría falta un backend con clave — no se entrega un rastreador a medias. / `web_search` is not shipped: keyless search endpoints return empty answers or break on their own, so it needs a keyed backend — a half-working scraper is not shipped.

**Tus propios especialistas, y el registro de verdad.** Puedes definir subagentes dejando un `AGENT.md` en `<carpeta de datos>/agents/<id>/`. Una definición nunca puede darse más de lo que da el techo de serie (su lista de herramientas se cruza con el catálogo real), y un archivo roto se salta avisando en vez de tumbar la app. La vista de Agentes deja de ser una vitrina fija de seis tarjetas que no correspondía al registro usable: ahora pinta los agentes reales, marca cuáles vienen del disco y los relee con **Recargar**. / **Your own specialists, and the real registry.** You can define subagents by dropping an `AGENT.md` into `<data dir>/agents/<id>/`. A definition can never grant itself more than the built-in ceiling (its tool list is intersected with the real catalogue), and a broken file is skipped with a warning instead of taking the app down. The Agents view stops being a fixed showcase of six cards that did not match the usable registry: it renders the real agents, marks which came from disk and re-reads them with **Recargar**.

**Y por debajo, diecinueve defectos corregidos** — incluido un interbloqueo del turno cuando dos herramientas del mismo mensaje pedían confirmación a la vez (la ranura de confirmación era única y la segunda pisaba a la primera, dejando el turno colgado sin error), un interbloqueo del navegador en su reintento de sesión (reencolaba la continuación detrás de la tarea que la esperaba), un fallo abierto en `update:retry` (sin hash esperado lanzaba el instalador con `verified:true`), contraseñas tecleadas en una web que quedaban en claro en el log y en la conversación, y la comprobación de cierre ejecutando un comando derivado de archivos que el propio agente acababa de escribir sin pasar por la barrera de comandos. El listado completo, abajo. / **And underneath, nineteen fixed defects** — including a turn deadlock when two tools of the same message asked for confirmation at once (the confirmation slot was single and the second overwrote the first, hanging the turn with no error), a browser deadlock in its session retry (it re-queued the continuation behind the very task waiting for it), a fail-open `update:retry` (with no expected hash it launched the installer with `verified:true`), passwords typed into a web page left in clear in the log and the conversation, and the close verification running a command derived from files the agent had just written, bypassing the command barrier. The full list is below.

### Cambios completos desde la 4.1.0

**Interfaz y revisión:**

- Panel de revisión del cambio: una tarjeta por archivo con contadores, hunks numerados y vuelta atrás de un solo archivo; el botón sigue la misma señal que «Deshacer» para que no puedan contradecirse. / Change review panel: one card per file with counters, numbered hunks and single-file revert; the button follows the same signal as "Undo" so the two cannot disagree.
- Órdenes de barra en la paleta de `/`, con la ayuda derivada de la misma lista que usa el despacho. / Slash commands in the `/` palette, with help derived from the same list the dispatcher uses.
- Medidor de contexto en el compositor (holgado / ajustado / apretado), alimentado por la medición que ya existía. / Context meter in the composer (normal / tight / critical), fed by the measurement that already existed.
- Los avisos se apilan de verdad: contenedor en columna, hasta tres, el más viejo cae primero. Antes los tres se pintaban en el MISMO punto fijo y el nuevo tapaba al viejo, que caducaba sin que nadie lo leyera. / Toasts really stack now: a column container, up to three, oldest first out. Before, all three painted at the SAME fixed point and the new one covered the old one, which expired unread.
- Vuelta atrás de un solo archivo y no solo del turno entero. / Single-file revert, not just the whole turn.
- Pestañas de Ajustes con el patrón ARIA completo y navegación por flechas. / Settings tabs with the full ARIA pattern and arrow-key navigation.
- `.dot.custom` faltaba y el punto salía invisible; el carril de agentes y la vista comparten una sola lista. / `.dot.custom` was missing and the dot was invisible; the agent rail and the view now share one list.
- Dos capturas nuevas en `npm run shots`: la paleta de órdenes y el panel de revisión. / Two new captures in `npm run shots`: the command palette and the review panel.

**Agente y herramientas:**

- PLAN solo lectura, con el catálogo recortado y rechazo en ejecución. / Read-only PLAN, with a trimmed catalogue and an execution-time refusal.
- `git_status`, `git_diff`, `git_log`, `git_branch` y `git_commit`, todas con la salida acotada. / `git_status`, `git_diff`, `git_log`, `git_branch` and `git_commit`, each with bounded output.
- `web_fetch` con barrera SSRF sobre la dirección resuelta y topes de tamaño, tiempo y redirecciones. / `web_fetch` with an SSRF gate on the resolved address and size, time and redirect caps.
- Subagentes definidos por el usuario desde `AGENT.md`, con el techo de herramientas del registro. / User-defined subagents from `AGENT.md`, capped by the registry's tool ceiling.
- `/compact` con resumen escrito por el modelo y `/cost` con el consumo acumulado de la conversación (incluidas las delegaciones, que antes no se contaban). / `/compact` with a model-written summary and `/cost` with the conversation's accumulated usage (delegations included, which were not counted before).
- Aceptar las ediciones de archivos sin preguntar, en Ajustes ▸ Seguridad: **solo** escrituras de archivo, nunca comandos ni ejecución. / Accept file edits without asking, in Settings ▸ Security: file writes **only**, never commands or execution.
- Bifurcar una conversación y rebobinar el hilo a un punto, tirando el resumen y la lista de tareas que describían lo que ya no está. / Fork a conversation and rewind the thread to a point, dropping the summary and todo list that described what is gone.
- El fallback automático a proveedores guardados pasa a ser opt-in: el modelo elegido manda y una petición no viaja a un tercero que no escogiste. / Automatic fallback to saved providers becomes opt-in: the chosen model wins and a request does not travel to a third party you did not pick.

**Seguridad:**

- La verificación de cierre ya no ejecuta un comando derivado de archivos escritos en el mismo turno: se clasifica y se exige que el comando existiera al empezar el turno. Un rechazo no gasta intentos de arreglo. / The close verification no longer runs a command derived from files written in the same turn: it is classified and must have existed at the start of the turn. A refusal does not burn repair attempts.
- El comprobador del proyecto que vive dentro del espacio de trabajo solo se ejecuta si ya estaba ahí antes del turno. / The project checker that lives inside the workspace only runs if it was already there before the turn.
- Lo tecleado en un campo sensible y lo escrito en el portapapeles se enmascaran en el log de ejecución y en el rastro guardado con la conversación. / Text typed into a sensitive field and clipboard writes are masked in the run log and in the trace saved with the conversation.
- El confinamiento del directorio de datos resuelve la ruta real: un enlace (junction) dentro del espacio de trabajo ya no lo atraviesa. / Data-directory confinement resolves the real path: a junction inside the workspace no longer gets through.
- `apply_patch` y `edit_file` escriben por archivo temporal y renombran; si algo falla, se restauran los ya escritos. / `apply_patch` and `edit_file` stage to a temp file and rename; on failure the already-written files are restored.
- `update:retry` exige el hash esperado y recomprueba la firma: sin verificación no se lanza nada. / `update:retry` requires the expected hash and re-checks the signature: nothing launches unverified.
- El cierre de la app espera a su limpieza (antes era `async` y Electron no lo esperaba: los procesos de MCP y el navegador podían quedar huérfanos). / App shutdown waits for its cleanup (it used to be `async` and Electron did not await it: MCP and browser processes could be orphaned).
- `settings:set` solo acepta claves conocidas: el espacio de trabajo no se puede fijar por ahí, solo por los canales que lo validan. / `settings:set` only accepts known keys: the workspace cannot be set there, only through the channels that validate it.
- Permisos de Chromium por lista blanca, con el origen comprobado y denegado por defecto. / Chromium permissions allow-listed, with the origin checked and deny by default.
- CSP con `object-src 'none'`, `base-uri 'self'` y `frame-ancestors 'none'`. / CSP with `object-src 'none'`, `base-uri 'self'` and `frame-ancestors 'none'`.

**Agente (fiabilidad):**

- Dos confirmaciones a la vez ya no cuelgan el turno: el registro es un mapa por identificador, con el reloj de duración pausado mientras queda alguna pendiente. / Two confirmations at once no longer hang the turn: the registry is a map by id, with the duration clock paused while any is outstanding.
- Detener cancela de verdad la acción del navegador en vuelo (esperas, `settle`, `wait_for`), no solo el texto. / Stop really cancels the in-flight browser action (waits, `settle`, `wait_for`), not just the text.
- El reintento de sesión del navegador ya no se encola detrás de sí mismo. / The browser's session retry no longer queues behind itself.
- La lista de tareas viva se reinyecta en el prompt en cada paso del turno. / The live todo list is re-injected into the prompt at every step.
- El gasto y los tokens se cuentan aunque el proveedor no mande `total_tokens` (se normaliza en el borde del protocolo). / Cost and tokens are counted even when the provider omits `total_tokens` (normalised at the protocol edge).
- Los subagentes que escriben no dejan árboles de trabajo huérfanos si algo falla a mitad. / Writing subagents leave no orphaned worktrees if something fails midway.
- El registro de herramientas en vuelo es uno solo (se eliminó la ranura antigua, que las mataba dos veces). / There is a single in-flight tool registry (the old slot, which killed them twice, is gone).
- `toolsFired` se reinicia por turno. / `toolsFired` resets per turn.

**Por dentro:**

- 30 herramientas nativas (antes 24) y `esSoloLectura()` como única fuente del catálogo de PLAN. / 30 native tools (was 24) and `esSoloLectura()` as the single source for the PLAN catalogue.
- `main/workspace-ruta.js`: una sola validación del espacio de trabajo para las tres vías que lo fijan. / `main/workspace-ruta.js`: one workspace validation for all three paths that set it.
- La suite: 417 pruebas en `npm test` y 510 en `npm run test:renderer` (40 archivos), todas en verde; `uicheck` gana siete comprobaciones para las superficies nuevas. / The suite: 417 tests in `npm test` and 510 in `npm run test:renderer` (40 files), all green; `uicheck` gains seven checks for the new surfaces.
- El arnés del actualizador arranca Electron con los mismos conmutadores que `lanzar.js` y declara «entorno no sirve» cuando el sandbox impide montar el escenario, en vez de inventar un veredicto. / The updater harness starts Electron with the same switches as `lanzar.js` and reports "environment unusable" when the sandbox prevents the scenario, instead of inventing a verdict.

# SAGITARI 4.1.0

**El agente trabaja con una lista de tareas viva.** En una tarea de varios pasos, el agente ahora crea y mantiene un checklist propio con la nueva herramienta `todo_write`: marca cada paso en curso y completado mientras trabaja, y la tarjeta avanza en el chat — el mismo modo de trabajo de los mejores agentes de código. La lista viaja en su prompt en cada paso (el progreso sobrevive a los turnos largos y a los recortes de contexto), se normaliza al entrar (estados en español aceptados, sin duplicados, una sola tarea en curso) y se guarda con la conversación para ver en qué quedó el trabajo al reabrirla. Actualizar la lista no cuenta como acción del sistema: no pide permiso y no dispara el guardián de bucles cuando el modelo la actualiza paso a paso. / **The agent now works with a live task list.** On a multi-step task, the agent creates and maintains its own checklist with the new `todo_write` tool: it marks each step in progress and completed as it works, and the card advances in the chat — the same working style as the best coding agents. The list rides in its prompt on every step (progress survives long turns and context trimming), it is normalized on arrival (Spanish states accepted, no duplicates, a single in-progress task), and it is saved with the conversation so you can see where the work ended when you reopen it. Updating the list is not a system action: it never asks for permission, and stepping through it does not trip the loop guard.

# SAGITARI 4.0.0

**El aura ya no late: rueda.** El glow se rediseña entero: filo nítido de 1px que reparte los 6 tonos del espectro, tres halos con su tono —y uno con núcleo blanco— que ruedan por el borde (el color gira cada 22s y el alcance respira cada 8s, con las propiedades registradas para que la interpolación sea continua y no a saltos), y cada estado del agente distinguiéndose por el NIVEL de luz del marco en vez de por un ritmo propio: pensar y trabajar se leen de un vistazo. Añade la cáustica del compositor (luz arriba-izquierda, sombra abajo-derecha), el slider de vidrio ultra claro ↔ tintado con sus etiquetas sin pisarse, el reloj y las puertas numeradas del estado vacío, y el logotipo muerto del rebranding fuera del instalador (−1,4 MB), y el README estrena en su galería las capturas de Ajustes y Skills. / **The aura no longer beats: it rolls.** The glow is fully redesigned: a sharp 1px edge carrying the 6 spectrum hues, three tonal halos —one with a white core— rolling along the border (the hue rotates every 22s and the reach breathes every 8s, with registered properties so the interpolation is continuous instead of stepped), and each agent state told apart by the frame's light LEVEL instead of its own rhythm: thinking and working are readable at a glance. Plus the composer's caustic (light top-left, shadow bottom-right), the ultra-light ↔ tinted glass slider whose labels no longer collide, the clock and numbered gates of the empty state, and the dead rebranding logo out of the installer (−1.4 MB), and the README gallery now shows Settings and Skills.

**Tus claves quedan fuera del alcance del agente.** El directorio de datos de la app (claves API, conversaciones, memoria) ya no se lee ni se escribe desde las herramientas, y un `run_command` con `cwd` fuera del espacio de trabajo se rechaza en vez de lanzarse — ni `C:\Windows` ni la carpeta de configuración. Los hooks que escribes tú pasan la misma barrera de comandos destructivos que la terminal, el navegador solo abre `http(s)` (`file://` leería el disco fuera del confinamiento), y el ayudante que instala la nueva versión se sella con una huella SHA-256 que se recomprueba justo antes de disparar la tarea — el `.ps1` vive en `%TEMP%`, donde otro proceso podría tocarlo. Y las skills importadas de repos ajenos llegan como CONTENIDO de terceros delimitado, no como órdenes: si piden algo que no pediste, se avisa y no se hace. Y el JavaScript del navegador estrena permiso propio en Seguridad ▸ Permisos: puedes ponerlo en «permitir siempre» y deja de preguntar en cada eval — por defecto sigue preguntando. / **Your keys are now out of the agent's reach.** The app's data directory (API keys, conversations, memory) is no longer read or written by tools, and a `run_command` whose `cwd` falls outside the workspace is rejected instead of launched — neither `C:\Windows` nor the config folder. Hooks you write pass the same destructive-command barrier as the terminal, the browser only opens `http(s)` (`file://` would read disk outside the confinement), and the helper that installs the new version is sealed with a SHA-256 fingerprint re-checked right before the task fires — the `.ps1` lives in `%TEMP%`, where another process could touch it. And skills imported from third-party repos arrive as delimited third-party CONTENT, not as orders: if they ask for something you never asked for, you are told and nothing runs. And browser JavaScript gets its own row in Security ▸ Permissions: set it to “always allow” and it stops asking on every eval — by default it still asks.

**Por dentro, sin cambios a la vista:** `main.js` se trocea en doce routers `ipc-*`, el renderer en tres scripts (`10-chat`, `30-ajustes`, `40-vistas`) y la suite de tests en cuatro bloques; el mapa del proyecto y la búsqueda comparten ya un único recorrido del árbol. / **Inside, with nothing changed on screen:** `main.js` is split into twelve `ipc-*` routers, the renderer into three scripts (`10-chat`, `30-ajustes`, `40-vistas`), and the test suite into four blocks; the project map and search now share a single tree walk.

**La obra pasa a licencia propia.** Desde la 4.0.0, SAGITARI se publica bajo la Licencia de Uso Personal: uso individual gratis para siempre y sin cargos, código fuente visible para revisión, pero sin distribución por terceros, sin compilación externa, sin uso en empresas y con la marca SAGITARI reservada a su autor. / **The work moves to its own license.** From 4.0.0, SAGITARI ships under its Personal Use License: free individual use forever with no fees, source code open for review, but no redistribution, no building by third parties, no organizational use, and the SAGITARI mark is reserved to its author.

### Cambios completos desde la 3.3.5

**Visual y tema:**

- Aura rediseñada: filo de 1px con 6 tonos, tres halos que ruedan (`giro` 22s + `reachLife` 8s con `@property` registrados) y estados distinguidos por el nivel de luz. / Redesigned aura: 1px edge with 6 hues, three rolling halos (`giro` 22s + `reachLife` 8s with registered `@property`) and states told apart by light level.
- Cáustica en el compositor (luz arriba-izquierda, sombra abajo-derecha). / Composer caustic (light top-left, shadow bottom-right).
- Slider de vidrio ultra claro ↔ tintado con sus etiquetas sin pisarse. / Ultra-light ↔ tinted glass slider with labels that no longer collide.
- Deck: reloj, puertas numeradas y holo con momentos. / Deck: clock, numbered gates and holo moments.
- Estado vacío limpio: fuera el scope/radar del fondo. / Clean empty state: the scope/radar is gone.
- Sliders de cristal en Ajustes y en Memoria: relleno real hasta el pulgar, pulgar con anillo oscuro y foco visible al teclado. / Glass sliders in Settings and Memory: real fill up to the thumb, dark-ringed thumb, keyboard-visible focus.
- Aurora pasa a ser el tema por defecto. / Aurora becomes the default theme.
- El logotipo muerto del rebranding sale del instalador (−1,4 MB). / The dead rebranding logo leaves the installer (−1.4 MB).
- El README estrena en su galería las capturas de Ajustes y Skills. / The README gallery gains the Settings and Skills shots.
- La marca queda sin referencias a sistemas ajenos. / The brand carries no third-party OS references.
- Corregido: mover el tinte de vidrio ya no destellaba el glow. / Fixed: adjusting the glass tint no longer flashes the glow.

**Seguridad:**

- El agente queda confinado a los datos de la app y al espacio de trabajo (leer, escribir, editar y `cwd`). / The agent is confined to app data and the workspace (read, write, edit and `cwd`).
- Los hooks pasan la misma barrera de comandos destructivos que la terminal. / Hooks pass the same destructive-command barrier as the terminal.
- El navegador solo abre `http(s)` (`file:`, `chrome:` y `about:` se rechazan). / The browser only opens `http(s)` (`file:`, `chrome:` and `about:` are rejected).
- El ayudante que instala la nueva versión se sella con SHA-256 y se recomprueba antes de disparar la tarea. / The install helper is SHA-256-sealed and re-verified before the task fires.
- Las skills de repos ajenos se entregan como contenido de terceros delimitado, no como órdenes. / Third-party skills arrive as delimited third-party content, not orders.
- El JavaScript del navegador gana su propia fila en Seguridad ▸ Permisos. / Browser JavaScript gets its own row in Security ▸ Permissions.

**Por dentro (fase 4):**

- `main.js` se trocea en doce routers `ipc-*`; el renderer en tres scripts; la suite en cuatro bloques; mapa y búsqueda comparten un único recorrido del árbol. / `main.js` splits into twelve `ipc-*` routers; the renderer into three scripts; the suite into four blocks; map and search share a single tree walk.

**Proceso de release:**

- El workflow gatea tag contra versión y sección de notas, firma todos los binarios y publica SHA-256; `npm audit` corre en la CI. / The workflow gates tag vs version and the notes section, signs every binary and publishes SHA-256; `npm audit` runs in CI.
- La Licencia de Uso Personal entra en vigor (detalle en el párrafo de arriba y en `LICENSE`). / The Personal Use License takes effect (see the paragraph above and `LICENSE`).

# SAGITARI 3.3.5

**La respuesta ya no se vuelve corta al terminar.** Antes toda la narración del turno se acumulaba en un bloque que al cerrar se tiraba y se sustituía por el último párrafo —una respuesta larga se convertía en tres líneas—. Ahora cada tramo de explicación queda congelado encima de la herramienta que viene después, en orden cronológico como en las grandes herramientas agénticas, y el historial guarda la historia completa (con tope): reabrir la conversación enseña lo mismo que se vio en vivo. El modo Plan no cambia. / **Answers no longer shrink when the turn ends.** All of the turn's narration used to pile into one block that was thrown away at close and replaced with the last paragraph —a long answer turned into three lines—. Now each explanation sits frozen above the tool that follows it, in chronological order like the big agentic tools, and the history keeps the whole story (capped): reopening the conversation shows what you saw live. Plan mode is unchanged.

**Rebranding: icono, sidebar y cabecera nuevos.** Nueva marca en la ventana, la barra de tareas, la bandeja, el instalador y los avatares del chat; el sidebar lleva el logo completo en una sola pieza; y el README estrena cabecera. / **Rebrand: new icon, sidebar and header.** New mark on the window, taskbar, tray, installer and chat avatars; the sidebar carries the full logo in one piece; and the README has a new header.

# SAGITARI 3.3.4

**El actualizador ya no depende de sobrevivir al cierre.** El diseño anterior (un proceso desligado que sostenía al asistente) pasaba 3/3 en el laboratorio pero moría en máquinas reales al cerrarse la app: cuatro intentos medidos en un diario de usuario, en dos versiones distintas, todos con el asistente muerto tras su primera línea. Ahora la instalación la ejecuta el Programador de tareas de Windows —un servicio del sistema, no un hijo de la app—, así que cerrar SAGITARI (o que lo tumbe el antivirus) ya no puede matarla. Además el diario escribe un latido cada 10 segundos mientras espera, para que el próximo fallo diga cuándo murió en vez de quedarse mudo, y la tarea de un solo uso se autoborra al terminar. Si el programador no está disponible, se intenta la vía clásica como plan B. / **The updater no longer depends on surviving the shutdown.** The previous design (a detached process holding the helper) passed 3/3 in the lab but died on real machines when the app closed: four attempts measured in a user's log, across two versions, all with the helper dead after its first line. The installation is now run by the Windows Task Scheduler —a system service, not a child of the app— so closing SAGITARI (or the antivirus killing it) can no longer take it down. The log also writes a heartbeat every 10 seconds while waiting, so the next failure will say when it died instead of going silent, and the one-shot task deletes itself when done. If the scheduler is unavailable, the classic path is attempted as plan B.

# SAGITARI 3.3.3

**El diario ya no apunta tus secretos.** Todo lo que hacía el agente se guardaba tal cual en el registro local: si escribía una contraseña, pegaba una clave o el portapapeles llevaba un código, quedaba en disco en claro. Ahora cada evento se redacta antes de guardarse (claves y tokens se tachan, los textos largos se recortan) y la memoria de hábitos recibe la misma versión ya limpia. Lo que nunca se guardó no hay que perseguirlo después. / **The log no longer records your secrets.** Everything the agent did was stored verbatim in the local log: a typed password, a pasted key or a clipboard code stayed on disk in clear text. Every event is now redacted before it is written (keys and tokens blacked out, long texts trimmed) and the habits memory receives the same already-clean version. What was never stored never needs chasing.

**Los comandos disfrazados también piden permiso.** El vigilante de comandos frenaba lo obvio (formatear, borrar la raíz), pero un PowerShell ofuscado en base64 (`-enc`), una descarga con `DownloadString` o `Invoke-WebRequest`, o un `mshta`/`rundll32` con URL pasaban sin preguntar. Esas vías ahora se clasifican como sensibles y exigen tu confirmación aunque la terminal esté en modo automático. / **Disguised commands now ask first too.** The command watchdog stopped the obvious (formatting, wiping the drive root), but an obfuscated base64 PowerShell (`-enc`), a `DownloadString` or `Invoke-WebRequest` download, or an `mshta`/`rundll32` with a URL slipped through silently. Those paths are now classified as sensitive and require your confirmation even with the terminal in automatic mode.

**Instalar y las skills piden un «sí, lo sé».** Los binarios siguen sin firma digital, así que instalar pedía lo mismo con prueba SHA-512 que sin ella: ahora el primer clic te avisa y solo el segundo instala (vale también para reintentar). Y las skills de GitHub —que son órdenes que el agente obedecerá— primero te enseñan lo que traen y solo se instalan si confirmas; además se comprueba que lo descargado sea exactamente el contenido publicado (hash git-blob). De propina: las imágenes de tus chats se guardan en miniatura (las conversaciones ya no engordan megabytes), la carpeta de trabajo rechaza rutas del sistema y la detección de modelos aguanta endpoints maliciosos sin romperse. / **Installing and skills now need an explicit “yes, I know”.** The binaries are still unsigned, so installing asked the same with or without SHA-512 proof: now the first click warns you and only the second one installs (retries included). And GitHub skills —orders your agent will obey— first show you what they bring and only install on confirmation; on top of that, downloads are checked to be exactly the published content (git-blob hash). As a bonus: chat images are stored as thumbnails (conversations no longer swell by megabytes), the workspace rejects system paths, and model detection survives malicious endpoints unbroken.

# SAGITARI 3.3.2

**El actualizador, esta vez con la causa medida.** La explicación que dio la 3.3.1 («Windows
mata todo el árbol de procesos de la app») era **incorrecta**, y por eso el fallo seguía
ahí. Medido con un Electron de verdad, lanzando el mismo asistente de cuatro formas:
`powershell.exe` **directo** arranca y **muere con la app** (es el diario que veíais:
«asistente iniciado» y nada más); `powershell.exe` **desligado ni arranca**; y en cambio un
**`cmd.exe` que lo sostiene, desligado, sobrevive**. Eso es ahora el lanzamiento, y es la
diferencia entre cerrar la app y que la versión nueva esté al abrirla. Además, la prueba de
regresión anterior **no podía detectar este fallo** (usaba un Node como padre, y ahí el
diseño roto también pasa): ahora usa un Electron real y ejecuta un control con el diseño
que falló, exigiendo que NO instale — un test que no puede fallar por lo que dice guardar
no guarda nada. / **The updater, this time with the cause measured.** The explanation given
in 3.3.1 (“Windows kills the whole process tree of the app”) was **wrong**, which is why
the bug was still there. Measured with a real Electron, launching the same helper in four
ways: a **direct** `powershell.exe` starts and **dies with the app** (that is the log you
saw: “asistente iniciado” and nothing else); a **detached** `powershell.exe` does not even
start; while a **`cmd.exe` holding it, detached, survives**. That is the launch now, and it
is the difference between the app closing and the new version being there when you open
it. On top of that, the previous regression test **could not detect this bug** (it used a
Node process as the parent, and the broken design passes there too): it now uses a real
Electron and runs a control with the design that failed, requiring it to NOT install — a
test that cannot fail for what it claims to guard guards nothing.

**Si tienes instalada la 3.3.0 o anterior, necesitas instalarla UNA vez a mano** (descarga
el Setup y ejecútalo): esas versiones lanzaban el asistente de la forma que fallaba y no
pueden repararse a sí mismas —ese es justo el fallo—. A partir de ahí, las siguientes se
instalan solas. / **If you have 3.3.0 or older installed, you need to install it ONCE by
hand** (download the Setup and run it): those versions launched the helper the failing way
and cannot repair themselves — that is the very bug. From then on, later versions install
themselves.

**El chat recuerda su trabajo.** Al cerrar la app y volver a abrirla, el hilo repintaba
solo las burbujas de texto: las tarjetas de herramienta, el razonamiento y sus tiempos
desaparecían de la vista, y una respuesta se quedaba sin saber cómo se había llegado a
ella. Ahora el turno se guarda ENTERO —herramientas con sus argumentos, resultado y
duración, el razonamiento y su resumen— y al reabrir la conversación se reconstruye el
mismo bloque plegable, con su recuento y sus fallos. Lo que no llegó a terminar se dice
tal cual, en vez de pintarle un check verde que nunca ocurrió. / **The chat remembers its
work.** On closing and reopening the app, the thread only repainted the text bubbles: the
tool cards, the reasoning and their timings vanished, leaving an answer with no trace of
how it was reached. The turn is now stored WHOLE — tools with their arguments, result and
duration, plus the reasoning and its summary — and reopening the conversation rebuilds the
same collapsible block, with its count and its failures. Whatever did not finish is said
as such, instead of being given a green check that never happened.

**Respuestas que se entienden.** El agente tenía instrucciones que empujaban al telegrama
(«respuestas breves», «minimiza explicaciones», «1-3 líneas»), y el resultado eran cosas
como «divisor corregido de /2|9 a /7|9» o un «Revisado: sin hallazgos» a secas. Ahora el
prompt le pide lo contrario: la respuesta final es lo único que lees de todo su trabajo,
se escribe para quien no ha visto las herramientas, con frases enteras (nada de siglas
inventadas para ahorrar caracteres) y en este orden: qué hizo, qué cambió con los datos
concretos, cómo lo comprobó y qué queda pendiente. Y cuando el turno se corta —por
estancamiento, por bucle, por límite— ya no deja un «(detenido: sin progreso)» sin
explicación: dice qué pasó y qué puedes hacer. / **Answers you can actually read.** The
agent had instructions pushing it towards telegraphic replies (“keep answers short”,
“minimise explanations”, “1-3 lines”), which produced things like “divisor fixed from
/2|9 to /7|9” or a bare “Reviewed: nothing found”. The prompt now asks for the opposite:
the final answer is all you see of its work, it is written for someone who has not seen
the tools, in whole sentences (no invented abbreviations to save characters), in this
order: what it did, what changed with the concrete details, how it checked, and what is
still pending. And when a turn cuts off — stall, loop, limit — it no longer leaves an
unexplained “(stopped: no progress)”: it says what happened and what you can do.

# SAGITARI 3.3.1

**El actualizador instala de verdad.** «Cerrar e instalar» cerraba la app y no pasaba
nada: aparecía una ventana de consola, se cerraba y la versión seguía siendo la misma. La
causa no era un comando mal escrito, sino algo más de fondo: **Windows mata todo el árbol
de procesos de la app cuando se cierra**, así que el asistente que debía esperar a que
SAGITARI desapareciera moría con ella justo antes de poder instalar nada. Se ve en su
propio diario: escribía su primera línea y ahí se acababa. Ahora la instalación la pide a
Windows, que crea al asistente **fuera del árbol de la app** (y por eso sí la sobrevive),
y SAGITARI ya no se cierra hasta tener la prueba de que ese asistente está vivo y
trabajando. Si no lo consigue, no se cierra: te lo dice y te deja reintentarlo o
instalarlo a mano. / **The updater actually installs.** “Close and install” closed the app
and nothing happened: a console window appeared, closed, and the version was still the
same. The cause was not a mistyped command but something deeper: **Windows kills the whole
process tree of the app when it closes**, so the helper that was supposed to wait for
SAGITARI to disappear died with it, right before it could install anything. It is visible
in its own log: it wrote its first line and that was it. Now the installation is requested
from Windows, which creates the helper **outside the app's process tree** (and that is why
it does survive it), and SAGITARI no longer closes until it has proof that the helper is
alive and working. If it can't, it does not close: it tells you and lets you retry or
install by hand.

**Si tienes la versión instalada anterior a esta, necesitas instalarla UNA vez a mano**
(descarga el Setup y ejecútalo). El actualizador roto vivía dentro de las versiones
anteriores y no puede repararse a sí mismo —ese es justo el fallo—; a partir de esta, las
siguientes se instalarán solas. / **If your installed version is older than this one, you
need to install it ONCE by hand** (download the Setup and run it). The broken updater
lived inside the earlier versions and cannot repair itself —that is the very bug—; from
this one on, later versions will install themselves.

Además, el diario del asistente recoge ahora el **código de salida del instalador** y si la
app seguía viva al lanzarlo, y la app vuelve a abrirse sola al terminar la actualización
(antes se cerraba y el usuario creía que no había pasado nada… aunque hubiera pasado). /
On top of that, the helper's log now records the **installer's exit code** and whether the
app was still running when it launched it, and the app reopens by itself when the update
finishes (it used to close and the user thought nothing had happened — even when it had).

## Novedades / What's new

- **La instalación sobrevive al cierre de la app.** El archivo que la app ejecuta ahora es
  un puente que le pide a Windows (WMI) crear al asistente fuera de su árbol de procesos;
  el asistente espera a que SAGITARI desaparezca y lanza el Setup en silencio. Está medido
  con la app real: antes no se ejecutaba **3 de 3 veces**; ahora sí **3 de 3**, y el
  asistente vive en unos 2,3 s. / **The installation survives the app closing.** What the
  app runs now is a bridge that asks Windows (WMI) to create the helper outside its own
  process tree; the helper waits for SAGITARI to disappear and launches the Setup silently.
  Measured with the real app: it used to fail to run **3 out of 3 times**; now it succeeds
  **3 out of 3**, with the helper alive in about 2.3 seconds.
- **La app no se cierra sin pruebas.** Antes de cerrarte la ventana se espera a que el
  asistente deje su rastro en el diario; si no lo consigue (sin PowerShell, WMI bloqueado,
  política del equipo), la app NO se cierra y te lo dice, en vez de dejarte con la ventana
  cerrada y nada instalado. / **The app does not close without proof.** Before your window
  closes, it waits for the helper to leave its trace in the log; if it can't (no PowerShell,
  WMI blocked, machine policy), the app does NOT close and tells you, instead of leaving you
  with a closed window and nothing installed.
- **El diario del asistente dice más.** Código de salida del instalador, si la app seguía
  viva al lanzarlo y el rastro completo de cada intento, en
  `%TEMP%\sagitari-update\instalar.log`. Si algo vuelve a fallar, ahí está el porqué. /
  **The helper's log says more.** Installer exit code, whether the app was still running when
  it launched it, and the full trace of every attempt, in `%TEMP%\sagitari-update\instalar.log`.
  If something fails again, the reason is there.

# SAGITARI 3.3.0

**Los subagentes que escriben dejan de pisarse.** Cuando SAGITARI reparte un trabajo grande
entre sus especialistas, los que escriben código trabajan ahora cada uno en su **propio árbol
de git** —con tu proyecto tal y como lo tienes, incluidos los cambios sin guardar— y al terminar
sus cambios vuelven al proyecto **como un parche que se comprueba antes de aplicarse**. Si algo
no encaja, no se aplica nada, se te dice por qué y el árbol queda ahí para mirarlo: nunca un
proyecto a medias. Y de paso, **lo que destruiría tu equipo ya no se ejecuta**: formatear una
unidad, gestionar particiones, borrar dentro de Windows o la raíz de un disco no son una
pregunta que puedas contestar que sí, y lo delicado (push forzado, publicar un paquete,
instalar en el equipo, borrados recursivos, el registro, tareas programadas, descargar y
ejecutar) pregunta siempre, aunque tengas la terminal en automático. / **Writing subagents stop
stepping on each other.** When SAGITARI splits a big job across its specialists, the ones that
write code each work now in their **own git worktree** —with your project exactly as you have
it, unsaved changes included— and when they finish their work comes back to the project **as a
patch that is checked before it is applied**. If it does not fit, nothing is applied, you are
told why, and the worktree stays put so you can look at it: never a half-changed project. And
along the way, **what would destroy your machine no longer runs**: formatting a drive, managing
partitions, deleting inside Windows or the root of a disk are not a question you can answer yes
to, and the delicate stuff (force-push, publishing a package, installing system-wide, recursive
deletes, the registry, scheduled tasks, download-and-run) always asks, even with the terminal
set to automatic.

Y la tercera es la que más vas a notar en el día a día: un anclaje de edición que solo fallaba
por la **sangría** ya no es un callejón sin salida. SAGITARI te enseña el bloque exacto que hay
en el archivo, con sus números de línea, y arregla el cambio **reajustando la sangría** en lugar
de destruirla. / And the third one is the one you will notice most day to day: an edit anchor
that only failed because of **indentation** is no longer a dead end. SAGITARI shows you the
exact block that is in the file, with its line numbers, and fixes the change **by readjusting
the indentation** instead of destroying it.

## Novedades / What's new

- **Aislar a los subagentes que escriben.** Cada especialista que escribe código (`coding`,
  `file`) trabaja en un árbol de trabajo de git propio: ve el proyecto entero —con tus cambios
  sin guardar y tus archivos nuevos—, escribe donde quiera y al cerrar vuelve un parche que se
  comprueba con `git apply --check` **antes** de tocar nada. Si entra, los archivos quedan como
  cualquier otro cambio del turno: **se pueden deshacer**. Si no entra, no se aplica nada y se
  te dice por qué y dónde quedó el árbol. Se apaga en Ajustes ▸ Agente, y sin git (o sin
  commits) funciona como siempre. / **Isolate writing subagents.** Every code-writing
  specialist (`coding`, `file`) works in its own git worktree: it sees the whole project —your
  unsaved changes and your new files included—, writes wherever it wants, and on finish a patch
  comes back that is checked with `git apply --check` **before** anything is touched. If it
  applies, the files are like any other change of the turn: **they can be undone**. If it does
  not, nothing is applied and you are told why and where the worktree stayed. It can be turned
  off in Settings ▸ Agent, and without git (or without commits) it works as always.
- **Los comandos se juzgan por lo que hacen, no por quién los pide.** Antes `run_command` tenía
  un único nivel de riesgo: el de la herramienta entera, así que poner «Terminal» en automático
  —o aprobar una vez un comando— autorizaba por igual `git status` y `format C:`. Ahora hay
  tres escalones: lo que solo lee no molesta; lo sensible pide confirmación **siempre** (push
  forzado, `git reset --hard`, publicar, instalar en el equipo, borrados recursivos, el
  registro, servicios y tareas programadas, usuarios, cortafuegos, apagar el equipo, descargar
  y ejecutar); y lo que destruye el sistema **no se ejecuta**, ni con tu permiso. / **Commands
  are judged by what they do, not by who asks.** `run_command` used to have a single risk level:
  the whole tool's, so setting “Terminal” to automatic —or approving one command once—
  authorised `git status` and `format C:` alike. There are now three tiers: read-only commands
  do not bother you; sensitive ones always ask (force-push, `git reset --hard`, publishing,
  installing system-wide, recursive deletes, the registry, services and scheduled tasks, users,
  firewall, powering the machine off, download-and-run); and what destroys the system does not
  run at all, not even with your permission.
- **La sangría ya no mata una edición.** Un anclaje que no coincidía al carácter devuelve un
  «¿Querías esto?» con el bloque real numerado, el texto exacto para copiar y una salida de una
  sola llamada (`tolerar_espacios`), que reajusta la sangría al archivo **línea a línea** (los
  tabuladores cuentan como tabuladores, no como un carácter). Con varias coincidencias no elige
  por su cuenta: te dice en cuántos sitios aparece. Nunca aplica una suposición en silencio. /
  **Indentation no longer kills an edit.** An anchor that did not match to the character now
  returns a “Did you mean this?” with the real block numbered, the exact text to copy and a
  one-call way out (`tolerar_espacios`) that readjusts the indentation to the file **line by
  line** (tabs count as tabs, not as one character). With several matches it does not choose on
  its own: it tells you how many places it found. It never applies a guess silently.

# SAGITARI 3.2.3

**El navegador por fin se puede manejar con su ventana detrás de la app.** Es el caso normal
—trabajas en SAGITARI y el navegador hace lo suyo por debajo— y era justo donde se rompía:
Windows le avisa a Chromium de que su ventana está tapada, Chromium la congela para ahorrar
batería y, a partir de ahí, cada clic y cada tipeo se quedaban esperando hasta morir con un
«CDP timeout» a los 30 segundos, sin decir por qué. Ahora el navegador se lanza con la
configuración que usa cualquier automatización profesional y ninguna espera interna puede
quedarse sin cerrar. / **The browser can finally be driven with its window behind the app.**
That is the normal case —you work in SAGITARI while the browser does its job underneath— and
it was exactly where it broke: Windows tells Chromium its window is covered, Chromium freezes
it to save power, and from then on every click and keystroke waited until it died with a “CDP
timeout” after 30 seconds, saying nothing about why. The browser now launches with the same
settings any professional automation uses, and no internal wait can hang forever.

Y el resto es lo que convierte a SAGITARI en un agente en el que se puede confiar para trabajar
de verdad: **puedes deshacer lo que hizo** (por turno o por archivo), **lee las reglas de tu
proyecto** si tienes un `SAGITARI.md` o un `AGENTS.md`, **ejecuta tus comandos** cuando escribo y
antes de cerrar el turno, **los errores de tu proyecto vuelven solos** tras cada escritura, y hay
un **banco de tareas** para medir al agente con números en vez de con sensaciones. / And the
rest is what turns SAGITARI into an agent you can trust with real work: **undo what it did**
(per turn or per file), it **follows your project's rules** when you have a `SAGITARI.md` or
`AGENTS.md`, it **runs your commands** on every write and before the turn closes, **your
project's errors come back on their own** after each write, and there is a **task bench** to
measure the agent with numbers instead of with feelings.

## Novedades / What's new

- **Deshacer, de verdad.** El trabajo del turno se puede revertir entero o archivo por archivo
  (`Deshacer` aparece en el chat en cuanto hay algo que deshacer). El agente ya guardaba cómo
  estaba cada archivo antes de tocarlo para poder revisar el cambio; ahora eso se usa también
  para devolverlo a como estaba, avisando de lo que NO se puede restaurar. / **Undo, for real.**
  A turn's work can be reverted as a whole or file by file (`Undo` appears in the chat as soon
  as there is something to undo). The agent already kept a copy of every file before touching
  it in order to review the change; now that is used to put it back, warning about what cannot
  be restored.
- **Las reglas de tu proyecto mandan.** Un `SAGITARI.md` o `AGENTS.md` en la raíz (o en
  `.sagitari/`) se lee SIEMPRE, antes de tocar nada, y también lo leen los subagentes. En
  Ajustes ▸ Agente se ve qué archivos se están leyendo (y se crea la plantilla con un botón);
  en tu carpeta de datos puedes tener un `AGENTS.md` tuyo, válido para todos los proyectos. /
  **Your project's rules win.** A `SAGITARI.md` or `AGENTS.md` at the root (or in `.sagitari/`)
  is read ALWAYS, before touching anything, and the subagents read it too. Settings ▸ Agent
  shows which files are being read (and creates the template with one button); your data folder
  can hold your own `AGENTS.md`, valid for every project.
- **Tus comandos, enganchados al agente (hooks).** Un comando tras cada escritura (formatear,
  `lint --fix`, lo que quieras: `{{file}}`, `{{files}}`, `{{dir}}` con las rutas ya entre
  comillas) y otro antes de cerrar el turno. Si el de cierre falla, el turno **no** cierra: el
  agente lee la salida y lo arregla, igual que con tus pruebas. / **Your commands, hooked into
  the agent.** One command after every write (format, `lint --fix`, whatever: `{{file}}`,
  `{{files}}`, `{{dir}}` with paths already quoted) and another before the turn closes. If the
  closing one fails, the turn does **not** close: the agent reads the output and fixes it, just
  like with your tests.
- **El agente se comprueba a sí mismo con tu proyecto.** Tras cada archivo escrito se pasan los
  comprobadores de TU proyecto (ESLint, Ruff, Flake8, Mypy…) sobre las líneas que ha cambiado y
  el fallo vuelve en el mismo paso; lo que ya estaba mal en el archivo no se le exige. Al cerrar,
  se ejecutan tus pruebas (o tu compilación) y, si fallan, el turno no termina hasta arreglarlas
  (con tope de intentos, ajustable). / **The agent checks itself against your project.** After
  every file written, YOUR project's checkers (ESLint, Ruff, Flake8, Mypy…) run over the lines it
  changed and the failure comes back in the same step; what was already wrong in the file is not
  demanded of it. On close, your tests (or your build) run and, if they fail, the turn does not
  end until they are fixed (with an adjustable retry cap).
- **Búsqueda híbrida (`search_code`).** Coincidencia exacta con ripgrep cuando está en el equipo
  (y un barrido propio cuando no) **más** un ranking por relevancia calculado en local, sin claves
  ni servicios. Sirve para las dos preguntas de siempre: «dónde se usa esto» y «dónde está lo que
  decide X», aunque no sepas cómo se llama. / **Hybrid search (`search_code`).** Exact matching
  with ripgrep when it is on the machine (with its own sweep when it is not) **plus** a relevance
  ranking computed locally, with no keys and no services. It answers both classic questions:
  “where is this used” and “where is whatever decides X”, even when you do not know its name.
- **El contexto tiene presupuesto.** Se mide lo que se manda (mensajes y las definiciones de las
  22 herramientas, que son miles de tokens que nadie cuenta) y, cuando ya no cabe, se sueltan del
  envío los bloques más antiguos —el historial y la conversación no se tocan— avisando en el chat.
  Además, la caché de prompt del proveedor se aprovecha por defecto (se puede apagar). /
  **Context has a budget.** What is sent is measured (messages plus the definitions of the 22
  tools, which are thousands of tokens nobody counts) and, when it no longer fits, the oldest
  blocks are dropped from the request —history and conversation are untouched— with a notice in
  the chat. On top of that, the provider's prompt cache is used by default (it can be turned off).
- **Banco de tareas (`npm run banco`).** Tres tareas con punto de partida, objetivo y criterio
  objetivo de éxito (las pruebas del propio proyecto de la tarea), y un informe con pasos, tokens,
  tiempo y coste. Compara con una línea base y **falla** si algo que pasaba ya no pasa: cambiar un
  prompt, una skill o la orquestación deja de ser una apuesta. / **Task bench (`npm run banco`).**
  Three tasks with a starting point, a goal and an objective success criterion (the task's own
  project tests), plus a report with steps, tokens, time and cost. It compares against a baseline
  and **fails** if something that used to pass no longer does: changing a prompt, a skill or the
  orchestration stops being a gamble.

## Interfaz / Interface

- **El razonamiento se puede leer de un vistazo.** Mientras el modelo piensa, la cabecera cuenta
  el tiempo en vivo; al plegarse queda un **resumen de una línea** de lo que estaba pensando, y
  abierto dice cuánto pensó y cuántas líneas. / **Reasoning is readable at a glance.** While the
  model thinks, the header counts time live; once collapsed it leaves a **one-line summary** of
  what it was thinking, and when opened it reports how long it thought and how many lines.
- **Las tarjetas de herramientas informan solas.** El tiempo corre mientras trabajan (un comando
  largo ya no parece colgado), un **fallo se lee en la propia cabecera** sin desplegar la tarjeta,
  y el resultado dice cuántas líneas trae antes de abrirlo. / **Tool cards report on their own.**
  The timer runs while they work (a long command no longer looks stuck), a **failure is readable in
  the header itself** without expanding the card, and the result says how many lines it carries
  before you open it.
- **El icono de la app es el de SAGITARI**, también en la barra de tareas. Comprobado en los
  binarios publicados: llevan los seis tamaños del icono de la app (16 a 256), no el de Electron.
  En desarrollo el proceso es `electron.exe`, así que ahí puede verse el de Electron: es del
  binario, no de la app. / **The app icon is SAGITARI's**, including in the taskbar. Verified on the
  published binaries: they carry all six sizes of the app icon (16 to 256), not Electron's. In
  development the process is `electron.exe`, so Electron's icon may show there: it belongs to the
  binary, not the app.

## Correcciones / Fixes

- **El navegador se cuelga 30 s por acción cuando su ventana no está delante.** Dos causas, las
  dos corregidas: una espera de pintado basada en `requestAnimationFrame` sin tope (Chromium no da
  frames a una ventana oculta, así que la promesa no se resolvía nunca) y el congelado por oclusión
  de Windows. Se arregla con los flags de automatización (`--disable-backgrounding-occluded-windows`,
  `--disable-renderer-backgrounding`, `--disable-background-timer-throttling`,
  `--disable-features=CalculateNativeWinOcclusion`) y con esperas que siempre cierran. La batería
  contra un Chrome real pasa entera en el escenario que antes fallaba. / **The browser hangs 30 s
  per action when its window is not in front.** Two causes, both fixed: a paint wait built on
  `requestAnimationFrame` with no cap (Chromium gives no frames to an occluded window, so the
  promise never resolved) and Windows' occlusion freezing. Fixed with the standard automation flags
  and with waits that always close. The suite against a real Chrome now passes fully in the
  scenario that used to fail.
- **El ciclo «prueba → falla → arreglo → repito» repetía de verdad.** El contador de intentos
  nacía sin inicializar (`undefined++` es `NaN`, y `NaN >= tope` siempre es falso), así que el tope
  no existía y la comprobación no se repetía tras un arreglo: el turno se cerraba creyendo que
  estaba comprobado. / **The “test → fail → fix → retry” cycle really retries.** The attempt counter
  was born uninitialised, so the cap did not exist and the check was not repeated after a fix.
- **Las reglas de un proyecto no entran dos veces.** En Windows `SAGITARI.md` y `sagitari.md` son el
  mismo archivo: ahora se deduplica por ruta real (antes el texto iba duplicado al prompt). / **A
  project's rules do not enter twice.** On Windows `SAGITARI.md` and `sagitari.md` are the same file:
  it is now deduplicated by real path.
- **La búsqueda exacta ya no se queda muda.** Sin ruta explícita, y con la entrada estándar siendo
  un tubo, ripgrep esperaba a que se cerrara en vez de buscar; y fuera de un repositorio de git no
  aplicaba el `.gitignore`, así que devolvía lo que el usuario tiene mandado ignorar. / **Exact
  search is no longer mute.** Without an explicit path, and with standard input being a pipe,
  ripgrep waited for it to close instead of searching; and outside a git repository it did not apply
  `.gitignore`.
- **`latest.yml` firmaba solo el instalador** (arreglado en la 3.2.2 y con verificación propia en
  el CI desde entonces). / **`latest.yml` only signed the installer** (fixed in 3.2.2, with its own
  CI verification since then).

---

# SAGITARI 3.2.2

**El portable ya puede actualizarse solo.** La app verifica cada descarga contra la firma
publicada en la release, y ese manifiesto (`latest.yml`) solo llevaba la firma del **instalador**:
quien usaba el portable descargaba los 110 MB y los veía desaparecer con un «no se pudo verificar la
descarga», sin manera de avanzar. Ahora la release publica la firma de **los dos** binarios, y el
CI **se niega a publicar** si alguno se queda sin firmar, así que no puede repetirse. / **The
portable can update itself now.** The app verifies every download against the signature published in
the release, and that manifest (`latest.yml`) only carried the **installer's** signature: portable
users downloaded 110 MB and watched them vanish with a “the download could not be verified”, with no
way forward. The release now publishes the signature of **both** binaries, and CI **refuses to
publish** if any of them is unsigned, so it cannot happen again.

> **Si vienes de la 3.1.1 o de cualquier versión anterior y usas la edición INSTALADA, este salto
> hay que hacerlo a mano UNA vez** —descarga el instalador de esta página y ejecútalo—, porque
> esas versiones llevan el lanzador del instalador roto (corregido en la 3.2.1). Si usas el
> **portable**, no hace falta: descarga el portable nuevo y sustitúyelo. / **If you are on 3.1.1 or
> any earlier version and you use the INSTALLED edition, you have to take this step by hand ONCE**
> —download the installer from this page and run it— because those versions carry the broken
> installer launcher (fixed in 3.2.1). If you use the **portable**, you do not need to: download
> the new portable and replace it.

## Correcciones / Fixes

- **La release firma todos sus binarios, no solo el instalador.** El `latest.yml` que genera
  electron-builder describe únicamente el Setup, así que el portable no tenía ninguna firma contra
  la que compararse y la app lo descartaba por seguridad —correctamente, pero sin salida—. El
  workflow ahora completa el manifiesto con la firma sha512 de **cada** `.exe` del `dist/` antes de
  publicar, y usa para ello **el mismo lector que la app** (`main/updater.js`): lo que se publica es
  exactamente lo que la app va a ver. / **The release signs all its binaries, not just the
  installer.** The `latest.yml` electron-builder generates only describes the Setup, so the portable
  had no signature to compare against and the app discarded it for safety —correctly, but with no
  way out—. The workflow now completes the manifest with the sha512 of **every** `.exe` in `dist/`
  before publishing, using **the same reader as the app** (`main/updater.js`): what is published is
  exactly what the app will look at.
- **Y no se publica a medias: el CI lo comprueba.** Antes de subir nada, el workflow verifica que
  cada binario tenga su firma en el manifiesto **y que esa firma sea la del binario** (no la de
  otro); si algo falla, la release no sale. Es el mismo gate que hoy habría parado la 3.2.1. /
  **And nothing ships half-signed: CI checks it.** Before uploading anything, the workflow verifies
  that every binary has its signature in the manifest **and that the signature is that binary's**
  (not another one's); if anything fails, the release does not go out. It is the same gate that
  would have stopped 3.2.1 today.
- **Cuando algo no se puede verificar, la app lo dice de verdad.** El aviso era «la release no
  publica latest.yml» aunque el manifiesto existiera: ahora distingue si falta el manifiesto, si no
  se pudo leer o si la release no firma **ese** archivo (con su nombre), y añade el enlace de la
  release para instalarlo a mano, así que el usuario nunca se queda en un «no se pudo descargar» sin
  saber qué hacer. / **When something cannot be verified, the app now says the truth.** The message
  used to be “the release does not publish latest.yml” even when the manifest existed: it now
  distinguishes whether the manifest is missing, could not be read, or does not sign **that** file
  (naming it), and adds the release link to install it by hand, so the user is never left with a
  “could not download” and nothing to do.

## Cómo viene probado / How it is tested

- **335 pruebas en verde**, dos nuevas: el manifiesto se completa de verdad en una carpeta de
  prueba (firma correcta de cada binario, el hash superior sigue siendo el del Setup, idempotente y
  corrige una firma equivocada) y el gate del CI **falla** si un binario se queda sin firma —la
  regresión exacta de la 3.2.1—. / **335 tests green**, two new: the manifest is really completed in
  a test folder (each binary's correct signature, the top-level hash still the Setup's, idempotent,
  and it fixes a wrong signature) and the CI gate **fails** when a binary is left unsigned —the exact
  3.2.1 regression—.
- Y el texto que ve el usuario cuando una descarga no se puede verificar, con sus cuatro casos. /
  And the message the user sees when a download cannot be verified, with its four cases.

# SAGITARI 3.2.1

**La actualización ya se instala de verdad.** Hasta ahora, pulsar **Cerrar e instalar** cerraba la
app, abría una ventana de terminal, la cerraba y no instalaba nada: al volver a abrir seguías en la
versión vieja. El motivo era una única orden de `cmd.exe` que **no llegaba a lanzar el instalador
nunca** —comprobado con un señuelo, que jamás se ejecutaba—, así que lo único que se veía era la
ventana de consola de un proceso «separado» en Windows. Ahora el instalador lo arranca un
**asistente oculto** que espera a que no quede ninguna instancia de la app y luego actualiza en
silencio, sin ventanas de por medio; y si una instalación se queda a medias, **el siguiente arranque
te lo cuenta y te deja reintentarla**. / **Updates actually install now.** Until now, pressing
**Close and install** closed the app, opened a terminal window, closed it, and installed nothing: on
reopening you were still on the old version. The cause was a single `cmd.exe` command that **never
reached the installer at all** —verified with a decoy, which was never executed—, so all you saw was
the console window of a “detached” process on Windows. The installer is now launched by a **hidden
helper** that waits until no instance of the app is left and then updates silently, with no windows
in between; and if an installation is left half-done, **the next launch tells you and lets you retry**.

> **Si vienes de la 3.2.0 o de cualquier versión anterior, este salto hay que hacerlo a mano UNA
> vez** —descarga el instalador de esta página y ejecútalo—, porque esas versiones llevan el
> lanzamiento roto y no pueden instalarse solas la corrección. A partir de ahí, el actualizador de
> la app ya funciona. / **If you are on 3.2.0 or any earlier version, you have to take this step by
> hand ONCE** —download the installer from this page and run it— because those versions carry the
> broken launcher and cannot install the fix on their own. From then on, the in-app updater works.

## Correcciones / Fixes

- **«Cerrar e instalar» ya no se queda en nada.** El instalador lo lanza un guion de PowerShell
  **oculto** que viaja en `-EncodedCommand` (base64 de UTF-16LE), así que la ruta del instalador es
  texto y no una línea de órdenes que analizar: una ruta con espacios, `&`, `/` o `%` deja de ser un
  problema, y se acabó la ventana de terminal. El asistente deja su diario en
  `%TEMP%\sagitari-update\instalar.log`. / **“Close and install” no longer does nothing.** The
  installer is launched by a **hidden** PowerShell script that travels in `-EncodedCommand`
  (UTF-16LE base64), so the installer path is text rather than a command line to be parsed: a path
  with spaces, `&`, `/` or `%` is no longer a problem, and the terminal window is gone. The helper
  keeps its log in `%TEMP%\sagitari-update\instalar.log`.
- **Se espera a que la app esté cerrada de verdad, no un margen adivinado.** El asistente espera
  (hasta 90 s, sondeo cada 400 ms) a que no quede ninguna instancia de SAGITARI y da 1,2 s de gracia
  al disco antes de lanzar el Setup con `/S --updated`. Sin esto, el instalador —que decide si hay
  una app en ejecución mirando su proceso PADRE, que era SAGITARI.exe— se saltaba su comprobación y
  se quedaba a medias con los ficheros en uso. / **It waits for the app to be really closed, not for
  a guessed margin.** The helper waits (up to 90 s, polling every 400 ms) until no SAGITARI instance
  is left and gives the disk a 1.2 s grace period before launching the Setup with `/S --updated`.
  Without it, the installer —which decides whether an app is running by looking at its PARENT
  process, which was SAGITARI.exe— skipped its check and stopped halfway with the files in use.
- **La app no se cierra si el asistente no puede arrancar.** Antes de cerrarse se comprueba que el
  ayudante sigue vivo: si muere en el primer segundo (sin PowerShell, o bloqueado por política), la
  app **sigue abierta** y te dice por qué, en vez de dejarte cerrado y sin nada instalado. / **The
  app no longer closes if the helper cannot start.** Before quitting, the app checks that the helper
  is alive: if it dies within the first second (no PowerShell, or blocked by policy), the app **stays
  open** and tells you why, instead of closing on you with nothing installed.
- **Una instalación a medias deja de ser invisible.** Como para instalar hay que cerrar la app, en
  el momento del fallo no hay a quién contárselo: el intento se anota en disco y el arranque
  siguiente, si sigues en la versión vieja, te avisa con un aviso discreto, deja el punto en Ajustes
  y ofrece **Reintentar la instalación** en **Ajustes ▸ Acerca de** (vuelve a comprobar el SHA-512
  publicado antes de relanzarla). Si el archivo descargado ya no está, la tarjeta invita a
  descargarla otra vez en vez de ofrecer un fantasma. / **A half-done installation is no longer
  invisible.** Since installing requires closing the app, at the moment of failure there is nobody
  to tell: the attempt is written to disk and, on the next launch, if you are still on the old
  version, you get an unobtrusive notice, a dot in Settings, and a **Retry the installation** button
  in **Settings ▸ About** (it re-checks the published SHA-512 before relaunching). If the downloaded
  file is gone, the card invites you to download it again instead of offering a ghost.

## Cómo viene probado / How it is tested

- El lanzamiento real se prueba **ejecutando el asistente de verdad** contra un señuelo, que ahora
  sí recibe `/S --updated` y deja su diario: el fallo original queda cubierto para que no vuelva.
  Con el guion y su escapado, el estado pendiente y sus cuatro casos, **333 pruebas en verde**. /
  The real launch is tested by **running the actual helper** against a decoy, which now does receive
  `/S --updated` and writes its log: the original failure is covered so it cannot come back. With
  the script and its escaping, the pending state and its four cases, **333 tests green**.
- En la interfaz, dos comprobaciones nuevas: la tarjeta de Ajustes pinta una instalación a medias
  con su botón **Reintentar la instalación**, y si el archivo ya no está invita a descargarla. /
  In the UI, two new checks: the Settings card renders a half-done installation with its **Retry the
  installation** button, and if the file is gone it invites you to download it again.

# SAGITARI 3.2.0

**SAGITARI deja de trabajar «a ciegas»: ahora maneja el navegador como una persona, revisa lo
que escribe y reparte el trabajo en paralelo.** Esta versión es la de la fiabilidad. El
**navegador** pasa a la versión 2 —nombres accesibles en lugar de texto invisible, componentes
web e iframes, clics que no caen donde no deben, esperas de verdad, consola y errores de red,
diálogos, subida de archivos y atajos de teclado—, el agente **comprueba el código al
escribirlo** y **un revisor lee el cambio** antes de dártelo por hecho, y las órdenes de un
mismo mensaje se ejecutan **a la vez** con un bloqueo por recurso (el navegador es uno solo, la
escritura va en cola) para que las tareas largas dejen de durar la suma de sus pasos. Y todo
eso en la interfaz: razonamiento visible opcional, tablero del equipo en vivo, separador de día
y tarjetas de herramienta que dicen qué pasó. / **SAGITARI stops working blind: it now drives
the browser like a person, reviews what it writes, and spreads work in parallel.** This is the
reliability release. The **browser** moves to v2 —accessible names instead of invisible text,
web components and iframes, clicks that never land in the wrong place, real waits, console and
network errors, dialogs, file uploads and keyboard shortcuts—, the agent **checks code as it
writes it** and **a reviewer reads the change** before handing it to you, and the orders inside
one message run **at the same time** behind a per-resource lock (there is only one browser; disk
writes queue up) so long tasks stop taking the sum of their steps. All of it visible in the UI:
optional reasoning, a live team board, a day separator, and tool cards that say what happened.

## Navegador 2 / Browser v2

- **El inventario dice el nombre REAL de cada control.** Antes se usaba el texto del elemento:
  un botón de icono salía con nombre vacío y el agente pulsaba por coordenadas a ciegas. Ahora
  se calcula el nombre accesible (`aria-label`, `aria-labelledby`, `<label for>`, `alt`,
  `title`, `placeholder`, `data-testid`, `value` de un submit), con su rol, su estado
  (deshabilitado, marcado, valor actual, obligatorio) y su `data-testid`, que es la forma en
  que las webs hechas para automatizar se identifican. / **The inventory reports the REAL name
  of every control.** It used to use the element's text, so an icon-only button came out with an
  empty name and the agent clicked by coordinates, blind. Now the accessible name is computed
  (`aria-label`, `aria-labelledby`, `<label for>`, `alt`, `title`, `placeholder`,
  `data-testid`, submit `value`), together with its role, its state (disabled, checked, current
  value, required) and its `data-testid`, which is how automation-friendly sites identify
  themselves.
- **Componentes web e iframes del mismo origen.** Shadow DOM y marcos eran invisibles: media
  interfaz moderna (editores, reproductores, formularios embebidos) no existía para el agente.
  Ahora se recorren, y cada elemento dice en qué marco está. / **Web components and same-origin
  iframes.** Shadow DOM and frames were invisible: much of the modern web (editors, players,
  embedded forms) simply did not exist for the agent. Now they are walked, and each element
  says which frame it lives in.
- **Los clics ya no caen donde no deben.** Antes de pulsar se vuelve a localizar el elemento
  **por su huella** (no por la posición que tenía), se comprueba que ha dejado de moverse y que
  **nadie lo tapa**; si algo lo tapa, el error dice QUÉ lo tapa, y si de verdad hay que pulsarlo
  (un aviso de cookies pegado encima), `force` lo hace. Lo que está por debajo del pliegue se
  marca como «fuera de pantalla» y se trae a la vista al clicar, en vez de obligar al modelo a
  adivinar el scroll. / **Clicks no longer land in the wrong place.** Before pressing, the
  element is located again **by its fingerprint** (not by the position it had), it is checked
  that it stopped moving and that **nothing covers it**; if something does, the error says WHAT
  covers it, and if it truly must be pressed (a cookie banner stuck on top), `force` does it.
  Anything below the fold is flagged as “off screen” and scrolled into view when clicked,
  instead of forcing the model to guess the scroll.
- **Esperar sin dormir.** `wait_for` espera a que aparezca un texto, un selector, un título o
  una URL —o a que desaparezca algo—, con tiempo límite, y si no llega explica en qué estado
  quedó la página en vez de seguir como si nada. / **Waiting without sleeping.** `wait_for`
  waits for a text, selector, title or URL to appear —or for something to disappear—, with a
  deadline, and if it never comes it explains the state the page was left in instead of carrying
  on as if nothing had happened.
- **Se puede depurar la web que el propio agente abre.** `logs` devuelve la consola, las
  excepciones, las peticiones que fallaron (404/500) y las descargas; los diálogos de la página
  (`alert`, `confirm`, `prompt`) se detectan, se avisan en el resultado y se contestan con
  `dialog` en vez de dejar la página pausada y el turno colgado. / **You can debug the site the
  agent itself opens.** `logs` returns console output, exceptions, failed requests (404/500) and
  downloads; page dialogs (`alert`, `confirm`, `prompt`) are detected, announced in the result
  and answered with `dialog` instead of leaving the page paused and the turn hanging.
- **Actuar como una persona.** `select` (opción por valor, texto o posición), `check` para
  casillas, `hover` para menús, `hotkey` para atajos (`Ctrl+Shift+T`, `Alt+ArrowLeft`…), `upload`
  para subir archivos, `back`/`forward`/`reload` sobre el historial real, captura de un elemento
  concreto y descargas guardadas en una carpeta conocida que se dice en el resultado. `type`
  escribe tecla a tecla en textos cortos (las webs que validan al escribir no ven el pegado) y
  **devuelve lo que quedó escrito**: si el sitio recortó por `maxlength` o una máscara, lo dices
  tú y no lo descubre tres pasos después. / **Acting like a person.** `select` (option by value,
  text or position), `check` for boxes, `hover` for menus, `hotkey` for shortcuts
  (`Ctrl+Shift+T`, `Alt+ArrowLeft`…), `upload` for files, `back`/`forward`/`reload` on the real
  history, screenshots of a single element, and downloads saved to a known folder that is
  reported in the result. `type` types key by key for short texts (sites that validate as you
  type never see a paste) and **returns what ended up in the field**: if the site trimmed it via
  `maxlength` or a mask, you hear it right away instead of three steps later.
- **Subir un archivo y aceptar un diálogo piden permiso siempre.** Lo primero manda datos tuyos
  a una web y lo segundo puede confirmar algo destructivo: ninguna de las dos se hace sin
  preguntar. / **Uploading a file and accepting a dialog always ask for permission.** The first
  sends your data to a website and the second can confirm something destructive: neither happens
  without asking.

## Trabajo en paralelo y por recursos / Parallel work and resource locks

- **Las órdenes de un mismo mensaje se ejecutan a la vez.** Si el modelo pide tres lecturas, dos
  investigaciones o un comando y una captura, ya no van una detrás de otra: salen en paralelo
  (hasta 3 por defecto, ajustable de 1 a 4 en Ajustes ▸ Delegación y verificación) y los
  resultados vuelven al modelo en el orden que pidió. / **Orders in the same message run
  together.** If the model asks for three reads, two investigations or a command plus a
  screenshot, they no longer run one after another: they go in parallel (3 by default, adjustable
  from 1 to 4 in Settings ▸ Delegation and verification) and results come back to the model in
  the order it asked.
- **Bloqueo por recurso, para que el paralelismo no rompa nada.** Hay cosas que no se pueden
  compartir: el navegador es **una sola instancia** (dos clics a la vez se pisan la pestaña y el
  inventario de elementos), la **escritura** en disco va en cola y la **terminal** admite dos
  comandos a la vez. Lo que no choca no espera: leer un archivo no bloquea a quien escribe. Y el
  orden de adquisición es canónico, así que no hay interbloqueos. / **Per-resource locks, so
  parallelism breaks nothing.** Some things cannot be shared: there is only **one browser
  instance** (two clicks at once trip over the active tab and the element inventory), **disk
  writes** queue up, and the **terminal** takes two commands at once. What does not collide does
  not wait: reading a file never blocks whoever is writing. Acquisition order is canonical, so
  there are no deadlocks.
- **Detener mata TODO lo que esté en vuelo.** Antes solo alcanzaba a la herramienta actual;
  ahora mueren las que estén corriendo a la vez y también los subagentes en paralelo. Y lo que
  aún esperaba su turno de recurso **ya no se ejecuta después de la parada** (el semáforo no
  sabe nada del abort: hasta dos clics encolados detrás del navegador salían con la app ya
  detenida). / **Stop kills EVERYTHING in flight.** It used to reach only the current tool; now
  it takes down the ones running side by side and the parallel subagents too. And whatever was
  still waiting for its resource turn **no longer runs after the stop** (the semaphore knows
  nothing about the abort: up to two clicks queued behind the browser used to go off with the
  app already stopped).

## El código sale con red / Code ships with a safety net

- **Sabe cómo se comprueba TU proyecto.** Detecta con qué se ejecutan los tests, la compilación
  y el lint (Node con su gestor por fichero de bloqueo, Python, Rust, Go, .NET…) y lo pone en el
  prompt, del orquestador y de cada subagente; solo nombra los comandos que existen. / **It knows
  how YOUR project is verified.** It detects what runs tests, builds and lint (Node with its
  lockfile package manager, Python, Rust, Go, .NET…) and puts it in the prompt, for the
  orchestrator and for every subagent; it only names commands that exist.
- **La sintaxis se comprueba al escribir.** Cada archivo escrito o editado se valida al
  instante: si no compila, el error vuelve en el mismo paso —cuando el modelo aún tiene el
  contexto— y la tarjeta se marca en rojo en vez de dar el cambio por bueno. / **Syntax is
  checked as it writes.** Every written or edited file is validated immediately: if it does not
  compile, the error comes back in the same step —while the model still has the context— and the
  card turns red instead of calling the change done.
- **Un revisor lee el cambio antes de cerrar.** El turno guarda el diff de lo modificado
  (también lo que tocaron los subagentes), y antes de dártelo por hecho un agente de revisión
  busca contratos rotos, casos límite y restos del nombre viejo; el hallazgo bloqueante se
  arregla en ese mismo turno. Va en la **misma ronda** que la verificación del resultado, para
  que dos comprobaciones cuesten una vuelta y no dos. Se apaga en Ajustes ▸ Delegación y
  verificación. / **A reviewer reads the change before closing.** The turn keeps the diff of
  everything modified (including what subagents touched), and before handing it to you a review
  agent looks for broken contracts, missed edge cases and leftovers of the old name; a blocking
  finding is fixed in that same turn. It rides in the **same round** as result verification, so
  two checks cost one extra round instead of two. Turn it off in Settings ▸ Delegation and
  verification.
- **Ediciones de varios archivos, atómicas.** `apply_patch` comprueba todos los anclajes y solo
  entonces escribe: o entran todos los archivos o no entra ninguno (antes, un refactor de cinco
  archivos podía dejar el proyecto a medias). / **Multi-file edits, atomic.** `apply_patch`
  checks every anchor and only then writes: either all files go in or none does (before, a
  five-file refactor could leave the project half-done).
- **Mapa del proyecto para no leer a ciegas.** `repo_map` y `find_symbol` indexan archivos y
  símbolos (sin `node_modules`, binarios ni archivos enormes): «¿qué hay aquí?» y «¿dónde se
  define X?» se responden sin abrir nada. / **Project map instead of blind reading.**
  `repo_map` and `find_symbol` index files and symbols (no `node_modules`, binaries or huge
  files): “what is in here?” and “where is X defined?” are answered without opening anything.

## Agente, equipo e interfaz / Agent, team and UI

- **Razonamiento visible (opcional).** Los modelos que razonan enseñan su proceso en un bloque
  plegable sobre la respuesta; se lee en vivo, se pliega al empezar a contestar y no ensucia al
  copiar. Ajustes ▸ Agente. / **Optional visible reasoning.**
  Reasoning models show their process in a collapsible block above the answer; it streams live,
  folds when the answer starts and stays out of copied text.
  Settings ▸ Agent.
- **Tablero del equipo en el chat.** Cada delegación se ve **en vivo** con su subtarea y su
  criterio, se resuelve con OK, «a medias» o fallo, y al acabar queda su tarjeta con resultado,
  detalles, evidencia y duración. / **Live team board in the chat.** Every delegation is visible
  **while it runs**, with its subtask and success criterion, resolves to OK, partial or failed,
  and leaves a card with result, details, evidence and duration.
- **Skills dentro de cada agente.** Cada subagente recibe el índice de las skills de su
  especialidad y las carga solo cuando le hacen falta; su método de trabajo y lo que debe
  entregar ya no son genéricos. / **Skills inside every agent.** Each subagent gets the index of
  the skills for its specialty and loads them only when needed; its working method and its
  deliverable are no longer generic.
- **La interfaz dice qué pasó.** Separador de día real (no una marca entre cada pregunta y su
  respuesta), cabecera del grupo de herramientas con cuántas van en curso y si algo falló, y
  plegado automático del detalle al llegar la respuesta. / **The UI says what happened.** A real
  day separator (not a stamp between every question and its answer), a tool-group header showing
  how many are running and whether anything failed, and automatic folding of the details once
  the answer arrives.

## Coste y estabilidad / Cost and stability

- **Menos lecturas y menos tokens por turno.** El índice de skills y el mapa del proyecto se
  sirven de memoria (invalidados al escribir) en vez de releerse del disco en cada paso, y
  `use_skill` no vuelve a mandar el cuerpo entero de una skill ya cargada en el turno. / **Fewer
  reads and fewer tokens per turn.** The skills index and the project map are served from memory
  (invalidated on write) instead of being re-read from disk at every step, and `use_skill` no
  longer resends the full body of a skill already loaded in the turn.
- **Prompt pensado para la caché.** Lo estable (identidad, reglas, proyecto, mapa) va primero y
  lo volátil (memoria, hábitos, skills sugeridas) al final, para que el prefijo se reutilice en
  proveedores con caché de prompt. / **Cache-friendly prompt.** Stable content (identity, rules,
  project, map) goes first and volatile content (memory, habits, suggested skills) last, so the
  prefix is reused on providers with prompt caching.
- **Un subagente ya no muere por un fallo del proveedor.** Hereda la cadena de modelos: si el
  primero devuelve un 500, sigue con el siguiente en vez de tirar treinta pasos de trabajo. / **A
  subagent no longer dies on a provider hiccup.** It inherits the model chain: if the first one
  returns a 500, it moves to the next instead of throwing away thirty steps of work.
- **Frenos explícitos.** Tope de subagentes por turno (configurable, con aviso claro y sin cortar
  la tarea), tope de llamadas, detección de bucle y de estancamiento, y un resumen rodante que
  conserva lo importante de hilos largos en vez de cortar el principio en seco. / **Explicit
  brakes.** A per-turn subagent cap (configurable, clearly announced, never cutting the task),
  a tool-call cap, loop and stall detection, and a rolling summary that keeps what matters from
  long threads instead of cutting the beginning off.

## Comprobado antes de publicar / Verified before publishing

- **330 tests unitarios**, la comprobación de interfaz sobre la app viva (iconos, cableado,
  navegación, delegación, razonamiento, revisión del cambio) y el arranque real de la app. / **330
  unit tests**, the UI check against the live app (icons, wiring, navigation, delegation,
  reasoning, change review) and a real app launch.
- **Y el navegador, contra un navegador de verdad**: 29 comprobaciones en un Chrome real con una
  página de prueba que incluye componentes web, iframes, un botón tapado, uno fuera de pantalla,
  un `confirm()` y errores de consola —`npm run navcheck`—. / **And the browser tool, against a
  real browser**: 29 checks in a real Chrome with a test page that includes web components,
  iframes, a covered button, an off-screen one, a `confirm()` and console errors — `npm run
navcheck`.

# SAGITARI 3.1.1

## Correcciones / Fixes

- **Los servidores MCP locales funcionan sin tener Node.js instalado.** Un servidor con
  `"command": "node"` —lo que traen los ajustes importados de otros clientes— moría con un
  «spawn node ENOENT» en cualquier equipo sin Node. Ahora se usa el Node del equipo si existe
  y, si no, el que la propia app lleva dentro; y si el comando es `npx`/`npm`, que sí necesitan
  una instalación real, se dice qué falta y cómo resolverlo en vez de fallar dentro de cmd.exe.
  / **Local MCP servers work without Node.js installed.** A server with `"command": "node"`
  —what imported settings from other clients contain— died with a “spawn node ENOENT” on any
  machine without Node. Now the machine's Node is used when it exists and otherwise the one
  the app itself carries; and if the command is `npx`/`npm`, which do need a real install, the
  app says what is missing and how to fix it instead of failing inside cmd.exe.

# SAGITARI 3.1.0

**Conecta tus propios servidores MCP.** Esta versión trae la integración de MCP y una tanda
de correcciones de fondo. Añade tus propios servidores —comandos locales o URLs remotas— para
que el agente use sus herramientas como las de casa: mismo catálogo, mismas confirmaciones,
mismos guardarraíles. / **Plug in your own MCP servers.** This version brings MCP integration
plus a round of deep fixes. Add your own servers —local commands or remote URLs— so the agent
uses their tools like its own: same catalog, same confirmations, same guardrails.

## Servidores MCP / MCP servers

- **Cliente MCP propio, sin dependencias nuevas.** Transporte `stdio` (procesos locales) y HTTP
  remoto con streaming y SSE, con validación de URL, sesión y errores legibles. / **Own MCP
  client, no new dependencies.** `stdio` transport (local processes) and remote HTTP with
  streaming and SSE, with URL validation, session handling and readable errors.
- **Las herramientas MCP son herramientas de casa.** Aparecen en el catálogo como las nativas
  (`mcp__servidor__herramienta`), con su tarjeta de confirmación, su resultado en el registro y
  su coste de pasos igual que cualquier otra. No hay vía lateral: si el motor de permisos no la
  ve, no se ejecuta. / **MCP tools are first-class tools.** They show up in the catalog like the
  native ones (`mcp__server__tool`), with their confirmation card, their result in the log and
  their step cost like any other. There is no side door: if the permission engine does not see
  it, it does not run.
- **Permiso explícito por defecto, con niveles.** Cada llamada pide confirmación salvo que tú
  subas la confianza de un servidor o de una herramienta concreta, y el interruptor global
  apaga también las herramientas que se le ofrecen al modelo. / **Explicit permission by
  default, with levels.** Every call asks for confirmation unless you raise the trust for a
  server or a specific tool, and the global switch also removes those tools from the model's
  catalog.
- **Ajustes › MCP:** lista con el estado de cada servidor, formulario guiado, botón **Probar**
  (conecta y lista sus herramientas de verdad), registro por servidor, importar/exportar el
  bloque `mcpServers` de otros clientes y reconexión al reencender. / **Settings › MCP:** list
  with each server's state, guided form, **Test** button (really connects and lists its tools),
  per-server log, import/export of the `mcpServers` block from other clients and reconnect on
  re-enable.
- **Credenciales cifradas con DPAPI**, como las claves de API, y **Detener** corta una llamada
  MCP en vuelo. / **Credentials encrypted with DPAPI**, like API keys, and **Stop** cancels an
  in-flight MCP call.

## Correcciones y dureza / Fixes and hardening

- **Un guardarraíl podía inutilizar la sesión** y una lectura SSE incompleta tiraba respuestas
  enteras: ambos corregidos, con la confirmación de clics por índice y el estado compartido del
  navegador arreglados. / **A guardrail could make the session unusable** and an incomplete SSE
  read dropped whole answers: both fixed, along with click confirmation by index and the shared
  browser state.
- **No se pierden conversaciones ni claves** al cerrar el turno o la app, y el sistema de
  adjuntos es un módulo probado. / **Conversations and keys are no longer lost** when a turn or
  the app closes, and attachments are now a tested module.
- **El modelo que eliges manda.** El router ya no rellena por categoría en silencio, y un
  proveedor que acepta la conexión pero deja de enviar datos corta el turno solo con un error
  legible y un botón **Reintentar**. / **The model you choose wins.** The router no longer fills
  in by category behind your back, and a provider that accepts the connection but stops sending
  data cuts the turn off by itself with a readable error and a **Retry** button.
- **El navegador espera a que la página cargue de verdad** (se habilita el dominio `Page` y se
  espera al compromiso de la navegación), en vez de dar por cargada una página a medias. /
  **The browser waits for the page to actually load** (the `Page` domain is enabled and it waits
  for the navigation commit) instead of calling a half-loaded page ready.
- **Verificación más honesta:** la suite de tests es determinista y no toca tus datos reales, la
  comprobación de interfaz tiene límite de tiempo y el smoke test da un veredicto real. 268
  comprobaciones unitarias más la comprobación sobre la app viva pasan antes de publicar. /
  **More honest verification:** the test suite is deterministic and never touches your real data,
  the UI check has a deadline and the smoke test gives a real verdict. 268 unit checks plus the
  live-app check pass before publishing.

## Descargas / Downloads

| Archivo / File                | Descripción / Description                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `SAGITARI-Setup-3.1.0.exe`    | **Instalador / Installer** (NSIS): accesos directos, desinstalador / shortcuts, uninstaller |
| `SAGITARI-Portable-3.1.0.exe` | **Portable**: un solo ejecutable, sin instalación / single executable, no install           |
| `Source code (zip/tar.gz)`    | Código fuente / Source code                                                                 |

> Binario sin firmar: Windows SmartScreen puede avisar en la primera ejecución (_Más información → Ejecutar de todas formas_). La app te dice si la actualización que descarga está firmada o no. / Unsigned binary: SmartScreen may warn on first run (_More info → Run anyway_). The app tells you whether the update it downloads is signed.

# SAGITARI 3.0.1

**El router respeta tu modelo elegido y los proveedores mudos no cuelgan el chat.** La cadena de
fallback reelegía modelo por categoría en cada turno: con mimo-v2.5 seleccionado, una petición
«simple» viajaba a deepseek-flash y los fallos de ese modelo parecían «este modelo no funciona».
Y un proveedor que aceptaba la conexión sin enviar datos dejaba el turno «ocupado» para siempre,
ignorando todo lo que escribieras después. Ahora el modelo de Ajustes manda (el router solo rellena
cuando no hay elección explícita), el silencio del proveedor se corta solo a los ~2 min con error
legible y botón «Reintentar», y las tareas largas quedan recuperables si el modelo deja de mandar
datos. / **The router respects your chosen model and silent providers no longer hang the chat.**
The fallback chain re-picked a model per task category on every turn: with mimo-v2.5 selected, a
"simple" request went to deepseek-flash and that model's failures looked like "this model doesn't
work". And a provider that accepted the connection without sending data left the turn "busy"
forever, ignoring everything you typed next. The Settings model now wins (the router only fills in
when there is no explicit choice), provider silence cuts itself off after ~2 min with a readable
error and a Retry button, and long tasks stay recoverable if the model stops sending data.

## Descargas / Downloads

| Archivo / File                | Descripción / Description                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `SAGITARI-Setup-3.0.1.exe`    | **Instalador / Installer** (NSIS): accesos directos, desinstalador / shortcuts, uninstaller |
| `SAGITARI-Portable-3.0.1.exe` | **Portable**: un solo ejecutable, sin instalación / single executable, no install           |
| `Source code (zip/tar.gz)`    | Código fuente / Source code                                                                 |

> Binario sin firmar: Windows SmartScreen puede avisar en la primera ejecución (_Más información → Ejecutar de todas formas_). La app te dice si la actualización que descarga está firmada o no. / Unsigned binary: SmartScreen may warn on first run (_More info → Run anyway_). The app tells you whether the update it downloads is signed.

# SAGITARI 3.0.0

**Glow del marco corregido:** el aura vuelve a renderizarse de forma consistente, con un halo suave, visible y sin bloquear la interacción de la ventana. También se corrige la muestra de color del glow en Ajustes. / **Frame glow fixed:** the aura now renders consistently with a soft, visible halo without blocking window interaction. The glow color preview in Settings is fixed too.

**Seguridad y fiabilidad / Security and reliability:** se cierran dos vías que podían costar
caro (el borrado del directorio de datos desde una skill y la instalación de una actualización
sin verificar) y se corrigen los fallos que hacían perder trabajo: la pausa que no guardaba el
punto de control, el coste por modelo que siempre marcaba cero, las confirmaciones que se
quedaban colgadas y el navegador que quedaba inservible tras un cierre brusco. / **Security and
reliability:** two potentially expensive holes are closed (wiping the data directory from a
skill, and installing an unverified update) and the bugs that lost work are fixed: pause not
saving its checkpoint, per-model cost always reading zero, confirmations hanging and the
browser becoming unusable after a hard exit.

## Descargas / Downloads

| Archivo / File                | Descripción / Description                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `SAGITARI-Setup-3.0.0.exe`    | **Instalador / Installer** (NSIS): accesos directos, desinstalador / shortcuts, uninstaller |
| `SAGITARI-Portable-3.0.0.exe` | **Portable**: un solo ejecutable, sin instalación / single executable, no install           |
| `Source code (zip/tar.gz)`    | Código fuente / Source code                                                                 |

> Binario sin firmar: Windows SmartScreen puede avisar en la primera ejecución (_Más información → Ejecutar de todas formas_). La app te dice si la actualización que descarga está firmada o no. / Unsigned binary: SmartScreen may warn on first run (_More info → Run anyway_). The app tells you whether the update it downloads is signed.

## Seguridad / Security

- **Los ids de skill se validan resolviendo la ruta.** `deleteSkill('..')` podía resolver a la
  carpeta de datos y borrarla entera: configuración, claves de API y conversaciones incluidas. /
  **Skill ids are validated by resolving the path.** `deleteSkill('..')` could resolve to the
  data folder and wipe it whole: settings, API keys and conversations included.
- **`open_url` solo abre `http(s)`.** En Windows `shell.openExternal` invoca el manejador del
  sistema, así que `file://`, `ms-msdt:` o `javascript:` abrían cualquier cosa sin que lo vieras. /
  **`open_url` only opens `http(s)`.** On Windows `shell.openExternal` invokes the OS handler, so
  `file://`, `ms-msdt:` or `javascript:` could open anything without you seeing it.
- **Leer el portapapeles, ejecutar JS en la página y cambiar de perfil de navegador piden
  confirmación** aunque su herramienta esté configurada como automática. / **Reading the
  clipboard, running JS in the page and switching browser profiles always ask first**, even if
  their tool is set to run automatically.
- **Un subagente no puede usar herramientas fuera de su lista**, y una herramienta inventada por
  el modelo ya no llega a pedirte permiso. / **A subagent cannot use tools outside its list**,
  and a made-up tool no longer reaches you as a permission request.
- **Los triggers de una skill importada se tratan como texto, no como expresión regular**: un
  patrón remoto podía congelar la app en cada mensaje. / **Triggers from an imported skill are
  plain text, not a regular expression**: a remote pattern could freeze the app on every message.
- **El actualizador descarta cualquier descarga sin firma SHA-512 publicada** y vuelve a
  comprobar el hash justo antes de ejecutar el instalador. Además te dice si el binario tiene
  firma digital y quién lo firma. / **The updater discards any download without a published
  SHA-512** and re-checks the hash right before running the installer. It also tells you whether
  the binary is digitally signed and by whom.
- **Las claves de API se guardan cifradas** con el almacén del sistema (DPAPI en Windows). Un
  `config.json` copiado o sincronizado ya no expone tus credenciales. / **API keys are stored
  encrypted** with the system keychain (DPAPI on Windows). A copied or synced `config.json` no
  longer exposes your credentials.

## Correcciones / Fixes

- **Si el proveedor deja de enviar datos, el turno se corta solo y te lo dice.** Antes, un modelo
  que aceptaba la conexión y no mandaba nada dejaba el chat «ocupado» para siempre: lo que
  escribías después se ignoraba con «SAGITARI está ocupado» y había que adivinar que tocaba
  pulsar Detener. Ahora hay un límite de silencio configurable (Ajustes › Seguridad › «Sin
  respuesta del modelo») y, si una tarea larga atraviesa un hueco sin datos, el guardarraíl la
  detiene y queda recuperable en Tareas. / **If the provider stops sending data, the turn cuts
  itself off and tells you.** A model that accepted the connection and then went silent used to
  leave the chat "busy" forever: anything you typed next was ignored with "SAGITARI está ocupado"
  and you had to guess that Stop was the way out. There is now a configurable silence limit
  (Settings › Security › "No answer from the model"), and a long task crossing a data gap is
  stopped by the guardrail and stays recoverable in Tasks.
- **El router ya no cambia tu modelo elegido por otro en silencio.** La cadena de fallback
  reelegía modelo por categoría en cada turno: con p. ej. mimo-v2.5 seleccionado, una petición
  «simple» viajaba a deepseek-flash (coincidía con el patrón de modelos rápidos) y los fallos de
  ese modelo parecían «este modelo no funciona». Ahora el modelo elegido en Ajustes manda y el
  router solo rellena cuando no hay elección explícita. / **The router no longer swaps your
  chosen model silently.** The fallback chain re-picked a model per task category on every turn:
  with e.g. mimo-v2.5 selected, a "simple" request went to deepseek-flash (it matched the
  fast-model pattern) and that model's failures looked like "this model doesn't work". The model
  chosen in Settings now wins; the router only fills in when there is no explicit choice.
- **La firma digital del binario se informa aunque abras la app desde PowerShell 7.** Windows
  PowerShell 5.1 heredaba de ahí su lista de módulos, dejaba de encontrar
  `Get-AuthenticodeSignature` y la firma se informaba como «no se pudo consultar», justo el dato
  que te dice si lo que vas a instalar está firmado. / **The binary's digital signature is
  reported even if you open the app from PowerShell 7.** Windows PowerShell 5.1 inherited that
  process's module list, could no longer find `Get-AuthenticodeSignature` and reported the
  signature as "couldn't check" — the very fact that tells you whether what you are about to
  install is signed.
- **Pausar durante la respuesta guarda el punto de control.** Antes la tarea quedaba marcada como
  interrumpida y se perdía la reanudación. / **Pausing mid-answer saves the checkpoint.** The task
  used to be marked as interrupted and resumption was lost.
- **El panel de salud por modelo muestra el coste real**, que siempre aparecía como 0,0000. / **The
  per-model health panel shows the real cost**, which always read 0.0000.
- **Esperar tu decisión en una tarjeta de confirmación ya no agota el límite de duración**, y las
  confirmaciones de varias tareas en segundo plano se atienden en cola en vez de pisarse. / **Waiting
  for your answer on a confirmation card no longer eats the duration limit**, and confirmations
  from several background tasks queue up instead of overwriting each other.
- **Una confirmación ya no puede quedarse colgada** al repintarse la vista: la promesa se resuelve
  siempre. / **A confirmation can no longer hang** when the view is repainted: the promise always
  resolves.
- **Los argumentos ilegibles de una herramienta devuelven un error** en vez de ejecutarla con
  valores vacíos. / **Unreadable tool arguments return an error** instead of running the tool with
  empty values.
- **El navegador se recupera tras un cierre brusco de la app** (lee el puerto que dejó Chrome en
  el perfil) y ya no puede matar por error un proceso ajeno al cambiar de perfil. / **The browser
  recovers after a hard exit** (it reads the port Chrome left in the profile) and can no longer
  kill an unrelated process by mistake when switching profiles.
- **El botón Detener cancela también los procesos** de abrir aplicaciones, gestión de ventanas y
  multimedia, no solo los comandos de terminal. / **The Stop button also cancels** app-launching,
  window-management and media processes, not just terminal commands.
- **La carpeta de logs respeta sus topes**: dos fallos en la rotación (nombres repetidos y poda
  prematura) dejaban ficheros creciendo sin control. / **The logs folder respects its limits**: two
  rotation bugs (repeated names and premature pruning) let files grow unbounded.
- **Los puntos de estado vuelven a verse** (tareas falladas y salud del modelo), la búsqueda de
  Ajustes cuenta solo el panel visible, el plan no reinicia su progreso al repintarse y un fallo
  interno muestra un aviso en vez de una burbuja roja en el chat. / **Status dots are visible
  again** (failed tasks and model health), settings search only counts the visible panel, the plan
  no longer resets its progress when repainted, and an internal failure shows a notice instead of
  a red bubble in the chat.

## Actualizaciones / Updates

El actualizador integrado comprueba si hay versión nueva, avisa sin interrumpir, verifica la
descarga con **SHA-512** y, desde esta versión, **rechaza el archivo si la release no publica esa
firma** en lugar de instalarlo sin comprobar nada. También informa del estado de la firma digital
del binario y solo instala cuando tú lo pides. / The in-app updater checks for a new version,
notifies discreetly, verifies the download with **SHA-512** and, from this version on, **rejects
the file if the release does not publish that signature** instead of installing it unchecked. It
also reports the binary's digital signature status and installs only when you ask it to.

## Verificación / Verification

- `npm test`: **163 tests en verde** / **163 tests passing**, con regresiones para cada corrección de esta versión. / with regressions for every fix in this release.
- `npm run smoke`: la app arranca de verdad / the app really starts.
- `npm run uicheck`: 28 comprobaciones sobre la interfaz viva (iconos, cableado, navegación, modo,
  tamaño mínimo) — y ahora corre en la CI antes de publicar. / 28 checks against the live UI
  (icons, wiring, navigation, mode, minimum size) — and it now runs in CI before publishing.
- `node --check` de todos los módulos, y el tag de la release debe coincidir con la versión de
  `package.json` o el workflow aborta. / `node --check` on every module, and the release tag must
  match the `package.json` version or the workflow aborts.
- SHA-256 de los ejecutables calculado automáticamente por el workflow de CI al publicar. /
  Executable SHA-256 hashes computed automatically by the CI workflow when publishing.

## Requisitos / Requirements

- Windows 10/11 · Proveedor de IA compatible (OpenCode Go, OpenRouter, Groq, OpenAI,
  Anthropic, Ollama local, LM Studio…) · Node.js 20+ solo para compilar desde fuente. /
  Windows 10/11 · Compatible AI provider (OpenCode Go, OpenRouter, Groq, OpenAI, Anthropic,
  local Ollama, LM Studio…) · Node.js 20+ only to build from source.
