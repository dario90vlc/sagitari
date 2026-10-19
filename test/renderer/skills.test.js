'use strict';

/* Tests para agent/skills.js — función pura parseFrontMatter.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const skills = require(path.join(__dirname, '..', '..', 'agent', 'skills.js'));
const { parseFrontMatter } = skills.__test;

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

console.log('skills.js — parseFrontMatter');

test('parsea front-matter simple', () => {
  const raw = '---\nname: mi-skill\ndescription: Qué hace\n---\nCuerpo de la skill';
  const result = parseFrontMatter(raw);
  assertOk(result, 'debe devolver un resultado');
  assertEqual(result.meta.name, 'mi-skill');
  assertEqual(result.meta.description, 'Qué hace');
  assertEqual(result.body, 'Cuerpo de la skill');
});

test('parsea front-matter con lista', () => {
  const raw = '---\nname: mi-skill\nagents:\n  - coding\n  - browser\n---\nCuerpo';
  const result = parseFrontMatter(raw);
  assertOk(result, 'debe devolver un resultado');
  assertEqual(result.meta.name, 'mi-skill');
  assertOk(Array.isArray(result.meta.agents), 'agents debe ser un array');
  assertEqual(result.meta.agents.length, 2);
  assertEqual(result.meta.agents[0], 'coding');
  assertEqual(result.meta.agents[1], 'browser');
});

test('parsea front-matter con comillas', () => {
  const raw = '---\nname: "mi skill"\ndescripcion: "Qué hace"\n---\nCuerpo';
  const result = parseFrontMatter(raw);
  assertOk(result, 'debe devolver un resultado');
  assertEqual(result.meta.name, 'mi skill');
  assertEqual(result.meta.descripcion, 'Qué hace');
});

test('devuelve null si no hay front-matter', () => {
  const raw = 'Sin front-matter';
  const result = parseFrontMatter(raw);
  assertEqual(result, null);
});

test('maneja front-matter vacío', () => {
  const raw = '---\n---\nCuerpo';
  const result = parseFrontMatter(raw);
  // Front-matter vacío no coincide con el regex → null
  assertEqual(result, null);
});

test('maneja front-matter con bloque YAML', () => {
  const raw = '---\nname: mi-skill\ndescription: >\n  Línea 1\n  Línea 2\n---\nCuerpo';
  const result = parseFrontMatter(raw);
  assertOk(result, 'debe devolver un resultado');
  assertEqual(result.meta.name, 'mi-skill');
  assertOk(result.meta.description.includes('Línea 1'), 'debe incluir la primera línea');
  assertOk(result.meta.description.includes('Línea 2'), 'debe incluir la segunda línea');
});

test('acepta un SKILL.md con BOM UTF-8', () => {
  const raw = '\uFEFF---\nname: con-bom\ndescription: Qué hace\n---\nCuerpo';
  const result = parseFrontMatter(raw);
  assertOk(result, 'un BOM delante no puede invalidar el front-matter');
  assertEqual(result.meta.name, 'con-bom');
  assertEqual(result.meta.description, 'Qué hace');
  assertEqual(result.body, 'Cuerpo');
});

test('decodifica un SKILL.md guardado en UTF-16 (Out-File de PowerShell)', () => {
  // es el texto que llega cuando un fichero utf16le (con su BOM FF FE) se lee como
  // utf8: cada carácter ASCII trae su \0 al lado y el BOM queda como dos U+FFFD
  const bytes = Buffer.from('---\nname: en-utf16\ndescription: y\n---\nCuerpo', 'utf16le');
  const raw = '\uFFFD\uFFFD' + bytes.toString('utf8');
  const result = parseFrontMatter(raw);
  assertOk(result, 'un SKILL.md en UTF-16 no puede desaparecer en silencio');
  assertEqual(result.meta.name, 'en-utf16');
  assertEqual(result.body, 'Cuerpo');
});

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
