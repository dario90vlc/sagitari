'use strict';

/* Runner de los tests del renderer/agente.
 *
 * Por qué existe: cada archivo *.test.js es un programa suelto que termina con
 * `process.exit(failed ? 1 : 0)`. Eso está bien para lanzarlos de uno en uno,
 * pero hace que la lista del package.json crezca a mano con cada archivo nuevo.
 *
 * Aquí se descubren solos. No se lanza ningún proceso hijo (spawn está vetado
 * en el sandbox de Windows), así que se cargan en ESTE proceso: se intercepta
 * `process.exit` para que el archivo no mate al runner y se captura su salida
 * para leer el recuento. El `process.exit` del archivo lanza una señal interna
 * que se recoge en el `require`, porque es su última instrucción. */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const RE_TEST = /\.test\.js$/;

class FinDeArchivo extends Error {
  constructor(code) {
    super('fin');
    this.code = code;
  }
}

const archivos = fs
  .readdirSync(DIR)
  .filter((f) => RE_TEST.test(f))
  .sort();

if (!archivos.length) {
  console.error('No hay archivos *.test.js en ' + DIR);
  process.exit(1);
}

const exitReal = process.exit.bind(process);
const writeReal = process.stdout.write.bind(process.stdout);
const errorReal = process.stderr.write.bind(process.stderr);

const resultados = [];

for (const archivo of archivos) {
  let salida = '';
  let code = 0;

  process.stdout.write = (chunk, ...rest) => {
    salida += String(chunk);
    return writeReal(chunk, ...rest);
  };
  process.stderr.write = (chunk, ...rest) => {
    salida += String(chunk);
    return errorReal(chunk, ...rest);
  };
  process.exit = (c) => {
    throw new FinDeArchivo(typeof c === 'number' ? c : 0);
  };

  let reventó = null;
  try {
    require(path.join(DIR, archivo));
    // Si el archivo no llama a process.exit, se da por bueno.
  } catch (e) {
    if (e instanceof FinDeArchivo) code = e.code;
    else reventó = e;
  } finally {
    process.exit = exitReal;
    process.stdout.write = writeReal;
    process.stderr.write = errorReal;
  }

  const m = salida.match(/(\d+)\s+pasaron,\s+(\d+)\s+fallaron/);
  const pasaron = m ? Number(m[1]) : 0;
  const fallaron = m ? Number(m[2]) : 0;

  if (reventó) {
    console.error('\n✗ ' + archivo + ' reventó: ' + (reventó && reventó.stack ? reventó.stack : reventó));
    code = 1;
  } else if (!m) {
    console.error('\n✗ ' + archivo + ' no informó de resultados (¿le falta el resumen final?)');
    code = 1;
  } else if (fallaron || code !== 0) {
    console.error('\n✗ ' + archivo + ': ' + pasaron + ' pasaron, ' + fallaron + ' fallaron');
  }

  resultados.push({ archivo, pasaron, fallaron, code, reventó: !!reventó });
}

const totalPasaron = resultados.reduce((n, r) => n + r.pasaron, 0);
const totalFallaron = resultados.reduce((n, r) => n + r.fallaron, 0);
const archivosMal = resultados.filter((r) => r.code !== 0 || r.fallaron || r.reventó).length;

console.log('\n' + '─'.repeat(60));
console.log('Archivos: ' + resultados.length + '   Pruebas: ' + totalPasaron + ' pasaron, ' + totalFallaron + ' fallaron');
if (archivosMal) {
  console.log('Archivos con fallos:');
  for (const r of resultados) if (r.code !== 0 || r.fallaron || r.reventó) console.log('  ✗ ' + r.archivo);
}
console.log('─'.repeat(60));

exitReal(archivosMal || totalFallaron ? 1 : 0);
