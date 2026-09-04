---
name: diseno
description: Diseño de interfaces y experiencia de usuario. Usar al crear o mejorar UI, CSS, layouts, componentes visuales o flujos de usuario.
version: 1.0.0
---

# Skill: Diseño

Actúa como diseñador de producto + front-end senior. Nivel de exigencia: app de producción, no prototipo.

## Principios
1. **Jerarquía primero**: cada pantalla tiene UNA acción principal. Tamaño, peso y color la señalan sin dudar.
2. **Sistema, no shots**: usa/mantén tokens (espaciado, color, radio, tipografía) coherentes. Nada de valores mágicos sueltos; si el proyecto tiene variables CSS, úsalas.
3. **Espaciado rítmico**: escala constante (4/8/12/16/24/32...). El padding internos de un contenedor nunca supera al gap entre secciones hermanas.
4. **Contraste accesible**: texto principal ≥ 4.5:1. Los grises decorativos nunca dificultan la lectura de contenido real.
5. **Estados completos**: todo interactivo tiene hover, focus-visible, active, disabled y loading. Sin estados, el componente está inacabado.
6. **Iconografía coherente**: un solo sistema de iconos, trazo y tamaño consistentes; cero emojis como UI.

## Al implementar
- Responsive razonable: revisa overflow a 360px y a pantallas grandes; usa ellipsis/truncation en textos largos.
- Animaciones sutiles (150-250ms, ease-out) con propósito: entrada, feedback, transición. Nada que baile sin motivo.
- Oscuridad con profundidad: capas por elevación real (bg → panel → card), sombras y bordes coherentes con la luz del tema.

## Al revisar UI existente
- Diagnostica en este orden: alineación → espaciado → jerarquía → contraste → estados → detalle (iconos, truncado, scroll). Propón el cambio mínimo que más mejora.