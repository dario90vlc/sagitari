---
name: navegacion
description: Manejar webs reales con el navegador (buscar, leer, rellenar formularios, clics, descargas) sin perderse ni romper nada. Usar cuando la tarea implique operar una página concreta.
version: 1.0.0
category: Web
agents:
  - browser
  - research
triggers:
  - navega
  - abre la web
  - rellena el formulario
  - busca en internet
  - descarga de la web
---

# Skill: Navegación

## 1. Antes de tocar la página
- Si ya hay navegador abierto, **reutilízalo** (una sola ventana con pestañas) y muévete con `tabs` / `select_tab`. Relanzar crea estados duplicados y confunde.
- Mira la página antes de actuar: `elements` (inventario con índices) para saber qué hay, `content` para leer el texto, `screenshot` cuando la duda es visual.
- Decide **una** acción por paso y léela antes de la siguiente.

## 2. Actuar
- Prefiere el **texto visible** del botón o enlace antes que un selector CSS: cambia menos entre visitas.
- Al escribir en un campo: vacíalo antes (`clear`) o el valor anterior se mezclará. Para buscar, usa `submit` en vez de buscar el botón.
- Si un elemento tarda, usa `wait`; no rellenes a ciegas ni hagas doble clic por impaciencia.
- Consiente cookies/avisos de la forma menos intrusiva (rechazar lo no esencial) y sigue.

## 3. Verificar cada paso
- Tras un clic o un envío, lee el resultado: la URL cambió, apareció un mensaje, se abrió un modal.
- Si algo falla, **mira la página** antes de reintentar. Un clic sobre el elemento equivocado (o un consentimiento bloqueando) se detecta así, no repitiendo el clic.
- Al terminar, comprueba el estado real: qué quedó guardado, qué mensaje se ve.

## 4. Límites
- Nada de pagos, publicaciones públicas, borrados de cuenta ni cambios de contraseña: repórtalo para que lo decida el usuario.
- No descargues ejecutables ni instales nada desde la web sin pedirlo explícitamente.
- Cierra las pestañas que ya no uses: heredas el navegador del usuario, no es tuyo.
