'use strict';

/* Tests para agent/subagents.js — equipo de especialistas y delegación.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const subagents = require(path.join(__dirname, '..', '..', 'agent', 'subagents.js'));

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

function assertOk(value, msg) {
  if (!value) throw new Error(msg || 'valor falso');
}

console.log('subagents.js — catálogo');

test('hay siete especialistas', () => {
  assertEqual(subagents.SUBAGENT_KEYS.length, 7);
});

test('están los especialistas esperados', () => {
  for (const k of ['research', 'browser', 'coding', 'file', 'vision', 'verification', 'review']) {
    assertOk(subagents.SUBAGENT_KEYS.includes(k), 'falta ' + k);
  }
});

test('cada especialista tiene nombre, rol y herramientas', () => {
  for (const k of subagents.SUBAGENT_KEYS) {
    const s = subagents.SUBAGENTS[k];
    assertOk(s.name, k + ' sin nombre');
    assertOk(s.role, k + ' sin rol');
    assertOk(Array.isArray(s.allowTools), k + ' sin allowTools');
    assertOk(s.allowTools.length > 0, k + ' sin herramientas permitidas');
  }
});

test('la guía de delegación menciona cada especialista', () => {
  for (const k of subagents.SUBAGENT_KEYS) {
    assertOk(subagents.DELEGATION_GUIDE.includes(k), 'la guía no menciona ' + k);
  }
});

console.log('subagents.js — delegateToolDef');

test('describe la herramienta delegate', () => {
  const d = subagents.delegateToolDef();
  assertEqual(d.type, 'function');
  assertEqual(d.function.name, 'delegate');
  assertOk(d.function.description.length > 0, 'debe tener descripción');
  assertOk(d.function.parameters, 'debe tener parámetros');
});

console.log('subagents.js — toolDefsFor');

test('devuelve las herramientas del especialista', () => {
  const defs = subagents.toolDefsFor('research');
  assertOk(defs.length > 0, 'debe tener herramientas');
  assertOk(
    defs.every((d) => subagents.SUBAGENTS.research.allowTools.includes(d.function.name)),
    'no debe colar herramientas de fuera',
  );
});

test('coding puede escribir y ejecutar', () => {
  const nombres = subagents.toolDefsFor('coding').map((d) => d.function.name);
  assertOk(nombres.includes('write_file'), 'debe poder escribir');
  assertOk(nombres.includes('run_command'), 'debe poder ejecutar');
});

test('un especialista inventado no tiene herramientas', () => {
  assertEqual(subagents.toolDefsFor('inventado').length, 0);
});

console.log('subagents.js — buildSubagentBrief');

test('incluye la subtarea', () => {
  const b = subagents.buildSubagentBrief({ task: 'hacer X' });
  assertOk(b.includes('hacer X'), 'debe incluir la tarea');
});

test('incluye el contexto cuando lo hay', () => {
  const b = subagents.buildSubagentBrief({ task: 't', context: 'dato previo' });
  assertOk(b.includes('dato previo'), 'debe incluir el contexto');
});

test('incluye el criterio de éxito cuando lo hay', () => {
  const b = subagents.buildSubagentBrief({ task: 't', expect: 'que pase el test' });
  assertOk(b.includes('que pase el test'), 'debe incluir el criterio');
});

test('sin contexto no inventa la sección', () => {
  const b = subagents.buildSubagentBrief({ task: 't' });
  assertOk(!b.includes('CONTEXTO DEL ORQUESTADOR'), 'no debe haber sección de contexto');
});

test('maneja opciones vacías', () => {
  const b = subagents.buildSubagentBrief({});
  assertOk(typeof b === 'string', 'debe devolver una cadena');
});

console.log('subagents.js — formatDelegationBoard');

test('formatea una entrada del equipo', () => {
  const b = subagents.formatDelegationBoard([{ agent: 'research', task: 'buscar algo', result: 'hecho' }]);
  assertOk(b.includes('research'), 'debe incluir el agente');
  assertOk(b.includes('buscar algo'), 'debe incluir la tarea');
  assertOk(b.includes('hecho'), 'debe incluir el resultado');
});

test('un tablero vacío no pinta nada', () => {
  assertEqual(subagents.formatDelegationBoard([]), '');
});

test('descarta entradas sin agente', () => {
  assertEqual(subagents.formatDelegationBoard([{ task: 'sin agente' }]), '');
});

console.log('subagents.js — parseSubagentResult');

test('extrae resultado y evidencia', () => {
  const r = subagents.parseSubagentResult('RESULTADO: todo bien\nEVIDENCIA: log.txt');
  assertOk(r, 'debe devolver un objeto');
  assertEqual(r.result, 'todo bien');
  assertEqual(r.evidence, 'log.txt');
});

test('reconoce las etiquetas en inglés', () => {
  const r = subagents.parseSubagentResult('RESULT: done\nEVIDENCE: out.log');
  assertEqual(r.result, 'done');
  assertEqual(r.evidence, 'out.log');
});

test('maneja texto vacío sin reventar', () => {
  const r = subagents.parseSubagentResult('');
  assertOk(r && typeof r === 'object', 'debe devolver un objeto');
});

test('maneja null', () => {
  const r = subagents.parseSubagentResult(null);
  assertOk(r && typeof r === 'object', 'debe devolver un objeto');
});

console.log('subagents.js — subagentSystemPrompt');

test('el prompt incluye el espacio de trabajo', () => {
  const p = subagents.subagentSystemPrompt('research', 'C:\\ws');
  assertOk(p.includes('C:\\ws'), 'debe incluir el espacio de trabajo');
});

test('el prompt incluye las herramientas permitidas', () => {
  const p = subagents.subagentSystemPrompt('coding', '');
  assertOk(p.includes('write_file'), 'debe mencionar write_file');
});

test('el prompt incluye el índice de skills cuando se le pasa', () => {
  const p = subagents.subagentSystemPrompt('research', '', { skillsIndex: 'SKILL-A' });
  assertOk(p.includes('SKILL-A'), 'debe incluir el índice');
});

test('sin índice de skills no añade el bloque', () => {
  const p = subagents.subagentSystemPrompt('research', '');
  assertOk(!p.includes('SKILLS DE TU ESPECIALIDAD'), 'no debe haber bloque de skills');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
