'use strict';
/* Suite SAGITARI — hardening del proceso principal (hallazgos de la auditoría que no
   cabían en los bloques 10-40): recorrido de rutas de `tasks:*`, cuarentena de
   conversations.json, alias de las carpetas del sistema en el espacio de trabajo,
   tope agregado de adjuntos, recorte del rastro del turno, credenciales en la URL de
   un servidor MCP, código de salida del arranque de prueba sin bloqueo, cierre del
   navegador sin promesas sueltas, poda de runtimes sin perder el «Deshacer» y
   recuperación de la ventana cuando el renderer se cae.
   Registra tests en la cola de ./comun; run.js carga los bloques en orden. */
const { fs, path, tmpDir, test, eq, ok, checkpoints, MAIN_SRC } = require('./comun');

/* ---------- recorrido de rutas en tasks:* (main/ipc-tareas.js + agent/checkpoints.js) ---------- */

const ctxTareas = (dir, tm, usados) => ({
  config: {},
  persistConfig: () => ({ ok: true }),
  getTaskManager: () => tm,
  peekTaskManager: () => tm,
  checkpoints: {
    list: () => [],
    remove: (id) => {
      usados.push('checkpoints:' + id);
      return { ok: true };
    },
    // la guarda real del almacén: el router usa la MISMA que construye las rutas
    safeRunId: require('../agent/checkpoints').safeRunId,
  },
  runtimes: { liveIds: () => [], allAgents: () => [] },
  securityDefaults: {},
  DEFAULT_RISK: {},
  CONFIG_DIR: dir,
  runlog: { readRecent: () => [] },
  getWin: () => null,
});

test('tasks: el router rechaza un runId con recorrido antes de tocar el almacén', () => {
  const { registerTareasIpc } = require('../main/ipc-tareas');
  const dir = tmpDir('sagi-tareas-rx-');
  // El id del informe: al unirlo al directorio del almacén sale fuera del perfil.
  const malo = '..' + path.sep + 'victima-' + Date.now();
  const victima = path.resolve(dir, malo);
  fs.mkdirSync(victima, { recursive: true });
  fs.writeFileSync(path.join(victima, 'run.json'), JSON.stringify({ runId: malo, status: 'completed', goal: 'x' }));
  const handlers = new Map();
  const usados = [];
  const tm = {
    pause: (id) => {
      usados.push('pause:' + id);
      return { ok: true };
    },
    resume: (id) => {
      usados.push('resume:' + id);
      return { ok: true };
    },
    cancel: (id) => {
      usados.push('cancel:' + id);
      return { ok: true };
    },
    remove: (id) => {
      usados.push('remove:' + id);
      return { ok: true };
    },
  };
  registerTareasIpc({ handle: (c, fn) => handlers.set(c, fn) }, ctxTareas(dir, tm, usados));
  for (const canal of ['tasks:pause', 'tasks:resume', 'tasks:cancel', 'tasks:remove']) {
    const r = handlers.get(canal)(null, malo);
    eq(r.ok, false, canal + ' tiene que rechazar el id');
  }
  eq(usados.length, 0, 'ningún id con recorrido puede llegar al gestor ni al almacén');
  ok(fs.existsSync(path.join(victima, 'run.json')), 'la carpeta señalada sigue intacta');
});

test('tasks: un id válido sigue pasando al gestor', () => {
  const { registerTareasIpc } = require('../main/ipc-tareas');
  const dir = tmpDir('sagi-tareas-ok-');
  const handlers = new Map();
  const usados = [];
  const tm = { pause: (id) => (usados.push('pause:' + id), { ok: true }) };
  registerTareasIpc({ handle: (c, fn) => handlers.set(c, fn) }, ctxTareas(dir, tm, usados));
  const r = handlers.get('tasks:pause')(null, '123e4567-e89b-12d3-a456-426614174000');
  eq(r.ok, true);
  eq(usados[0], 'pause:123e4567-e89b-12d3-a456-426614174000');
});

test('checkpoints: safeRunId rechaza separadores, «..», rutas absolutas y nombres vacíos', () => {
  const { safeRunId } = checkpoints;
  eq(typeof safeRunId, 'function', 'checkpoints tiene que exponer la guarda (defensa en profundidad)');
  ok(safeRunId('123e4567-e89b-12d3-a456-426614174000'), 'un uuid vale');
  ok(safeRunId('t1a2b3c4x5'), 'el formato clásico vale');
  eq(safeRunId(''), null);
  eq(safeRunId('   '), null);
  eq(safeRunId(null), null);
  eq(safeRunId(undefined), null);
  eq(safeRunId('..'), null);
  eq(safeRunId('../fuera'), null);
  eq(safeRunId('..\\fuera'), null);
  eq(safeRunId('a/b'), null);
  eq(safeRunId('a\\b'), null);
  eq(safeRunId('C:\\Windows'), null);
  eq(safeRunId('/etc/passwd'), null);
  eq(safeRunId('ab'), null, 'un id demasiado corto no es un runId');
});

test('checkpoints: remove() no borra fuera del almacén con un runId con recorrido', () => {
  const dir = tmpDir('sagi-tareas-travesia-');
  const prev = checkpoints._dir();
  checkpoints.__test._resetForTests(dir);
  try {
    const malo = '..' + path.sep + 'victima-' + Date.now();
    const victima = path.resolve(dir, malo);
    fs.mkdirSync(victima, { recursive: true });
    fs.writeFileSync(path.join(victima, 'run.json'), JSON.stringify({ runId: malo, status: 'completed' }));
    const r = checkpoints.remove(malo);
    eq(r.ok, false, 'el borrado recursivo tiene que rechazarse');
    ok(fs.existsSync(path.join(victima, 'run.json')), 'la carpeta de fuera sigue entera');
    eq(checkpoints.read(malo), null, 'leer tampoco puede salir del almacén');
  } finally {
    checkpoints.__test._resetForTests(prev);
  }
});

test('tasks: el recorrido de rutas del informe no borra nada (router + almacén reales)', () => {
  // El repro de la auditoría, de punta a punta: window.sagitari.taskRemove('..\..\..\…')
  // con el router REAL y el almacén REAL (sin gestor de tareas vivo).
  const { registerTareasIpc } = require('../main/ipc-tareas');
  const dir = tmpDir('sagi-tareas-e2e-');
  const prev = checkpoints._dir();
  checkpoints.__test._resetForTests(dir);
  try {
    const malo = '..' + path.sep + 'victima-' + Date.now();
    const victima = path.resolve(dir, malo);
    fs.mkdirSync(victima, { recursive: true });
    fs.writeFileSync(path.join(victima, 'run.json'), '{}');
    const handlers = new Map();
    registerTareasIpc(
      { handle: (c, fn) => handlers.set(c, fn) },
      {
        ...ctxTareas(dir, null, []),
        checkpoints, // el de verdad
        getTaskManager: () => {
          throw new Error('no debe crearse el gestor para un id inválido');
        },
        peekTaskManager: () => null,
      },
    );
    const r = handlers.get('tasks:remove')(null, malo);
    eq(r.ok, false, 'responde error, no {ok:true}');
    ok(fs.existsSync(path.join(victima, 'run.json')), 'la carpeta de la víctima sigue ahí');
  } finally {
    checkpoints.__test._resetForTests(prev);
  }
});

/* ---------- conversations.json ilegible: cuarentena, no pérdida ---------- */

const ctxConv = (dir, avisos) => ({
  config: () => ({ settings: {} }),
  saveConfig: () => ({ ok: true }),
  configDir: () => dir,
  // la misma escritura atómica que main/config.js: copia el fichero ACTUAL sobre el .bak
  writeJsonAtomic: (file, data) => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, data);
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
    } catch {}
    fs.renameSync(tmp, file);
  },
  onSaveError: (m) => avisos.push('saveError: ' + m),
  avisar: (titulo, m) => avisos.push(titulo + ': ' + m),
  getWin: () => null,
  runtimes: { agentFor: () => null, peek: () => null, isBusy: () => false, liveIds: () => [], dispose: () => {} },
  dialog: {},
  app: { getPath: () => dir },
  fs,
  path,
});

const cuarentenasEn = (dir) => fs.readdirSync(dir).filter((f) => /^conversations\.corrupt-\d+\.json$/.test(f));

test('conv: un conversations.json ilegible se conserva y no destruye el .bak', () => {
  const { registerConvsIpc } = require('../main/ipc-convs');
  const dir = tmpDir('sagi-conv-cuarentena-');
  fs.writeFileSync(path.join(dir, 'conversations.json'), '{ esto no es JSON');
  fs.writeFileSync(
    path.join(dir, 'conversations.json.bak'),
    JSON.stringify([{ id: 'c1', title: 'Antigua', messages: [{ role: 'user', content: 'hola' }], createdAt: 1, updatedAt: 1 }]),
  );
  const avisos = [];
  const api = registerConvsIpc({ handle: () => {} }, ctxConv(dir, avisos));
  ok(api.convById('c1'), 'se recupera el historial del .bak');
  const cuarentenas = cuarentenasEn(dir);
  eq(cuarentenas.length, 1, 'el fichero ilegible se aparta con un nombre reconocible');
  eq(
    fs.readFileSync(path.join(dir, cuarentenas[0]), 'utf8'),
    '{ esto no es JSON',
    'se conserva tal cual, por si el usuario lo quiere recuperar',
  );
  ok(avisos.length >= 1, 'el usuario tiene que enterarse, no solo quedar en console.error');
  // el guardado siguiente NO puede pisar la copia buena con el fichero roto
  api.saveConvs();
  eq(JSON.parse(fs.readFileSync(path.join(dir, 'conversations.json.bak'), 'utf8')).length, 1, 'el .bak sigue siendo la copia buena');
  eq(JSON.parse(fs.readFileSync(path.join(dir, 'conversations.json'), 'utf8'))[0].id, 'c1');
});

test('conv: sin copia válida también se pone en cuarentena y se avisa', () => {
  const { registerConvsIpc } = require('../main/ipc-convs');
  const dir = tmpDir('sagi-conv-cero-');
  fs.writeFileSync(path.join(dir, 'conversations.json'), '{ roto');
  fs.writeFileSync(path.join(dir, 'conversations.json.bak'), 'tampoco esto');
  const avisos = [];
  const api = registerConvsIpc({ handle: () => {} }, ctxConv(dir, avisos));
  eq(api.convById('c1'), null, 'se empieza de cero (no había nada legible)');
  eq(cuarentenasEn(dir).length, 1, 'el original ilegible no se pisa ni se pierde');
  ok(avisos.length >= 1, 'y se dice al usuario');
});

test('conv: sin conversations.json no hay cuarentena ni aviso', () => {
  const { registerConvsIpc } = require('../main/ipc-convs');
  const dir = tmpDir('sagi-conv-nuevo-');
  const avisos = [];
  const api = registerConvsIpc({ handle: () => {} }, ctxConv(dir, avisos));
  eq(avisos.length, 0, 'un arranque nuevo no avisa de nada');
  eq(fs.readdirSync(dir).filter((f) => /corrupt/.test(f)).length, 0);
  eq(api.convById('x'), null);
});

test('conv: un JSON válido con otra forma (no una lista) es tan ilegible como uno roto', () => {
  const { registerConvsIpc } = require('../main/ipc-convs');
  const dir = tmpDir('sagi-conv-forma-');
  fs.writeFileSync(path.join(dir, 'conversations.json'), '{"algo":1}');
  fs.writeFileSync(
    path.join(dir, 'conversations.json.bak'),
    JSON.stringify([{ id: 'c9', title: 'De la copia', messages: [], createdAt: 1, updatedAt: 1 }]),
  );
  const avisos = [];
  const api = registerConvsIpc({ handle: () => {} }, ctxConv(dir, avisos));
  ok(api.convById('c9'), 'se recupera la copia válida');
  eq(cuarentenasEn(dir).length, 1, 'y el fichero con la forma rara se conserva, no se pisa');
  ok(avisos.length >= 1, 'avisando al usuario');
  eq(fs.readFileSync(path.join(dir, cuarentenasEn(dir)[0]), 'utf8'), '{"algo":1}');
});

/* ---------- espacio de trabajo: alias de las carpetas del sistema ---------- */

test('workspace-ruta: un alias de una carpeta del sistema no puede colarse', () => {
  const { validarWorkspaceRuta } = require('../main/workspace-ruta');
  // el nombre a secas ya se rechazaba: eso no puede cambiar
  eq(validarWorkspaceRuta('C:\\Windows', 'D:\\datos').ok, false, 'C:\\Windows sigue rechazándose');
  eq(validarWorkspaceRuta('C:\\Windows\\System32\\drivers', 'D:\\datos').ok, false, 'y su interior');
  if (process.platform === 'win32') {
    // Windows resuelve «.» final y el nombre 8.3 a la MISMA carpeta del sistema
    eq(validarWorkspaceRuta('C:\\Windows.', 'D:\\datos').ok, false, 'el punto final que Windows ignora');
    eq(validarWorkspaceRuta('C:\\PROGRA~1', 'D:\\datos').ok, false, 'el nombre corto 8.3');
    ok(validarWorkspaceRuta(tmpDir('sagi-ws-'), 'D:\\datos').ok, 'una carpeta normal sí vale');
  } else {
    ok(validarWorkspaceRuta(tmpDir('sagi-ws-'), 'D:/datos').ok, 'una carpeta normal sí vale');
  }
});

/* ---------- adjuntos: tope del CONJUNTO, no solo por archivo ---------- */

test('adjuntos: 8 archivos grandes no se cuelan enteros (tope del conjunto)', () => {
  const attach = require('../main/attachments');
  ok(typeof attach.MAX_ADJUNTOS_CHARS === 'number', 'el techo del conjunto tiene que ser explícito');
  const atts = Array.from({ length: 8 }, (_, i) => ({ name: 'f' + i + '.txt', size: 150000, text: 'x'.repeat(150000) }));
  const texto = attach.blocksFor(atts);
  ok(texto.length <= attach.MAX_ADJUNTOS_CHARS + 600, 'la suma se queda en el techo: ' + texto.length);
  ok(/f7\.txt \(omitido/.test(texto), 'los que no caben se anuncian en vez de desaparecer');
  eq((texto.match(/x/g) || []).length <= attach.MAX_ADJUNTOS_CHARS + 600, true, 'no se cuela texto por encima del techo');
});

test('adjuntos: dos adjuntos normales siguen viajando enteros', () => {
  const attach = require('../main/attachments');
  const texto = attach.blocksFor([
    { name: 'a', size: 1, text: 'uno' },
    { name: 'b', size: 1, text: 'dos' },
  ]);
  eq(texto.split('--- ARCHIVO ADJUNTO').length - 1, 2);
  ok(!/omitido|recortado/.test(texto), 'sin pasarse del techo no se recorta nada');
});

/* ---------- traza del turno: recorte de argumentos que no son cadenas ---------- */

test('traza: los argumentos no-string también se recortan (apply_patch)', () => {
  const traza = require('../main/traza');
  const out = traza.argsTraza('apply_patch', {
    changes: [
      { path: 'src/a.js', old_string: 'x'.repeat(9000), new_string: 'y'.repeat(9000) },
      { path: 'src/b.js', old_string: '', new_string: 'z'.repeat(20) },
    ],
  });
  eq(out.changes.length, 2, 'la forma del argumento se conserva');
  eq(out.changes[0].path, 'src/a.js', 'lo corto sigue igual');
  ok(out.changes[0].old_string.length < 1400, 'el texto de un cambio no puede ir entero: ' + out.changes[0].old_string.length);
  ok(/recortado/.test(out.changes[0].new_string), 'y queda dicho cuánto se recortó');
  eq(out.changes[1].new_string, 'z'.repeat(20), 'lo que cabe no se toca');
  // el resto del contrato sigue en pie
  const img = traza.argsTraza('write_file', { content: 'data:image/png;base64,' + 'A'.repeat(5000) }).content;
  ok(/no guardada/.test(img), 'una imagen en base64 sigue sin guardarse');
});

/* ---------- MCP: credenciales dentro de la URL ---------- */

test('mcp: una URL con credenciales se detecta, se enmascara y se recupera al guardar', () => {
  const mcpConfig = require('../main/mcp-config');
  eq(typeof mcpConfig.urlLlevaCredenciales, 'function', 'el módulo tiene que decidir qué es credencial');
  eq(typeof mcpConfig.enmascararUrl, 'function');
  eq(typeof mcpConfig.mergeUrl, 'function');
  ok(mcpConfig.urlLlevaCredenciales('https://usuario:token@mcp.ejemplo.com/sse'), 'userinfo con contraseña');
  ok(mcpConfig.urlLlevaCredenciales('https://mcp.ejemplo.com/sse?key=SECRETO'), 'parámetro de credencial');
  ok(mcpConfig.urlLlevaCredenciales('https://mcp.ejemplo.com/sse?access_token=abc'), 'y su alias');
  ok(mcpConfig.urlLlevaCredenciales('https://mcp.ejemplo.com/sse?a=1&token=abc#x'), 'aunque no sea el primero');
  ok(!mcpConfig.urlLlevaCredenciales('https://mcp.ejemplo.com/sse'), 'una URL sin credenciales no es un secreto');
  ok(!mcpConfig.urlLlevaCredenciales('https://mcp.ejemplo.com/sse?page=1'), 'un parámetro normal tampoco');
  // la vista la enseña SIN el secreto, pero sigue siendo la misma URL
  const visto = mcpConfig.enmascararUrl('https://mcp.ejemplo.com/sse?key=SECRETO');
  ok(!visto.includes('SECRETO'), 'el token no puede viajar al renderer: ' + visto);
  ok(visto.includes('mcp.ejemplo.com/sse'), 'la URL sigue siendo la misma: ' + visto);
  const vistoUser = mcpConfig.enmascararUrl('https://usuario:token@mcp.ejemplo.com/sse');
  ok(!vistoUser.includes('token'), 'el userinfo se tapa: ' + vistoUser);
  ok(vistoUser.includes('usuario'), 'y el usuario se puede seguir leyendo: ' + vistoUser);
  const vistoLimpio = 'https://mcp.ejemplo.com/sse';
  eq(mcpConfig.enmascararUrl(vistoLimpio), vistoLimpio, 'sin secretos, la URL se entrega tal cual');
  // al guardar, el formulario reenvía la máscara: se recupera la guardada
  eq(mcpConfig.mergeUrl('https://mcp.ejemplo.com/sse?key=SECRETO', visto), 'https://mcp.ejemplo.com/sse?key=SECRETO');
  eq(
    mcpConfig.mergeUrl('https://usuario:token@mcp.ejemplo.com/sse', vistoUser),
    'https://usuario:token@mcp.ejemplo.com/sse',
    'el userinfo enmascarado también se recupera',
  );
  eq(mcpConfig.mergeUrl('https://a/sse', 'https://b/sse'), 'https://b/sse', 'sin máscara manda lo que escribió el usuario');
});

test('mcp: la URL con credenciales se cifra en disco y se enmascara hacia la vista', () => {
  const i = MAIN_SRC.indexOf('function configParaDisco()');
  ok(i > -1, 'main tiene que tener la copia para disco');
  const bloque = MAIN_SRC.slice(i, MAIN_SRC.indexOf('function needsKeyEncryption', i));
  ok(/urlLlevaCredenciales/.test(bloque), 'config.json solo protege la URL cuando lleva credenciales');
  ok(/protectKey\(s\.url\)/.test(bloque), 'y entonces la cifra, como env/headers');
  const j = MAIN_SRC.indexOf('function mcpState()');
  ok(j > -1);
  const bloque2 = MAIN_SRC.slice(j, MAIN_SRC.indexOf('function mcpExport', j));
  ok(/enmascararUrl/.test(bloque2), 'mcp:list no puede entregar el token al renderer');
  const k = MAIN_SRC.indexOf('function applyConfig(');
  const aplicar = MAIN_SRC.slice(k, MAIN_SRC.indexOf('function loadConfig', k));
  ok(/url: revealKey\(def\.url/.test(aplicar), 'y al arrancar se descifra la URL antes de usarla');
  ok(
    aplicar.indexOf('revealKey(def.url') < aplicar.indexOf('validateServer(s)'),
    'la URL descifrada tiene que validarse, no el criptograma',
  );
  const n = MAIN_SRC.indexOf('function needsKeyEncryption');
  ok(
    /urlLlevaCredenciales/.test(MAIN_SRC.slice(n, MAIN_SRC.indexOf('function applyConfig', n))),
    'una URL con credenciales que ya estaba en claro tiene que migrar a cifrado',
  );
  const ipcMcp = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc-mcp.js'), 'utf8');
  ok(/mergeUrl\(previo\.url/.test(ipcMcp), 'mcp:save tiene que recuperar la URL guardada si el formulario la reenvía enmascarada');
});

/* ---------- arranque de prueba sin bloqueo: el smoke no puede dar verde ---------- */

test('arranque: perder el bloqueo en modo de prueba sale con código ≠ 0', () => {
  const i = MAIN_SRC.indexOf('const gotLock = app.requestSingleInstanceLock()');
  ok(i > -1, 'debe existir el bloqueo de instancia');
  const bloque = MAIN_SRC.slice(i, MAIN_SRC.indexOf("app.on('second-instance'", i));
  ok(/app\.exit\(\s*[1-9]/.test(bloque), 'un arranque de prueba que no abre ventana no puede salir con 0');
  ok(/HEADLESS/.test(bloque), 'solo en modo de prueba (la app normal sigue saliendo en silencio)');
  ok(/app\.quit\(\)/.test(bloque), 'la instancia duplicada normal sigue igual');
});

/* ---------- cierre ordenado: la promesa del navegador no queda suelta ---------- */

test('cierre: la petición de cerrar el navegador no se queda sin capturar', () => {
  const i = MAIN_SRC.indexOf("browser.send('Browser.close')");
  ok(i > -1, 'main.js tiene que cerrar Chrome/Edge al salir');
  ok(/\.catch\(/.test(MAIN_SRC.slice(i, i + 120)), 'sin .catch, el socket cerrándose se reporta como «fallo interno» al salir');
});

/* ---------- runtimes: podar NO es borrar ---------- */

test('runtimes: la poda de un agente ocioso se avisa con su motivo', () => {
  const { createRuntimes } = require('../main/runtimes');
  const avisos = [];
  const rt = createRuntimes({
    createAgent: (id) => ({ sessionId: 's-' + id, isBusy: () => false, stop: () => {}, useSession: () => {}, history: [] }),
    mensajesDe: () => [],
    onDispose: (convId, motivo) => avisos.push({ convId, motivo }),
  });
  for (let i = 0; i < 9; i++) rt.agentFor('c' + i);
  eq(avisos.length, 1, 'con 9 conversaciones se poda una');
  eq(avisos[0].convId, 'c0', 'se poda la más vieja');
  eq(avisos[0].motivo, 'podado', 'podar NO es borrar: main tiene que poder distinguirlo');
  rt.dispose('c8');
  eq(avisos[1].motivo, 'borrada', 'borrar la conversación sí suelta todo');
  rt.disposeAll();
  ok(avisos.slice(2).length > 0 && avisos.slice(2).every((a) => a.motivo === 'cierre'), 'el cierre de la app se avisa aparte');
});

test('main: podar un runtime no olvida las pre-imágenes del turno', () => {
  const i = MAIN_SRC.indexOf('onDispose:');
  ok(i > -1, 'main tiene que montar onDispose');
  const bloque = MAIN_SRC.slice(i, i + 600);
  const antes = bloque.indexOf('cambios.olvidar');
  ok(antes > -1, 'el rastro y las pre-imágenes se sueltan al descartar la conversación');
  ok(/podado/.test(bloque.slice(0, antes)), 'pero NO al podar: el botón «Deshacer el cambio» seguiría en pantalla');
});

/* ---------- ventana: el renderer que se cae tiene que poder recuperarse ---------- */

test('ventana: si el renderer se cae, la interfaz se recupera (o se ofrece reiniciarla)', () => {
  const ventana = fs.readFileSync(path.join(__dirname, '..', 'main', 'ventana.js'), 'utf8');
  const i = ventana.indexOf("'render-process-gone'");
  ok(i > -1, 'el caso tiene que estar cubierto');
  const bloque = ventana.slice(i, i + 3200);
  ok(/getAgent\(\)[\s\S]{0,60}stop\(\)/.test(bloque), 'sin perder la parada del agente que ya había');
  ok(/reload\(\)/.test(bloque), 'tiene que intentar recargar la vista');
  ok(/recrearVentana\(\)/.test(bloque), 'y recrearla si la recarga no basta');
  ok(
    /showMessageBox/.test(bloque) || /preguntarReiniciarInterfaz\(\)/.test(bloque),
    'y ofrecer reiniciar la interfaz con un diálogo nativo',
  );
});

/* ---------- sec:setGuardrail: el tope de gasto admite decimales ----------
   Hallazgo 2 de la revisión de la interfaz: el panel edita `maxCostUsd` con decimales
   (0,5 $, `step="0.1"`) pero el router aplicaba `Math.floor` a TODAS las claves, así que
   0,5 se guardaba como 0 — y 0 es «sin tope» para el motor (`agent/guardrails.js`: solo
   corta con `maxCostUsd > 0`): el guardarraíl que el usuario creía activo estaba apagado. */

test('sec:setGuardrail: el tope de gasto en dólares conserva los decimales', () => {
  const { registerTareasIpc } = require('../main/ipc-tareas');
  const dir = tmpDir('sagi-gr-coste-');
  const config = { security: { guardrails: { maxCostUsd: 0, maxSteps: 60, loopThreshold: 5 } } };
  const handlers = new Map();
  registerTareasIpc(
    { handle: (c, fn) => handlers.set(c, fn) },
    {
      config: () => config,
      persistConfig: () => ({ ok: true }),
      getTaskManager: () => null,
      peekTaskManager: () => null,
      checkpoints: { list: () => [], safeRunId: require('../agent/checkpoints').safeRunId },
      runtimes: { liveIds: () => [], allAgents: () => [] },
      securityDefaults: {},
      DEFAULT_RISK: {},
      CONFIG_DIR: dir,
      runlog: { readRecent: () => [] },
      getWin: () => null,
    },
  );
  const r = handlers.get('sec:setGuardrail')(null, { maxCostUsd: 0.5, maxSteps: 12.7, loopThreshold: 1 });
  eq(r.guardrails.maxCostUsd, 0.5, 'el tope de gasto tiene que conservar el decimal (0 = sin tope):');
  eq(r.guardrails.maxSteps, 12, 'las cuentas de pasos siguen siendo enteras:');
  eq(r.guardrails.loopThreshold, 2, 'el umbral de bucle sigue con su mínimo de 2:');
});

/* ---------- lo que el paquete debe llevar: requires de runtime declarados ---------- */

/* electron-builder copia a `node_modules/` SOLO las dependencias de producción (el
   paquete real trae `node_modules/ws` y nada más). Un `require('x')` de runtime que no
   esté en `dependencies` funciona en desarrollo —porque `x` está en el árbol de
   desarrollo— y falla en la app instalada con el error crudo de Node delante del
   usuario. Pasó con `undici` en `agent/web.js` (5.0.1): `web_fetch` devolvía
   «Cannot find module 'undici'» en todos los equipos y en las pruebas salía verde.
   Esta prueba cierra la clase entera: lo que el código pide en tiempo de ejecución o es
   builtin, o es `electron`, o está declarado como dependencia. */
test('runtime: cada require de un paquete está en dependencies (o es builtin/electron)', () => {
  const Module = require('module');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const deps = new Set(Object.keys(pkg.dependencies || {}));
  const builtins = new Set(Module.builtinModules.flatMap((m) => [m, 'node:' + m]));
  const faltan = [];
  for (const dir of ['main', 'agent', 'renderer']) {
    const base = path.join(__dirname, '..', dir);
    for (const f of fs.readdirSync(base).filter((x) => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(base, f), 'utf8');
      for (const m of src.matchAll(/require\(\s*['"]([^'".][^'"]*)['"]\s*\)/g)) {
        const spec = m[1];
        if (builtins.has(spec) || spec === 'electron' || deps.has(spec)) continue;
        faltan.push(dir + '/' + f + ' → ' + spec);
      }
    }
  }
  eq(faltan.join(', '), '', 'requires de runtime que el paquete instalado NO llevaría');
});

test('claveGuardadaPara: la URL se compara normalizada (espacios y barra final)', () => {
  /* Hallazgo 11 de la revisión de IPC: «Detectar modelos» podía salir en 401 con la
     clave guardada intacta porque el sondeo buscaba la credencial comparando la URL byte
     a byte, y el campo del formulario guarda lo que escribe el usuario. */
  const { claveGuardadaPara } = require('../main/ipc-config');
  const config = { providers: [{ id: 'p1', baseUrl: 'https://api.x/v1', apiKey: 'k-guardada' }] };
  eq(claveGuardadaPara(config, { baseUrl: 'https://api.x/v1' }), 'k-guardada', 'la misma URL exacta:');
  eq(claveGuardadaPara(config, { baseUrl: 'https://api.x/v1/' }), 'k-guardada', 'con barra final es el mismo proveedor:');
  eq(claveGuardadaPara(config, { baseUrl: ' https://api.x/v1 ' }), 'k-guardada', 'y con espacios sueltos:');
  eq(claveGuardadaPara(config, { providerId: 'p1', baseUrl: 'https://otra/v9' }), 'k-guardada', 'el id manda aunque la URL no coincida:');
  eq(claveGuardadaPara(config, { baseUrl: 'https://otra/v9' }), '', 'una URL de otro proveedor no encuentra credencial:');
  eq(claveGuardadaPara(config, { baseUrl: '' }), '', 'sin URL ni id no hay nada que buscar:');
});

/* ---------- checkpoints: un borrado que no ocurre no puede decir «ok» ----------
   Hallazgo 7 de la revisión del agente: `fs.rmSync(..., { force: true })` NO falla si la
   ruta no existe, así que contar los intentos como éxito daba `ok:true` con solo que las
   otras siete carpetas de estado no estuvieran: la tarea reaparecía al listar mientras la
   interfaz decía «eliminada». */

test('checkpoints: si el borrado del disco falla, remove() no puede decir ok', () => {
  const fsMod = require('fs');
  const dir = tmpDir('sagi-tareas-borrado-');
  checkpoints.__test._resetForTests(dir);
  const run = checkpoints.newRun({ goal: 'revisar', status: 'completed' });
  checkpoints.save(run);
  const carpeta = path.join(dir, 'completed', run.runId);
  ok(fsMod.existsSync(path.join(carpeta, 'run.json')), 'la tarea está en disco antes de borrarla:');
  const original = fsMod.rmSync;
  /* Solo falla la carpeta que EXISTE (EBUSY/EPERM de un fichero abierto o del antivirus);
     las que no existen siguen comportándose como siempre — sin lanzar, porque `force` es
     justo lo que hacía que el borrado se diera por bueno sin haber borrado nada. */
  fsMod.rmSync = (p, opts) => {
    if (fsMod.existsSync(p)) {
      const e = new Error('EBUSY: resource busy or locked');
      e.code = 'EBUSY';
      throw e;
    }
    return original.call(fsMod, p, opts);
  };
  let r;
  try {
    r = checkpoints.remove(run.runId);
  } finally {
    fsMod.rmSync = original;
  }
  eq(r.ok, false, 'un borrado que no ocurrió no puede devolver ok (la tarea reaparecería al listar):');
  ok(fsMod.existsSync(path.join(carpeta, 'run.json')), 'y el run.json tiene que seguir ahí, que es lo que hay que decir:');
  eq(checkpoints.remove(run.runId).ok, true, 'con el disco sano el borrado sigue funcionando:');
  ok(!fsMod.existsSync(path.join(carpeta, 'run.json')), 'y la tarea desaparece de verdad:');
});

test('tasks: una interrumpida de una TAREA cuyo backoff vence se reintenta sin reiniciar la app', () => {
  /* `autoResume()` corría una sola vez al arrancar (`main.js`): si el reloj de espera
     (`nextAttemptAt`, 60 s · 2^n, hasta 64 min) no había vencido al abrir la app, la
     tarea se quedaba interrumpida toda la sesión. Ahora `_tick` (cada 20 s) también la
     recupera cuando le toca. */
  const { TaskManager } = require('../agent/tasks');
  const dir = tmpDir('sagi-tareas-backoff-');
  checkpoints.__test._resetForTests(dir);
  const run = checkpoints.newRun({ goal: 'seguir con lo pendiente', status: 'interrupted', origin: 'background' });
  run.nextAttemptAt = new Date(Date.now() - 1000).toISOString(); // el backoff ya venció
  checkpoints.save(run);
  const tm = new TaskManager({
    getSettings: () => ({ active: { baseUrl: 'https://api.x/v1', model: 'm' }, settings: {} }),
    agentFactory: () => ({ chat: async () => {} }),
    emit: () => {},
    notify: () => {},
  });
  tm._tick();
  tm.dispose();
  const despues = checkpoints.read(run.runId);
  ok(Number(despues.attempts) >= 1, 'la tarea se reintenta sin reiniciar la app: ' + JSON.stringify({ attempts: despues.attempts, status: despues.status }));
  ok(Date.parse(despues.nextAttemptAt) > Date.now(), 'y el backoff se reprograma: ' + despues.nextAttemptAt);
});

test('tasks: un turno de CHAT interrumpido NO se reintenta solo aunque venza su backoff', () => {
  /* El turno que dijo «me he detenido… dime si lo retomo» también es un run (origin
     'chat') interrumpido por guardarraíl o tope de llamadas. Con `autoResume()` en el
     tick se re-encolaba solo en background sin que el usuario lo pidiera y sin pasar
     por `isRunBusy`; ahora espera a que el usuario decida. */
  const { TaskManager } = require('../agent/tasks');
  const dir = tmpDir('sagi-tareas-chat-backoff-');
  checkpoints.__test._resetForTests(dir);
  const run = checkpoints.newRun({ goal: 'me he detenido; dime si lo retomo', status: 'interrupted' }); // origin 'chat'
  run.nextAttemptAt = new Date(Date.now() - 1000).toISOString();
  checkpoints.save(run);
  const tm = new TaskManager({
    getSettings: () => ({ active: { baseUrl: 'https://api.x/v1', model: 'm' }, settings: {} }),
    agentFactory: () => ({ chat: async () => {} }),
    emit: () => {},
    notify: () => {},
  });
  tm._tick();
  tm.dispose();
  const despues = checkpoints.read(run.runId);
  eq(despues.status, 'interrupted', 'el turno de chat sigue interrumpido (lo decide el usuario):');
  eq(Number(despues.attempts) || 0, 0, 'y no consume reintentos automáticos:');
});

test('tasks: _start no arranca un run que el chat sigue ejecutando (isRunBusy)', async () => {
  /* main.js inyecta isRunBusy justo para que no haya dos agentes sobre el mismo runId,
     pero solo lo miraba resume(); el arranque desde la cola (_pump → _start) no. */
  const { TaskManager } = require('../agent/tasks');
  const dir = tmpDir('sagi-tareas-ocupado-');
  checkpoints.__test._resetForTests(dir);
  let arrancado = false;
  const tm = new TaskManager({
    getSettings: () => ({ active: { baseUrl: 'https://api.x/v1', model: 'm' }, settings: {} }),
    agentFactory: () => ({ chat: async () => { arrancado = true; } }),
    emit: () => {},
    notify: () => {},
    isRunBusy: () => true,
  });
  const r = tm.enqueue({ goal: 'revisa lo pendiente' });
  await new Promise((res) => setTimeout(res, 20));
  tm.dispose();
  eq(arrancado, false, 'no se lanza el segundo agente sobre un run vivo:');
  eq(checkpoints.read(r.runId).status, 'pending', 'y la tarea espera en cola:');
});

/* ---------- el «Modo» de una tarea en background tiene que llegar al agente ----------
   Hallazgo 2 de la revisión de IPC: el modo elegido al encolar una tarea (vista Tareas,
   Act/Plan/Think) se guardaba en el `run` y no se aplicaba nunca. El agente lee el modo
   de `settings.settings.mode`, así que una tarea encolada en PLAN corría con el modo
   GLOBAL (ACT por defecto) y ESCRIBÍA archivos, contra lo que promete el modo. */

test('tasks: una tarea encolada en PLAN se ejecuta en PLAN (no con el modo global)', async () => {
  const { TaskManager } = require('../agent/tasks');
  const dir = tmpDir('sagi-tareas-modo-');
  checkpoints.__test._resetForTests(dir);
  const vistos = [];
  const tm = new TaskManager({
    getSettings: () => ({ active: { baseUrl: 'https://api.x/v1', model: 'm' }, settings: { mode: 'act' } }),
    agentFactory: () => ({
      chat: async (prompt, settings) => {
        vistos.push(settings.settings.mode);
      },
    }),
    emit: () => {},
    notify: () => {},
  });
  const r = tm.enqueue({ goal: 'revisa el proyecto', mode: 'plan' });
  ok(r.ok, 'la tarea entra en la cola: ' + JSON.stringify(r));
  for (let i = 0; i < 60 && !vistos.length; i++) await new Promise((res) => setTimeout(res, 10));
  eq(vistos[0], 'plan', 'el agente recibe el modo de la tarea, no el global «act»:');
  eq(checkpoints.read(r.runId).mode, 'plan', 'y el run sigue diciendo en qué modo se encoló:');
});

test('tasks: un modo desconocido al encolar cae en ACT (no se guarda basura en el run)', () => {
  const { TaskManager } = require('../agent/tasks');
  const dir = tmpDir('sagi-tareas-modo2-');
  checkpoints.__test._resetForTests(dir);
  const tm = new TaskManager({
    getSettings: () => ({ active: null, settings: {} }),
    agentFactory: () => ({ chat: async () => {} }),
    emit: () => {},
    notify: () => {},
  });
  const r = tm.enqueue({ goal: 'x', mode: 'destructor' });
  ok(r.ok, 'la tarea entra en la cola: ' + JSON.stringify(r));
  eq(checkpoints.read(r.runId).mode, 'act', 'el modo guardado en el run:');
});

test('banco: el lanzador pasa --json al hijo (es quien imprime el informe)', () => {
  const banco = require('../scripts/banco');
  eq(typeof banco.argsHijo, 'function', 'los argumentos del hijo tienen que poder probarse');
  const args = banco.argsHijo(['--json', '--tarea', 'bug']);
  ok(args.includes('--json'), 'el --json NO puede filtrarse: el hijo solo imprime el informe si lo recibe');
  ok(args.includes('--tarea') && args.includes('bug'), 'y los demás flags siguen pasando');
  eq(args.slice(0, 2).join(' '), '. --banco');
  // y la línea que elige el lanzador es el informe (el resto de stdout es progreso con
  // el prefijo del log, que NO empieza por «{»: por eso el informe tiene que ir crudo)
  eq(banco.informeDeSalida('[2026-01-01] [INFO] tarea 1 ok\n{"resumen":{"pasaron":1}}\n'), '{"resumen":{"pasaron":1}}');
  eq(banco.informeDeSalida('[2026-01-01] [INFO] sin informe\n'), null);
  const i = MAIN_SRC.indexOf("hay('--json')");
  ok(i > -1, 'la app tiene que imprimir el informe en una línea');
  ok(/process\.stdout\.write/.test(MAIN_SRC.slice(i, i + 140)), 'y hacerlo sin el prefijo del log (o el lanzador no lo encuentra)');
});

/* ---------- guardado de configuración: el canal tiene que poder decir la verdad ----------
   Hallazgo 4 de la revisión de IPC: workspace:set/workspace:pick (convs), shell:openPath
   (misc) y mode:set (modo) llamaban al saveConfig crudo y respondían como si hubiera
   guardado. Con config.json no escribible (datos en solo lectura, disco lleno, fichero
   bloqueado) la interfaz daba el cambio por bueno y al reiniciar volvía el valor anterior.
   Ahora propagan el {ok:false,error} de saveConfig. */

const ctxConvConSave = (dir, datos, saveConfig) => ({ ...ctxConv(dir, []), configDir: () => datos, saveConfig });

test('workspace:set: un guardado que falla se propaga como ok:false (antes salía ok:true)', () => {
  const { registerConvsIpc } = require('../main/ipc-convs');
  const dir = tmpDir('sagi-ws-fallo-');
  const datos = tmpDir('sagi-ws-datos-');
  const destino = tmpDir('sagi-ws-destino-');
  const handlers = new Map();
  const error = 'EPERM: config.json en solo lectura';
  registerConvsIpc(
    { handle: (c, fn) => handlers.set(c, fn) },
    ctxConvConSave(dir, datos, () => ({ ok: false, error })),
  );
  const r = handlers.get('workspace:set')(null, destino);
  eq(r.ok, false, 'no puede dar por bueno un cambio que se perderá al reiniciar');
  eq(r.error, error, 'el error de disco tiene que llegar a la interfaz');
});

test('workspace:set: un guardado correcto mantiene la forma {ok:true, path}', () => {
  const { registerConvsIpc } = require('../main/ipc-convs');
  const { validarWorkspaceRuta } = require('../main/workspace-ruta');
  const dir = tmpDir('sagi-ws-ok-');
  const datos = tmpDir('sagi-ws-okdatos-');
  const destino = tmpDir('sagi-ws-okdestino-');
  const handlers = new Map();
  registerConvsIpc(
    { handle: (c, fn) => handlers.set(c, fn) },
    ctxConvConSave(dir, datos, () => ({ ok: true })),
  );
  const r = handlers.get('workspace:set')(null, destino);
  eq(r.ok, true, 'con disco sano sigue siendo un éxito');
  eq(r.path, validarWorkspaceRuta(destino, datos).real, 'y la ruta sigue viniendo de vuelta');
  eq(Object.keys(r).sort().join(','), 'ok,path', 'sin campos de más en el caso bueno');
});

test('workspace:pick: el diálogo también propaga el fallo de guardado', async () => {
  const { registerConvsIpc } = require('../main/ipc-convs');
  const dir = tmpDir('sagi-pick-fallo-');
  const datos = tmpDir('sagi-pick-datos-');
  const destino = tmpDir('sagi-pick-destino-');
  const handlers = new Map();
  const error = 'EROFS: sistema de ficheros de solo lectura';
  const ctx = {
    ...ctxConvConSave(dir, datos, () => ({ ok: false, error })),
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [destino] }) },
  };
  registerConvsIpc({ handle: (c, fn) => handlers.set(c, fn) }, ctx);
  const r = await handlers.get('workspace:pick')();
  eq(r.ok, false, 'elegir carpeta tampoco puede dar por fijado lo que no se guardó');
  eq(r.error, error);
});

test('workspace:set: tras un guardado fallido, el workspace EN MEMORIA vuelve al anterior', () => {
  const { registerConvsIpc } = require('../main/ipc-convs');
  const dir = tmpDir('sagi-ws-mem-');
  const previo = tmpDir('sagi-ws-memprevio-');
  const destino = tmpDir('sagi-ws-memdestino-');
  // config vivo (main usa un único objeto): si el handler se queda el valor nuevo, aquí se ve.
  const config = { settings: { workspace: previo } };
  const handlers = new Map();
  registerConvsIpc(
    { handle: (c, fn) => handlers.set(c, fn) },
    { ...ctxConv(dir, []), config: () => config, saveConfig: () => ({ ok: false, error: 'EPERM' }) },
  );
  const r = handlers.get('workspace:set')(null, destino);
  eq(r.ok, false);
  eq(config.settings.workspace, previo, 'no puede quedarse en memoria la carpeta que no se guardó');
});

test('workspace:pick: tras un guardado fallido, el workspace EN MEMORIA vuelve al anterior', async () => {
  const { registerConvsIpc } = require('../main/ipc-convs');
  const dir = tmpDir('sagi-pick-mem-');
  const previo = tmpDir('sagi-pick-memprevio-');
  const destino = tmpDir('sagi-pick-memdestino-');
  const config = { settings: { workspace: previo } };
  const handlers = new Map();
  registerConvsIpc(
    { handle: (c, fn) => handlers.set(c, fn) },
    {
      ...ctxConv(dir, []),
      config: () => config,
      saveConfig: () => ({ ok: false, error: 'EROFS' }),
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [destino] }) },
    },
  );
  const r = await handlers.get('workspace:pick')();
  eq(r.ok, false);
  eq(config.settings.workspace, previo, 'elegir carpeta con guardado fallido tampoco cambia la memoria');
});

test('mode:set: un guardado que falla se propaga; con disco sano sigue devolviendo el modo', () => {
  const { registerModoIpc } = require('../main/ipc-modo');
  const os = require('os');
  const mk = (saveConfig) => {
    const handlers = new Map();
    const config = { settings: { mode: 'act' } };
    registerModoIpc(
      { handle: (c, fn) => handlers.set(c, fn), on: () => {} },
      {
        config: () => config,
        saveConfig,
        runtimes: { peek: () => null, allAgents: () => [] },
        getSkills: () => ({ skillsDir: () => os.tmpdir(), listSkills: async () => [] }),
        getHabits: () => ({ observe: () => {} }),
        marketplace: { catalog: () => [], searchGitHub: async () => [] },
        fsp: fs.promises,
      },
    );
    return handlers;
  };
  const error = 'EACCES: permiso denegado al escribir config.json';
  const malo = mk(() => ({ ok: false, error })).get('mode:set')(null, 'plan');
  eq(malo.ok, false, 'sin persistir no puede responder como si el modo hubiera quedado guardado');
  eq(malo.error, error);
  const bueno = mk(() => ({ ok: true })).get('mode:set')(null, 'plan');
  eq(bueno, 'plan', 'en el caso bueno sigue devolviendo el modo (lo que espera el renderer)');
});

test('shell:openPath: un guardado que falla devuelve ok:false en vez de dar la carpeta por fijada', async () => {
  const { registerMiscIpc } = require('../main/ipc-misc');
  const os = require('os');
  const datos = tmpDir('sagi-open-datos-');
  const destino = tmpDir('sagi-open-destino-');
  const mk = (saveConfig) => {
    const handlers = new Map();
    const config = { settings: {} };
    registerMiscIpc(
      { handle: (c, fn) => handlers.set(c, fn), on: () => {} },
      {
        config: () => config,
        saveConfig,
        getWin: () => null,
        getWorkspace: () => config.settings.workspace || '',
        configDir: () => datos,
        getGlow: () => {},
        app: { getPath: (k) => (k === 'desktop' ? os.tmpdir() : os.tmpdir()), quit: () => {}, minimize: () => {}, maximize: () => {} },
        shell: { openPath: async () => '', openExternal: () => {} },
        dialog: {},
        fsp: fs.promises,
        fs,
        path,
      },
    );
    return handlers;
  };
  const error = 'ENOSPC: no queda espacio en el dispositivo';
  const r = await mk(() => ({ ok: false, error })).get('shell:openPath')(null, destino);
  eq(r.ok, false, 'la carpeta se abre, pero fijarla como workspace no puede mentir');
  eq(r.error, error);
  const ok2 = await mk(() => ({ ok: true })).get('shell:openPath')(null, destino);
  eq(ok2.ok, true, 'con disco sano sigue abriendo y fijando la carpeta');
  eq(ok2.path, destino, 'y devuelve la misma ruta de antes');
  ok('workspace' in ok2, 'sin perder el campo workspace que ya devolvía');
});

test('shell:openPath: tras un guardado fallido, el workspace EN MEMORIA vuelve al anterior', async () => {
  const { registerMiscIpc } = require('../main/ipc-misc');
  const os = require('os');
  const datos = tmpDir('sagi-open-mem-datos-');
  const previo = tmpDir('sagi-open-mem-previo-');
  const destino = tmpDir('sagi-open-mem-destino-');
  const config = { settings: { workspace: previo } };
  const handlers = new Map();
  registerMiscIpc(
    { handle: (c, fn) => handlers.set(c, fn), on: () => {} },
    {
      config: () => config,
      saveConfig: () => ({ ok: false, error: 'ENOSPC' }),
      getWin: () => null,
      getWorkspace: () => config.settings.workspace || '',
      configDir: () => datos,
      getGlow: () => {},
      app: { getPath: () => os.tmpdir(), quit: () => {}, minimize: () => {}, maximize: () => {} },
      shell: { openPath: async () => '', openExternal: () => {} },
      dialog: {},
      fsp: fs.promises,
      fs,
      path,
    },
  );
  const r = await handlers.get('shell:openPath')(null, destino);
  eq(r.ok, false);
  eq(config.settings.workspace, previo, 'abrir con guardado fallido no puede cambiar la memoria');
});

/* ---------- guardado atómico: bloqueos pasajeros de Windows ---------- */

test('config: un EPERM pasajero al escribir se reintenta y no deja temporales', () => {
  const cfg = require('../main/config');
  const dir = tmpDir('sagi-config-atomic-');
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{"a":1}');
  const orig = fs.writeFileSync;
  let intentos = 0;
  fs.writeFileSync = function (destino, ...resto) {
    if (String(destino).endsWith('.tmp') && ++intentos === 1) {
      const e = new Error("EPERM: operation not permitted, open '" + destino + "'");
      e.code = 'EPERM';
      throw e;
    }
    return orig.call(fs, destino, ...resto);
  };
  try {
    cfg.writeJsonAtomic(file, '{"b":2}');
  } finally {
    fs.writeFileSync = orig;
  }
  eq(intentos >= 2, true, 'el primer bloqueo pasajero se reintenta');
  eq(fs.readFileSync(file, 'utf8'), '{"b":2}', 'el archivo bueno queda con el contenido nuevo');
  eq(fs.readFileSync(file + '.bak', 'utf8'), '{"a":1}', 'el .bak conserva la versión anterior');
  eq(
    fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length,
    0,
    'sin temporales sueltos junto a la configuración',
  );
});
