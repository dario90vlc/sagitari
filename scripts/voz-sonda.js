'use strict';

/* Sonda del motor de dictado: arranca `main/voice.ps1` con los MISMOS argumentos que la
 * app, cuenta lo que devuelve y remata con un veredicto.
 *
 * Para qué: el modo voz cae al motor clásico cuando el moderno no puede arrancar, y esa
 * caída se ve como «no me reconoce la voz» sin más. Aquí se ve cuál de los dos corre, en
 * qué idioma y cuántas frases devuelve. No guarda audio en ningún sitio: solo imprime el
 * texto que el motor ha reconocido.
 *
 * Uso:  node scripts/voz-sonda.js [segundos] [idioma]
 *       (por defecto 30 s y es-ES, que es lo que trae Ajustes > Voz)
 */
const path = require('path');
const { spawn } = require('child_process');
const { partirLinea, SEP_CONFIANZA } = require('../main/voice/protocolo');

const SEGUNDOS = Math.max(8, Number(process.argv[2]) || 30);
const LANG = process.argv[3] || 'es-ES';
const SCRIPT = path.join(__dirname, '..', 'main', 'voice.ps1');

const t0 = Date.now();
const visto = { motor: '', idioma: '', parciales: 0, finales: [], avisos: [], errores: [] };
const marca = () => ('+' + ((Date.now() - t0) / 1000).toFixed(1) + 's').padStart(7);

console.log('Sonda del motor de dictado — ' + SEGUNDOS + ' s, idioma ' + LANG);
console.log('No se graba nada: solo se imprime lo que el motor reconozca.');
console.log('');
console.log('AHORA: habla con tu voz normal, dos o tres frases seguidas.');
console.log('DESPUÉS: calla unos segundos a propósito (sirve para ver si el silencio hace');
console.log('         que el motor se rinda o cambie al clásico).');
console.log('');

/* Igual que la app: sin `-NoWinrt`, para que se pueda ver la caída al motor clásico.
   La entrada estándar NO se cierra: `voice.ps1` la vigila para salir si la app muere. */
const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Lang', LANG], { windowsHide: true });

let buf = '';
p.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const linea = buf.slice(0, i).replace(/\r$/, '').trim();
    buf = buf.slice(i + 1);
    if (linea) anota(linea);
  }
});
p.stderr.on('data', (d) => {
  const m = d.toString('utf8').trim();
  if (m) console.log(marca() + '   [stderr] ' + m.slice(0, 300));
});
p.on('error', (e) => {
  console.log('No se pudo arrancar PowerShell: ' + e.message);
  process.exit(1);
});

function anota(linea) {
  /* La frase va con su confianza detrás de un separador de unidad: se enseña aparte para
     que se lea, y para no confundirla con parte de lo dictado. */
  const corte = linea.indexOf(SEP_CONFIANZA);
  const legible = corte >= 0 ? linea.slice(0, corte) + '   (confianza ' + linea.slice(corte + 1) + ')' : linea;
  const parte = partirLinea(linea);
  const tipo = parte ? parte.prefijo.replace('::', '') : 'RUIDO';
  console.log(marca() + '   ' + tipo.padEnd(7) + ' ' + (parte ? parte.cuerpo : legible));
  if (!parte) return;
  const { prefijo, cuerpo } = parte;
  if (prefijo === 'MODE::') visto.motor = cuerpo;
  else if (prefijo === 'READY::') visto.idioma = cuerpo;
  else if (prefijo === 'PART::') visto.parciales++;
  else if (prefijo === 'FINAL::') visto.finales.push({ t: (Date.now() - t0) / 1000, texto: cuerpo });
  else if (prefijo === 'ERROR::') visto.errores.push(cuerpo);
  else if (prefijo === 'NOTE::' || prefijo === 'HINT::') visto.avisos.push(cuerpo);
}

setTimeout(() => {
  try { p.kill(); } catch {}
  veredicto();
}, SEGUNDOS * 1000);

function veredicto() {
  console.log('');
  console.log('== Veredicto ==');
  if (!visto.motor) {
    console.log('El motor no llegó a arrancar. Es lo que se ve cuando el dictado «no hace nada».');
    if (visto.avisos.length) console.log('Los avisos de arriba dicen por qué.');
    return;
  }
  console.log('Motor en uso: ' + visto.motor + (visto.motor === 'winrt'
    ? '  (el moderno: es el que reconoce bien)'
    : '  (el CLÁSICO: oye mucho peor, y es la causa de que no te reconozca)'));
  if (visto.idioma) console.log('Idioma con el que escucha: ' + visto.idioma + '   (pedido: ' + LANG + ')');
  console.log('Frases reconocidas: ' + visto.finales.length + (visto.parciales ? ' (+' + visto.parciales + ' hipótesis en curso)' : ''));
  for (const f of visto.finales) console.log('   +' + f.t.toFixed(1) + 's  ' + f.texto);
  if (visto.errores.length) {
    console.log('Errores del motor:');
    for (const e of visto.errores) console.log('   · ' + e);
  }
  if (!visto.finales.length) {
    console.log('');
    console.log('No reconoció NI UNA frase. Lo más probable, por orden:');
    console.log('  1) el micrófono predeterminado de Windows no es el que estás usando');
    console.log('     (el motor no puede elegir otro: mira la pista «Escuchando por…» de arriba);');
    console.log('  2) estás demasiado lejos del micro o hablas por debajo de su umbral;');
    console.log('  3) el idioma del reconocedor no es el tuyo (míralo arriba).');
  } else if (visto.finales.length < 2) {
    console.log('');
    console.log('Reconoció poco para lo que se ha hablado: suele ser distancia al micrófono o');
    console.log('un micro que no es el tuyo, más que el motor.');
  }
}

/* La sonda no deja el micrófono abierto: si el usuario la corta con Ctrl+C, se mata el
   proceso de PowerShell en lugar de dejarlo escuchando en segundo plano. */
for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, () => { try { p.kill(); } catch {} process.exit(130); });
}
