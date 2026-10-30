'use strict';

/* Ajustes ▸ Seguridad: cuando main NO pudo guardar, la interfaz no puede enseñar el valor
   tecleado. Los canales `sec:*` devuelven `{ok:false,error}` tras restaurar su copia, así
   que el desplegable de permisos y los campos de guardarraíles tienen que volver a lo que
   hay de verdad, y el presupuesto del equipo se pinta con lo que main conservó (descarta
   lo que supera su tope). Sin spawn: monta el markup real (ver arnes-renderer.js). */

const { montar, configBase } = require('./arnes-renderer');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${e.message}`);
  }
}

function assertOk(value, msg) {
  if (!value) throw new Error(msg || 'valor falso');
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || ''} esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
}

const GUARDARRAILES = {
  maxSteps: 60,
  maxToolCalls: 80,
  maxDurationMs: 0,
  maxTokens: 0,
  loopThreshold: 3,
  maxCostUsd: 0,
  stallThreshold: 6,
  maxDelegations: 8,
};

function montarApp() {
  return montar({
    api: {
      getConfig: async () => configBase({ settings: { parallelTools: 3 } }),
      convList: async () => [],
      convOpen: async () => ({ ok: true, messages: [] }),
      metaGet: async () => ({
        guardrails: { ...GUARDARRAILES },
        permissions: { read_file: 'safe' },
        riskDefaults: { read_file: 'safe', write_file: 'confirm' },
      }),
      instruccionesInfo: async () => ({ fuentes: [], candidatos: [], workspace: '' }),
      mcpList: async () => ({ servers: [] }),
      secSetToolPerm: async () => ({ ok: false, error: 'ENOSPC: no queda espacio' }),
      secSetGuardrail: async () => ({ ok: false, error: 'ENOSPC: no queda espacio' }),
      // main descarta lo que supera el tope del presupuesto (50 $) y devuelve lo guardado
      setSettings: async (patch) => ({
        equipoPresupuestoUsd: Number(patch.equipoPresupuestoUsd) > 50 ? 0 : Number(patch.equipoPresupuestoUsd),
      }),
      onAgentEvent: () => () => {},
    },
  });
}

/** Los avisos reales se pintan en #toastStack (showToast vive en 40-vistas.js). */
function avisos(m) {
  return m.$$('#toastStack .toast').map((t) => t.textContent);
}

async function esperar(m) {
  // los handlers son async y algunos rellenan tras un microtarea/tiempo
  await new Promise((r) => setTimeout(r, 30));
  void m;
}

async function main() {
  await test('permiso: si no se guarda, el desplegable vuelve al nivel anterior y avisa', async () => {
    const m = montarApp();
    await m.w.initSecurity();
    await esperar(m);
    const sel = m.$('select[data-tool="read_file"]');
    assertOk(sel, 'el desplegable del permiso tiene que existir');
    assertEqual(sel.value, 'safe', 'nace con el nivel guardado:');
    sel.value = 'restricted';
    sel.dispatchEvent(new m.w.Event('change', { bubbles: true }));
    await esperar(m);
    assertEqual(sel.value, 'safe', 'sin guardado el control NO puede quedarse en el nivel nuevo:');
    assertOk(
      avisos(m).some((t) => /No se pudo guardar el permiso/.test(t)),
      'tiene que avisar de que no se guardó: ' + JSON.stringify(avisos(m)),
    );
  });

  await test('guardarraíl: si no se guarda, el campo vuelve al valor guardado y avisa', async () => {
    const m = montarApp();
    await m.w.initSecurity();
    await esperar(m);
    const pasos = m.$('#grSteps');
    assertEqual(pasos.value, '60', 'nace con el valor guardado:');
    pasos.value = '5';
    pasos.dispatchEvent(new m.w.Event('change', { bubbles: true }));
    await esperar(m);
    assertEqual(pasos.value, '60', 'sin guardado el campo vuelve a lo que de verdad hay:');
    assertOk(
      avisos(m).some((t) => /No se pudo guardar el límite/.test(t)),
      'tiene que avisar de que no se guardó: ' + JSON.stringify(avisos(m)),
    );
  });

  await test('presupuesto del equipo: el campo y el aviso usan el valor que main conservó', async () => {
    const m = montarApp();
    await m.w.initSecurity();
    await esperar(m);
    const campo = m.$('#eqPresupuesto');
    campo.value = '80'; // por encima del tope: main lo descarta
    campo.dispatchEvent(new m.w.Event('change', { bubbles: true }));
    await esperar(m);
    assertEqual(campo.value, '0', 'el campo se vuelca con el valor persistido, no con el tecleado:');
    assertOk(
      avisos(m).some((t) => /sin tope/.test(t)),
      'y el aviso dice lo que quedó guardado: ' + JSON.stringify(avisos(m)),
    );
  });

  console.log(`\n${passed} pasaron, ${failed} fallaron`);
  process.exit(failed ? 1 : 0);
}

/* El runner espera la promesa del módulo para recoger el `process.exit` dentro de su
   interceptor: sin devolverla, el proceso moría después de que el runner restaurara su
   `process.exit` y la suite entera se caía sin resumen. */
module.exports = main();
