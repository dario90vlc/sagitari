'use strict';

/* ============================================================================
   banco.js — lanzador del banco de pruebas de TAREAS de SAGITARI.

   Mide al AGENTE, no al código: le da un punto de partida, un objetivo y un
   criterio de éxito, y mira si lo cumple (con las pruebas del propio proyecto
   de la tarea y con lo que tiene que existir al terminar). Devuelve 0 si todo
   pasa y 1 si algo falla o si hay regresión frente a `bench/linea-base.json`.

   Uso:
     npm run banco                       todas las tareas, tu proveedor activo
     npm run banco -- --tarea bug        solo las que encajen con ese patrón
     npm run banco -- --base             compara con la línea base (gate)
     npm run banco -- --guardar-base     fija la línea base con esta corrida
     npm run banco -- --conservar        no borra el espacio de trabajo
     npm run banco -- --json             informe en una línea (para máquinas)

   ¿Por qué un lanzador y no un script de Node directo? Porque la clave del
   proveedor está cifrada con el almacén del sistema (safeStorage) y solo el
   proceso principal de Electron puede descifrarla: aquí se arranca la app en
   modo `--banco`, sin ventana, y se deja que corra el banco con la MISMA
   configuración que usas a diario — que es lo único que tiene sentido medir.
   ============================================================================ */

const { spawn } = require('child_process');
const electron = require('electron'); // en un proceso Node normal: la ruta del binario
const path = require('path');

const APP_DIR = path.join(__dirname, '..');

/* Argumentos del hijo. El `--json` viaja TAMBIÉN al hijo: el informe en una línea lo
   imprime la app (`if (hay('--json')) log.info(JSON.stringify(informe))`) y filtrarlo aquí
   dejaba stdout sin ninguna línea JSON, así que este lanzador no tenía nada que extraer. */
function argsHijo(argv) {
  return ['.', '--banco', ...argv];
}

/* Última línea con un objeto JSON del hijo: es el informe en una línea (el lanzador lo
   relee así porque el resto de stdout es el progreso humano). */
function informeDeSalida(salida) {
  const linea = String(salida || '')
    .split('\n')
    .reverse()
    .find((l) => l.trim().startsWith('{'));
  return linea ? linea.trim() : null;
}

function lanzar() {
  const args = process.argv.slice(2);
  const quiereJson = args.includes('--json');

  const hijo = spawn(electron, argsHijo(args), {
    cwd: APP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });

  let salida = '';
  hijo.stdout.on('data', (d) => {
    salida += String(d);
    if (!quiereJson) process.stdout.write(d); // el progreso se ve en vivo
  });
  hijo.stderr.on('data', (d) => {
    salida += String(d);
    if (!quiereJson) process.stderr.write(d);
  });

  hijo.on('close', (codigo) => {
    if (quiereJson) {
      const informe = informeDeSalida(salida);
      if (informe) process.stdout.write(informe + '\n');
      else process.stderr.write(salida);
    }
    process.exit(codigo === null ? 1 : codigo);
  });
}

if (require.main === module) lanzar();

module.exports = { argsHijo, informeDeSalida };
