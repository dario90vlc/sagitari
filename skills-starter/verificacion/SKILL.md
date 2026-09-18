---
name: verificacion
description: Comprobar de verdad que una tarea quedó bien hecha, con evidencia y buscando el fallo en vez de confirmarlo. Usar antes de dar por terminado un cambio, un archivo o un flujo, y al revisar el trabajo de otro agente.
version: 1.0.0
category: Calidad
agents:
  - verification
  - orchestrator
triggers:
  - verifica
  - comprueba
  - revisa que
  - esta bien hecho
  - antes de cerrar
---

# Skill: Verificación

Verificar no es repetir que está hecho: es **intentar demostrar que NO lo está**.

## 1. Comprueba el mundo, no el informe
- Que otro agente diga "hecho" no es evidencia. Abre la ruta, lee el archivo, ejecuta el comando, mira la página.
- La evidencia es concreta y reproducible: la salida exacta, la ruta exacta con su contenido, la URL y lo que se ve en ella.
- Si no puedes comprobar algo, dilo como **NO COMPROBABLE** con el motivo. Nunca lo cuentes como bueno.

## 2. Cómo buscar el fallo
1. ¿Existe? (la ruta está, la página responde, la función se exporta)
2. ¿Es lo que se pidió? (contenido, valor, formato, nombre) — no solo que exista
3. ¿Sobrevive al uso real? Ejecútalo, ábrelo, pásale una entrada distinta a la de ejemplo.
4. Casos límite del objetivo: vacío, muy grande, ruta con espacios o acentos, sin permisos, segunda ejecución.
5. Efectos colaterales: ¿se tocó algo que no debía? ¿quedó a medias?

## 3. Señales de verificación falsa (desconfía de ti mismo)
- "Debería funcionar", "seguramente", "parece correcto".
- Salidas truncadas o recortadas justo donde importaba.
- Un test que no se ejecutó, un comando que salió con código distinto de 0 y se ignoró.
- Errores silenciados (try/catch vacío, `|| true`, avisos que se dan por normales).

## 4. Cómo se entrega
- **VERIFICADO**: qué comprobaste, con qué comando/ruta/URL y qué salió.
- **FALLO**: qué se esperaba y qué encontraste. Sé específico: "el archivo existe pero tiene 0 bytes" es útil; "hay un problema" no.
- Un punto por comprobación. Sin adornos y sin repetir el trabajo del otro agente.
