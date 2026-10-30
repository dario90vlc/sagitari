# Idioma de la interfaz — diseño (5.4)

Aprobado por el usuario el 2026-10-30 con dos decisiones: **todo lo que el usuario puede ver
en pantalla debe poder estar traducido** (interfaz, resultados de herramientas, tarjetas,
diálogos nativos, bandeja y notificaciones) y **detección automática del idioma de Windows
con selector en Ajustes**, aplicándose al reiniciar.

## Qué es

Hoy todo el texto de SAGITARI está en español fijo: ~296 nodos en `renderer/index.html`,
~47 textos dinámicos en `renderer/*.js` y ~144 mensajes de `main/` y `agent/` que la
interfaz enseña tal cual. No existe ninguna infraestructura de idioma.

Con esto, la app habla **español si Windows está en español** (cualquier región: `es-ES`,
`es-AR`, `es-MX`…) y **inglés en cualquier otro caso**, y el usuario puede forzarlo en
Ajustes. Las respuestas del agente ya siguen el idioma del usuario (el prompt del sistema
ya lo dice), así que eso no se toca.

## Decisiones

| Decisión | Valor | Por qué |
|---|---|---|
| Mecanismo | claves + dos diccionarios (`es`, `en`) | un mapa «texto español → inglés» se rompe en silencio en cuanto cambia una palabra en español |
| Detección | `app.getLocale()` → `/^es/i` | una sola fuente, la que ya usa Windows; cualquier variante regional cae en español |
| Preferencia | `settings.uiLang`: `auto` \| `es` \| `en` | `auto` por defecto; el usuario manda |
| Aplicación | al reiniciar | repintar en vivo obliga a rehacer todos los textos ya pintados; no aporta |
| Alcance | **todo lo visible**: interfaz, resultados de herramientas, tarjetas, diálogos nativos, bandeja y notificaciones | lo que el usuario ve en pantalla debe poder estar en su idioma; lo único fuera es lo que nunca se pinta |

## Cómo se resuelve el idioma

```
resolverIdioma(uiLang, locale)            // agent/i18n.js, función pura
  'es' | 'en' explícitos → ese
  'auto' (o inválido)    → /^es\b/i.test(locale) ? 'es' : 'en'
  locale vacío/indefinido → 'es'          // la suite sin Electron sigue en español
```

- `main/main.js` resuelve **una vez** al arrancar (`app.getLocale()`) y guarda el idioma
  activo; `agent/i18n.js` lo recibe con `configurar(idioma)`.
- Al renderer no se le abre un canal nuevo: la ventana se crea con
  `webPreferences.additionalArguments: ['--sag-idioma=es']` y `preload.js` lo lee del
  proceso, exponiéndolo como `window.sagitari.idioma`.
- Cambiar el selector guarda `uiLang` y avisa «se aplica al reiniciar»; no se repinta nada.

## Módulos nuevos

| Módulo | Qué expone |
|---|---|
| `agent/i18n.js` | `t(clave, vars)`, `configurar(idioma)`, `idiomaActual()`, `claves()`, `resolverIdioma(uiLang, locale)` |
| `agent/i18n/es.js`, `agent/i18n/en.js` | diccionario del motor (mensajes, motivos, títulos de tarjeta, estados) |
| `renderer/i18n.js` | `I18N.t(clave, vars)`, `I18N.aplicarDOM()`, `I18N.idioma` (lo lee de `window.sagitari.idioma`) |
| `renderer/i18n-es.js`, `renderer/i18n-en.js` | diccionario de la interfaz |

Reglas comunes a los dos diccionarios:

- Clave plana y con área delante: `ajustes.modelo.titulo`, `chat.detener`, `mcp.sinServidor`.
- Interpolación con llaves: `t('chat.herramientas', { n: 3 })` → `{n} herramientas`.
- **Fallback en cascada**: clave ausente en `en` → se pinta la de `es`; ausente en `es` →
  se pinta `⟦clave⟧`. Nunca queda vacío ni revienta.
- Los dos diccionarios de un par tienen **exactamente las mismas claves** (lo comprueba
  una prueba; si falta o sobra una, la suite se pone roja).

## Marcar el HTML

`renderer/index.html` gana atributos, sin cambiar una sola etiqueta:

| Atributo | Rellena |
|---|---|
| `data-i18n="clave"` | el texto del nodo |
| `data-i18n-ph="clave"` | el `placeholder` |
| `data-i18n-title="clave"` | el `title` |
| `data-i18n-aria="clave"` | el `aria-label` |

`I18N.aplicarDOM()` se llama una vez al arrancar el renderer (antes de pintar nada) y es
idempotente. Los textos que se generan por código (`toasts`, tarjetas, listas) se pintan
con `I18N.t()` en el sitio donde hoy está el literal.

## Qué se traduce y qué no

**Regla única: lo que puede aparecer en pantalla pasa por clave.** Si un texto también lo
lee el modelo (un resultado de herramienta, un motivo de guardarraíl), se traduce igual: el
modelo entiende el inglés, y el usuario tiene que entender lo que ve.

| Se traduce (todo lo visible) | No se traduce (nunca llega a pantalla) |
|---|---|
| `index.html` y textos de `renderer/*.js` | prompt del sistema (`agent/agent.js`, `subagents.js`) |
| errores de IPC y avisos que la interfaz enseña | descripciones de herramientas (`tools.js`), que solo lee el modelo |
| **resultados de herramientas** que se pintan en su tarjeta | cuerpo de skills (de serie o importadas) |
| títulos, resúmenes y motivos de las tarjetas de permiso | ficheros de log (`main/log.js`, `runlog`) |
| estados del turno, razonamiento, lista de tareas, equipo, memoria, historial | texto de terceros: proveedor, webs, herramientas MCP, salida de compiladores |
| ventana, **diálogos nativos** (`dialog.showMessageBox`), bandeja, notificaciones, avisos de actualización | |

**Excepción obligatoria (una línea):** el prompt de `/compact` pide el resumen «en español»
fijo; pasa a «en el idioma del usuario». Sin eso, un usuario inglés recibe el resumen en
español.

## Los mensajes no se leen por su texto

Traducir rompe cualquier código que decida mirando el texto de un mensaje. Hoy hay tres
sitios así y se arreglan **antes** de traducir el motor:

| Sitio | Hoy | Queda |
|---|---|---|
| `renderer/10-chat.js:2185` | oculta Deshacer si el error contiene `no hay ningún cambio` | el motor devuelve `{ ok:false, code:'sin_cambios' }` y el renderer mira `code` |
| `renderer/20-app.js:515` | pinta en rojo si `result.startsWith('Error')` | usa `ev.ok === false`, que el evento ya trae |
| `agent/agent.js:2050` | marca la herramienta como fallida si el texto empieza por `Error` | usa el `failed` explícito que ya existe; el prefijo queda solo como último recurso |

Regla para lo nuevo: **un mensaje es para leerlo, no para interpretarlo**. Si alguien
necesita saber *qué* pasó, va un `code` o un booleano, no una frase.

## Ajustes

- Fila **Idioma** como primera de Apariencia (Automático / Español / English), con la nota
  de que se aplica al reiniciar.
- `uiLang` entra en la lista blanca de `main/ipc-config.js` y se valida a
  `auto|es|en`; cualquier otro valor se descarta y se conserva el que había.

## Casos límite

- `app.getLocale()` vacío o desconocido → `es`.
- `uiLang` tocado a mano en `config.json` → `auto`.
- Ventana recreada tras una caída: hereda el mismo `additionalArguments` (un solo helper
  crea la ventana).
- Tests: sin Electron, `resolverIdioma('auto', undefined)` → `es`, así que las 1.437
  pruebas que ya existen (muchas comparan textos en español) siguen valiendo.

## Pruebas

| Prueba | Qué cubre |
|---|---|
| `test/i18n.test.js` | paridad de claves en los dos pares, interpolación, fallback en cascada, `resolverIdioma` con `es-AR`, `en-GB`, vacío y valores inválidos |
| `test/renderer/i18n.test.js` | `aplicarDOM()` rellena texto y los tres atributos sobre el `index.html` real, no toca nodos sin clave y con `en` deja el HTML en inglés |
| códigos de error | `cambios:deshacer` devuelve `code:'sin_cambios'` y el renderer oculta el botón por el código, con el mensaje cambiado a propósito |
| acoplamientos | ni `renderer/*.js` ni `agent/agent.js` deciden por el texto de un mensaje (los tres sitios de la tabla, cada uno con su prueba) |
| Suite existente | se queda en español por defecto (idioma resuelto = `es`) |

## Orden de trabajo

1. **Esqueleto**: `agent/i18n.js`, `renderer/i18n*.js`, resolución en `main`, paso al
   renderer por `additionalArguments`, selector en Ajustes y las pruebas de paridad con
   diccionarios mínimos.
2. **`index.html` completo** (296 nodos) + `aplicarDOM`.
3. **Barra y chat**: `10-chat.js`, `20-app.js`.
4. **Ajustes**: `30-ajustes.js`.
5. **Vistas**: `40-vistas.js`, `memoria-ui.js`, `chatkit.js`.
6. **Mensajes del motor**: primero los tres acoplamientos por texto (códigos y banderas),
   después `main/*.js` y los de `agent/` que llegan a pantalla, los diálogos nativos y la
   línea de `/compact`.
7. **Barrido final**: buscar texto en español que no pase por clave (renderer, main y
   agent), incluidos diálogos nativos, bandeja y notificaciones.

En cada paso la app funciona en español; el inglés se completa al terminar el paso 6.

## Criterios de aceptación

- Con Windows en inglés: menús, chat, ajustes, vistas, tarjetas, **resultados de
  herramientas**, errores, diálogos nativos, bandeja y notificaciones en inglés; el agente
  responde en inglés.
- Con Windows en español (cualquier región): todo en español, como hoy.
- El selector fuerza el idioma y se aplica al reiniciar.
- Nada visible se queda en español con la app en inglés; ninguna clave pinta vacío.
- Ningún código decide por el texto de un mensaje: se cambia un mensaje a otro idioma y
  nada deja de funcionar.
- `npm test`, `npm run test:renderer` y `npm run lint` en verde al cerrar cada paso.

## Fuera de alcance

- Traducir el prompt del sistema, las descripciones de herramientas, las skills de serie,
  `README`/`PRODUCT.md` ni las notas de versión.
- Cambio de idioma en vivo sin reiniciar.
- Idiomas distintos de español e inglés.

## Riesgos

- **Dejarse textos**: 1.400 cadenas son muchas; el barrido del paso 7 (buscar literales en
  español fuera de los diccionarios) es la red, y con la app en inglés se ve al instante.
- **Las pruebas actuales comparan textos en español**: por eso el idioma por defecto sin
  Electron es `es`; si alguna prueba fija el idioma, se actualiza junto con el cambio.
- **Dos fuentes de diccionario** (motor e interfaz): la paridad se comprueba por par, no
  entre pares; un texto repetido en los dos lados es aceptable y no se unifica.
