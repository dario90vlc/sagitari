'use strict';

/* ============================================================================
   ui-check.js — ¿funciona de verdad la interfaz de SAGITARI?

   El smoke test (`npm run smoke`) sólo comprueba que la ventana se abre. Eso
   NO basta: si un script del renderer revienta al compilar (por ejemplo, dos
   ficheros que declaran el mismo nombre), la ventana se abre igual, el HTML
   estático se ve... y la app no responde a nada. Pasó exactamente eso.

   Esto arranca la app de verdad, se conecta a la ventana por el protocolo de
   depuración de Chromium y comprueba el renderer ya en marcha: iconos, cableado
   de botones, navegación entre vistas, el tema de cada modo y el estado vacío.

   Uso: node scripts/ui-check.js      (exit 0 = interfaz sana)
   ============================================================================ */

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

const electron = require('electron'); // en un proceso Node normal: la ruta del binario
const APP_DIR = path.join(__dirname, '..');
const TIMEOUT_MS = 25000;
/* Tope por comprobación: una que no responde (hilo del renderer bloqueado) debe
   contar como fallo, no dejar el script esperando para siempre. */
const CHECK_DEADLINE_MS = 8000;

/* La app de prueba vive en su propio directorio de datos (main.js lo deriva de
   --hidden/--test). Se le deja un config mínimo para que la interfaz se vea como
   una instalación configurada: sin proveedor activo la app arranca con la
   bienvenida «ve a Ajustes» y el estado vacío no está visible, que es justo lo
   que se comprueba aquí. No lleva ninguna credencial: el «modelo» es un servidor
   local de mentira (`fakeLlm`), así que las llamadas al modelo no salen a la red
   ni tocan claves reales — y de paso enseñan qué herramientas le ofrece la app
   al modelo, que no viaja por ningún canal de la interfaz. */
/* Perfil de la instancia de prueba. SAGITARI_TEST_PROFILE lo apunta a un directorio
   escribible: en un sandbox que restringe el token, Electron no puede escribir en
   %APPDATA% (el bloqueo de instancia no se crea y la app sale con «ya está
   abierta» sin que haya ninguna). Sin la variable, la ruta es siempre la de antes. */
const TEST_PROFILE = process.env.SAGITARI_TEST_PROFILE
  ? path.resolve(process.env.SAGITARI_TEST_PROFILE)
  : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'SagitariAI-test');
const TEST_DATA_DIR = TEST_PROFILE;
/* El espacio de trabajo de la instancia de prueba: dentro del workspace, no en
   %TEMP% — por el mismo motivo de arriba: Electron no puede escribir en %TEMP% y
   la comprobación de la revisión del cambio escribe un archivo de verdad. */
/* Restos de ejecuciones cortadas: el espacio de trabajo se borra al terminar, pero una
   ejecución interrumpida (Ctrl+C, un timeout, el portapapeles de una tubería) deja la
   carpeta con el archivo que escribe la comprobación de la revisión. Se barren ANTES de
   crear el de esta ejecución: si no, se acumulan en el repositorio y aparecen como código
   del proyecto en el lint y en el formateo. */
try {
  for (const e of fs.readdirSync(APP_DIR)) {
    if (!/^sagi-ui-ws-/.test(e)) continue;
    try {
      fs.rmSync(path.join(APP_DIR, e), { recursive: true, force: true });
    } catch {}
  }
} catch {}
const WS_TEST = fs.mkdtempSync(path.join(APP_DIR, 'sagi-ui-ws-'));
/* El directorio de los árboles de trabajo aislados (agent/arboles.js) se fija AQUÍ para que
   esta comprobación pruebe siempre lo mismo: sin fijarlo, un equipo donde %TEMP% no admita
   un árbol hacía que el compañero escribiera directo en el espacio de trabajo —aislamiento
   apagado sin decirlo— y la comprobación pasaba por el camino fácil. Dentro del repositorio
   (ignorado por git) el aislamiento ocurre igual aquí y en la CI, y la comprobación de más
   abajo exige ver el árbol mientras el compañero trabaja. */
const ARBOLES_TEST = path.join(APP_DIR, '.tmp-arboles', 'uicheck');
try {
  fs.rmSync(ARBOLES_TEST, { recursive: true, force: true });
} catch {}
/** ¿Hay ahora mismo un árbol de trabajo aislado en pie? Se mira mientras el compañero espera
    el permiso: en ese momento el árbol está creado y quieto, así que no es una carrera. */
function hayArbolAislado() {
  try {
    return fs.readdirSync(ARBOLES_TEST).some((e) => /^arbol-/.test(e));
  } catch {
    return false;
  }
}
function seedTestConfig(apiPort) {
  const file = path.join(TEST_DATA_DIR, 'config.json');
  /* Proveedor con lista larga y el modelo en uso al final: es el caso que hace
     desplazarse al menú de modelos, así que las comprobaciones de interfaz se
     enfrentan al mismo escenario que el usuario (lista desplazada, cabecera y pie
     fijos) y no al caso fácil de una sola fila. */
  const modelos = Array.from({ length: 12 }, (_, i) => 'test-model-' + (i + 1));
  const dummy = {
    providerId: 'ui-check',
    name: 'Prueba (sin conexión)',
    baseUrl: 'http://127.0.0.1:' + apiPort + '/v1',
    apiKey: '',
    model: 'test-model-10',
    vision: false,
  };
  // Servidor MCP de prueba: el mismo que usan los tests unitarios. Sin red y sin
  // instalar nada, así que la comprobación de interfaz no depende del entorno.
  const mcpServer = {
    id: 'eco',
    name: 'Eco de prueba',
    enabled: true,
    transport: 'stdio',
    command: process.execPath,
    args: [path.join(APP_DIR, 'test', 'fixtures', 'mcp-echo-server.js')],
    env: {},
  };
  /* Y un segundo servidor APAGADO (no arranca nada) cuyo id lleva guion: es el caso en
     el que el id crudo y el nombre expuesto NO coinciden (`mcp__my-server__*` frente a
     `mcp__my_server__*`). Con él la comprobación de la fila de permisos discrimina de
     verdad: con el id crudo, el desplegable de Seguridad no coincidiría con la clave
     que resuelve el motor de permisos. */
  const mcpServerConGuion = {
    id: 'my-server',
    name: 'Con guion (apagado)',
    enabled: false,
    transport: 'stdio',
    command: process.execPath,
    args: [path.join(APP_DIR, 'test', 'fixtures', 'mcp-echo-server.js')],
    env: {},
  };
  /* Un proveedor guardado cuya clave NO se puede descifrar (pasa de verdad: config
     traída de otro perfil o de otro equipo). Antes, el arranque lo trataba como fallo
     interno y sacaba un diálogo modal antes de poder usar nada; ahora la app arranca, el
     proveedor queda marcado y Ajustes dice qué hacer. Esta entrada es lo que hace que la
     comprobación de interfaz cubra ese camino. */
  const proveedorConClaveIlegible = {
    id: 'clave-ilegible',
    name: 'Prueba (clave ilegible)',
    baseUrl: 'https://ejemplo.invalid/v1',
    apiKey: 'enc:v1:ZXN0by1uby1lc3VuYS1jbGF2ZQ==',
    models: ['modelo-x'],
  };
  /* SIEMPRE se reescribe. Este perfil es de las pruebas: dar por bueno lo que
     hubiera dejado otro proceso hacía que el ui-check verificara un estado distinto
     cada vez (llegó a comprobar un menú con 16 modelos y otro activo, donde la
     primera fila de la lista quedaba fuera de la parte visible). */
  try {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          providers: [{ ...dummy, id: 'ui-check', models: modelos }, proveedorConClaveIlegible],
          active: dummy,
          mcp: { enabled: true, servers: [mcpServer, mcpServerConGuion] },
          // el razonamiento se muestra en las comprobaciones de la interfaz: es un ajuste
          // del usuario y hay que verificar que su bloque aparece (y que se apaga solo)
          settings: { showThinking: true, workspace: WS_TEST },
        },
        null,
        2,
      ),
      'utf8',
    );
    /* Y el HISTORIAL también se limpia: este perfil es de las pruebas y arrastrar las
       conversaciones de otra ejecución (o las de una copia del perfil real, que es como
       se descubrió) hacía que las comprobaciones del chat encontraran tarjetas y burbujas
       de un hilo viejo. El turno que escribe cada comprobación tiene que ser el ÚNICO
       contenido del hilo: es lo que hace que estas aserciones midan lo que dicen medir. */
    for (const f of ['conversations.json', 'conversations.json.bak', 'memory.json', 'memory.json.bak', 'memory-tray.json']) {
      try {
        fs.rmSync(path.join(TEST_DATA_DIR, f), { force: true });
      } catch {}
    }
  } catch {}
}

const get = (url) =>
  new Promise((res, rej) => {
    http
      .get(url, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => res(d));
      })
      .on('error', rej);
  });

/** Puerto libre para no chocar con otra instancia de desarrollo. */
function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
}

/* Un «modelo» de mentira, en local: contesta cada petición con un turno SSE de una línea y
   apunta qué herramientas (`tools`) le ofreció la app. Es la ÚNICA ventana al catálogo real
   que ve el modelo (`allToolDefs`): no viaja por ningún canal de la interfaz, así que sin
   esto el interruptor global sólo se podía comprobar por lo que la app dice de sí misma, no
   por lo que de verdad recibe el modelo. `vistos` guarda un array de nombres por petición. */
function fakeLlm() {
  const vistos = [];
  /* La petición CRUDA, además de los nombres de herramientas: es lo único que el modelo
     recibe de verdad (system prompt, definiciones y el índice de skills), así que es
     donde se puede comprobar el registro con el que se le habla, sin fiarse del código. */
  const cuerpos = [];
  /* GUION: respuestas SSE ya hechas que se sirven en orden antes de caer al «listo» de
     siempre. Permite escenificar un turno con herramientas (p. ej. una delegación) sin
     inventar un servidor aparte: cada petición —incluidas las del SUBAGENTE, que usa el
     mismo proveedor— consume la siguiente. */
  const guion = [];
  /* ENRUTADO POR PETICIÓN (v4.4): el guion lineal sirve mientras haya UN solo hablante,
     pero con dos compañeros de equipo en paralelo el orden de llegada de sus peticiones
     no está garantizado y el guion se repartiría al azar. Un router mira el CUERPO de la
     petición (quién pregunta: el líder o el compañero «m2») y devuelve su respuesta; si
     no dice nada, se sigue con la cola de siempre. */
  let router = null;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      let nombres = null;
      try {
        nombres = (JSON.parse(body).tools || []).map((t) => (t.function || {}).name).filter(Boolean);
      } catch {}
      vistos.push(nombres); // null = la petición no traía `tools`
      cuerpos.push(body);
      let respuesta = null;
      if (router) {
        try {
          respuesta = router(body);
        } catch {}
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        respuesta ||
          (guion.length
            ? guion.shift()
            : 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'listo' } }] }) + '\n\ndata: [DONE]\n\n'),
      );
      res.end();
    });
  });
  return new Promise((res) =>
    srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port, vistos, cuerpos, guion, setRouter: (f) => (router = f) })),
  );
}

/** Una respuesta SSE de una sola frase (o de un tool_call, ver `guionToolCall`). */
function guionTexto(texto) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content: texto } }] }) + '\n\ndata: [DONE]\n\n';
}
function guionToolCall(id, name, args) {
  return (
    'data: ' +
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] }) +
    '\n\ndata: [DONE]\n\n'
  );
}
/** VARIAS llamadas en el MISMO mensaje (lo que necesita un líder que reparte trabajo:
    dos compañeros se levantan a la vez, no uno detrás de otro). */
function guionToolCalls(lista) {
  return (
    'data: ' +
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: lista.map((c, i) => ({ index: i, id: c.id, function: { name: c.name, arguments: JSON.stringify(c.args) } })),
          },
        },
      ],
    }) +
    '\n\ndata: [DONE]\n\n'
  );
}
/** Razonamiento del modelo (`reasoning_content`, como DeepSeek y compañía) + su respuesta. */
function guionRazonamiento(razonamiento, respuesta) {
  return (
    'data: ' +
    JSON.stringify({ choices: [{ delta: { reasoning_content: razonamiento } }] }) +
    '\n\n' +
    (respuesta ? 'data: ' + JSON.stringify({ choices: [{ delta: { content: respuesta } }] }) + '\n\n' : '') +
    'data: [DONE]\n\n'
  );
}

/** Comprobaciones sobre la ventana viva. `true` = bien. */
const CHECKS = {
  'renderer sin errores de carga (nada roto antes de arrancar)':
    'typeof window.ChatKit === "object" && typeof window.SAGI_ICONS === "object"',
  'iconos inyectados en toda la interfaz': 'document.querySelectorAll("[data-i] svg").length >= 25',
  'ningún icono se quedó sin dibujo': '[...document.querySelectorAll("[data-i]")].every(e => e.querySelector("svg"))',
  'los iconos tienen trazo real (no el punto de reserva)':
    '[...document.querySelectorAll("[data-i] svg")].filter(s => s.innerHTML.length > 20).length >= 20',
  'sidebar: 4 grupos y 11 secciones (sin Inicio)':
    'document.querySelectorAll(".navgroup").length === 4 && document.querySelectorAll(".navitem").length === 11',
  'la sección MCP es propia: el ítem del sidebar abre su vista y contiene la lista':
    '(function(){ const b = document.querySelector(\'.navitem[data-view="mcp"]\'); if (!b) return false; b.click(); const v = document.querySelector("#view-mcp"); const list = document.querySelector("#mcpList"); return !!v && v.classList.contains("on") && b.classList.contains("on") && !!list && v.contains(list) && !document.querySelector("#setTabs .settab[data-set=mcp]"); })()',
  'Alt+0 sigue sin cambiar de vista':
    '(function(){ const antes = [...document.querySelectorAll(".view.on")].map(v => v.id).join(","); window.dispatchEvent(new KeyboardEvent("keydown", { key: "0", altKey: true, bubbles: true })); return [...document.querySelectorAll(".view.on")].map(v => v.id).join(",") === antes; })()',
  'Alt+7 sigue abriendo Herramientas':
    '(function(){ document.querySelector(\'[data-view="chat"]\').click(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "7", altKey: true, bubbles: true })); return document.querySelector("#view-tools").classList.contains("on"); })()',
  'controles de ventana cableados':
    '["#btnClose","#btnMin","#btnMax"].every(s => { const e = document.querySelector(s); return e && typeof e.onclick === "function"; })',
  'la navegación responde':
    '(function(){ document.querySelector(\'[data-view="tasks"]\').click(); const ok1 = document.querySelector("#view-tasks").classList.contains("on"); document.querySelector(\'[data-view="chat"]\').click(); return ok1 && document.querySelector("#view-chat").classList.contains("on"); })()',
  'el selector de modo tiene los cuatro, con icono':
    'document.querySelectorAll("#modeSeg button").length === 4 && [...document.querySelectorAll("#modeSeg button")].every(b => b.querySelector("svg"))',
  'el chat queda teñido con su modo': '/^(act|plan|think|equipo)$/.test(document.querySelector("#view-chat").dataset.mode)',
  'el compositor del chat está cableado':
    'typeof document.querySelector("#chatSend").onclick === "function" && typeof document.querySelector("#btnCopyConv").onclick === "function"',
  'la interfaz no ha registrado ningún error propio': 'Array.isArray(window.__errores) && window.__errores.length === 0',
};

const EVENTS = [
  ['conversación nueva deja el estado vacío visible', '(function(){ document.querySelector("#btnClear").click(); return true; })()'],
];

const AFTER = {
  'el estado vacío sigue existiendo tras vaciar los mensajes':
    '!document.querySelector("#chatEmpty").hidden && document.querySelector("#messages").children.length === 0',
  'ofrece los cuatro modos, en fila':
    '(function(){ const c = [...document.querySelectorAll("#ceModes .ce-mode")]; return c.length === 4 && new Set(c.map(x => Math.round(x.getBoundingClientRect().top))).size === 1 && c[0].getBoundingClientRect().width > 120; })()',
  'sin vista Inicio: la app abre directamente en Chat':
    '(function(){ return !document.querySelector("#view-home") && document.querySelector("#view-chat").classList.contains("on"); })()',
  'no pisa el compositor':
    '(function(){ const e = document.querySelector("#chatEmpty").getBoundingClientRect(); const c = document.querySelector("#chatWrap .composer").getBoundingClientRect(); return e.bottom <= c.top + 1; })()',
  'cambiar de modo se refleja en la vista':
    '(function(){ const b = [...document.querySelectorAll("#modeSeg button")].find(x => x.dataset.m === "think"); b.click(); return true; })()',
};

(async () => {
  // El modelo de mentira primero: su puerto va en el config que se siembra.
  const llm = await fakeLlm();
  seedTestConfig(llm.port);
  const port = await freePort();
  // --hidden: la ventana NO se muestra. Antes se abría y se cerraba sola durante
  // probar.bat, y eso se ve idéntico a «la app se cierra sola».
  /* El entorno no debe heredar ELECTRON_RUN_AS_NODE: con él Electron se comporta
     como Node, no hay ventana y el puerto de depuración no existe. Y el perfil de
     pruebas tiene que ser escribible (arriba). */
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  env.SAGITARI_TEST_PROFILE = TEST_PROFILE;
  /* Y los árboles aislados a un directorio escribible dentro del repositorio: así el
     aislamiento de verdad ocurre también donde %TEMP% no lo admite (ver ARBOLES_TEST). */
  env.SAGITARI_ARBOLES_DIR = ARBOLES_TEST;
  const child = spawn(
    electron,
    [
      '--remote-debugging-port=' + port,
      '--hidden',
      /* Sin --no-sandbox el sandbox de Chromium no se levanta en un token
         restringido y el proceso sale con STATUS_CONTROL_C_EXIT. --disable-gpu
         evita el proceso de GPU, que es el que falla en un escritorio sin GPU. */
      '--no-sandbox',
      '--disable-gpu',
      '.',
    ],
    { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe'], env },
  );
  let childOut = '';
  child.stdout.on('data', (d) => {
    childOut += d;
  });
  child.stderr.on('data', (d) => {
    childOut += d;
  });
  /* Salir ANTES de que la instancia de prueba muera de verdad dejaba vivo un
     proceso que aún sujetaba cosas (el bloqueo de instancia única, el
     navegador). El lanzamiento siguiente se encontraba el terreno ocupado.
     Ahora esperamos a su salida real; si se resiste, lo forzamos. */
  const done = (code) => {
    let salido = false;
    const salir = () => {
      if (!salido) {
        salido = true;
        process.exit(code);
      }
    };
    try {
      llm.srv.close();
    } catch {}
    try {
      fs.rmSync(WS_TEST, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(ARBOLES_TEST, { recursive: true, force: true });
    } catch {}
    child.once('exit', salir);
    try {
      child.kill();
    } catch {}
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      salir();
    }, 4000);
  };

  let page = null;
  const deadline = Date.now() + TIMEOUT_MS;
  while (!page && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      const list = JSON.parse(await get(`http://127.0.0.1:${port}/json/list`));
      page = list.find((p) => p.type === 'page' && /index\.html/.test(p.url));
    } catch {}
  }
  if (!page) {
    const abierta = /ya está abierta/i.test(childOut);
    const motivo = abierta ? 'hay otra instancia de SAGITARI abierta: ciérrala y vuelve a intentarlo' : 'la ventana no respondió';
    console.error('UI-CHECK::' + JSON.stringify({ ok: false, error: motivo }));
    if (abierta) console.error('SAGITARI ya se está ejecutando. Ciérralo (o usa el icono de la bandeja) antes de probar.');
    return done(1);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  /* Fallos registrados ANTES de tener ventana: aquí ya están escritos (loadConfig corre
     al cargar el módulo). A partir de aquí, cualquier línea nueva es un fallo ocurrido
     con la app ya en marcha, y eso es lo que se comprueba al final. */
  const lineasCrash = () => {
    try {
      return fs
        .readFileSync(path.join(TEST_DATA_DIR, 'logs', 'crash.log'), 'utf8')
        .split('\n')
        .filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  const crashAlArrancar = lineasCrash();
  let id = 0;
  let terminado = false; // el veredicto final ya está dado: no lo pisa el cierre
  const pending = new Map();
  const scriptErrors = [];
  /* Sólo cuentan los errores de SCRIPT (un fichero que no compila, una función
     que no existe...). Un aviso de red o del sistema de audio no dice nada
     sobre si la interfaz está viva, y contarlo volvía el check inestable. */
  const isScriptError = (t) =>
    /uncaught|syntaxerror|referenceerror|typeerror|is not defined|is not a function|cannot read|unexpected token/i.test(String(t || ''));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      scriptErrors.push((d.exception && d.exception.description) || d.text || 'excepción');
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const text = (m.params.args || []).map((a) => a.value || a.description || '').join(' ');
      if (isScriptError(text)) scriptErrors.push(text.slice(0, 160));
    }
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const evaluate = (expr) =>
    new Promise((res) => {
      const myId = ++id;
      // deadline: si el renderer deja de responder (bucle en su hilo, IPC colgado,
      // proceso muerto) la comprobación se resuelve como fallo en vez de dejar el
      // job colgado para siempre — que es justo lo que este script debe detectar.
      const timer = setTimeout(() => {
        pending.delete(myId);
        res(undefined);
      }, CHECK_DEADLINE_MS);
      pending.set(myId, (m) => {
        clearTimeout(timer);
        res(m.result && m.result.result ? m.result.result.value : undefined);
      });
      // awaitPromise: las comprobaciones que consultan el estado por IPC son async
      ws.send(
        JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }),
      );
    });
  /* Comando CDP cualquiera (se usa para emular el tamaño mínimo de ventana). */
  const cmd = (method, params = {}) =>
    new Promise((res) => {
      const myId = ++id;
      const timer = setTimeout(() => {
        pending.delete(myId);
        res(undefined);
      }, CHECK_DEADLINE_MS);
      pending.set(myId, (m) => {
        clearTimeout(timer);
        res(m.result);
      });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  /* Si el renderer se cae a mitad, sin esto el script se quedaba esperando una
     respuesta que ya no podía llegar (y la CI, 360 min de job). */
  ws.on('close', () => {
    if (terminado) return;
    console.error('UI-CHECK::{"ok":false,"error":"la interfaz cerró la conexión antes de terminar"}');
    done(1);
  });
  ws.on('error', (e) => {
    if (terminado) return;
    console.error('UI-CHECK::{"ok":false,"error":' + JSON.stringify('websocket: ' + ((e && e.message) || e)) + '}');
    done(1);
  });
  await new Promise((r) => ws.on('open', r));
  await new Promise((r) => setTimeout(r, 1200)); // deja terminar el arranque del renderer
  await ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable' }));
  await new Promise((r) => setTimeout(r, 300));

  let failed = 0;
  /* Una comprobación se repite una vez antes de darla por fallida: tras un
     cambio de vista o un IPC recién resuelto el layout puede tardar un frame.
     Un fallo real falla las dos veces. */
  const judge = async (name, expr) => {
    let v = await evaluate(expr);
    if (v !== true) {
      await new Promise((r) => setTimeout(r, 500));
      v = await evaluate(expr);
    }
    if (v === true) {
      console.log('  ok   ' + name);
      return true;
    }
    failed++;
    console.log('  FALLO ' + name + '  ->  ' + JSON.stringify(v));
    return false;
  };

  for (const [name, expr] of Object.entries(CHECKS)) await judge(name, expr);
  // escenario: conversación nueva
  for (const [, expr] of EVENTS) await evaluate(expr);
  await new Promise((r) => setTimeout(r, 900));
  for (const [name, expr] of Object.entries(AFTER)) await judge(name, expr);
  // el cambio de modo debe haber teñido la vista
  await judge(
    'el modo elegido tiñe el chat',
    '(function(){ for (let i = 0; i < 40; i++) {} return document.querySelector("#view-chat").dataset.mode === "think"; })()',
  );
  /* ---- regresiones de la auditoría de UI (verificadas sobre la app viva) ---- */
  // El atributo `hidden` era anulado por reglas con display:grid/flex/inline-flex
  await judge(
    'los elementos ocultos con [hidden] no se pintan',
    '(function(){ return ["#jumpDown","#attachStrip","#chStatus"].every(function(s){ var e = document.querySelector(s); return !e || !e.hidden || getComputedStyle(e).display === "none"; }); })()',
  );
  // Sin @keyframes blink los indicadores de actividad quedaban estáticos
  await judge(
    'los indicadores de actividad tienen animación real',
    '(function(){ for (var i = 0; i < document.styleSheets.length; i++) { var rules; try { rules = document.styleSheets[i].cssRules; } catch (e) { continue; } for (var j = 0; j < rules.length; j++) { if (rules[j].type === CSSRule.KEYFRAMES_RULE && rules[j].name === "blink") return true; } } return false; })()',
  );
  // Alt+0 mapeaba a una vista inexistente y dejaba la app en blanco
  await judge(
    'Alt+0 no deja la app sin vista activa',
    '(function(){ window.dispatchEvent(new KeyboardEvent("keydown", { key: "0", altKey: true, bubbles: true })); var on = document.querySelector(".view.on"); return !!on && on.id === "view-chat"; })()',
  );
  // Los atajos no deben dispararse mientras se escribe en un campo
  await judge(
    'los atajos no saltan de vista escribiendo en el chat',
    '(function(){ var input = document.querySelector("#chatInput"); input.focus(); input.dispatchEvent(new KeyboardEvent("keydown", { key: "4", altKey: true, bubbles: true })); var on = document.querySelector(".view.on"); var ok = !!on && on.id === "view-chat"; input.blur(); return ok; })()',
  );
  /* ---- actualizaciones: una instalación que se quedó a medias se puede reintentar ----
     El motor la recuerda en disco y el siguiente arranque la anuncia (para instalar hay
     que cerrar la app, así que es el único momento en que se le puede contar). Aquí se
     comprueba que la tarjeta la pinta con su botón: sin esto el usuario se quedaba en
     «se cierra, aparece una terminal, no pasa nada» y sin forma de volver a intentarlo. */
  await judge(
    'la tarjeta de actualizaciones ofrece reintentar una instalación a medias',
    '(function(){ if (typeof renderUpdate !== "function") return "renderUpdate no accesible"; var antes = JSON.stringify(updState); renderUpdate({ kind: "nsis", current: "3.2.0", latest: "3.2.1", available: true, ready: null, pending: { version: "3.2.1", path: "C:\\\\Temp\\\\sagitari-update\\\\SAGITARI-Setup-3.2.1.exe", exists: true } }); var b = document.querySelector("#updInstallBtn"), lbl = document.querySelector("#updInstallLabel"), nota = document.querySelector("#updNote"); var ok = !b.hidden && !b.disabled && lbl.textContent === "Reintentar la instalación" && !nota.hidden && /3\\.2\\.1/.test(nota.textContent); renderUpdate(JSON.parse(antes)); return ok; })()',
  );
  await judge(
    'si el instalador pendiente ya no está, la tarjeta invita a descargarla otra vez',
    '(function(){ if (typeof renderUpdate !== "function") return "renderUpdate no accesible"; var antes = JSON.stringify(updState); renderUpdate({ kind: "nsis", current: "3.2.0", latest: "3.2.1", available: true, ready: null, pending: { version: "3.2.1", path: "C:\\\\Temp\\\\ya-no-esta.exe", exists: false } }); var dl = document.querySelector("#updDownloadBtn"), nota = document.querySelector("#updNote"); var ok = !dl.hidden && !nota.hidden && /vuelve a descargar|descarga la actualización otra vez/i.test(nota.textContent) && /no llegó a completarse/.test(nota.textContent); renderUpdate(JSON.parse(antes)); return ok; })()',
  );
  /* ---- selector de modelo: el clic tiene que llegar al menú ----
     Comprueba el recorrido completo del selector (abrir → pulsar una fila →
     menú cerrado y píldora actualizada) con eventos de ENTRADA del navegador en
     vez de `.click()`, que se salta el reparto de eventos y por eso no veía nada.

     Lo que ESTE check no puede cubrir: el reparto de zonas de arrastre de la
     ventana. Los eventos inyectados por CDP entran directamente en el renderer y
     no pasan por el hit-test del sistema, así que un elemento dentro de una zona
     `-webkit-app-region: drag` recibe el clic inyectado aunque para el ratón real
     esté muerto (le pasó al menú de modelos: se abría y no respondía). Eso sólo se
     detecta con un clic físico en una ventana visible: ver el comentario de
     `.side` en styles.css. */
  const pulsarConRaton = async (selector) => {
    const pos = await evaluate(
      `(function(){ var e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; var r = e.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }); })()`,
    );
    if (!pos) return false;
    const { x, y } = JSON.parse(pos);
    await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 450));
    return true;
  };
  await pulsarConRaton('#sideStatusBtn');
  const menuAbierto = await evaluate('!document.querySelector("#modelMenu").hidden');
  const destino = await evaluate(`(function(){
    /* Se elige una fila que esté DENTRO de la parte visible del menú y que el
       hit-test del navegador confirme. Con la lista desplazada (el modelo en uso va
       marcado y se desplaza a la vista), la primera fila del proveedor puede quedar
       por encima del área visible: pulsar sus coordenadas cae fuera del menú, en la
       barra lateral — eso cerraba el menú como «clic fuera» y además cambiaba de
       vista, tirando las comprobaciones siguientes. */
    var m = document.querySelector('#modelMenu').getBoundingClientRect();
    var filas = [...document.querySelectorAll('#modelMenu [data-model]')];
    var orden = filas.filter(function(r){ return !r.classList.contains('on'); }).concat(filas);
    for (var i = 0; i < orden.length; i++) {
      var b = orden[i].getBoundingClientRect();
      if (b.top < m.top || b.bottom > m.bottom) continue;
      var hit = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2));
      if (hit && hit.closest('[data-model]') === orden[i]) return orden[i].dataset.model;
    }
    return null;
  })()`);
  const pulsado = destino ? await pulsarConRaton('#modelMenu [data-model="' + destino + '"]') : false;
  const menuCerrado = await evaluate('document.querySelector("#modelMenu").hidden');
  const pildora = await evaluate('document.querySelector("#stModel").textContent');
  if (menuAbierto && destino && pulsado && menuCerrado && pildora === destino) {
    console.log('  ok   el selector de modelo responde al ratón real (' + destino + ')');
  } else {
    failed++;
    console.log(
      '  FALLO el selector de modelo no responde al ratón real  ->  ' +
        JSON.stringify({ menuAbierto, destino, pulsado, menuCerrado, pildora }),
    );
  }
  /* ---- el menú de modelos también con el teclado (antes solo con ratón) ----
     El botón anuncia aria-haspopup="listbox": si no se puede elegir sin ratón, la
     promesa de accesibilidad es falsa. Se comprueba sobre la interfaz viva. */
  await judge(
    'el menú de modelos se navega con el teclado',
    '(function(){' +
      ' var b = document.querySelector("#sideStatusBtn"), m = document.querySelector("#modelMenu");' +
      ' if (!b || !m) return false;' +
      ' if (m.hidden) b.click();' + // abrir solo si estaba cerrado
      ' if (m.hidden) return false;' +
      ' b.focus();' +
      ' if (!b.contains(document.activeElement)) return false;' +
      ' var kv = function (k) { document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); };' +
      ' var hl = function () { return m.querySelectorAll(".sm-item.hl"); };' +
      ' kv("ArrowDown");' +
      ' if (hl().length !== 1) return false;' +
      ' var uno = hl()[0];' +
      ' kv("ArrowDown");' +
      ' if (hl().length !== 1 || hl()[0] === uno) return false;' +
      ' kv("End");' +
      ' if (hl().length !== 1) return false;' +
      ' kv("ArrowUp");' +
      ' if (hl().length !== 1) return false;' +
      ' kv("Escape");' +
      ' return m.hidden === true;' +
      '})()',
  );
  /* ---- desplegables propios: el popup del sistema no se puede tematizar ----
     El popup de un <select> lo dibuja Windows (claro, con su tipografía) y no hay
     CSS que lo alcance; por eso cada select lleva encima un control de la app. Se
     comprueba que TODOS están mejorados, que la lista se pinta con las clases de los
     menús, que elegir escribe en el select nativo y propaga `change` —el contrato
     del que vive el resto del código— y que los campos de fecha piden tema oscuro
     (así el calendario del sistema sale oscuro). */
  /* Un `evaluate` cuya expresión lanza devuelve undefined: si eso pasaba (p. ej. al
     desactivar la mejora para probar esta misma comprobación) el JSON.parse reventaba
     el arnés entero en vez de contar un fallo. */
  const jsonDe = (v) => {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };
  const selects = jsonDe(
    await evaluate(
      'JSON.stringify({ total: document.querySelectorAll("select").length, mejorados: [...document.querySelectorAll("select")].filter(s => s.dataset.csel === "1" && s.closest(".csel") && s.closest(".csel").querySelector(".csel-btn") && s.closest(".csel").querySelector(".csel-menu")).length })',
    ),
  ) || { total: -1, mejorados: -1 };
  await evaluate('document.querySelector(\'[data-view="tasks"]\').click()');
  await new Promise((r) => setTimeout(r, 400));
  await pulsarConRaton('.csel[data-csel-de="taskMode"] .csel-btn');
  const listaModo =
    jsonDe(
      await evaluate(`JSON.stringify({
    abierto: document.querySelector('.csel[data-csel-de="taskMode"] .csel-menu') ? !document.querySelector('.csel[data-csel-de="taskMode"] .csel-menu').hidden : false,
    filas: [...document.querySelectorAll('.csel[data-csel-de="taskMode"] .sm-item .sm-name')].map(f => f.textContent),
    opciones: [...(document.querySelector('#taskMode') || { options: [] }).options].map(o => o.textContent.trim()),
    clases: (document.querySelector('.csel[data-csel-de="taskMode"] .sm-item') || {}).className || '',
    fondo: document.querySelector('.csel[data-csel-de="taskMode"] .csel-menu') ? getComputedStyle(document.querySelector('.csel[data-csel-de="taskMode"] .csel-menu')).backgroundImage.slice(0, 21) : '',
    alfa: document.querySelector('.csel[data-csel-de="taskMode"] .csel-menu') ? parseFloat(getComputedStyle(document.querySelector('.csel[data-csel-de="taskMode"] .csel-menu')).backgroundColor.split(',').pop()) : 0,
    blur: document.querySelector('.csel[data-csel-de="taskMode"] .csel-menu') ? String(getComputedStyle(document.querySelector('.csel[data-csel-de="taskMode"] .csel-menu')).backdropFilter || 'none') : 'none'
  })`),
    ) || {};
  await pulsarConRaton('.csel[data-csel-de="taskMode"] .sm-item:nth-child(2)');
  const elegido =
    jsonDe(
      await evaluate(`JSON.stringify({
    valor: (document.querySelector('#taskMode') || {}).value,
    etiqueta: (document.querySelector('.csel[data-csel-de="taskMode"] .csel-label') || {}).textContent,
    cerrado: (document.querySelector('.csel[data-csel-de="taskMode"] .csel-menu') || {}).hidden
  })`),
    ) || {};
  const fechaOscura = (await evaluate('getComputedStyle(document.querySelector("#taskWhen")).colorScheme === "dark"')) === true;
  await evaluate('document.querySelector(\'[data-view="chat"]\').click()');
  await new Promise((r) => setTimeout(r, 300));
  const selectsOk =
    selects.total > 0 &&
    selects.total === selects.mejorados &&
    listaModo.abierto === true &&
    (listaModo.filas || []).join(',') === (listaModo.opciones || []).join(',') &&
    listaModo.filas.length > 0 &&
    /sm-item/.test(listaModo.clases) &&
    (/linear-gradient/.test(listaModo.fondo) ||
      (listaModo.fondo === 'none' && (listaModo.alfa >= 0.9 || /blur/.test(listaModo.blur || '')))) &&
    elegido.valor === 'plan' &&
    elegido.etiqueta === 'Plan' &&
    elegido.cerrado === true &&
    fechaOscura;
  if (selectsOk) console.log('  ok   los desplegables son de la app (lista propia, elegir propaga change, fecha en oscuro)');
  else {
    failed++;
    console.log('  FALLO los desplegables nativos siguen a la vista  ->  ' + JSON.stringify({ selects, listaModo, elegido, fechaOscura }));
  }
  // Tamaño mínimo real de la ventana (main.js: minWidth 1000 x minHeight 620):
  // el compositor quedaba 60px fuera de pantalla porque el grid se dimensionaba
  // por contenido en vez de por la altura disponible
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1000, height: 620, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 700));
  await judge(
    'a 1000x620 el compositor sigue dentro de la ventana',
    '(function(){ var c = document.querySelector("#composer"); return !!c && c.getBoundingClientRect().bottom <= innerHeight + 1; })()',
  );
  /* Estar DENTRO de la ventana no basta: el mobiliario del compositor no encoge,
     y en el ancho mínimo el campo de texto llegó a quedarse en 8px (0 útiles)
     mientras el compositor seguía «dentro». Se mide el ancho ÚTIL real del campo,
     que es lo que el usuario necesita para escribir. */
  await judge(
    'a 1000x620 el campo de texto conserva ancho útil',
    '(function(){ var i = document.querySelector("#chatInput"); if (!i) return false; var r = i.getBoundingClientRect(); var cs = getComputedStyle(i); return r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) >= 140; })()',
  );
  await judge(
    'a 1000x620 el chat no provoca scroll de página',
    '(function(){ return document.documentElement.scrollHeight <= innerHeight + 1; })()',
  );
  await cmd('Emulation.clearDeviceMetricsOverride', {});

  /* ---- MCP: la sección existe, el formulario abre y el estado se pinta ----
     Sobre la app viva y con un servidor de verdad (el de eco de los tests): lo que
     se comprueba es el recorrido completo, no que los elementos existan. */
  await evaluate('document.querySelector(\'.navitem[data-view="mcp"]\').click()');
  await new Promise((r) => setTimeout(r, 400));
  await judge(
    'la sección MCP muestra el servidor de prueba',
    '(function(){ var rows = document.querySelectorAll("#mcpList .mcprow"); return rows.length >= 1 && /Eco de prueba/.test(document.querySelector("#mcpList").textContent); })()',
  );
  await judge(
    'el formulario de MCP abre y tiene los campos',
    '(function(){ document.querySelector("#mcpNew").click(); var c = document.querySelector("#mcpFormCard"); return c.classList.contains("on") && getComputedStyle(c).display !== "none" && !!document.querySelector("#mcpCommand") && !!document.querySelector("#mcpUrl"); })()',
  );
  // se cierra para no interferir con las comprobaciones siguientes de la sección
  await evaluate('document.querySelector("#mcpCancel").click()');
  await judge(
    'cambiar a URL remota oculta el comando local',
    '(function(){ var t = document.querySelector("#mcpTransport"); t.value = "http"; t.dispatchEvent(new Event("change", { bubbles: true })); var ok1 = document.querySelector("#mcpStdioRows").hidden && !document.querySelector("#mcpHttpRows").hidden; t.value = "stdio"; t.dispatchEvent(new Event("change", { bubbles: true })); return ok1 && !document.querySelector("#mcpStdioRows").hidden; })()',
  );
  // El flujo de importación tiene su propia entrada (window.prompt NO existe en Electron):
  // se comprueba que abre y que un JSON inválido se explica en el aviso del panel.
  await evaluate('document.querySelector("#mcpPaste").click()');
  await judge(
    'la caja de pegar JSON abre',
    '(function(){ var b = document.querySelector("#mcpPasteBox"); return !!b && !b.hidden && !!document.querySelector("#mcpPasteText"); })()',
  );
  await evaluate(
    '(function(){ document.querySelector("#mcpPasteText").value = "no es json"; document.querySelector("#mcpPasteGo").click(); return true; })()',
  );
  await new Promise((r) => setTimeout(r, 600));
  await judge(
    'un JSON inválido se explica en el aviso de la sección',
    '(function(){ return /Error/.test(document.querySelector("#mcpMsg").textContent); })()',
  );
  await evaluate('(function(){ document.querySelector("#mcpPasteCancel").click(); return true; })()');
  // el botón Probar habla con el servidor de prueba y trae sus herramientas reales
  await evaluate(
    '(function(){ var b = document.querySelector("#mcpList .mcprow [data-mcp=\\"test\\"]"); if (b) b.click(); return true; })()',
  );
  await new Promise((r) => setTimeout(r, 2500));
  await judge(
    'probar el servidor trae sus herramientas reales',
    '(function(){ var t = document.querySelector("#mcpList").textContent; return /echo/.test(t) && /Listo/.test(t); })()',
  );
  // ---- las OTRAS dos superficies del mismo dato: Herramientas y Seguridad ----
  await evaluate('document.querySelector(\'[data-view="tools"]\').click()');
  await new Promise((r) => setTimeout(r, 600));
  await judge(
    'la vista Herramientas muestra el grupo con las herramientas MCP',
    '(function(){ var g = document.querySelector("#toolsGrid"); return !!g && /Servidores MCP/.test(g.textContent) && /echo/.test(g.textContent); })()',
  );
  await evaluate(
    'document.querySelector(\'[data-view="settings"]\').click(); document.querySelector(\'#setTabs .settab[data-set="security"]\').click()',
  );
  await new Promise((r) => setTimeout(r, 600));
  await judge(
    'Seguridad tiene una fila de permiso para el servidor MCP',
    '(function(){ var p = document.querySelector("#permList"); return !!p && /MCP/.test(p.textContent) && !!p.querySelector(\'select[data-tool="mcp__eco__*"]\'); })()',
  );
  await judge(
    'la fila de permiso usa la MISMA clave que resuelve el motor de permisos',
    '(async function(){ const l = await window.sagitari.mcpList(); const s = (l.servers || [])[0]; if (!s || !s.permKey) return false; return !!document.querySelector("#permList select[data-tool=\\"" + s.permKey + "\\"]"); })()',
  );
  /* La de arriba pasa también con un id sin guion, donde id crudo y slug coinciden; esta
     usa el servidor `my-server` (id con guion), que es el caso que se rompía: la clave del
     desplegable tiene que ser la del nombre expuesto, y la del id crudo no puede existir. */
  await judge(
    'con un id con guion, la fila de permiso usa el slug del nombre expuesto',
    '(async function(){ const l = await window.sagitari.mcpList(); const s = (l.servers || []).find(x => x.id === "my-server"); if (!s || s.permKey !== "mcp__my_server__*") return false; const q = (k) => !!document.querySelector("#permList select[data-tool=\\"" + k + "\\"]"); return q(s.permKey) && !q("mcp__my-server__*"); })()',
  );
  // ---- el interruptor global apaga y enciende el catálogo (de punta a punta) ----
  await evaluate('document.querySelector(\'.navitem[data-view="mcp"]\').click()');
  await new Promise((r) => setTimeout(r, 400));
  /* Y lo que de verdad recibe el MODELO, que no viaja por ningún canal de la interfaz: se
     mira la petición que la app le manda al modelo de mentira. */
  const pedirAlModelo = async () => {
    const antes = llm.vistos.length;
    const libre = async () => (await evaluate('(async function(){ return !(await window.sagitari.getAgentsLive()).running; })()')) === true;
    // con el agente ocupado, enviar sólo detendría el turno anterior
    for (let i = 0; i < 40 && !(await libre()); i++) await new Promise((r) => setTimeout(r, 200));
    await evaluate(
      'document.querySelector(\'[data-view="chat"]\').click(); document.querySelector("#chatInput").value = "hola"; document.querySelector("#chatSend").click()',
    );
    const limite = Date.now() + 10000;
    while (llm.vistos.length === antes && Date.now() < limite) await new Promise((r) => setTimeout(r, 150));
    const llegadas = llm.vistos.slice(antes);
    for (let i = 0; i < 40 && !(await libre()); i++) await new Promise((r) => setTimeout(r, 200));
    return llegadas;
  };
  const nombresDe = (peticiones) => [...new Set(peticiones.flat().filter(Boolean))];
  const mcpDe = (nombres) => nombres.filter((n) => n.startsWith('mcp__'));
  await evaluate('document.querySelector("#mcpGlobal").click()');
  await new Promise((r) => setTimeout(r, 1500));
  await judge(
    'con el interruptor apagado el catálogo no ofrece herramientas MCP',
    '(async function(){ const l = await window.sagitari.mcpList(); document.querySelector(\'[data-view="tools"]\').click(); await new Promise(r => setTimeout(r, 500)); const g = document.querySelector("#toolsGrid"); const sinGrupo = !!g && !/Servidores MCP/.test(g.textContent); document.querySelector(\'.navitem[data-view="mcp"]\').click(); return l.enabled === false && sinGrupo; })()',
  );
  const sinMcp = nombresDe(await pedirAlModelo());
  if (sinMcp.length && !mcpDe(sinMcp).length) {
    console.log('  ok   con el interruptor apagado la petición al modelo no lleva herramientas MCP (' + sinMcp.length + ' nativas)');
  } else {
    failed++;
    console.log(
      '  FALLO la petición al modelo sigue llevando herramientas MCP con el interruptor apagado  ->  ' +
        JSON.stringify({ ofrecidas: sinMcp.length, mcp: mcpDe(sinMcp) }),
    );
  }
  await evaluate('document.querySelector(\'.navitem[data-view="mcp"]\').click()');
  await new Promise((r) => setTimeout(r, 400));
  await evaluate('document.querySelector("#mcpGlobal").click()');
  await new Promise((r) => setTimeout(r, 2500));
  await judge(
    'al reencender, el catálogo vuelve a ofrecer las herramientas MCP',
    '(async function(){ const l = await window.sagitari.mcpList(); document.querySelector(\'[data-view="tools"]\').click(); await new Promise(r => setTimeout(r, 500)); const g = document.querySelector("#toolsGrid"); const conGrupo = !!g && /Servidores MCP/.test(g.textContent) && /echo/.test(g.textContent); document.querySelector(\'.navitem[data-view="mcp"]\').click(); return l.enabled === true && conGrupo; })()',
  );
  await evaluate('document.querySelector(\'[data-view="chat"]\').click()');
  const conMcp = nombresDe(await pedirAlModelo());
  if (mcpDe(conMcp).includes('mcp__eco__echo')) {
    console.log('  ok   al reencender, el modelo vuelve a recibir las herramientas MCP (' + mcpDe(conMcp).join(', ') + ')');
  } else {
    failed++;
    console.log(
      '  FALLO el modelo no recibe las herramientas MCP al reencender  ->  ' +
        JSON.stringify({ ofrecidas: conMcp.length, mcp: mcpDe(conMcp) }),
    );
  }
  await evaluate('document.querySelector(\'.navitem[data-view="mcp"]\').click()');
  await evaluate('document.querySelector(\'[data-view="chat"]\').click()');

  /* El registro con el que se le habla al modelo: TODO lo que recibe —system prompt,
     definiciones de herramientas y el índice de skills— va sin emojis y con la regla de
     estilo escrita, porque el modelo copia lo que ve y el usuario no quiere un asistente
     que adorne el texto con caritas. Se mira la petición CRUDA (la última, que ya lleva
     las herramientas MCP), que es lo único que el modelo recibe de verdad. */
  const cuerpoModelo = llm.cuerpos[llm.cuerpos.length - 1] || '';
  const emojisEnviados = [...new Set(cuerpoModelo.match(/.\p{Extended_Pictographic}/gu) || [])];
  if (/NADA de emojis/.test(cuerpoModelo) && !emojisEnviados.length) {
    console.log('  ok   la petición al modelo va sin emojis y declara la regla de estilo');
  } else {
    failed++;
    console.log(
      '  FALLO la petición al modelo ' +
        (emojisEnviados.length ? 'lleva emojis: ' + JSON.stringify(emojisEnviados.slice(0, 6)) : 'no declara la regla de estilo'),
    );
  }

  /* El prompt en la petición CRUDA: lo estable delante y lo volátil al final, para que el
     proveedor pueda cachear el prefijo. La memoria cambia en cada turno; si viaja en medio
     del prompt, el caché se rompe desde ahí. */
  const iGuia = cuerpoModelo.indexOf('DELEGACIÓN');
  const iWs = cuerpoModelo.indexOf('ESPACIO DE TRABAJO');
  const iMem = cuerpoModelo.indexOf('MEMORIA del usuario');
  if (iGuia > 0 && iWs > 0 && iMem > 0 && iMem > iGuia && iMem > iWs) {
    console.log('  ok   el prompt va con lo estable delante y lo volátil al final (caché de prefijo)');
  } else {
    failed++;
    console.log('  FALLO el orden del prompt no deja cachear el prefijo  ->  ' + JSON.stringify({ iGuia, iWs, iMem }));
  }

  /* ---- DELEGACIÓN en la interfaz (de punta a punta, con el modelo de mentira) ----
     Tres turnos: el orquestador delega en el investigador, el subagente cierra con su
     RESULT/EVIDENCE y el orquestador responde. El texto interno del subagente lleva una
     marca irrepetible: si esa marca aparece en la RESPUESTA (quitando el grupo de
     herramientas), es que se ha colado en la burbuja, que es justo el defecto que esta
     comprobación vigila. Solo aparece en su tarjeta de delegación, que es donde el usuario
     quiere leerla. */
  const MARCA_SUB = 'prueba-interna-999';
  // El agente elegido es el VERIFICADOR a propósito: su clave real (`verification`)
  // no estaba en el catálogo de etiquetas de la interfaz (`verify`), así que su ficha
  // no resolvía y leer `.label` de la nada tumbaba el manejador de eventos.
  llm.guion.push(
    guionToolCall('d1', 'delegate', { agent: 'verification', task: 'comprueba el informe de vuelos', expect: 'una URL con el precio' }),
    guionTexto('RESULT: 3 vuelos hallados\nDETAILS: 180 EUR ida y vuelta\nEVIDENCE: ' + MARCA_SUB + '\nSTATUS: OK'),
    guionTexto('Tienes tres vuelos a Roma desde 180 EUR.'),
  );
  const esperar = async (expr, ms) => {
    const limite = Date.now() + ms;
    for (;;) {
      if ((await evaluate(expr)) === true) return true;
      if (Date.now() > limite) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  await evaluate('document.querySelector(\'[data-view="chat"]\').click()');
  await evaluate('document.querySelector("#chatInput").value = "investiga vuelos a Roma"; document.querySelector("#chatSend").click()');
  const llegoLaTarjeta = await esperar('!!document.querySelector("#messages .tcard.dcard")', 25000);
  if (llegoLaTarjeta) {
    console.log('  ok   la delegación pinta su tarjeta en el chat');
  } else {
    failed++;
    console.log('  FALLO la delegación no dejó tarjeta en el chat (guion: ' + llm.guion.length + ' respuestas sin usar)');
  }
  await judge(
    'la tarjeta de la delegación trae estado y evidencia',
    '(function(){ var c = document.querySelector("#messages .tcard.dcard"); if (!c) return { tarjeta: false, ai: document.querySelectorAll("#messages .msg.ai").length, tcards: document.querySelectorAll("#messages .tcard").length, msgs: document.querySelectorAll(".msgs").length, idMessages: !!document.getElementById("messages") }; var t = c.textContent || ""; var bien = /Verificador/.test(t) && /OK/.test(t) && t.indexOf(' +
      JSON.stringify(MARCA_SUB) +
      ') >= 0; return bien || { texto: t.slice(0, 240) }; })()',
  );
  /* El tablero del equipo: la delegación se ve EN VIVO (una fila por subtarea, con su
     criterio) y se resuelve al acabar. Se comprueba aquí y no en el test unitario porque
     es lo único que cierra la pregunta «¿quién está trabajando ahora mismo?». */
  await judge(
    'el tablero del equipo enseña la delegación en vivo y la cierra',
    '(function(){ var g = document.querySelector("#messages .tgroup.team"); if (!g) return false; if (!/Equipo/.test(g.textContent || "")) return false; var chips = g.querySelectorAll(".toolchip"); if (chips.length !== 1) return false; var c = chips[0]; if (c.classList.contains("run")) return false; if (!(c.classList.contains("done") || c.classList.contains("err"))) return false; var t = c.textContent || ""; return /Verificador/.test(t) && /comprueba el informe de vuelos/.test(t); })()',
  );
  await judge(
    'Ajustes deja fijar el tope de subagentes por turno',
    '(async function(){ var el = document.querySelector("#grDelegations"); return !!el && Number(el.value) === 8; })()',
  );

  await judge(
    'el texto interno del subagente NO entra en la respuesta',
    '(function(){ var ms = document.querySelectorAll("#messages .msg.ai"); var last = ms[ms.length - 1]; if (!last) return false; var copia = last.cloneNode(true); copia.querySelectorAll(".tgroup").forEach(function(g){ g.remove(); }); var t = copia.textContent || ""; return t.indexOf(' +
      JSON.stringify(MARCA_SUB) +
      ') < 0 && /Roma/.test(t); })()',
  );

  /* ---- v2.3: razonamiento visible (Ajustes ▸ Agente ▸ Conversación) ----
     El modelo de mentira manda `reasoning_content`, como DeepSeek y compañía. Se
     comprueba lo que VE el usuario: un bloque propio encima de la respuesta, plegado
     en cuanto el agente empieza a contestar, que no se cuela en la respuesta y que
     desaparece si apaga el ajuste. En el mismo turno se fuerza UNA herramienta que falla
     (leer un archivo que no existe): antes, con el grupo plegado, un fallo dentro era
     invisible hasta abrirlo a mano. */
  const MARCA_RAZON = 'prueba-razonamiento-777';
  await evaluate('document.querySelector("#btnClear").click()'); // conversación limpia: el separador de día se cuenta desde cero
  await new Promise((r) => setTimeout(r, 600));
  llm.guion.push(
    guionToolCall('r1', 'read_file', { path: 'no-existe-jamas-sagitari.txt' }),
    guionRazonamiento(MARCA_RAZON + ': ese archivo no está; lo digo tal cual.', 'Listo: no había tal archivo.'),
  );
  const aiAntes = await evaluate('document.querySelectorAll("#messages .msg.ai").length');
  await evaluate('document.querySelector("#chatInput").value = "mira ese archivo"; document.querySelector("#chatSend").click()');
  const llegoRazon = await esperar(
    'document.querySelectorAll("#messages .msg.ai").length > ' +
      aiAntes +
      ' && !!document.querySelector("#messages .msg.ai:last-child .thinkblock")',
    25000,
  );
  if (llegoRazon) console.log('  ok   el razonamiento del modelo se pinta en su propio bloque');
  else {
    failed++;
    console.log('  FALLO no apareció el bloque de razonamiento (guion: ' + llm.guion.length + ' respuestas sin usar)');
  }
  /* v2.5: la cabecera es informativa de verdad. Plegado enseña un resumen de una línea (para
     seguir el hilo sin abrir cada bloque) y abierto, la duración y cuántas líneas pensó. */
  await judge(
    'el bloque trae el razonamiento, su resumen, su botón de copiar y queda plegado',
    '(function(){ const b = document.querySelector("#messages .msg.ai:last-child .thinkblock"); if (!b) return { bloque: false }; const cuerpo = b.querySelector(".think-body"); const meta = () => b.querySelector(".th-meta").textContent; const plegado = meta(); const head = b.querySelector(".think-head"); head.click(); const abierto = meta(); head.click(); const otraVez = meta(); const r = { marca: !!cuerpo && cuerpo.textContent.indexOf(' +
      JSON.stringify(MARCA_RAZON) +
      ') >= 0, copiar: !!b.querySelector(".th-copy"), plegadoAlLlegar: !b.classList.contains("open"), resumen: plegado, abierto: abierto, vuelve: otraVez === plegado }; return (r.marca && r.copiar && r.plegadoAlLlegar && /[a-zA-Z]/.test(plegado) && !/^pensando/.test(plegado) && /^pensó .* · \\d+ línea/.test(abierto) && r.vuelve) ? true : r; })()',
  );
  await judge(
    'el resumen plegado dice algo del razonamiento, no una etiqueta vacía',
    '(function(){ const b = document.querySelector("#messages .msg.ai:last-child .thinkblock"); if (!b || !b.classList.contains("closed")) return false; const t = b.querySelector(".th-meta").textContent.trim(); return t.length > 10 && !/^pensó$/.test(t) && !/^pensando/.test(t); })()',
  );
  await judge(
    'el razonamiento NO entra en la respuesta',
    '(function(){ const m = document.querySelector("#messages .msg.ai:last-child"); if (!m) return { ai: false, msgs: document.querySelectorAll(".msgs").length, ultimo: (function(){ var n = document.querySelector(".msgs"); return n && n.lastElementChild ? n.lastElementChild.className : "vacio"; })() }; const c = m.querySelector(".bubble").cloneNode(true); c.querySelectorAll(".thinkblock,.tgroup").forEach(x => x.remove()); const t = c.textContent || ""; var bien = t.indexOf(' +
      JSON.stringify(MARCA_RAZON) +
      ') < 0 && /no había tal archivo/.test(t); return bien || { respuesta: t.slice(0, 240), nodos: (function(){ return [...document.querySelectorAll(".msgs")].map(function(n){ return (n.id||"sin-id") + (n.hidden ? " OCULTO" : " visible") + " · hijos=" + n.children.length + " · ai=" + n.querySelectorAll(".msg.ai").length; }); })(), ultimos: [...document.querySelectorAll("#messages .msg.ai")].slice(-3).map(function(n){ return (n.textContent||"").trim().slice(0, 40); }) }; })()',
  );
  /* v2.5: dentro de una tarjeta, un fallo se lee en la propia cabecera (sin desplegarla) y
     el tiempo corre mientras la herramienta trabaja. Se comprueba con una tarjeta real del
     chat: primero en marcha (el cronómetro avanza) y después fallida. */
  await evaluate('(function(){ toolCard({ name: "run_command", args: { command: "prueba-de-interfaz" } }); return true; })()');
  await new Promise((r) => setTimeout(r, 900));
  await judge(
    'mientras una herramienta corre, su tarjeta enseña el tiempo en marcha',
    '(function(){ const c = document.querySelector("#messages .msg.ai:last-child .tcard.run:last-of-type"); if (!c) return { tarjeta: false }; const t = c.querySelector(".tcard-time").textContent.trim(); return /^[\\d,.]+ s$/.test(t) ? true : { tiempo: t }; })()',
  );
  await judge(
    'un fallo se lee en la cabecera de la tarjeta, sin desplegarla',
    '(function(){ const c = document.querySelector("#messages .msg.ai:last-child .tcard.run:last-of-type"); if (!c) return { tarjeta: false }; completeToolCard({ name: "run_command", ok: false, result: "Error: el comando no existe en este equipo" }); const n = c.querySelector(".tcard-note"); const r = { clase: c.className, nota: n && n.textContent }; return (c.classList.contains("err") && !!n && /no existe en este equipo/.test(n.textContent) && !n.textContent.startsWith("Error:") && !c.classList.contains("open")) ? true : r; })()',
  );
  await judge(
    'la cabecera del grupo avisa del fallo con el grupo plegado',
    '(function(){ const g = document.querySelector("#messages .msg.ai:last-child .tgroup:not(.team)"); if (!g) return { grupo: false, aiUltimo: (document.querySelector("#messages .msg.ai:last-child")||{}).className || "sin .msg.ai:last-child", grupos: document.querySelectorAll("#messages .tgroup").length, equipo: document.querySelectorAll("#messages .tgroup.team").length }; const f = g.querySelector(".tg-fails"); var bien = !!f && !f.hidden && /1 fallo/.test(f.textContent) && g.classList.contains("has-fails"); return bien || { clase: g.className, fallos: f ? f.textContent : "SIN .tg-fails", oculto: f ? f.hidden : null }; })()',
  );
  /* El separador de día: antes lo estampaba CADA respuesta del agente (doce veces en una
     tarde, entre la pregunta y la respuesta). Se mide contando: uno al empezar el hilo y
     el MISMO número después de otro turno, que es exactamente lo que fallaba. */
  const dias1 = await evaluate('document.querySelectorAll("#messages .day").length');
  if (dias1 >= 1) console.log('  ok   el hilo estampa su separador de día al empezar');
  else {
    failed++;
    console.log('  FALLO el hilo no tiene separador de día');
  }

  /* LA REGRESIÓN QUE REPORTÓ EL USUARIO, letra por letra: «si cierro la app y la abro, las
     herramientas que usó ya no se muestran». Se reabre la MISMA conversación por el camino
     real (el que usa la app al arrancar: `conv:open` + `resetChatView`) y se exige que el
     turno vuelva ENTERO: su grupo de herramientas con las mismas tarjetas que se contaron,
     su razonamiento con su texto, y la respuesta. Antes solo se guardaba el texto, así que
     aquí no habría ni un `.tcard` que encontrar. */
  await judge(
    'al reabrir la conversación vuelven sus herramientas, y no solo el texto',
    '(async function(){' +
      ' const list = await window.sagitari.convList();' +
      ' if (!list || !list.length) return { lista: false };' +
      ' const r = await window.sagitari.convOpen(list[0].id);' +
      ' if (!r || !r.ok) return { abrir: false };' +
      ' const msgs = r.messages || [];' +
      ' const idx = msgs.findIndex(m => m.trace && (m.trace.tools || []).length);' +
      ' if (idx < 0) return { guardado: false, mensajes: msgs.length };' +
      ' const guardadas = msgs[idx].trace.tools.length;' +
      ' await openConversation(list[0].id);' +
      ' await new Promise(res => setTimeout(res, 700));' +
      ' const el = document.querySelectorAll("#messages .msg")[idx];' +
      ' if (!el) return { dom: false, idx };' +
      ' const grupo = el.querySelector(".tgroup:not(.team)");' +
      ' const tarjetas = grupo ? grupo.querySelectorAll(".tcard").length : 0;' +
      ' const titulo = grupo && grupo.querySelector(".tg-title") ? grupo.querySelector(".tg-title").textContent : "";' +
      ' const razon = el.querySelector(".thinkblock");' +
      ' const cuerpo = razon && razon.querySelector(".think-body") ? razon.querySelector(".think-body").textContent : "";' +
      ' const salida = el.querySelector(".bubble").textContent || "";' +
      ' const todo = { guardadas: guardadas, tarjetas: tarjetas, titulo: titulo, razon: !!razon,' +
      '   marca: cuerpo.indexOf(' +
      JSON.stringify(MARCA_RAZON) +
      ') >= 0, plegado: !!grupo && !grupo.classList.contains("open"),' +
      '   resp: salida.indexOf("no había tal archivo") >= 0, reloj: !!el.querySelector(".tcard-time").textContent.trim() };' +
      ' return (todo.tarjetas === guardadas && todo.tarjetas > 0 && /herramienta/i.test(titulo) && todo.razon && todo.marca && todo.plegado && todo.resp && todo.reloj) ? true : todo;' +
      ' })()',
  );

  /* El interruptor de Ajustes manda de verdad: apagado, el siguiente turno no trae
     bloque (el agente ni lo pide), y al volver a encenderlo vuelve a aparecer. Se deja
     ENCENDIDO al terminar: el ajuste persiste en la configuración de la prueba. */
  const enviarYEsperar = async (marca) => {
    // el turno anterior tiene que haber cerrado del todo: con el agente ocupado, el envío
    // se descarta (a propósito) y la espera se quedaría mirando un turno que no existe
    await esperar('(async function(){ return !(await window.sagitari.getAgentsLive()).running; })()', 15000);
    const n = await evaluate('document.querySelectorAll("#messages .msg.ai").length');
    await evaluate(
      'document.querySelector("#chatInput").value = ' + JSON.stringify(marca) + '; document.querySelector("#chatSend").click()',
    );
    const ok = await esperar(
      'document.querySelectorAll("#messages .msg.ai").length > ' +
        n +
        ' && /no había tal archivo/.test(document.querySelector("#messages .msg.ai:last-child").textContent)',
      25000,
    );
    return ok;
  };
  await evaluate('document.querySelector(\'[data-view="settings"]\').click()');
  await evaluate('document.querySelector(\'.settab[data-set="agent"]\').click()');
  const apagadoOk = await evaluate(
    '(async function(){ const sw = document.querySelector("#swThinking"); if (!sw || !sw.classList.contains("on")) return false; sw.click(); await new Promise(r => setTimeout(r, 400)); return !sw.classList.contains("on"); })()',
  );
  if (apagadoOk) console.log('  ok   el interruptor del razonamiento se apaga en Ajustes');
  else {
    failed++;
    console.log('  FALLO no se pudo apagar el razonamiento en Ajustes');
  }
  llm.guion.push(guionRazonamiento(MARCA_RAZON + ': esto NO debería verse.', 'Listo: no había tal archivo.'));
  await enviarYEsperar('otra vez, sin razonamiento visible');
  await judge(
    'con el ajuste apagado el turno no trae bloque de razonamiento',
    '!document.querySelector("#messages .msg.ai:last-child .thinkblock")',
  );
  await judge('y el turno nuevo tampoco añade otro separador de día', 'document.querySelectorAll("#messages .day").length === ' + dias1);
  const encendidoOk = await evaluate(
    '(async function(){ const sw = document.querySelector("#swThinking"); sw.click(); await new Promise(r => setTimeout(r, 400)); return sw.classList.contains("on"); })()',
  );
  llm.guion.push(guionRazonamiento(MARCA_RAZON + ': vuelvo a pensar a la vista.', 'Listo: no había tal archivo.'));
  const envio3 = await enviarYEsperar('y ahora otra vez, con razonamiento visible');
  await judge(
    'al volver a encenderlo el bloque reaparece',
    '(function(){ const b = document.querySelector("#messages .msg.ai:last-child .thinkblock"); if (!b) return { encendido: document.querySelector("#swThinking").classList.contains("on"), envio: ' +
      JSON.stringify(envio3) +
      ', turnos: document.querySelectorAll("#messages .msg.ai").length, bloques: document.querySelectorAll("#messages .msg.ai .thinkblock").length }; return (b.querySelector(".think-body").textContent || "").indexOf(' +
      JSON.stringify(MARCA_RAZON) +
      ') >= 0; })()',
  );
  if (!encendidoOk) {
    failed++;
    console.log('  FALLO el interruptor no vuelve a encender el razonamiento');
  }
  await evaluate('document.querySelector(\'[data-view="chat"]\').click()');

  /* ---- v2.4: la revisión del CAMBIO antes de cerrar (de punta a punta) ----
     El modelo de mentira escribe un archivo y el orquestador contesta. Antes de aceptar
     ese cierre, la app delega la revisión en su Revisor. Se comprueba en la ventana viva
     lo que el usuario ve (la tarjeta con el informe y el cierre final) y, en Node, lo que
     de verdad recibió el modelo y qué hay en el disco — sin creerse a la app. */
  const MARCA_REV = 'prueba-revision-555';
  const archivoRev = 'revision-' + Date.now() + '.js';
  await evaluate('document.querySelector("#btnClear").click()');
  await new Promise((r) => setTimeout(r, 600));
  llm.guion.push(
    guionToolCall('w1', 'write_file', { path: archivoRev, content: 'function revisado() { return 42; }\n' }),
    guionTexto('He creado ' + archivoRev + '.'),
    guionTexto('RESULT: ' + MARCA_REV + ' sin hallazgos bloqueantes\nDETAILS: un archivo, un añadido\nSTATUS: OK'),
    guionTexto('Listo: el archivo está y pasa la revisión.'),
  );
  await evaluate('document.querySelector("#chatInput").value = "crea un módulo de prueba"; document.querySelector("#chatSend").click()');
  /* Escribir en el disco pide permiso (y está bien que lo pida): aquí se concede, que es
     lo que haría el usuario. Si no apareciera la barra, la escritura no llegaría y la
     comprobación del archivo en el disco lo diría. */
  let permitido = false;
  for (let i = 0; i < 40 && !permitido; i++) {
    const visible = await evaluate('(function(){ const b = document.querySelector("#confirmBar"); return !!b && !b.hidden; })()');
    if (visible) {
      await evaluate('document.querySelector("#confirmOk").click()');
      permitido = true;
    } else await new Promise((r) => setTimeout(r, 250));
  }
  const llegoRevision = await esperar(
    '!!document.querySelector("#messages .tcard.dcard") && /Revisor/.test(document.querySelector("#messages").textContent)',
    25000,
  );
  if (llegoRevision) console.log('  ok   la revisión del cambio deja su tarjeta en el chat');
  else {
    failed++;
    console.log('  FALLO el Revisor no llegó a pintar su tarjeta (guion: ' + llm.guion.length + ' respuestas sin usar)');
  }
  // la tarjeta de la revisión se pinta al ACABAR la delegación: el cierre del modelo viene después
  const llegoCierreRev = await esperar('/pasa la revisi[oó]n/.test(document.querySelector("#messages").textContent)', 25000);
  if (!llegoCierreRev) {
    failed++;
    console.log('  FALLO el turno no cerró con la respuesta del modelo tras la revisión');
  }
  /* El cierre se busca en las ÚLTIMAS burbujas sin el grupo de herramientas ni el
     razonamiento: el texto del turno y las tarjetas comparten burbuja, así que leer el
     `.textContent` crudo de la última mezcla las dos cosas. */
  await judge(
    'el revisor deja su informe y el cierre final es el del modelo',
    '(function(){ const cards = [...document.querySelectorAll("#messages .tcard.dcard")]; const rev = cards.find(c => /Revisor/.test(c.textContent || "")); if (!rev) return { tarjeta: false }; const conTexto = [...document.querySelectorAll("#messages .msg.ai")].slice(-2).map(m => { const c = m.cloneNode(true); c.querySelectorAll(".tgroup,.thinkblock").forEach(x => x.remove()); return c.textContent || ""; }).join(" | "); return (new RegExp(' +
      JSON.stringify(MARCA_REV) +
      ').test(rev.textContent || "") && /sin hallazgos bloqueantes/.test(rev.textContent || "") && /pasa la revisi[oó]n/.test(conTexto)) ? true : { informe: (rev.textContent || "").slice(0, 110), cierre: conTexto.slice(0, 160) }; })()',
  );
  await judge(
    'Ajustes trae la revisión del cambio activada (y es apagable)',
    '(function(){ const sw = document.querySelector("#swRevisar"); return !!sw && sw.classList.contains("on"); })()',
  );
  /* v2.5: la verificación REAL se configura desde aquí (comprobadores del proyecto al
     escribir y ejecución de las pruebas al cerrar). Se comprueba que existen, que vienen
     encendidas y que el clic apaga de verdad el ajuste, no solo el dibujo del interruptor. */
  await judge(
    'la comprobación del proyecto al escribir viene activada y es apagable',
    '(async function(){ const sw = document.querySelector("#swDiagnosticos"); if (!sw) return "no existe el interruptor"; const venia = sw.classList.contains("on") && CFG.settings.diagnosticosEscritura !== false; sw.click(); await new Promise(r => setTimeout(r, 500)); const apagado = !sw.classList.contains("on") && CFG.settings.diagnosticosEscritura === false; sw.click(); await new Promise(r => setTimeout(r, 500)); return (venia && apagado && sw.classList.contains("on")) ? true : { venia, apagado, final: sw.classList.contains("on") }; })()',
  );
  await judge(
    'las pruebas de cierre vienen activadas y su tope de intentos es editable',
    '(async function(){ const sw = document.querySelector("#swCierre"); const inp = document.querySelector("#verAttempts"); if (!sw || !inp) return "faltan controles"; const venia = sw.classList.contains("on") && inp.value === "2"; inp.value = "1"; inp.dispatchEvent(new Event("change")); await new Promise(r => setTimeout(r, 500)); const guardado = CFG.settings.intentosArreglo === 1 && inp.value === "1"; inp.value = "2"; inp.dispatchEvent(new Event("change")); await new Promise(r => setTimeout(r, 400)); return (venia && guardado) ? true : { venia, guardado, valor: inp.value }; })()',
  );
  /* v3.0: el aislamiento de los subagentes que escriben también se configura desde aquí. */
  await judge(
    'el aislamiento de los subagentes que escriben viene activado y es apagable',
    '(async function(){ const sw = document.querySelector("#swArboles"); if (!sw) return "no existe el interruptor"; const venia = sw.classList.contains("on") && CFG.settings.arbolesAislados !== false; sw.click(); await new Promise(r => setTimeout(r, 500)); const apagado = !sw.classList.contains("on") && CFG.settings.arbolesAislados === false; sw.click(); await new Promise(r => setTimeout(r, 500)); return (venia && apagado && sw.classList.contains("on")) ? true : { venia, apagado, final: sw.classList.contains("on") }; })()',
  );
  /* En Node: el diff del turno tiene que haber llegado AL MODELO y el archivo tiene que
     estar en el disco. La primera es la prueba de que la revisión no es decorado; la
     segunda, de que el permiso y la escritura atómica funcionaron de verdad. */
  const cuerpoRev = llm.cuerpos.map(String).find((b) => b.indexOf('DIFF DEL TURNO') >= 0);
  if (cuerpoRev && /\+ function revisado/.test(cuerpoRev)) {
    console.log('  ok   el diff del turno llega al agente de revisión');
  } else {
    failed++;
    console.log('  FALLO el revisor no recibió el diff del turno');
  }
  if (fs.existsSync(path.join(WS_TEST, archivoRev))) {
    console.log('  ok   el archivo escrito existe en el espacio de trabajo');
  } else {
    failed++;
    console.log('  FALLO la escritura no llegó al disco (permiso concedido: ' + permitido + ')');
  }
  if (llm.guion.length) {
    failed++;
    console.log('  FALLO el turno de revisión consumió un guion distinto (quedan ' + llm.guion.length + ')');
  }
  await evaluate('document.querySelector(\'[data-view="chat"]\').click()');

  /* La revisión del cambio: el botón abre el panel con el diff ESTRUCTURADO del turno y
     cada archivo deja volver atrás SÓLO ese archivo (antes solo había «Deshacer el
     cambio»: todo el turno o nada, y a ciegas). El turno acaba de escribir un archivo de
     verdad, así que hay diff que revisar. La expresión es idempotente porque `judge` la
     repite si falla: solo pulsa el botón si el panel está cerrado. */
  await judge(
    'la revisión del cambio abre con el diff del turno',
    '(function(){ var b=document.querySelector("#btnDiff"); if(!b) return false; if(b.hidden) return {oculto:true}; var p=document.querySelector("#diffPanel"); if(!p) return {panel:false}; if(p.hidden) b.click(); if(p.hidden) return {panel:false}; var l=document.querySelector("#diffList"); if(!l||!l.textContent.trim()) return {vacio:true}; if(!l.querySelectorAll("[data-revert]").length) return {revert:0}; return l.textContent.indexOf("revision-")>=0; })()',
  );
  await judge(
    'y se cierra devolviendo el chat',
    '(function(){ var p=document.querySelector("#diffPanel"); if(!p) return false; if(!p.hidden){ var c=document.querySelector("#diffClose"); if(c) c.click(); } return p.hidden; })()',
  );
  /* Y la luz vuelve a la CALMA cuando el turno termina: antes quedaba en «think», así que
     el panel lateral se quedaba encendido para siempre y parecía que el agente seguía
     trabajando. Se comprueba aquí, con el turno ya cerrado. */
  await judge(
    'al acabar el turno la luz vuelve a la calma',
    '(function(){ var s=document.getElementById("shell"); if(!s) return false; return !/glow-(think|work|pulse)/.test(s.className || ""); })()',
  );

  /* ---- v4.2: órdenes de barra, medidor de contexto, revisión del cambio, registro real
     de agentes, bifurcación del historial y el interruptor de aceptar ediciones. Todo
     sobre la app viva y con su modelo de mentira: se comprueba el recorrido, no que los
     elementos existan. Estas comprobaciones nacieron de la auditoría: eran justo las
     que faltaban para que un fallo así no se colara otra vez. ---- */
  await evaluate('document.querySelector(\'.navitem[data-view="chat"]\').click()');
  await new Promise((r) => setTimeout(r, 300));

  /* La paleta de `/` ofrece las ÓRDENES de barra por encima de las skills, y su lista
     sale de ChatKit.COMMANDS: si alguien añade una orden y la paleta no la pinta, esto lo
     dice. Y lo que de verdad tiene que cumplirse es que TODA orden anunciada se pueda
     despachar: el mínimo de «al menos 5» venía de cuando la lista tenía seis —tres de
     ellas sin existir detrás, así que la paleta mentía y el conteo no probaba nada—. */
  await judge(
    'la paleta de «/» ofrece las órdenes de barra (todas pintadas y explicadas)',
    '(function(){ var i=document.querySelector("#chatInput"); if(!i) return false; i.value="/"; i.dispatchEvent(new Event("input",{bubbles:true})); var m=document.querySelector("#skillMenu"); if(!m||m.hidden) return false; var t=m.textContent||""; var c=(typeof ChatKit!=="undefined"&&ChatKit.COMMANDS)||[]; if(!c.length) return {ordenes:0}; var faltan=c.map(function(x){return x.name}).filter(function(n){return t.indexOf("/"+n)<0}); if(faltan.length) return {faltan:faltan}; var sinDecir=c.filter(function(x){ return !String(x.descripcion||"").trim(); }); if(sinDecir.length) return {sinDescripcion:sinDecir.map(function(x){return x.name})}; return /ÓRDENES/.test(t); })()',
  );
  /* Y una barra que NO es orden no puede tragarse el mensaje: es la diferencia entre
     una orden y escribir «mira / esto». */
  await judge(
    'una barra que no es orden sigue siendo un mensaje',
    '(function(){ if(typeof ChatKit==="undefined") return false; if(!ChatKit.parseCommand("/cost")) return {cost:false}; if(ChatKit.parseCommand("/zzz")) return {zzz:true}; if(ChatKit.parseCommand("mira / esto")) return {texto:true}; return !!ChatKit.parseCommand("  /HELP  "); })()',
  );
  await evaluate(
    '(function(){ var i=document.querySelector("#chatInput"); if(i){ i.value=""; i.dispatchEvent(new Event("input",{bubbles:true})); } })()',
  );

  /* El medidor de contexto vive en el compositor y lleva el nivel en la palabra que usa
     el motor (hola/ajustado/apretado), no en un sinónimo inventado en la interfaz. */
  await judge(
    'el medidor de contexto está en el compositor y trae su nivel',
    '(function(){ var m=document.querySelector("#ctxMeter"); if(!m) return false; var e=m.getAttribute("data-estado"); if(["hola","ajustado","apretado"].indexOf(e)<0) return {estado:e}; var v=(m.querySelector(".ctxval")||{}).textContent||""; return /%/.test(v) && /[0-9]/.test(v); })()',
  );

  /* La revisión del cambio: el botón y el diff del turno se comprueban junto al turno
     que escribe (más arriba); aquí solo queda el registro real de agentes, la
     bifurcación del historial y el interruptor de aceptar ediciones. */

  /* El registro real de agentes: la vista enseñaba una vitrina fija que no correspondía
     al registro usable (seis tarjetas frente a siete agentes). Ahora pinta el registro y
     su cuenta tiene que cuadrar con él. */
  await evaluate('document.querySelector(\'.navitem[data-view="agents"]\').click()');
  await judge(
    'la vista de Agentes enseña el registro real (y su cuenta cuadra)',
    '(async function(){ var l=document.querySelector("#agentsList"); if(!l) return false; for(var i=0;i<20 && l.getAttribute("aria-busy")==="true";i++) await new Promise(function(r){setTimeout(r,200)}); var r=await window.sagitari.agentsCustom(); if(!r||!r.ok) return {ipc:(r&&r.error)||false}; var n=l.querySelectorAll(".acard").length; if(n!==r.agentes.length) return {tarjetas:n, registro:r.agentes.length}; var c=document.querySelector("#agentsCount"); return !!(c && /[0-9]/.test(c.textContent)); })()',
  );

  /* El historial deja bifurcar: el botón tiene que llevar el id de la conversación. */
  await evaluate('document.querySelector(\'.navitem[data-view="history"]\').click()');
  await new Promise((r) => setTimeout(r, 300));
  await judge(
    'el historial deja duplicar una conversación',
    '(function(){ var f=document.querySelector("#histList [data-fork]"); return !!f && !!f.getAttribute("data-fork"); })()',
  );

  /* El interruptor de aceptar ediciones vive en Seguridad y su texto dice lo que NO
     cubre: es un ajuste de riesgo y esa frase es parte del contrato con el usuario. */
  await evaluate('document.querySelector(\'.navitem[data-view="settings"]\').click()');
  await new Promise((r) => setTimeout(r, 300));
  await judge(
    'Seguridad tiene el interruptor de aceptar ediciones y dice qué no cubre',
    '(function(){ var p=document.querySelector("#setpanel-security"); if(!p||!p.querySelector("#swAutoEdits")) return false; return /NO cubre/.test(p.textContent); })()',
  );

  /* Y dos avisos seguidos se leen los dos: se apilan en columna de verdad. Antes cada
     uno se posicionaba en el MISMO punto fijo, así que el segundo tapaba al primero y
     el primero caducaba sin que nadie lo hubiera visto. */
  await judge(
    'dos avisos seguidos se apilan y no se tapan',
    '(function(){ showToast("aviso uno de prueba"); showToast("aviso dos de prueba"); var t=document.querySelectorAll("#toastStack .toast"); if(t.length<2) return {avisos:t.length}; var a=t[0].getBoundingClientRect(); var b=t[t.length-1].getBoundingClientRect(); return b.top >= a.bottom - 1; })()',
  );
  await evaluate('document.querySelector(\'.navitem[data-view="chat"]\').click()');
  await new Promise((r) => setTimeout(r, 200));

  /* Y una clave guardada que el equipo no puede descifrar no puede ser un «fallo
     interno» modal: la app arranca, el proveedor se marca y Ajustes dice qué hacer.
     Antes salía un diálogo bloqueante con la clave intacta en disco. */
  await evaluate('document.querySelector(\'.navitem[data-view="settings"]\').click()');
  await new Promise((r) => setTimeout(r, 400));
  await judge(
    'una clave ilegible se explica en Ajustes y no bloquea nada',
    '(async function(){ var n=document.getElementById("provKeyUnreadable"); var c=await window.sagitari.getConfig(); var malo=(c.providers||[]).find(function(p){return p.keyUnreadable;}); if(!n) return {aviso:false, ids:(c.providers||[]).map(function(p){return p.id+":"+!!p.keyUnreadable;})}; if(!/no puede descifrar/.test(n.textContent)) return {texto:n.textContent.slice(0,90)}; if(!malo) return {sinFlag:true}; var url=document.querySelector("#pUrl"); url.value=malo.baseUrl; url.dispatchEvent(new Event("input",{bubbles:true})); var campo=document.querySelector("#pKey"); return /no se pudo descifrar/.test((campo&&campo.placeholder)||"") ? true : {placeholder:(campo&&campo.placeholder)||""}; })()',
  );
  /* Sin líneas NUEVAS en crash.log: la app no puede tratarlo como fallo interno. Se
     compara con lo que había al arrancar, porque el fichero es acumulativo entre
     ejecuciones (una línea del pasado hacía fallar esta comprobación para siempre). */
  const crashNuevas = lineasCrash() - crashAlArrancar;
  if (crashNuevas === 0) console.log('  ok   una clave ilegible no se registra como fallo interno');
  else {
    failed++;
    console.log('  FALLO la app registró ' + crashNuevas + ' fallo(s) con la app en marcha');
  }

  /* ---- v4.4: un encargo de EQUIPO de verdad, con DOS compañeros a la vez ----
     El proveedor se enruta POR PETICIÓN: el líder y cada compañero tienen su propio guion,
     así que el turno es determinista aunque los dos compañeros corran en paralelo (con la
     cola lineal, sus peticiones se repartirían las respuestas por orden de llegada). */
  const EQUIPO_MARCA = 'EQUIPO-' + Date.now();
  let llamadasLider = 0;
  const llamadasMiembro = {};
  llm.setRouter((body) => {
    if (body.indexOf('ERES EL LÍDER') >= 0) {
      llamadasLider++;
      if (llamadasLider === 1)
        return guionToolCalls([
          { id: 'e1', name: 'team_spawn', args: { agent: 'research', task: 'busca dos fuentes ' + EQUIPO_MARCA, expect: 'dos URLs' } },
          { id: 'e2', name: 'team_spawn', args: { agent: 'file', task: 'ordena la carpeta ' + EQUIPO_MARCA, expect: 'una lista' } },
        ]);
      if (llamadasLider === 2) return guionToolCall('e3', 'team_wait', { timeoutMs: 8000 });
      return guionTexto('Encargo de equipo cerrado: fuentes y carpeta listas. ' + EQUIPO_MARCA);
    }
    const m = /ERES EL COMPAÑERO «(m\d)»/.exec(body);
    if (m) {
      const id = m[1];
      llamadasMiembro[id] = (llamadasMiembro[id] || 0) + 1;
      if (llamadasMiembro[id] === 1)
        return id === 'm1'
          ? guionToolCalls([
              { id: 's1', name: 'team_send', args: { to: 'lider', text: 'fuentes listas ' + EQUIPO_MARCA } },
              { id: 's2', name: 'team_board', args: { quien: id, que: 'buscar fuentes', estado: 'terminado' } },
            ])
          : guionToolCall('s3', 'team_board', { quien: id, que: 'ordenar carpeta', estado: 'terminado' });
      return guionToolCall('s9', 'team_done', { resumen: id + ' terminó ' + EQUIPO_MARCA, evidencia: 'dos marcas' });
    }
    return null; // cualquier otra petición sigue con la cola de siempre
  });
  await evaluate(
    '(function(){ var b=[...document.querySelectorAll("#modeSeg button")].find(x=>x.dataset.m==="equipo"); if(b) b.click(); return !!b; })()',
  );
  await new Promise((r) => setTimeout(r, 300));
  await evaluate('document.querySelector("#chatInput").value = "reparte este encargo"; document.querySelector("#chatSend").click()');
  const terminoElEquipo = await esperar('/Encargo de equipo cerrado/.test(document.querySelector("#messages").textContent)', 30000);
  if (terminoElEquipo) console.log('  ok   el encargo de equipo se cierra y el líder agrega el resultado');
  else {
    failed++;
    console.log('  FALLO el encargo de equipo no llegó a cerrarse');
  }
  await judge(
    'la tarjeta del equipo enseña a sus dos compañeros',
    '(function(){ var c=document.querySelector("#messages .tcard.dcard[data-equipo]"); if(!c) return { tarjeta:false, dcards:document.querySelectorAll("#messages .tcard.dcard").length }; var t=c.textContent||""; var filas=c.querySelectorAll(".eqmiembro"); return filas.length===2 && new Set([...filas].map(f=>f.dataset.miembro)).size===2 ? true : { filas:filas.length, texto:t.slice(0,120) }; })()',
  );
  await evaluate('document.querySelector(\'.navitem[data-view="equipo"]\').click()');
  await judge(
    'la vista Equipo enseña miembros, buzón y tablero',
    '(function(){ var v=document.getElementById("view-equipo"); if(!v || !v.classList.contains("on")) return { vista:false }; var mi=document.querySelectorAll("#equipoMiembros .acard").length; var buz=document.querySelectorAll("#equipoBuzon .eqfila").length; var tab=document.querySelectorAll("#equipoTablero .eqitem").length; var notas=[...document.querySelectorAll("#equipoMiembros .acard")].filter(a=>/terminado|hecho/.test(a.textContent)).length; return mi===2 && buz>=1 && tab>=2 && notas===2 ? true : { miembros:mi, buzon:buz, tablero:tab, terminados:notas }; })()',
  );
  /* ---- v4.4: el permiso de un COMPAÑERO se atribuye a SU miembro (en vivo) ----
     Segundo encargo: el compañero escribe en el disco, así que la app pide permiso. La barra
     tiene que decir DE QUIÉN es el permiso, su fila en la tarjeta del equipo tiene que llevar
     la insignia de «1 permiso» y su estado «esperando» mientras está pendiente, y al
     concederlo el archivo tiene que estar en el disco y el encargo cerrarse. Se lee lo que la
     pantalla dice ANTES de conceder: el compañero trabaja en segundo plano, así que la
     confirmación puede tardar en aparecer. */
  await evaluate('document.querySelector(\'.navitem[data-view="chat"]\').click()');
  const PERMISO_MARCA = 'PERMISO-' + Date.now();
  const ARCHIVO_PERMISO = 'nota-' + Date.now() + '.txt';
  let permisoLider = 0;
  const permisoMiembro = {};
  llm.setRouter((body) => {
    if (body.indexOf(PERMISO_MARCA) < 0) return null; // otro encargo: la cola de siempre
    if (body.indexOf('ERES EL LÍDER') >= 0) {
      permisoLider++;
      if (permisoLider === 1)
        return guionToolCall('p1', 'team_spawn', { agent: 'file', task: 'escribe la nota ' + PERMISO_MARCA, expect: 'un archivo' });
      if (permisoLider === 2) return guionToolCall('p2', 'team_wait', { timeoutMs: 12000 });
      return guionTexto('Nota escrita con el permiso concedido. ' + PERMISO_MARCA);
    }
    const mp = /ERES EL COMPAÑERO «(m\d)»/.exec(body);
    if (!mp) return null;
    const idp = mp[1];
    permisoMiembro[idp] = (permisoMiembro[idp] || 0) + 1;
    if (permisoMiembro[idp] === 1)
      return guionToolCall('q1', 'write_file', { path: ARCHIVO_PERMISO, content: 'nota de ' + idp + ' ' + PERMISO_MARCA + '\n' });
    return guionToolCall('q2', 'team_done', { resumen: idp + ' escribió la nota', evidencia: ARCHIVO_PERMISO });
  });
  /* La marca va EN EL MENSAJE del usuario: es lo que llega al prompt del líder, así que el
     proveedor de mentira sabe de qué encargo es cada petición. Sin ella el router no reconoce
     al líder, la cola vieja (ya vacía) no responde y el turno cierra sin hacer nada. */
  await evaluate(
    'document.querySelector("#chatInput").value = "que un compañero escriba la nota ' +
      PERMISO_MARCA +
      '"; document.querySelector("#chatSend").click()',
  );
  /* La tarjeta del equipo se busca la ÚLTIMA: el primer encargo dejó la suya en el hilo. Y el
     estado del compañero se lee de SU fila, que es donde vive el estado y la insignia. */
  const ESTADO_M1 =
    '(function(){ var c=[...document.querySelectorAll("#messages .tcard.dcard[data-equipo]")].pop(); var fila=c && c.querySelector(".eqmiembro[data-miembro=m1]"); var ins=fila && fila.querySelector(".abadge.eqperm"); var est=fila && [...fila.querySelectorAll(".abadge")].filter(function(x){return !x.classList.contains("eqperm");})[0]; return { insignia: ins?(ins.textContent||"").trim():null, insigniaDe: ins?ins.getAttribute("title"):null, estado: est?(est.textContent||"").trim():null, fila: (fila?(fila.textContent||""):"").replace(/\\s+/g," ").slice(0,120) }; })()';
  const PENDIENTE_M1 =
    '(function(){ var b=document.querySelector("#confirmBar"); if(!b || b.hidden) return null; var e=' +
    ESTADO_M1 +
    '; e.titulo=(document.querySelector("#confirmTitle").textContent||""); return e; })()';
  let permisoPendiente = null;
  /* Mientras el compañero espera el permiso su árbol está en pie: se anota, porque es la
     prueba de que trabajó AISLADO y no escribiendo directo en el espacio de trabajo (si el
     aislamiento no ocurre, la comprobación del archivo pasaría por el camino fácil sin
     decir nada). */
  let arbolVisto = false;
  for (let i = 0; i < 120 && !permisoPendiente; i++) {
    permisoPendiente = await evaluate(PENDIENTE_M1);
    if (!arbolVisto) arbolVisto = hayArbolAislado();
    if (!permisoPendiente) await new Promise((r) => setTimeout(r, 250));
  }
  if (permisoPendiente && /quiere:/.test(permisoPendiente.titulo) && /File Agent|m1/.test(permisoPendiente.titulo)) {
    console.log('  ok   la confirmación dice de quién es el permiso: «' + permisoPendiente.titulo.slice(0, 70) + '»');
  } else {
    failed++;
    console.log('  FALLO la confirmación de un compañero no dice de quién es: ' + JSON.stringify(permisoPendiente));
  }
  if (permisoPendiente && permisoPendiente.insignia === '1 permiso' && /File Agent/.test(String(permisoPendiente.insigniaDe))) {
    console.log('  ok   la fila del compañero lleva su insignia de permiso pendiente');
  } else {
    failed++;
    console.log('  FALLO la fila del compañero no lleva la insignia de permiso: ' + JSON.stringify(permisoPendiente));
  }
  if (permisoPendiente && permisoPendiente.estado === 'esperando' && /te necesita/.test(permisoPendiente.fila)) {
    console.log('  ok   mientras espera, el compañero se ve «esperando» y diciendo qué necesita');
  } else {
    failed++;
    console.log('  FALLO el compañero no se ve esperando: ' + JSON.stringify(permisoPendiente));
  }
  await evaluate('document.querySelector("#confirmOk").click()');
  /* Contestado: el compañero escribe, vuelve a hablar con el modelo y cierra SU parte. La
     tarjeta tiene que seguirlo —un compañero puede terminar con el líder ya fuera— y la
     insignia de permiso tiene que irse. Se espera al estado, no a un tiempo fijo. */
  const serie = [];
  for (let i = 0; i < 24; i++) {
    const s = await evaluate(ESTADO_M1);
    serie.push(s);
    if (s.insignia === null && s.estado === 'terminado') break;
    await new Promise((r) => setTimeout(r, 400));
  }
  const trasElClick = serie[serie.length - 1];
  const cerroPermiso = await esperar(
    '/Nota escrita con el permiso concedido/.test(document.querySelector("#messages").textContent)',
    30000,
  );
  if (cerroPermiso) console.log('  ok   concedido el permiso, el compañero sigue y el encargo cierra');
  else {
    failed++;
    console.log('  FALLO el encargo del compañero no cerró tras conceder el permiso');
  }
  if (fs.existsSync(path.join(WS_TEST, ARCHIVO_PERMISO))) {
    console.log('  ok   el compañero escribió el archivo de verdad (con tu permiso)');
  } else {
    failed++;
    // Con el motivo: qué hay en el espacio de trabajo, qué dijo la tarjeta y qué pasó
    // con el árbol aislado (el archivo puede haberse quedado ahí).
    let enWs = '';
    try {
      enWs = fs.readdirSync(WS_TEST).slice(0, 12).join(',');
    } catch {}
    console.log(
      '  FALLO el compañero no escribió ' +
        ARCHIVO_PERMISO +
        ' en el espacio de trabajo (workspace: [' +
        enWs +
        '] | tarjeta: ' +
        JSON.stringify(trasElClick) +
        ')',
    );
  }
  if (arbolVisto) {
    console.log('  ok   el compañero trabajó en un árbol aislado de verdad y el archivo llegó fusionado');
  } else {
    failed++;
    console.log(
      '  FALLO el compañero no trabajó en un árbol aislado (el aislamiento no ocurrió) | tarjeta: ' +
        JSON.stringify(trasElClick) +
        ' | workspace: [' +
        (() => {
          try {
            return fs.readdirSync(WS_TEST).slice(0, 12).join(',');
          } catch {
            return '';
          }
        })() +
        ']',
    );
  }
  /* Y la tarjeta lo cuenta: sin insignia (el permiso ya se contestó) y con el compañero
     terminado. Su fila sigue viva aunque el líder ya cerrara su parte. */
  if (trasElClick.insignia === null && trasElClick.estado === 'terminado') {
    console.log('  ok   la insignia se descuenta al concederlo y el compañero queda terminado');
  } else {
    failed++;
    console.log('  FALLO el compañero no quedó terminado tras conceder el permiso: ' + JSON.stringify(trasElClick));
  }
  llm.setRouter(null);

  // El modo vuelve a ACT: el resto de comprobaciones no esperan un equipo en marcha.
  await evaluate(
    '(function(){ var b=[...document.querySelectorAll("#modeSeg button")].find(x=>x.dataset.m==="act"); if(b) b.click(); document.querySelector(\'.navitem[data-view="chat"]\').click(); return true; })()',
  );
  await new Promise((r) => setTimeout(r, 300));

  /* Cerrar un turno tiene que dejar pintado el texto COMPLETO aunque el último frame no
     haya llegado: el tramo abierto se acumula en cada evento pero se pinta por frames, y
     con la ventana sin foco Chromium no repinta. El cierre sólo rellenaba el elemento si
     estaba VACÍO, así que una respuesta «pintada a medias» se quedaba cortada en pantalla
     mientras el mensaje guardado estaba entero (pasó: el primer saludo salía en «…¿En»). */
  await judge(
    'cerrar el turno pinta el texto completo aunque el último frame no llegue',
    '(async function(){ var b = bubble("ai"); try { pendingAssistant = b; b._frozenText = ""; var A = "Primera parte de la respuesta. "; var B = "Segunda parte que antes se quedaba sin pintar."; b._openText = A; scheduleStreamRender(b); await new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(r); }); }); var pintado = (b.textContent || "").trim().length; b._openText = A + B; finishAssistant(b._openText); var enPantalla = (b.textContent || "").trim(); var esperado = (A + B).trim(); if (enPantalla === esperado) return true; return { pintadoAlCerrar: pintado, quedo: enPantalla.length, esperado: esperado.length, texto: enPantalla.slice(0, 60) }; } finally { b.remove(); } })()',
  );

  /* ---- FASE 1 MEMORIA: un turno que aprende un hecho, aparece en «Recién aprendido»,
     se guarda y se usa en el turno siguiente. Todo offline: la heurística no llama al
     modelo, así que la comprobación no depende de ningún proveedor. ---- */
  await evaluate('document.querySelector(\'.navitem[data-view="chat"]\').click()');
  await evaluate('document.querySelector("#btnClear").click()');
  await new Promise((r) => setTimeout(r, 600));
  const HECHO_MARCA = 'Memoria' + Date.now();
  const antesHecho = llm.cuerpos.length;
  await evaluate(
    'document.querySelector("#chatInput").value = ' +
      JSON.stringify('recuerda que me llamo ' + HECHO_MARCA) +
      '; document.querySelector("#chatSend").click()',
  );
  const enBandeja = await esperar('(async function(){ const l = await window.sagitari.memoryTrayList(); return l.length > 0; })()', 20000);
  if (enBandeja) console.log('  ok   el turno que aprende un hecho lo deja en «Recién aprendido»');
  else {
    failed++;
    console.log('  FALLO el hecho aprendido no llegó a la bandeja');
  }
  await evaluate('document.querySelector(\'.navitem[data-view="memory"]\').click()');
  await new Promise((r) => setTimeout(r, 400));
  const guardadoOk = await evaluate(
    '(function(){ var b = document.querySelector("#memBandeja [data-acc=\\"guardar\\"]"); if (!b) return false; b.click(); return true; })()',
  );
  if (guardadoOk) {
    const aparece = await esperar('document.querySelector("#memList").textContent.includes(' + JSON.stringify(HECHO_MARCA) + ')', 8000);
    if (aparece) console.log('  ok   el hecho guardado aparece en «Lo que sé de ti»');
    else {
      failed++;
      console.log('  FALLO el hecho guardado no aparece en la lista');
    }
  } else {
    failed++;
    console.log('  FALLO no había botón «Guardar» en la bandeja');
  }
  /* Y se usa en el turno siguiente: el hecho viaja en el prompt que recibe el modelo. */
  await evaluate('document.querySelector(\'.navitem[data-view="chat"]\').click()');
  await evaluate('document.querySelector("#chatInput").value = "¿cómo me llamo?"; document.querySelector("#chatSend").click()');
  let enPrompt = false;
  const limitePrompt = Date.now() + 20000;
  while (!enPrompt && Date.now() < limitePrompt) {
    if (llm.cuerpos.slice(antesHecho).join('\n').includes(HECHO_MARCA)) enPrompt = true;
    else await new Promise((r) => setTimeout(r, 250));
  }
  if (enPrompt) console.log('  ok   el hecho guardado viaja al prompt del turno siguiente');
  else {
    failed++;
    console.log('  FALLO el hecho guardado no llegó al prompt del modelo');
  }

  // errores que la propia interfaz haya detectado (red de seguridad del renderer)
  const propios = await evaluate('Array.isArray(window.__errores) ? window.__errores.slice(0, 5) : null');
  if (Array.isArray(propios) && propios.length) {
    failed++;
    console.log('  FALLO errores detectados por la propia interfaz:');
    propios.forEach((e) => console.log('        · ' + String(e).slice(0, 160)));
  } else console.log('  ok   ningún error detectado por la propia interfaz');
  // errores de script en el renderer
  if (scriptErrors.length) {
    failed++;
    console.log('  FALLO el renderer lanzó errores de script:');
    [...new Set(scriptErrors)].slice(0, 4).forEach((e) => console.log('        · ' + e));
  } else console.log('  ok   el renderer no lanzó ningún error de script');

  console.log('');
  console.log('UI-CHECK::' + JSON.stringify({ ok: failed === 0, fallos: failed }));
  if (failed) console.error(failed + ' comprobación(es) de interfaz fallaron');
  terminado = true; // veredicto dado: el cierre del socket ya no decide nada
  ws.close();
  done(failed ? 1 : 0);
})().catch((e) => {
  console.error('UI-CHECK::{"ok":false,"error":' + JSON.stringify(String((e && e.message) || e)) + '}');
  process.exit(1);
});
