'use strict';

/* Servidor MCP mínimo por stdio para los tests de integración: initialize,
   tools/list en DOS páginas (cursor) y tools/call. Sin dependencias. */

const readline = require('readline');

if (process.env.MCP_ECHO_BANNER) process.stdout.write('Servidor MCP de prueba listo\n');

const TOOLS = [
  { name: 'echo', description: 'Devuelve el texto recibido', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'needle', description: 'Segunda página del catálogo', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'Devuelve isError', inputSchema: { type: 'object', properties: {} } },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m = null;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'eco', version: '1.0.0' } } });
  }
  if (m.method === 'notifications/initialized') return;
  if (m.method === 'tools/list') {
    if (!(m.params && m.params.cursor)) return send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS.slice(0, 2), nextCursor: 'pagina2' } });
    return send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS.slice(2) } });
  }
  if (m.method === 'tools/call') {
    const name = m.params && m.params.name;
    const args = (m.params && m.params.arguments) || {};
    if (name === 'echo') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'eco: ' + String(args.text || '') }] } });
    if (name === 'needle') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'segunda' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] } });
    if (name === 'fail') return send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'no pude hacerlo' }] } });
    return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'herramienta desconocida' } });
  }
  if (m.id) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no soportado: ' + m.method } });
});
