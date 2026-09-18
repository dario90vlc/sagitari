# Verificación real: que el error lo diga el proyecto, no el modelo

Fecha: 2026-09-18 · Ámbito: `agent/diagnosticos.js` (nuevo), `agent/executors.js`,
`agent/agent.js`, `agent/cambios.js`, Ajustes · Estado: implementado y probado

## El problema

SAGITARI podía escribir un archivo con la sintaxis perfecta y el código mal: un tipo que no cuadra,
una variable que no existe, un import que ya no apunta a nada. Nada de eso lo ve `node --check`, y
hasta ahora la única red era **pedirle al modelo que comprobara** su propio trabajo (la puerta de
verificación) o esperar a que el usuario ejecutara las pruebas. Es decir: la calidad dependía de que
el modelo fuera honesto, y el error aparecía tres pasos después o en manos del usuario.

La comprobación del proyecto existía, pero a medias: `proyecto.js` deducía los comandos y comprobaba
la **sintaxis** de cada archivo. Faltaban las dos mitades que de verdad cambian el resultado: los
**diagnósticos del proyecto** (lo que sabe tsc/ESLint/Ruff/Mypy) y la **ejecución de las pruebas**.

## Qué se ha construido

### 1. `agent/diagnosticos.js` — lo que el proyecto sabe del código

Puro, como `proyecto.js` (no lanza procesos ni escribe: decide y parsea; quien ejecuta es el
ejecutor). Cuatro piezas:

- **`planPorArchivos(workspace, archivos)`** — qué se puede ejecutar *de verdad* aquí: ESLint si el
  proyecto lo tiene (binario en `node_modules` o config en la raíz), Ruff/Flake8/Mypy si el proyecto
  los declara en `requirements.txt`/`pyproject.toml`/config. Si no está, no se propone: mejor nada
  que un error inventado.
- **`parsear(salida, {formato})`** — lee la salida **real** de cada herramienta, con su formato:
  `tsc` (`archivo(l,c): error TSxxxx: …`), `eslint` (JSON, que es lo que de verdad devuelve),
  `ruff`/`flake8`, `mypy` (con su código al final), `go vet`, `clippy` (la ubicación va en la línea
  `-->`) y un genérico para cualquier `archivo:línea:columna: mensaje`. Cada hallazgo sale
  normalizado: archivo, línea, columna, severidad, código y mensaje.
- **`clasificar(hallazgos, {lineasDe})`** — separa lo **nuevo** de lo **preexistente**.
- **`planCierre(perfil)`** — la comprobación de cierre: las pruebas si el proyecto las tiene; si no,
  su compilación o sus tipos.

Dos reglas que evitan que esto estorbe o mienta:

1. **Un comprobador que no está en el equipo no es un error del código.** `pareceFalloDeHerramienta`
   reconoce `No module named`, `no se reconoce como un comando` (127/9009), `Cannot find module` y
   el caso de no poder ni lanzarlo; ese comprobador se **aparta** y no se vuelve a intentar.
2. **Lo que ya estaba mal en el archivo no es suyo.** Con las líneas que el turno ha tocado
   (`cambios.lineasCambiadas`, calculado del diff real contra la pre-imagen que ya se guardaba), un
   hallazgo fuera de esas líneas se cuenta y se dice, pero **no se le exige**. Sin esto, cada
   escritura en un archivo con desorden viejo se convertía en una invitación a refactorizar lo que
   nadie pidió.

Un comprobador que tarda más de 12 s en un proyecto se aparta 10 minutos (una comprobación que se
come el turno deja de ser una ayuda), y el estado adaptativo es por proyecto.

### 2. Al escribir: el error vuelve en el mismo paso

`executors.resultadoEscritura` ahora hace dos cosas además de la sintaxis: pasa los comprobadores del
proyecto sobre los archivos escritos y añade al resultado del paso lo que salga. Si hay **errores
nuevos**, el paso llega como **FALLO** (la tarjeta del chat se marca en rojo y el modelo lo tiene que
arreglar); los preexistentes y los avisos se dicen sin teñir el paso de rojo. Se puede apagar en
**Ajustes ▸ Agente ▸ Comprobar el proyecto al escribir**.

### 3. Al cerrar: prueba → falla → arreglo → repito

`Agent._chequeoCierre` corre justo antes del cierre, en el bucle, y **no le pregunta al modelo: lo
ejecuta**. Con el comando que deduce el proyecto (sus pruebas, o su compilación):

- si pasa, el run queda marcado como **verificado con evidencia real** (`_verified`), así que la
  puerta de verificación no vuelve a pedir que «compruebe» a ojo;
- si falla, **el turno no cierra**: se conserva su respuesta, se le añade la salida real del comando
  y la orden de arreglarlo, y el bucle sigue;
- se repite hasta el tope de **Ajustes ▸ Agente ▸ Intentos de arreglar un fallo** (0–5, por defecto
  2). Cuando se agotan, cierra igual (el fallo ya está a la vista en el chat) en lugar de girar para
  siempre.

Detalles que importan: se ejecuta **una vez por turno**; **no** se repite si el propio modelo ya
lanzó esa misma orden después de su última escritura (se recuerda el último comando: no se paga dos
veces el mismo `npm test`); se ejecuta con el directorio de trabajo del proyecto, se puede **matar
con Detener** (`registerKillable`) y **no pasa por el motor de permisos** —es la comprobación de la
app, como el chequeo de sintaxis, no una acción del modelo—, que es justo lo que hace falta para que
nadie tenga que confirmar un diálogo para que su propio proyecto se compruebe. El usuario ve lo que
se ejecutó y qué salió como una **tarjeta más del chat**, no como una promesa de que «está
verificado».

### 4. Ajustes

| Ajuste | Por defecto | Qué hace |
|---|---|---|
| Comprobar el proyecto al escribir | activado | Comprobadores del proyecto sobre lo que se escribe |
| Ejecutar las pruebas al cerrar | activado | El ciclo prueba → falla → arreglo antes de cerrar |
| Intentos de arreglar un fallo (0–5) | 2 | Cuántas vueltas se le dan al modelo antes de cerrar |

## Cómo queda probado

- **Parseo con la salida real de cada herramienta** (7 formatos: tsc, eslint JSON, ruff/flake8, mypy,
  go vet, clippy, genérico), incluida la caída al genérico cuando eslint no devuelve JSON, un
  hallazgo de fuera del proyecto (no se le atribuye) y el caso de ruta absoluta de Windows con sus
  dos puntos (que era un fallo real: el patrón genérico perdía todos esos diagnósticos).
- **Clasificación nuevo/preexistente** con un diff real de por medio, y `cambios.lineasCambiadas`
  (aquí salió otro fallo real: `diffLineas` devuelve solo el tramo del medio, así que sin contar el
  prefijo común la numeración salía desplazada y una línea tocada arriba del archivo se daba por no
  tocada).
- **Circuito completo con un proceso de verdad**: un proyecto con un ESLint de mentira (un script
  Node que devuelve JSON de ESLint) comprueba que los hallazgos en líneas tocadas tiñen la escritura
  de rojo, que los de líneas no tocadas no, que el comprobador que no arranca no culpa al código, y
  que apagado en Ajustes no se ejecuta nada.
- **El ciclo de cierre, con sus siete casos**: fallo → no cierra y se le devuelve la salida real;
  una vez por turno; tope de intentos; verde → verificado; apagado; proyecto sin pruebas ni
  compilación; y no repetir la orden que el modelo ya corrió. Más una comprobación de que la llamada
  está **cableada** en el bucle y **antes** del cierre del turno (una comprobación a la que nadie
  llama no comprueba nada).
- **La interfaz**: `uicheck` comprueba que los dos interruptores vienen encendidos, que apagan de
  verdad el ajuste y que el tope de intentos se guarda.

**340 pruebas**, `uicheck`, `smoke` y `navcheck` en verde.

## Lo que no cubre

- Los parsers están probados con la salida real de cada herramienta, pero **el equipo donde se
  desarrolla no tiene tsc/Ruff/Mypy instalados**, así que la integración de extremo a extremo usa un
  comprobador de verdad (un proceso real) con la salida de ESLint. Si algún proyecto cambia su
  formato de salida, `pareceFalloDeHerramienta` evita que eso se convierta en un error atribuido al
  código, pero el hallazgo se perdería hasta ajustar el parser.
- La comprobación de cierre la ejecuta el **agente principal** (una vez por turno). Los subagentes sí
  reciben los diagnósticos al escribir, pero no lanzan las pruebas del proyecto: lo hace el
  orquestador al cerrar, y ejecutarlas en cada subagente multiplicaría el coste sin añadir
  información.
- No hay todavía **prueba-primero** (escribir la prueba que falla antes del cambio): lo que hay es el
  ciclo de reparación sobre las pruebas que ya existan.
