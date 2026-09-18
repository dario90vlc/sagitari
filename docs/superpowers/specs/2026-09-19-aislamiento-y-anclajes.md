# Aislamiento, seguridad de comandos y anclajes tolerantes (v3.0)

Fecha: 2026-09-19 · Versión: 3.3.0

Cierra el hueco **6** de la lista de siete («aislamiento») y la **propina del hueco 1**
(«edición tolerante a espacios»). Es el último bloque que quedaba del plan 2–7.

---

## 1. Aislamiento: un árbol de trabajo por subagente

### El problema

El semáforo de recursos ya serializaba las escrituras, así que dos herramientas no
tocaban el mismo archivo a la vez. Lo que no resolvía es el conflicto **semántico**:
con un solo árbol de trabajo, un subagente de código lee los archivos que otro
subagente está dejando a medias, y un refactor grande no se puede repartir de verdad
entre especialistas porque cada uno «ve» el trabajo incompleto del otro.

### La respuesta

`agent/arboles.js`: un **árbol de trabajo de git** por subagente que escribe
(`coding`, `file`). Cada uno ve el proyecto entero, escribe donde quiera, y al
terminar sus cambios vuelven al árbol del usuario **como un parche verificado**.

Ciclo de vida:

| Paso | Cómo |
|---|---|
| ¿Se puede? | `git rev-parse --is-inside-work-tree` + `rev-parse HEAD`. Sin git (o sin commits) se devuelve `null` y el subagente trabaja sobre el árbol compartido, exactamente como antes |
| Punto de partida | `git stash create` → un commit con el **estado real** del usuario (cambios sin commitear incluidos) sin tocar su rama ni su índice. Con el árbol limpio, `HEAD` |
| Los archivos sueltos | los que git no conoce se copian a mano (`ls-files --others --exclude-standard`) |
| Línea base | `git add -A` + commit **dentro del árbol**. Sin esto, los archivos sueltos del usuario aparecían en el parche final como «nuevos» y la fusión fallaba con `does not exist in index` |
| Trabajo | `settings.settings.workspace` del subagente apunta al árbol: sus herramientas, sus comprobadores, sus reglas y su mapa del proyecto son **los del árbol** |
| Fusión | `git diff --cached --binary <base>` → `git apply --check` → `git apply`. Si la comprobación falla, **no se aplica nada** |
| Limpieza | `git worktree remove --force` siempre; con conflicto se **conserva** el árbol para poder mirarlo |

### Por qué `--3way` está fuera a propósito

La primera versión usaba `git apply --3way`, y la prueba con un repositorio real
(dos fallos, los dos cazados por el arnés) demostró que es la herramienta
equivocada: `--3way` compara contra el **índice** del usuario, y como el usuario
tiene cambios sin preparar, la comparación es contra una versión antigua del archivo
y fallaba **siempre** con `does not match index`. `git apply` a secas compara contra
el archivo tal y como está en el disco, que es justo lo que hay que respetar; y si el
usuario lo tocó por medio, el contexto ya no cuadra y sale un conflicto honesto.

### Un conflicto no es un trabajo hecho

Si la fusión no entra, el texto que recibe el orquestador lo dice con esas palabras
(`FUSIÓN CON CONFLICTO: sus cambios NO se aplicaron…`) y con la ruta del árbol
conservado. Es justo el error que este trabajo viene a evitar: presentar como hecho
algo que no está en el proyecto.

### La fusión se puede deshacer

`fusionar` recibe un gancho `preparar(rels)` que agent.js usa para registrar la
pre-imagen de cada archivo **antes** de aplicar (el mismo `cambios.recordar` del
deshacer). Fusionar y luego arrepentirse funciona como cualquier otro cambio del
turno.

### Ajuste

**Ajustes ▸ Agente ▸ Aislar a los subagentes que escriben** (activo por defecto,
`arbolesAislados`). Apagarlo devuelve el comportamiento anterior: escriben directo
sobre el proyecto.

---

## 2. Seguridad de los comandos

### El problema

`run_command` tenía **un** nivel de riesgo: el de la herramienta entera. El usuario
que la ponía en «safe» —o que aprobaba una vez un comando— autorizaba por igual
`git status` y `format C:`. El nivel se decidía por **quién** ejecuta, nunca por
**qué** se ejecuta.

### Los tres escalones (`agent/comandos.js`, lógica pura)

| Escalón | Qué hace | Ejemplos |
|---|---|---|
| `normal` | lo decide el nivel de la herramienta, como siempre | `git status`, `npm test`, `dir`, `node --version` |
| `sensible` | exige confirmación **siempre**, aunque `run_command` esté en «safe» | `git push --force`, `git reset --hard`, `npm publish`, `npm i -g`, `rm -rf`, `del /s`, `reg add`, `schtasks /create`, `shutdown`, `netsh`, `curl … \| bash`, `iwr … \| iex` |
| `prohibido` | **no se ejecuta**. No hay confirmación que valga | `format C:`, `diskpart`, `rm -rf /`, `del /s /q C:\`, `bcdedit`, `vssadmin delete`, `cipher /w`, borrar dentro de `C:\Windows` |

Dos detalles que evitan que estorbe o que mienta:

- **Lista blanca** de comandos que solo leen, para que una regla amplia no convierta
  en «sensible» algo inocente (`git diff`, `npm run build`). Solo vale si el comando
  es **una orden sencilla**: en cuanto encadena (`&&`, `;`, `|`, `>`), deja de valer,
  porque ya no se sabe qué se ejecuta después.
- El veredicto `prohibido` se aplica en **dos sitios**: `guardrails.decide` (para que
  ni siquiera se pregunte al usuario) y `executors.run_command` (por si se llega por
  otro camino). La barrera no depende de los permisos configurados.

### Lo que esto NO es

No es un sandbox. El comando sigue corriendo con los permisos del usuario. Es una
barrera de **juicio**: evita el desastre por descuido, no el ataque dirigido. Un
sandbox de verdad (proceso aparte, sin red, con el proyecto montado) es otro trabajo
y queda anotado como pendiente.

---

## 3. Anclajes tolerantes a espacios

### El problema

`old_string` con la sangría mal —o con saltos de línea cuando el archivo es CRLF—
hacía fallar `edit_file`/`apply_patch` con un «no encontrado» seco. Para el modelo
eso es un callejón: tiene el texto delante, la corrección es de espacios, y no sabe
qué sangría usa el archivo.

### El comportamiento

1. Coincidencia **exacta** primero: como siempre.
2. Si no aparece, se busca ignorando sangría y finales de línea (`agent/edicion.js`).
3. Con **una** coincidencia así, **no se aplica nada**: se devuelve un «¿Querías
   esto?» con el bloque real numerado, el **texto exacto** para copiar y la vía de
   una sola llamada: `tolerar_espacios: true`.
4. Con la bandera, se aplica y **se reajusta la sangría al archivo**.
5. Con **varias** coincidencias, no se elige: se dice en cuántos sitios aparece.

### Por qué no se aplica solo

Aplicar un anclaje que no coincidía significa **adivinar** la sangría. Una
adivinanza silenciosa en el código del usuario es peor que un error honesto. La
coincidencia tolerante se acepta cuando alguien la pide; nunca por sorpresa.

### El reajuste es por línea, no por longitudes

Comparar cuántos caracteres de sangría hay se rompe en cuanto aparece un tabulador
(un `\t` es un carácter y cuatro columnas): el bloque salía con 3 espacios donde el
archivo tenía 4. El reajuste quita de cada línea la sangría que traía el anclaje y
pone la que tiene esa misma línea **en el archivo**; las líneas que el modelo añada
conservan su sangría relativa.

---

## Lo que cubren las pruebas (15 nuevas, 366 en total)

- Comandos: lo que solo lee no se toca; encadenar deja de ser inocente; lo que
  destruye el sistema no se ejecuta; lo sensible pide permiso **con `run_command` en
  «safe»**; un prohibido se deniega en `decide` **y** en el ejecutor.
- Edición: el anclaje con la sangría mal no escribe y enseña el bloque, el texto
  exacto y la salida; con la bandera aplica sin comerse la línea siguiente; CRLF;
  ambigüedad; el marco numera.
- Árboles, **con un repositorio real**: sin git no se aísla; el árbol ve el cambio
  sin commitear y el archivo suelto; la fusión aplica solo lo del agente (los
  archivos del usuario no aparecen como trabajo ajeno) y registra la pre-imagen;
  un choque de contexto no aplica **nada** y deja el archivo del usuario intacto; sin
  cambios no hay parche.

## Lo que no cubre

- El aislamiento se probó con repositorios reales creados por la prueba, no con los
  repositorios del usuario más grandes; `git worktree add` concurrente sobre el mismo
  repositorio puede fallar por contención del índice y entonces se cae al árbol
  compartido (comportamiento seguro y documentado).
- La fusión usa `git apply` a secas: un archivo que cambie de codificación o con
  atributos `filter`/`smudge` poco comunes podría dar un conflicto falso. Un conflicto
  falso es ruidoso pero inofensivo —no aplica nada—.
- La clasificación de comandos es por patrones: un comando destructivo construido de
  forma muy retorcida (una variable que se expande a `format`) no se detecta. La
  barrera es de juicio, no un sandbox.
