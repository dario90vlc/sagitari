'use strict';

/* Validación de la configuración de un servidor MCP. Vive fuera de main.js (Node
   puro) para poder probarla: es la puerta por la que entran el comando que se
   ejecutará y la URL a la que se enviará el token. */

const { httpUrlAllowed, buildCmdLine } = require('../agent/mcp-transport');

const ID_RX = /^[a-z0-9_-]{1,24}$/;
const TRANSPORTS = ['stdio', 'http'];

const rawId = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);

/** Lista de nombres de herramienta: solo cadenas no vacías, sin duplicados. */
function sanitizeList(v) {
  const arr = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : []);
  const out = [];
  for (const x of arr) {
    if (typeof x !== 'string') continue;   // un número o un nulo no es un nombre de herramienta
    const s = x.trim();
    if (s && !out.includes(s)) out.push(s.slice(0, 80));
  }
  return out;
}

/** @returns {{ok: boolean, error?: string, value?: object}} */
function validateServer(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  // El id se sanea, pero no se inventa ni se traga una ruta: es lo que nombra las
  // claves de permisos (mcp__<id>__*) y la carpeta de estado del servidor, y un
  // '../fuera' saneado en silencio acabaría guardado como «fuera» (el usuario
  // creería haber configurado otra cosa).
  const idBruto = String(s.id == null ? '' : s.id).trim();
  if (/[\\/]/.test(idBruto) || idBruto.includes('..')) return { ok: false, error: 'El identificador no puede contener rutas.' };
  const id = rawId(idBruto);
  if (!id || !ID_RX.test(id)) return { ok: false, error: 'El identificador debe tener letras, números, guion o guion bajo (máx. 24).' };
  // Un transporte desconocido no se degrada a stdio en silencio: se explica.
  const transport = s.transport === undefined || s.transport === null || s.transport === '' ? 'stdio' : String(s.transport);
  if (!TRANSPORTS.includes(transport)) return { ok: false, error: `Transporte no soportado: «${transport}» (usa stdio o http).` };
  const timeoutMs = s.timeoutMs === undefined || s.timeoutMs === '' ? 60000 : Number(s.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 5000 || timeoutMs > 300000) {
    return { ok: false, error: 'El timeout debe estar entre 5 y 300 segundos.' };
  }
  const base = {
    id,
    name: String(s.name || s.id || id).trim().slice(0, 60) || id,
    enabled: s.enabled !== false,
    transport,
    timeoutMs,
    tools: { allow: sanitizeList(s.tools && s.tools.allow), deny: sanitizeList(s.tools && s.tools.deny) },
    autoStart: s.autoStart === true,
  };
  if (transport === 'stdio') {
    const command = String(s.command || '').trim();
    if (!command) return { ok: false, error: 'Falta el comando del servidor.' };
    // Un `args` que no sea lista (JSON pegado de otro cliente, config editado a mano)
    // reventaba en buildCmdLine como «args.map is not a function», que no explica nada.
    // `null` y `''` NO entran aquí: son «sin argumentos», y abortar por ellos descartaría
    // en silencio un servidor que hasta ahora cargaba bien.
    if (s.args != null && s.args !== '' && !Array.isArray(s.args)) {
      return { ok: false, error: 'Los argumentos deben ser una lista (ej.: ["-y", "paquete"]).' };
    }
    try { buildCmdLine(command, s.args || []); }
    catch (e) { return { ok: false, error: e.message }; }
    const env = {};
    for (const [k, v] of Object.entries(s.env && typeof s.env === 'object' ? s.env : {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return { ok: false, error: `Nombre de variable inválido: ${k}` };
      env[k] = String(v == null ? '' : v);
    }
    return { ok: true, value: { ...base, command, args: (s.args || []).map(String), cwd: String(s.cwd || ''), env } };
  }
  const url = String(s.url || '').trim();
  if (!httpUrlAllowed(url)) return { ok: false, error: 'La URL debe ser https (o http en localhost/127.0.0.1).' };
  const headers = {};
  for (const [k, v] of Object.entries(s.headers && typeof s.headers === 'object' ? s.headers : {})) {
    if (!/^[A-Za-z0-9-]+$/.test(k)) return { ok: false, error: `Cabecera inválida: ${k}` };
    headers[k] = String(v == null ? '' : v);
  }
  return { ok: true, value: { ...base, url, headers } };
}

/** Conserva un secreto ya guardado cuando el formulario llega con el campo vacío
    o con la máscara: sin esto, volver a guardar un servidor borraba su token. */
function mergeSecrets(prev = {}, next = {}) {
  const out = { ...prev };
  for (const [k, v] of Object.entries(next || {})) {
    const val = String(v == null ? '' : v);
    out[k] = (!val || val === '••••') ? (prev[k] || '') : val;
  }
  return out;
}

/**
 * Convierte el JSON de `mcpServers` de otro cliente en servidores validados.
 * `command` → stdio, `url` → http. Las entradas que no pasan la validación se
 * descartan (y si ninguna pasa, se explica).
 * @returns {{ok: boolean, error?: string, servers?: object[]}}
 */
function parseMcpImport(text) {
  let raw = null;
  try { raw = JSON.parse(String(text || '')); } catch { return { ok: false, error: 'Eso no es JSON válido.' }; }
  const mapa = (raw && raw.mcpServers) || raw;
  if (!mapa || typeof mapa !== 'object' || Array.isArray(mapa)) return { ok: false, error: 'No encuentro el bloque mcpServers.' };
  const servers = [];
  const rechazados = [];
  for (const [id, def] of Object.entries(mapa)) {
    const d = def && typeof def === 'object' ? def : {};
    const v = validateServer({
      id,
      name: id,
      transport: d.url ? 'http' : 'stdio',
      command: d.command,
      args: d.args,
      env: d.env,
      url: d.url,
      headers: d.headers,
    });
    if (v.ok) servers.push(v.value); else rechazados.push(id + ': ' + v.error);
  }
  if (!servers.length) return { ok: false, error: 'Ningún servidor válido. ' + rechazados.join(' · ') };
  return { ok: true, servers };
}

module.exports = { validateServer, sanitizeList, rawId, mergeSecrets, parseMcpImport };
