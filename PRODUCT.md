# Product

## Platform

web

> El renderer es una superficie web (Chromium, HTML/CSS/JS). Pero **el producto es
> una app de escritorio Electron para Windows 10/11**: no hay objetivo móvil ni
> navegador suelto, y el diseño debe contar con ventana sin marco, barra de tareas,
> bandeja del sistema y atajos globales.

## Users

Audiencia **amplia y deliberada**: desde personas que empiezan en el mundo de la IA
hasta gente experta. Todas en Windows, con su propio equipo como superficie de
trabajo.

- El principiante instala un `.exe`, pega su API key y escribe o dicta: no sabe —ni
  quiere saber— qué es una terminal. El README está escrito para él.
- El experto quiere un agente con manos en su máquina: auditable, con modelo propio,
  sin suscripciones ni cajas negras.

La consecuencia práctica es una restricción de producto: **los valores por defecto
tienen que resolverle la papeleta al principiante y, a la vez, cada decisión
avanzada debe seguir disponible para el experto sin estorbar en el camino simple.**

## Product Purpose

SAGITARI es un asistente agéntico de IA que vive en el escritorio de Windows y
**ejecuta de verdad**: pide algo escribiendo o dictando, y el agente planifica, usa
la terminal, lee y escribe archivos, abre aplicaciones, gestiona ventanas y maneja
Chrome/Edge, con cada paso a la vista en la interfaz.

Existe para cerrar la distancia entre «el asistente me dice cómo hacerlo» y «ya está
hecho». El éxito es que una petición en lenguaje natural termine en trabajo real
sobre tu máquina, con tu proveedor y con tu bolsillo, y que puedas pararlo cuando
quieras.

## Positioning

**«Ejecuta de verdad en tu PC».** Los asistentes de escritorio que la gente ya usa
conversan; SAGITARI abre la terminal, toca archivos, maneja ventanas y navega por ti,
y muestra el paso a paso mientras ocurre. Un asistente de chat no podría copiar esta
frase sin aceptar ejecución a nivel de sistema y, con ella, todo su modelo de
consentimiento.

Lo sostienen tres cosas que el producto ya hace:

- **Acceso real al sistema** con confirmación por herramienta cuando la acción es
  sensible, y un botón de paro que mata el proceso en marcha, no solo el texto.
- **Modelo propio (BYO)**: cualquier endpoint compatible con OpenAI, nube o 100%
  local (Ollama/LM Studio). Tus claves van de tus ajustes a tu proveedor y a ningún
  otro sitio.
- **Trabajo largo que no se pierde**: tareas en segundo plano, subagentes,
  checkpoints y reanudación tras un cierre o un fallo.

## Operating Context

- **Entorno**: Windows 10/11 de escritorio. La app se distribuye como instalador
  NSIS y como portable de un solo ejecutable, sin firma digital (el aviso de
  SmartScreen en la primera ejecución es un paso conocido y documentado).
  Decisión consciente, no descuido: un certificado Authenticode cuesta cientos de
  euros al año y este proyecto es MIT, gratis y sin monetización. Mientras no haya
  firma, cada binario se verifica por SHA-512 contra el `latest.yml` del CI antes
  de ejecutarse, la instalación exige consentimiento activo en dos pasos, y el
  firmante de la primera release firmada que se vea quedará fijado (TOFU: un cambio
  de firmante posterior exige confirmación explícita del cambio).
- **Proveedor**: se elige un preset (OpenCode Go, OpenRouter, Groq, OpenAI,
  Anthropic, Ollama, LM Studio o endpoint propio), se pega la clave si hace falta y
  los modelos se detectan automáticamente.
- **Datos**: configuración, claves y conversaciones viven en
  `%APPDATA%\SagitariAI\` (claves cifradas con DPAPI). Sin cuentas y sin telemetría.
- **Navegador**: el agente controla Chrome/Edge por el protocolo DevTools con un
  perfil persistente propio, así que los inicios de sesión del usuario se conservan.
- **Voz**: dictado con los reconocedores de voz de Windows y lectura en voz alta
  (TTS). Para máxima precisión se pide activar el reconocimiento en línea del sistema.
- **Espacio de trabajo**: carpeta por defecto (`Escritorio\Sagitari`) donde el agente
  crea y modifica archivos y ejecuta comandos si no se le da una ruta absoluta.
- **Ritual de release**: un tag `v*` dispara CI (tests + comprobación sobre la
  interfaz viva), compila instalador y portable, calcula los SHA-256 y publica las
  notas bilingües. El tag debe coincidir con la versión de `package.json`.

## Capabilities and Constraints

**Capacidades confirmadas**

- Chat con modos Think / Plan / Act, adjuntos (imágenes como partes de visión y 30+
  formatos de texto leídos solos) e historial de conversaciones separadas.
- Autonomía: tareas en segundo plano con pausa/reanudación/cancelación, subagentes
  especialistas, checkpoints y fallback de modelos si un proveedor falla.
- Conocimiento: motor de skills (formato `SKILL.md`) con carga bajo demanda, importación
  desde GitHub y marketplace curado; memoria persistente y hábitos observados.
- Control: terminal, archivos, apps, portapapeles, notificaciones, multimedia y
  ventanas; automatización de navegador; capturas que el modelo ve.
- Seguridad: permisos por herramienta, guardarraíles de pasos/tiempo/tokens/coste,
  detección de bucles, logs JSONL locales y modo desarrollador opcional.
- Interfaz: 9 secciones, seis paletas de acento, intensidad de glow configurable,
  atajos (`Alt+1…9`, `Ctrl+Alt+S`, `Alt+Shift+S`, `Ctrl+Shift+G`, `Alt+M`, `/`).

**Restricciones técnicas**

- **Solo Windows 10/11** (hecho actual, cambiable si un diseño lo justifica).
- **UI hecha a mano**: HTML/CSS/JS sin frameworks de interfaz y **una única
  dependencia de runtime** (`ws`). Decisión de producto, no limitación.
- Renderer con `contextIsolation` activado, `nodeIntegration` desactivado y `sandbox`
  activado; nada de estilos nativos del sistema en los controles (los desplegables y
  el calendario son componentes propios).
- Terminología en español en la interfaz; documentación y notas de versión con
  **paridad ES/EN**.

**Hechos de producto sin decidir**: ninguno abierto. Lo no blindado puede cambiar con
justificación (ver *Brand Commitments*).

## Brand Commitments

- **Nombre y activos**: SAGITARI, con marca y logotipo propios (`renderer/assets/`,
  `docs/header.png`). El icono se mantiene coherente en la barra de tareas de Windows.
- **Voz**: español primero, con paridad bilingüe en README y notas de versión —un
  compromiso de larga duración, no una traducción suelta.
- **Identidad visual fijada**: interfaz holográfica hecha a mano, con glow reactivo
  que ilumina el marco según lo que hace el agente (color e intensidad configurables).
  El brillo y el acento son la identidad, no decoración prescindible. El estado vacío
  del chat queda limpio: sin adornos, manda el texto sobre el aura del marco.
- **Licencia**: **MIT y gratis, sin monetización. Es lo único blindado**: no se diseña
  nada que dependa de un plan de pago ni se cierra nada para sostener uno.
- Windows-only, UI sin frameworks, claves/datos solo locales y el modelo de
  permisos+guardarraíles son **hechos actuales**, no dogmas: pueden cambiar si un
  diseño lo justifica, y conviene decirlo cuando se cambien.

## Evidence on Hand

- **Releases públicas reales** en GitHub, cada una con instalador, portable,
  `Source code` y SHA-256 en el cuerpo. El historial completo está en
  `RELEASE_NOTES.md` y en la página de releases del repositorio.
- **Descargas medidas el 2026-09-14**: 25 en la 2.2.2, y entre 3 y 7 en las
  anteriores (≈49 en total). Es un proyecto **en fase temprana, con audiencia
  pequeña**: el trabajo futuro no debe insinuar tracción que no existe.
- **Verificación propia**: suite de tests unitarios, `npm run smoke` (la app arranca)
  y `npm run uicheck` (comprobaciones sobre la interfaz viva), todo en CI antes de
  publicar.
- **No hay** testimonios, clientes, prensa, casos de estudio, precios ni métricas de
  uso. Nada de eso se puede fabricar.

## Product Principles

1. **Lo que dice, lo hace.** Cada promesa de la interfaz corresponde a una acción real
   y observable en la máquina del usuario; nada simulado ni de mentira.
2. **Fácil para quien empieza, hondo para quien sabe.** El camino por defecto no exige
   conocimientos; la profundidad existe y no estorba.
3. **Tus datos, tu equipo.** Sin cuentas ni telemetría: claves y conversaciones solo en
   local, y con un modelo local no sale un byte de la máquina.
4. **Lo peligroso se ve y se pregunta.** El acceso al sistema es la ventaja y el riesgo:
   consentimiento por herramienta, límites claros, paro real y registros que el usuario
   puede leer.
5. **Publicar es verificar y decirlo en los dos idiomas.** Tests y comprobación de interfaz
   antes de cada release; notas y documentación con paridad ES/EN.

## Accessibility & Inclusion

**Objetivo: WCAG 2.1 AA verificable** — contraste medido en toda la interfaz, foco
visible, uso completo por teclado y nombres accesibles en los controles.

> Elegido por el asistente a petición del usuario («lo que recomiendes»), no impuesto
> por él. El trabajo pendiente conocido está en el contraste del texto tenue (`--dim`)
> y en el foco de algunos controles; una auditoría con la app en marcha dará la lista
> medible.
