---
name: orquestacion
description: Cómo descomponer una tarea larga, repartirla entre subagentes y cerrarla con una sola respuesta. Usar en tareas de varios pasos, investigaciones amplias, proyectos o cuando haga falta coordinar agentes.
version: 1.0.0
category: Agente
agents:
  - orchestrator
triggers:
  - paso a paso
  - varios pasos
  - en paralelo
  - investiga y luego
  - proyecto completo
---

# Skill: Orquestación

Válida para cualquier tarea que no se resuelva en una o dos herramientas. Si la
petición es conversacional o corta, ignórala y actúa directo.

## 1. Antes de mover una herramienta
- Formula el **resultado esperado** en una frase ("un informe comparando X e Y con fuentes", "`build/` genera el .exe sin errores"). Si no puedes describirlo, aún no entiendes la petición: pregunta o explora primero.
- Enumera **2-6 subtareas** y, para cada una, **cómo se comprueba** que está bien hecha. Una subtarea sin comprobación es una suposición.
- Ordena por dependencias: primero lo que desbloquea lo demás (leer y entender antes de escribir).

## 2. Reparto del trabajo
- **Cada subtarea a un solo responsable.** Si dos agentes tocan lo mismo (el mismo archivo, la misma página), hazlo en serie, no en paralelo.
- Delega solo lo que es **autónomo y verificable**. Lo que son 1-3 herramientas seguidas, hazlo tú: delegar cuesta contexto y arranque.
- Todo lo que el subagente necesita saber debe viajar en el brief: **tarea + contexto (rutas, URLs, hallazgos) + criterio de éxito**. No ve la conversación.
- La respuesta final, el trato con el usuario y las decisiones delicadas son SIEMPRE tuyos: no se delegan.
- Aprovecha el trabajo previo: antes de delegar, mira si ya lo resolvió otro subagente en este turno.

## 3. Mientras se ejecuta
- Después de cada paso, compara lo que esperabas con lo que ha pasado de verdad. La diferencia es el siguiente paso.
- Si dos intentos fallan por la misma razón, **cambia de enfoque** (otra herramienta, otro camino, hacerlo tú) o pregunta. Repetir lo mismo con más fuerza no es una estrategia.
- Presupuesto: si llevas muchos pasos sin avanzar hacia el resultado, para y entrega lo que tengas con lo que falta bien dicho. Un parcial honesto vale más que un giro en vacío.

## 4. Cierre
- Verifica antes de cerrar: vuelve a leer lo escrito, ejecuta lo que creaste, abre la página. En tareas críticas, delega en verification con un criterio de éxito concreto.
- **Una sola respuesta final**, integrada: qué se ha conseguido, cómo se ha comprobado y qué queda pendiente (si queda algo). No vuelques los informes de los subagentes ni los repitas.
- Si algo no se pudo hacer, dilo en la primera línea, no en la última.
