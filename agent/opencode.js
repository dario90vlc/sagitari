'use strict';

/* Identificación del cliente ante proveedores que la exigen (OpenCode Go / Zen).

   OpenCode Go rechaza desde el 6-sep-2026 cualquier petición sin sesión:
     HTTP 400 { "type": "MissingSessionID",
                "message": "... missing x-opencode-session and cannot be routed efficiently ..." }
   Además pide identificarse con un User-Agent propio (no el de una librería
   genérica) para poder optimizar el enrutado y el prompt caching:

     - x-opencode-session : ID ESTABLE por conversación (misma conversación →
                            mismo proveedor → caché de prompt).
     - x-opencode-client  : nombre del cliente (estadísticas).
     - User-Agent         : 'Sagitari/<versión>'.

   Puro Node (sin Electron) y sin I/O salvo leer la versión del package. */

let APP_VERSION = '2.0.0';
try { APP_VERSION = require('../package.json').version || APP_VERSION; } catch {}

const CLIENT = 'sagitari';

/** ¿El endpoint pertenece a OpenCode (Go/Zen)? */
function isOpenCode(baseUrl) {
  return /opencode/i.test(String(baseUrl || ''));
}

/** ID de sesión nuevo (aleatorio, para tareas sueltas o agentes sin conversación). */
function newSessionId() {
  return 'sagi-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/** ID de sesión ESTABLE a partir de un identificador de conversación. */
function sessionFor(convId) {
  const id = String(convId || '').trim().replace(/[^\w.-]+/g, '');
  return id ? 'sagi-' + id : newSessionId();
}

/** User-Agent del cliente (identificación propia, como pide el proveedor). */
function userAgent() { return 'Sagitari/' + APP_VERSION; }

/** Cabeceras extra que el proveedor necesita para enrutar y cachear bien. */
function identityHeaders(baseUrl, sessionId) {
  const h = {};
  if (isOpenCode(baseUrl)) {
    h['x-opencode-session'] = String(sessionId || '').trim() || newSessionId();
    h['x-opencode-client'] = CLIENT;
  }
  return h;
}

module.exports = { isOpenCode, newSessionId, sessionFor, userAgent, identityHeaders, CLIENT, __version: () => APP_VERSION };
