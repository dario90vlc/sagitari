'use strict';

/* Tests para main/mcp-config.js — validación de la configuración de un servidor MCP.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const mcpConfig = require(path.join(__dirname, '..', '..', 'main', 'mcp-config.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${e.message}`);
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || ''} esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
}

console.log('mcp-config.js — rawId');

test('convierte un nombre en un id válido', () => {
  assertEqual(mcpConfig.rawId('Mi Servidor MCP!!'), 'mi_servidor_mcp');
});

test('recorta a 24 caracteres', () => {
  const id = mcpConfig.rawId('a'.repeat(50));
  assertEqual(id.length, 24);
});

test('maneja cadena vacía', () => {
  assertEqual(mcpConfig.rawId(''), '');
});

test('quita guiones bajos sobrantes de los extremos', () => {
  assertEqual(mcpConfig.rawId('__hola__'), 'hola');
});

console.log('mcp-config.js — sanitizeList');

test('separa una cadena por comas', () => {
  assertEqual(mcpConfig.sanitizeList('a, b ,,c').join(','), 'a,b,c');
});

test('acepta un array y descarta lo que no sea cadena', () => {
  assertEqual(mcpConfig.sanitizeList([1, 'x', null, 'y']).join(','), 'x,y');
});

test('quita duplicados', () => {
  assertEqual(mcpConfig.sanitizeList(['a', 'a', 'b']).join(','), 'a,b');
});

test('maneja entradas vacías', () => {
  assertEqual(mcpConfig.sanitizeList(null).length, 0);
  assertEqual(mcpConfig.sanitizeList(undefined).length, 0);
});

console.log('mcp-config.js — mergeSecrets');

test('conserva el secreto si llega vacío o enmascarado', () => {
  assertEqual(mcpConfig.mergeSecrets({ TOKEN: 'real' }, { TOKEN: '' }).TOKEN, 'real');
  assertEqual(mcpConfig.mergeSecrets({ TOKEN: 'real' }, { TOKEN: '••••' }).TOKEN, 'real');
});

test('un valor nuevo manda', () => {
  assertEqual(mcpConfig.mergeSecrets({ TOKEN: 'viejo' }, { TOKEN: 'nuevo' }).TOKEN, 'nuevo');
});

test('una clave ausente del mapa nuevo se borra (no se arrastra el secreto anterior)', () => {
  const out = mcpConfig.mergeSecrets({ Authorization: 'Bearer viejo', OTRO: 'x' }, { OTRO: 'y' });
  assertEqual(out.Authorization, undefined, 'el Authorization del servidor anterior no sobrevive');
  assertEqual(out.OTRO, 'y');
});

test('reemplazar un servidor sin cabeceras deja el mapa vacío', () => {
  assertEqual(Object.keys(mcpConfig.mergeSecrets({ Authorization: 'Bearer viejo' }, {})).length, 0);
});

console.log('mcp-config.js — mergeUrl');

test('restaura la credencial del userinfo si el destino no cambió', () => {
  const g = 'https://usuario:token-secreto@viejo.ejemplo.com/mcp';
  assertEqual(mcpConfig.mergeUrl(g, mcpConfig.enmascararUrl(g)), g, 'misma URL:');
});

test('restaura el parámetro de credencial si el destino no cambió', () => {
  const g = 'https://viejo.ejemplo.com/mcp?key=SECRETO';
  assertEqual(mcpConfig.mergeUrl(g, mcpConfig.enmascararUrl(g)), g, 'misma URL:');
});

test('no reinyecta el userinfo cuando cambia el host', () => {
  const g = 'https://usuario:token-secreto@viejo.ejemplo.com/mcp';
  const nueva = mcpConfig.enmascararUrl(g).replace('viejo.ejemplo.com', 'nuevo.ejemplo.com');
  const out = mcpConfig.mergeUrl(g, nueva);
  assertEqual(out, nueva, 'se guarda sin la credencial vieja:');
  assertEqual(out.includes('token-secreto'), false, 'el secreto no viaja al host nuevo:');
});

test('no reinyecta el parámetro de credencial cuando cambia el host', () => {
  const g = 'https://viejo.ejemplo.com/mcp?key=SECRETO';
  const nueva = mcpConfig.enmascararUrl(g).replace('viejo.ejemplo.com', 'nuevo.ejemplo.com');
  const out = mcpConfig.mergeUrl(g, nueva);
  assertEqual(out, nueva, 'se guarda sin la credencial vieja:');
  assertEqual(out.includes('SECRETO'), false, 'el secreto no viaja al host nuevo:');
});

console.log('mcp-config.js — validateServer');

test('acepta un servidor stdio válido', () => {
  const r = mcpConfig.validateServer({ id: 'mi_mcp', name: 'Mi MCP', transport: 'stdio', command: 'node server.js' });
  assertEqual(r.ok, true);
  assertEqual(r.value.id, 'mi_mcp');
  assertEqual(r.value.transport, 'stdio');
});

test('el servidor nace encendido: la bandera del arranque es `enabled`', () => {
  /* `autoStart` no lo lee nadie (ningún control del formulario lo escribe), así que
     probarlo no probaba el arreglo: el criterio real del arranque (main.js) y de
     `mcp:setGlobal` (ipc-mcp.js) es `enabled`. Ese criterio se ejercita con el router
     en 30-sistema; aquí solo se fija el valor que lo alimenta. */
  const r = mcpConfig.validateServer({ id: 'mi_mcp', transport: 'stdio', command: 'node server.js' });
  assertEqual(r.value.enabled, true, 'sin decirlo, queda encendido:');
  const off = mcpConfig.validateServer({ id: 'mi_mcp', transport: 'stdio', command: 'node server.js', enabled: false });
  assertEqual(off.value.enabled, false, 'y se respeta el «no» explícito:');
});

test('rechaza un servidor sin identificador', () => {
  const r = mcpConfig.validateServer({ name: 'X', transport: 'stdio', command: 'node x.js' });
  assertEqual(r.ok, false);
});

test('rechaza un identificador con ruta', () => {
  const r = mcpConfig.validateServer({ id: '../fuera', transport: 'stdio', command: 'node x.js' });
  assertEqual(r.ok, false);
});

test('rechaza un transporte desconocido', () => {
  const r = mcpConfig.validateServer({ id: 'x', transport: 'carrier-pigeon' });
  assertEqual(r.ok, false);
});

test('rechaza un servidor http sin URL', () => {
  const r = mcpConfig.validateServer({ id: 'x', transport: 'http' });
  assertEqual(r.ok, false);
});

test('rechaza una URL que no es http(s)', () => {
  const r = mcpConfig.validateServer({ id: 'x', transport: 'http', url: 'file:///C:/secreto' });
  assertEqual(r.ok, false);
});

test('acepta un servidor http con URL https', () => {
  const r = mcpConfig.validateServer({ id: 'x', transport: 'http', url: 'https://ejemplo.com/mcp' });
  assertEqual(r.ok, true);
});

test('rechaza un timeout fuera de rango', () => {
  const r = mcpConfig.validateServer({ id: 'x', transport: 'stdio', command: 'node x.js', timeoutMs: 1 });
  assertEqual(r.ok, false);
});

test('rechaza un servidor stdio sin comando', () => {
  const r = mcpConfig.validateServer({ id: 'x', transport: 'stdio' });
  assertEqual(r.ok, false);
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
