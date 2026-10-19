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

console.log('mcp-config.js — validateServer');

test('acepta un servidor stdio válido', () => {
  const r = mcpConfig.validateServer({ id: 'mi_mcp', name: 'Mi MCP', transport: 'stdio', command: 'node server.js' });
  assertEqual(r.ok, true);
  assertEqual(r.value.id, 'mi_mcp');
  assertEqual(r.value.transport, 'stdio');
});

test('un servidor se conecta al arrancar salvo que se diga lo contrario', () => {
  /* El arranque conectaba solo los `autoStart`, y ese campo se guardaba como `false` al
     no venir del formulario (no hay ningún control que lo ponga): el catálogo MCP nacía
     vacío en cada arranque y el modelo no veía ninguna herramienta MCP. Ahora el
     interruptor por servidor es `enabled`, y `autoStart` es verdadero por defecto. */
  const r = mcpConfig.validateServer({ id: 'mi_mcp', transport: 'stdio', command: 'node server.js' });
  assertEqual(r.value.autoStart, true, 'sin decirlo, arranca con la app:');
  const off = mcpConfig.validateServer({ id: 'mi_mcp', transport: 'stdio', command: 'node server.js', autoStart: false });
  assertEqual(off.value.autoStart, false, 'y se respeta el «no» explícito:');
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
