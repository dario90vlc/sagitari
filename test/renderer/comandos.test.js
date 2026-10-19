'use strict';

/* Tests para agent/comandos.js — funciones puras de seguridad de comandos.
   Sin spawn: se ejecuta directo con node. */

const path = require('path');
const comandos = require(path.join(__dirname, '..', '..', 'agent', 'comandos.js'));

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

console.log('comandos.js — clasificar');

test('clasifica git status como normal', () => {
  const c = comandos.clasificar('git status');
  assertEqual(c.nivel, 'normal');
});

test('clasifica format C: como prohibido', () => {
  const c = comandos.clasificar('format C:');
  assertEqual(c.nivel, 'prohibido');
});

test('clasifica rm -rf / como prohibido', () => {
  const c = comandos.clasificar('rm -rf /');
  assertEqual(c.nivel, 'prohibido');
});

test('clasifica del /s /q C:\\ como prohibido', () => {
  const c = comandos.clasificar('del /s /q C:\\');
  assertEqual(c.nivel, 'prohibido');
});

test('clasifica echo hola como normal', () => {
  const c = comandos.clasificar('echo hola');
  assertEqual(c.nivel, 'normal');
});

test('clasifica comando vacío como normal', () => {
  const c = comandos.clasificar('');
  assertEqual(c.nivel, 'normal');
});

console.log('comandos.js — el nombre del ejecutable no evade la barrera');

test('clasifica format.com C: /q como prohibido (la extensión no cambia la orden)', () => {
  const c = comandos.clasificar('format.com C: /q');
  assertEqual(c.nivel, 'prohibido');
});

test('clasifica cipher.exe /w:C: como prohibido', () => {
  const c = comandos.clasificar('cipher.exe /w:C:');
  assertEqual(c.nivel, 'prohibido');
});

test('clasifica vssadmin.exe delete shadows /all como prohibido', () => {
  const c = comandos.clasificar('vssadmin.exe delete shadows /all');
  assertEqual(c.nivel, 'prohibido');
});

test('la ruta del ejecutable tampoco evade: C:\\Windows\\System32\\format.exe C: /q', () => {
  const c = comandos.clasificar('C:\\Windows\\System32\\format.exe C: /q');
  assertEqual(c.nivel, 'prohibido');
});

test('las comillas no esconden la raíz: del /s /q "C:\\"', () => {
  const c = comandos.clasificar('del /s /q "C:\\"');
  assertEqual(c.nivel, 'prohibido');
});

test('un encadenado no tapa la orden de dentro: echo hola && format.com C: /q', () => {
  const c = comandos.clasificar('echo hola && format.com C: /q');
  assertEqual(c.nivel, 'prohibido');
});

test('un lanzador por delante no esconde la orden: sudo del /s /q C:\\', () => {
  const c = comandos.clasificar('sudo del /s /q C:\\');
  assertEqual(c.nivel, 'prohibido');
});

test('un intérprete por delante tampoco: cmd /c · bash -c', () => {
  assertEqual(comandos.clasificar('cmd /c del /s /q C:\\').nivel, 'prohibido');
  assertEqual(comandos.clasificar('bash -c "rm -rf /"').nivel, 'prohibido');
});

console.log('comandos.js — mencionar la orden no es ejecutarla');

test('echo format C: sigue siendo normal: solo lo menciona', () => {
  const c = comandos.clasificar('echo format C: es peligroso');
  assertEqual(c.nivel, 'normal');
});

test('el mensaje de un git commit -m que menciona la orden es normal', () => {
  const c = comandos.clasificar('git commit -m "arregla el format C: del script"');
  assertEqual(c.nivel, 'normal');
});

test('buscar la palabra (git log --grep) es normal', () => {
  const c = comandos.clasificar('git log --grep="cipher /w"');
  assertEqual(c.nivel, 'normal');
});

test('una mención dentro de un intérprete también es normal', () => {
  const c = comandos.clasificar('powershell -Command "echo format C: es inocente"');
  assertEqual(c.nivel, 'normal');
});

console.log('comandos.js — esSeguro');

test('git status es seguro', () => {
  assertEqual(comandos.esSeguro('git status'), true);
});

test('format C: no es seguro', () => {
  assertEqual(comandos.esSeguro('format C:'), false);
});

test('rm -rf / no es seguro', () => {
  assertEqual(comandos.esSeguro('rm -rf /'), false);
});

test('echo hola es seguro', () => {
  assertEqual(comandos.esSeguro('echo hola'), true);
});

console.log('comandos.js — compuesta');

test('git status no es compuesta', () => {
  assertEqual(comandos.compuesta('git status'), false);
});

test('git status && git push es compuesta', () => {
  assertEqual(comandos.compuesta('git status && git push'), true);
});

test('echo hola | grep test es compuesta', () => {
  assertEqual(comandos.compuesta('echo hola | grep test'), true);
});

test('comando vacío no es compuesta', () => {
  assertEqual(comandos.compuesta(''), false);
});

console.log('comandos.js — anteponer una palabra tampoco evade la barrera');

/* La revisión del diff cazó que la clasificación por tokens —que arregla la evasión por
   extensión y por comillas— dejaba pasar el MISMO comando con un prefijo de cmd.exe
   delante: `start`, `@`, una redirección, `if`, `for…do` o `ftype x=`. Las reglas van
   ancladas al principio, así que estos prefijos hay que quitarlos antes de mirar la orden
   (agent/comandos.js → `desnudar`). Son prohibidos: no se ejecutan ni con permiso. */
for (const t of [
  'start format C: /q',
  'start /wait format C: /q',
  '>nul format C: /q',
  '2>nul format C: /q',
  '> log.txt format C: /q',
  '@format C: /q',
  'if exist x format C: /q',
  'if not exist x del /s /q C:\\',
  'for %i in (*) do del /s /q C:\\',
  'ftype x=format C: /q',
  '(format C: /q)',
  'start powershell -c "cipher /w:C:"',
  'start "" /b format C: /q',
  '%COMSPEC% /c format C: /q',
  '%ComSpec% /c diskpart',
  'FOO=1 format C: /q',
]) {
  test('anteponer «' + t.slice(0, 22) + '» sigue siendo prohibido', () => {
    assertEqual(comandos.clasificar(t).nivel, 'prohibido');
  });
}

/* Y el otro lado: los prefijos NO pueden convertir en prohibido lo que solo menciona la
   orden (escribirla en un `echo`, en un mensaje de commit o en una lista). */
for (const t of ['start notepad', 'if exist x echo hola', 'for %i in (*) do echo %i', '> salida.txt echo hola', '(echo hola)', 'FOO=1 npm run build', 'echo %COMSPEC% /c format C: es un ejemplo']) {
  test('pero «' + t.slice(0, 22) + '» sigue siendo normal', () => {
    assertEqual(comandos.clasificar(t).nivel, 'normal');
  });
}

console.log(`\n${passed} pasaron, ${failed} fallaron`);
process.exit(failed ? 1 : 0);
