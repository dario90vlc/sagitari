# Banco de pruebas de tareas

Aquí no se prueba el **código** de SAGITARI (eso lo hacen las 344 pruebas de `test/`),
se prueba al **agente**: si le das un punto de partida, un objetivo y una forma objetiva
de saber si lo consiguió, ¿lo consigue?

Esa diferencia importa porque la calidad de un agente no vive en una función que se pueda
aislar: vive en el conjunto (prompt + herramientas + orquestación + skills + reglas del
proyecto). Contra ese conjunto, un test unitario no dice nada. Un banco de tareas sí, y
además deja **números**: pasa o no pasa, cuántos pasos, cuántos tokens, cuánto costó y
cuánto tardó. Es lo que permite decir «esto es mejor que ayer» sin creérselo.

## Uso

```bash
npm run banco                        # todas las tareas, con tu proveedor activo
npm run banco -- --tarea bug         # solo las que encajen con ese patrón
npm run banco -- --base              # compara con bench/linea-base.json (falla si hay regresión)
npm run banco -- --guardar-base      # fija la línea base con esta corrida
npm run banco -- --conservar         # no borra el espacio de trabajo de las tareas que fallan
```

Cada corrida imprime una tabla, guarda el informe completo en `%APPDATA%/SagitariAI/banco/`
y devuelve **0** si todo pasa y **1** si algo falla o hay regresión. Eso es lo que lo hace
servir como puerta de calidad: `npm run banco -- --base` es el comando que se puede meter
en el CI cuando se cambia un prompt, una skill o la orquestación.

Las corridas van contra tu proveedor real y **cuestan dinero**: son unas pocas tareas
cortas, pero cuentan. Y quedan en el registro de la app, porque son corridas de verdad.

## Cómo se escribe una tarea

```
bench/tareas/mi-tarea/
  tarea.json     ← qué se pide y cómo se decide si está bien
  inicio/        ← los archivos del punto de partida (se copian a un espacio temporal)
```

```json
{
  "nombre": "mi-tarea",
  "etiquetas": ["codigo"],
  "objetivo": "lo que se le pide al agente, en sus palabras",
  "comprobar": "npm test",
  "espera": [
    { "archivo": "src/x.js", "contiene": "function x" },
    { "archivo": "test/y.js", "sinCambios": true },
    { "archivo": "basura.txt", "noExiste": true }
  ],
  "pasosMax": 20,
  "tiempoMaxMs": 240000,
  "nota": "por qué existe esta tarea"
}
```

Reglas del criterio de éxito:

- **`comprobar`** es un comando que se ejecuta en el espacio de la tarea y tiene que salir
  `0`. Es la verdad del mundo (las pruebas del proyecto de la tarea), no la opinión del modelo.
- **`espera`** son comprobaciones sobre lo que quedó en disco: `existe`, `contiene`,
  `noContiene`, `noExiste` y `sinCambios` (este último compara con el punto de partida, y
  es la forma de medir un «no toques esto»).
- **`pasosMax`** y **`tiempoMaxMs`** son topes: pasarse también es fallar. Sin ellos, un
  agente que da vueltas acabaría «pasando» por agotamiento.
- El espacio de trabajo de una tarea que **falla** se conserva y su ruta sale en el informe:
  el valor de un banco está en poder mirar el desastre.

## Cosas que se aprenden mirándolo

- Un cambio de prompt que arregla una tarea y rompe otra deja de ser invisible.
- Se ve el precio de lo que se gana: el banco avisa cuando una tarea sigue pasando pero
  cuesta más tiempo o más tokens que en la línea base.
- Un modelo nuevo se compara con el anterior **en tu trabajo**, no en una tabla de
  marketing: los tres primeros informes con modelos distintos ya dicen más que cualquier
  lista de posiciones.
