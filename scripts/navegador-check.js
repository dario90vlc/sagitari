'use strict';

/* ============================================================================
   navegador-check.js — la herramienta de navegador, contra un navegador DE VERDAD.

   Los tests unitarios comprueban lo que se puede comprobar sin Chrome (atajos,
   acciones válidas, avisos, esquema, y que el código que se inyecta en la página
   COMPILA). Pero el corazón de la v2.5 es código que corre DENTRO de la página:
   nombres accesibles, shadow DOM, iframes, «fuera de pantalla», huellas, oclusión.
   Un fallo ahí no lo ve ninguna suite de unitarios: se ve cuando el agente clica
   donde no debe.

   Esto abre el navegador con un perfil propio, carga una página de prueba con
   todos esos casos y comprueba la herramienta de punta a punta. No toca cuentas ni
   webs del usuario: todo es un archivo local temporal.

   Uso: node scripts/navegador-check.js     (exit 0 = la herramienta responde bien)
   ============================================================================ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Browser } = require('../agent/browser');

const PASOS = [];
const fallos = [];
function ok(cond, que, detalle = '') {
  if (cond) PASOS.push('  ok   ' + que);
  else { fallos.push(que + (detalle ? '  →  ' + detalle : '')); PASOS.push('  FALLO ' + que + (detalle ? '  →  ' + detalle : '')); }
}

const PAGINA = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Prueba de navegador</title>
<style>
  body { font-family: sans-serif; margin: 20px; }
  .alto { height: 2200px; }
  .envuelto { position: relative; display: inline-block; }
  .tapa { position: absolute; inset: 0; background: rgba(120,120,180,0.25); z-index: 99; }
  #menu { display: none; } #menu.on { display: block; }
</style></head>
<body>
  <h1>Página de prueba</h1>
  <label for="nombre">Nombre completo</label>
  <input id="nombre" type="text" placeholder="Escribe aquí">
  <select id="pais"><option value="es">Uno</option><option value="fr">Dos</option><option value="de">Tres</option></select>
  <input id="acepto" type="checkbox"> <label for="acepto">Acepto</label>
  <button id="icono" aria-label="Guardar cambios" onclick="window.clics.push('guardar')">💾</button>
  <button data-testid="enviar" onclick="window.clics.push('enviar')">Enviar formulario</button>
  <button id="confirmar" onclick="window.confirmado = window.confirm('¿Seguir con el borrado?')">Borrar cuenta</button>
  <button id="boom" onclick="console.error('boom-check')">Provocar error</button>
  <button id="carga" onclick="setTimeout(() => { const d = document.createElement('div'); d.id = 'llego'; d.textContent = 'apareció el aviso'; document.body.appendChild(d); }, 250)">Simular carga</button>
  <button id="quita" onclick="document.getElementById('llego2').remove()">Quitar aviso</button>
  <div id="llego2">aviso temporal</div>
  <button id="hover" onmouseenter="document.getElementById('menu').classList.add('on')">Abrir menú</button>
  <div id="menu"><button onclick="window.clics.push('submenu')">Opción del menú</button></div>
  <img src="http://127.0.0.1:9/no-existe.png" alt="imagen rota">
  <div id="comp"></div>
  <iframe title="marco" srcdoc="<button id='enmarco' onclick='parent.clics.push(&quot;marco&quot;)'>Botón dentro del marco</button>"></iframe>
  <div class="alto"></div>
  <button id="abajo" onclick="window.clics.push('abajo')">Botón al final de la página</button>
  <div class="envuelto"><button id="tapado" onclick="window.clics.push('tapado')">Botón tapado</button><div class="tapa"></div></div>
  <script>
    window.clics = [];
    class Boton extends HTMLElement {
      connectedCallback() {
        const sr = this.attachShadow({ mode: 'open' });
        sr.innerHTML = '<button id="dentro" aria-label="Dentro del componente">x</button>';
        sr.querySelector('button').addEventListener('click', () => window.clics.push('componente'));
      }
    }
    customElements.define('mi-boton', Boton);
    document.getElementById('comp').innerHTML = '<mi-boton></mi-boton>';
  </script>
</body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sagi-nav-'));
  const archivo = path.join(dir, 'prueba.html');
  fs.writeFileSync(archivo, PAGINA, 'utf8');

  const b = new Browser();
  // perfil APARTE: la comprobación no toca el perfil del usuario
  await b.switchProfile('navegador-check');
  b.setDownloadDir(path.join(dir, 'descargas'));

  let abierto = false;
  try {
    const lanzado = await b.launch('chrome', 'file:///' + archivo.replace(/\\/g, '/'));
    abierto = !/Error/.test(String(lanzado));

    if (!abierto) {
      console.log('  (no hay Chrome ni Edge instalado: la comprobación se salta)');
      console.log('\nNAVEGADOR-CHECK::{"ok":true,"saltado":true}');
      process.exit(0);
    }

    const sess = await b.sessionIdOf();
    const evalPagina = (expr) => b.evalJs(expr, sess);

    /* ---- inventario: nombres accesibles, shadow DOM, iframe, fuera de pantalla ---- */
    const inv = await b.elements(sess, 'check');
    ok(/Guardar cambios/.test(inv), 'nombre accesible por aria-label (botón de icono)', inv.slice(0, 200));
    ok(/Nombre completo/.test(inv), 'nombre accesible por <label for>');
    ok(/Dentro del componente/.test(inv), 'encuentra botones dentro de un shadow root');
    ok(/Botón dentro del marco/.test(inv), 'y dentro de un iframe del mismo origen');
    ok(/enviar/.test(inv), 'la pista data-testid viaja en el inventario');
    ok(/fuera de pantalla/.test(inv), 'marca lo que está por debajo del pliegue');
    ok(/\[select\]/.test(inv) && /\[checkbox\]/.test(inv), 'distingue listas y casillas por rol');

    /* Los índices valen hasta que algo cambia la página: igual que hace el agente, se
       vuelve a inventariar antes de cada acción por índice. */
    const idxDe = (texto, frag) => {
      const m = texto.split('\n').find((l) => l.includes(frag));
      return m ? Number(m.trim().split(':')[0]) : -1;
    };
    const idx = (frag) => idxDe(inv, frag);
    const reInv = async () => { const t = await b.elements(sess, 'check'); return t; };

    /* ---- clic en lo que está fuera de pantalla (scroll + huella) ---- */
    const iAbajo = idx('Botón al final de la página');
    ok(iAbajo >= 0, 'el botón de abajo tiene índice');
    const clicAbajo = await b.clickIndex(iAbajo, sess, 'check');
    ok(/^OK/.test(clicAbajo), 'clic en un elemento fuera de pantalla (se trae a la vista)', clicAbajo);
    ok((await evalPagina('window.clics.join(",")')).includes('abajo'), 'y la página recibió el clic en el control correcto');

    /* ---- tipeo: se escribe, se lee de vuelta y la web ve los eventos ---- */
    const invB = await reInv();
    const iNombre = idxDe(invB, 'Nombre completo');
    await b.type({ index: iNombre }, 'Darío Verdugo', {}, sess, 'check');
    const valor = await evalPagina('document.getElementById("nombre").value');
    ok(valor === 'Darío Verdugo', 'escribir en el campo etiquetado y quedar el texto', JSON.stringify(valor));

    /* ---- select ---- */
    const invC = await reInv();
    const iPais = idxDe(invC, '[select]');
    const sel = await b.selectOption({ index: iPais }, 'Dos', sess, 'check');
    ok(/^OK/.test(sel), 'elegir una opción por su texto', sel);
    ok((await evalPagina('document.getElementById("pais").value')) === 'fr', 'y la página tiene el valor nuevo');

    /* ---- check ---- */
    const invD = await reInv();
    const iAcepto = idxDe(invD, '[checkbox]');
    const chk = await b.check({ index: iAcepto }, true, sess, 'check');
    ok(/marcado/.test(chk) && (await evalPagina('document.getElementById("acepto").checked')) === true, 'marcar una casilla', chk);
    const unchk = await b.check({ text: 'Acepto' }, false, sess, 'check');
    ok((await evalPagina('document.getElementById("acepto").checked')) === false, 'y desmarcarla', unchk);

    /* ---- clic tapado: lo dice en vez de clicar donde no ve ---- */
    const invE = await reInv();
    const iTapado = idxDe(invE, 'Botón tapado');
    const tapado = await b.clickIndex(iTapado, sess, 'check');
    ok(/^Error/.test(tapado) && /tapa/.test(tapado), 'si algo tapa el elemento, se dice qué lo tapa', tapado);
    ok(!(await evalPagina('window.clics.join(",")')).includes('tapado'), 'y NO se pulsa a ciegas');
    const forzado = await b.clickIndex(iTapado, sess, 'check', { force: true });
    ok(/^OK/.test(forzado) && (await evalPagina('window.clics.join(",")')).includes('tapado'), 'con force sí pulsa', forzado);

    /* ---- hover revela el menú ---- */
    await b.hover({ text: 'Abrir menú' }, sess, 'check');
    await sleep(200);
    const inv2 = await b.elements(sess, 'check');
    ok(/Opción del menú/.test(inv2), 'hover despliega el menú y el siguiente inventario lo ve');

    /* ---- wait_for: aparece y desaparece ---- */
    await b.findAndClick(null, 'Simular carga', sess, 'check');
    const espera = await b.waitFor({ text: 'apareció el aviso', timeoutMs: 4000 }, sess);
    ok(/^OK/.test(espera) && /cumplido en/.test(espera), 'wait_for espera a que aparezca el texto', espera);
    await b.findAndClick(null, 'Quitar aviso', sess, 'check');
    const espera2 = await b.waitFor({ text: 'aviso temporal', gone: true, timeoutMs: 4000 }, sess);
    ok(/^OK/.test(espera2), 'y a que desaparezca', espera2);
    const noLlega = await b.waitFor({ text: 'nunca-jamás-777', timeoutMs: 700 }, sess);
    ok(/^Error/.test(noLlega) && /no se cumplió/.test(noLlega), 'si no llega, se explica y no se cuelga', noLlega);
    ok(/«/.test(noLlega), 'diciendo además en qué estado quedó la página');

    /* ---- consola y errores de red ---- */
    await b.findAndClick(null, 'Provocar error', sess, 'check');
    await sleep(300);
    const logs = b.logs({});
    ok(/boom-check/.test(logs), 'action=logs lee la consola de la página', logs.slice(0, 200));
    ok(/no-existe\.png|red|http/.test(logs), 'y los errores de red', logs.slice(0, 300));

    /* ---- diálogos: la página se bloquea y el aviso aparece ---- */
    // por el mismo camino que usa el agente (handle): es quien añade el aviso del diálogo
    const dialogo = await b.handle({ action: 'click', text: 'Borrar cuenta' }, 'check');
    ok(/diálogo abierto/.test(dialogo), 'un confirm() avisa en el resultado (sin colgar la acción)', dialogo.slice(-200) + ' | _dialog=' + JSON.stringify(b._dialog));
    const mientras = await b.handle({ action: 'elements' }, 'check');
    ok(/diálogo/.test(String(mientras)), 'y con el diálogo abierto se avisa en vez de esperar 30 s', String(mientras).slice(0, 160));
    await sleep(300);
    const contestado = await b.dialog({ accept: true }, sess);
    ok(/^OK/.test(contestado), 'action=dialog lo contesta', contestado);
    ok((await evalPagina('window.confirmado')) === true, 'y la página recibe la respuesta');

    /* ---- captura de un elemento y lectura del DOM ---- */
    const shot = await b.handle({ action: 'screenshot', text: 'Enviar formulario' }, 'check');
    ok(shot && Array.isArray(shot.images) && /^data:image\/jpeg;base64,/.test(shot.images[0]), 'screenshot de un elemento concreto');
    const contenido = await b.handle({ action: 'content', selector: '#pais', html: true }, 'check');
    ok(/<select/.test(String(contenido)), 'content con selector y html devuelve el DOM de esa parte');

    /* ---- pestañas e historial ---- */
    await b.handle({ action: 'new_tab', url: 'about:blank' }, 'check');
    const tabs = await b.handle({ action: 'tabs' }, 'check');
    ok(/about:blank/.test(String(tabs)), 'se abre una pestaña nueva y se lista');
    await b.handle({ action: 'close_tab' }, 'check');
    const vuelta = await b.handle({ action: 'back' }, 'check');
    ok(/OK|Error/.test(String(vuelta)), 'volver atrás responde sin reventar', String(vuelta));
  } catch (e) {
    fallos.push('excepción: ' + (e && e.message));
    PASOS.push('  FALLO excepción: ' + (e && e.message));
  } finally {
    try { await b.handle({ action: 'close' }); } catch {}
    try { b.kill(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log(PASOS.join('\n'));
  if (fallos.length) {
    console.log('\n' + fallos.length + ' comprobación(es) del navegador fallaron');
    console.log('NAVEGADOR-CHECK::{"ok":false,"fallos":' + fallos.length + '}');
    process.exit(1);
  }
  console.log('\nNAVEGADOR-CHECK::{"ok":true,"fallos":0}');
  process.exit(0);
})();
