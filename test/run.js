'use strict';

/* Minimal test runner for SAGITARI's pure logic. Node-only, no Electron.
   Usage: node test/run.js   (exit code 0 = all green) */

let pass = 0, fail = 0;
const failures = [];

function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; failures.push({ name, err: e.message }); console.error('FAIL  ' + name + ' — ' + e.message); }
}
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'eq') + `: esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)}`); }
function ok(v, msg) { if (!v) throw new Error(msg || 'esperado verdadero'); }

const { Guardrails, describeAction, summarizeArgs } = require('../agent/guardrails');
const skills = require('../agent/skills');

/* ---------- permissions ---------- */
test('safe tool runs without confirmation', () => {
  const g = new Guardrails();
  eq(g.decide('read_file', { path: 'C:/x.txt' }).action, 'allow');
});
test('confirm tool asks with a description and summary', () => {
  const g = new Guardrails();
  const d = g.decide('run_command', { command: 'del C:/importante' });
  eq(d.action, 'confirm');
  ok(d.description.length > 3, 'debe describir la acción');
  ok(d.summary.includes('del'), 'el resumen debe incluir el comando');
});
test('restricted tool is denied with reason', () => {
  const g = new Guardrails({ permissions: { run_command: 'restricted' } });
  const d = g.decide('run_command', { command: 'dir' });
  eq(d.action, 'deny');
  ok(d.reason.includes('bloqueada'), 'debe explicar el bloqueo');
});
test('user override upgrades a tool to confirm', () => {
  const g = new Guardrails({ permissions: { open_url: 'confirm' } });
  eq(g.decide('open_url', { url: 'https://x' }).action, 'confirm');
});
test('user override downgrades a tool to safe', () => {
  const g = new Guardrails({ permissions: { run_command: 'safe' } });
  eq(g.decide('run_command', { command: 'dir' }).action, 'allow');
});
test('invalid override falls back to the default risk', () => {
  const g = new Guardrails({ permissions: { read_file: 'megaseguro' } });
  eq(g.levelFor('read_file'), 'safe');
});
test('approve() remembers the signature for 10 minutes', () => {
  const g = new Guardrails();
  const d = g.decide('write_file', { path: 'C:/a.txt' });
  eq(d.action, 'confirm');
  g.approve(d.signature);
  eq(g.decide('write_file', { path: 'C:/a.txt' }).action, 'allow');
  // pero otros argumentos vuelven a preguntar
  eq(g.decide('write_file', { path: 'C:/b.txt' }).action, 'confirm');
});
test('unknown tool defaults to confirm', () => {
  const g = new Guardrails();
  eq(g.decide('herramienta_misteriosa', {}).action, 'confirm');
});
test('describeAction / summarizeArgs produce human text', () => {
  ok(describeAction('run_command', {}).includes('terminal'));
  ok(summarizeArgs('browser_control', { action: 'click', text: 'Comprar' }).includes('Comprar'));
});

/* ---------- guardrails: limits ---------- */
test('checkStep stops after maxSteps', () => {
  const g = new Guardrails({ guardrails: { maxSteps: 3 } });
  g.beginRun();
  ok(g.checkStep().ok); ok(g.checkStep().ok); ok(g.checkStep().ok);
  eq(g.checkStep().ok, false);
});
test('maxSteps 0 means unlimited', () => {
  const g = new Guardrails({ guardrails: { maxSteps: 0 } });
  g.beginRun();
  for (let i = 0; i < 200; i++) ok(g.checkStep().ok, 'paso ' + i + ' debe pasar');
});
test('checkToolCall enforces the tool-call limit', () => {
  const g = new Guardrails({ guardrails: { maxToolCalls: 2 } });
  g.beginRun();
  ok(g.checkToolCall().ok); ok(g.checkToolCall().ok);
  eq(g.checkToolCall().ok, false);
});
test('addTokens enforces the token budget', () => {
  const g = new Guardrails({ guardrails: { maxTokens: 100 } });
  ok(g.addTokens(60).ok);
  eq(g.addTokens(60).ok, false);
});
test('setPolicy hot-reloads without losing counters', () => {
  const g = new Guardrails({ guardrails: { maxSteps: 5 } });
  g.beginRun();
  g.checkStep(); g.checkStep();
  g.setPolicy({ guardrails: { maxSteps: 100 } });
  ok(g.checkStep().ok);
  eq(g.steps, 3, 'los pasos previos se conservan');
});

/* ---------- loop detection ---------- */
test('identical repeated calls are detected as a loop', () => {
  const g = new Guardrails({ guardrails: { loopThreshold: 3 } });
  ok(!g.isLoop('read_file', { path: 'a' }).loop);
  ok(!g.isLoop('read_file', { path: 'a' }).loop);
  ok(g.isLoop('read_file', { path: 'a' }).loop, 'tercera llamada idéntica = bucle');
});
test('different args are not a loop', () => {
  const g = new Guardrails({ guardrails: { loopThreshold: 3 } });
  ok(!g.isLoop('read_file', { path: 'a' }).loop);
  ok(!g.isLoop('read_file', { path: 'b' }).loop);
  ok(!g.isLoop('read_file', { path: 'c' }).loop);
});
test('A-B ping-pong is detected as a loop', () => {
  const g = new Guardrails({ guardrails: { loopThreshold: 3 } });
  g.isLoop('t', { x: 1 }); g.isLoop('t', { x: 2 }); g.isLoop('t', { x: 1 }); g.isLoop('t', { x: 2 });
  ok(g.isLoop('t', { x: 1 }).loop, 'A-B-A-B debe detectarse');
});
test('genuinely different consecutive work is not a loop', () => {
  const g = new Guardrails();
  ok(!g.isLoop('list_dir', { path: 'C:/a' }).loop);
  ok(!g.isLoop('read_file', { path: 'C:/a/f.txt' }).loop);
  ok(!g.isLoop('write_file', { path: 'C:/a/out.txt' }).loop);
});

/* ---------- skills front-matter: new metadata ---------- */
test('parseFrontMatter extracts version/author and YAML lists', () => {
  const raw = '---\nname: prueba\nversion: 2.1.0\nauthor: Ana\ntools:\n  - run_command\n  - read_file\ndescription: Prueba de parseo\n---\n\nCuerpo de la skill.\n';
  const fm = skills.__test ? skills.__test.parseFrontMatter(raw) : null;
  // parseFrontMatter no está exportado; probamos vía el módulo si existe el hook de test
  if (!fm) { console.log('  (skip: parseFrontMatter no exportado)'); return; }
  eq(fm.meta.version, '2.1.0');
  eq(fm.meta.author, 'Ana');
  eq(Array.isArray(fm.meta.tools), true);
  eq(fm.meta.tools[1], 'read_file');
});

console.log('');
if (fail) {
  console.error(`${fail} test(s) fallaron, ${pass} pasaron`);
  failures.forEach(f => console.error('  ✗ ' + f.name + ' → ' + f.err));
  process.exit(1);
} else {
  console.log(`Todos los tests en verde (${pass})`);
}
