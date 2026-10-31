'use strict';

/* Tests de agent/equipo.js — el MOTOR del MODO EQUIPO (v4.4).

   Puros y deterministas: no se lanza ningún Agent de verdad (se inyecta una fábrica
   falsa) ni se toca la red. El motor no conoce el modelo, el bucle ni las herramientas
   —orquesta Agents que le llegan—, así que aquí se prueban SUS reglas: quién trabaja,
   cómo le llega el buzón, cuándo se para el equipo y qué viaja en los eventos.

   El `correr` inyectado tampoco termina solo: cada vuelta se resuelve desde el test, que
   es la única forma de mirar a un compañero EN MARCHA (y de que una prueba de espera no
   dependa de relojes. */

const path = require('path');
const raiz = path.join(__dirname, '..', '..');
const equipoMod = require(path.join(raiz, 'agent', 'equipo.js'));
const tools = require(path.join(raiz, 'agent', 'tools.js'));
const subagents = require(path.join(raiz, 'agent', 'subagents.js'));

const { crearEquipo, LIMITE_MIEMBROS, MAX_MENSAJES_MIEMBRO, MAX_MENSAJES_EQUIPO } = equipoMod;

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

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || ''} esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
}
function assertOk(value, msg) {
  if (!value) throw new Error(msg || 'valor falso');
}
function assertIncludes(texto, trozo, msg) {
  if (!String(texto).includes(trozo)) throw new Error(`${msg || ''} «${texto}» no contiene «${trozo}»`);
}

/** Deja correr los microtasks (el motor arranca cada vuelta en la siguiente vuelta del bucle). */
const flush = () => new Promise((r) => setImmediate(r));

const spec = (key) => ({ key, name: key === 'coding' ? 'Coding Agent' : key, emoji: '🧩' });

/**
 * Banco de pruebas del motor: fábrica falsa de Agents + un `correr` que no termina hasta
 * que el test lo pide. `corridas[i]` es la vuelta i-ésima (en orden de arranque).
 */
function banco({ limite, presupuestoUsd } = {}) {
  const eventos = [];
  const creados = [];
  const corridas = [];
  const agentFactory = (opts) => {
    const ag = {
      opts,
      _uso: { tokens: 0, costUsd: 0, turns: 1 },
      parado: false,
      stop() {
        ag.parado = true;
      },
      _aborto: { signal: { aborted: false } },
    };
    creados.push(ag);
    return ag;
  };
  const correr = (miembro, texto, opts) =>
    new Promise((resolve) => {
      corridas.push({ miembro, texto, opts, resolver: resolve, terminada: false });
    });
  const eq = crearEquipo({
    lider: { sessionId: 'conv-1' },
    limite,
    presupuestoUsd,
    onEvento: (e) => eventos.push(e),
    agentFactory,
    correr,
  });
  return {
    eq,
    eventos,
    creados,
    corridas,
    deTipo: (t) => eventos.filter((e) => e.type === t),
    /** Levanta y espera un microtask: así `correr` ya está en `corridas`. */
    async levantar(s = 'coding', tarea = 'una tarea', expect) {
      const r = eq.levantar(spec(s), { tarea, expect });
      await flush();
      return r;
    },
    /** Termina la vuelta i como si el compañero hubiera entregado su resultado. */
    async terminar(i, r = {}) {
      corridas[i].terminada = true;
      corridas[i].resolver({ ok: true, resumen: 'hecho', evidencia: 'ruta/x.js', ...r });
      await flush();
      await flush();
    },
  };
}

async function main() {
  console.log('equipo.js — compañeros (levantar, cerrar, tope)');

  await test('levantar devuelve el id al momento, sin esperar la vuelta', async () => {
    const b = banco();
    const r = await b.levantar('coding', 'escribe el fichero');
    assertEqual(r.ok, true);
    assertEqual(r.id, 'm1');
    assertEqual(r.estado, 'trabajando');
    assertEqual(b.eq.estado('m1'), 'trabajando');
    assertEqual(b.corridas.length, 1, 'la vuelta arranca sin esperarla:');
    assertEqual(b.corridas[0].texto, 'escribe el fichero');
    assertOk(!b.corridas[0].terminada, 'la vuelta no puede estar terminada');
  });

  await test('la identidad del miembro viaja a la fábrica y a su buzón', async () => {
    const b = await banco();
    const ins = b.eq.levantar(spec('research'), { tarea: 'busca', expect: 'fuentes' });
    await flush();
    const opts = b.creados[0].opts;
    assertEqual(opts.miembro.id, ins.id);
    assertEqual(opts.miembro.name, 'research');
    assertEqual(opts.miembro.spec, 'research');
    assertEqual(opts.miembro.estado, 'trabajando');
    assertOk(typeof opts.buzon === 'function', 'el compañero necesita leer su buzón');
    assertOk(typeof opts.atencion === 'function', 'necesita poder pedir atención');
    assertOk(typeof opts.reanudar === 'function', 'y avisar de que ya no pide nada');
    assertEqual(opts.equipo, b.eq, 'la fábrica recibe el propio motor');
  });

  await test('levantar sin tarea no crea compañero (error accionable)', () => {
    const b = banco();
    const r = b.eq.levantar(spec('coding'), { tarea: '   ' });
    assertEqual(r.ok, false);
    assertIncludes(r.error, 'falta la subtarea');
    assertEqual(b.eq.miembros.size, 0);
  });

  await test('levantar acepta la clave del especialista suelta', async () => {
    const b = banco();
    const r = b.eq.levantar('coding', { tarea: 'algo' });
    await flush();
    assertEqual(r.ok, true);
    assertEqual(b.creados[0].opts.miembro.spec, 'coding');
  });

  await test('cuatro compañeros caben; el quinto devuelve error', async () => {
    const b = banco();
    for (let i = 1; i <= LIMITE_MIEMBROS; i++) {
      const r = await b.levantar('coding', `tarea ${i}`);
      assertEqual(r.id, `m${i}`);
    }
    assertEqual(b.eq.miembros.size, LIMITE_MIEMBROS);
    const quinto = b.eq.levantar(spec('coding'), { tarea: 'la quinta' });
    assertEqual(quinto.ok, false);
    assertIncludes(quinto.error, `el equipo ya tiene ${LIMITE_MIEMBROS} compañeros`);
    assertEqual(b.eq.miembros.size, LIMITE_MIEMBROS);
    assertEqual(b.corridas.length, LIMITE_MIEMBROS, 'el quinto no arranca ninguna vuelta:');
  });

  await test('el tope vive en el motor y se expone resuelto', () => {
    assertEqual(LIMITE_MIEMBROS, 4);
    const b = banco();
    assertEqual(b.eq.limiteMiembros, 4);
  });

  await test('cerrar deja al compañero terminado y emite team_done', async () => {
    const b = await banco();
    await b.levantar('coding', 'algo');
    const r = b.eq.cerrar('m1', { resumen: 'hecho esto', evidencia: 'npm test' });
    assertEqual(r.ok, true);
    assertEqual(b.eq.estado('m1'), 'terminado');
    const done = b.deTipo('team_done');
    assertEqual(done.length, 1);
    assertEqual(done[0].id, 'm1');
    assertEqual(done[0].ok, true);
    assertEqual(done[0].resumen, 'hecho esto');
    assertEqual(done[0].evidencia, 'npm test');
    const m = b.eq.miembros.get('m1');
    assertEqual(m.resultado.resumen, 'hecho esto');
    // la vuelta seguía viva: al asentarse NO se pisa lo que cerró el propio compañero
    await b.terminar(0, { resumen: 'otra cosa' });
    assertEqual(b.eq.miembros.get('m1').resultado.resumen, 'hecho esto');
    assertEqual(b.deTipo('team_done').length, 1, 'team_done no se repite:');
  });

  await test('cerrar con un id desconocido devuelve error', () => {
    const b = banco();
    const r = b.eq.cerrar('m9', { resumen: 'x' });
    assertEqual(r.ok, false);
    assertIncludes(r.error, 'no existe ningún compañero');
  });

  await test('el gasto suma a los compañeros', async () => {
    const b = await banco();
    await b.levantar('coding', 'uno');
    await b.levantar('research', 'dos');
    b.creados[0]._uso = { tokens: 100, costUsd: 0.5, turns: 1 };
    b.creados[1]._uso = { tokens: 50, costUsd: 0.25, turns: 1 };
    const g = b.eq.gasto();
    assertEqual(g.tokens, 150);
    assertEqual(g.costUsd, 0.75);
  });

  console.log('equipo.js — buzón con entrega de verdad');

  await test('a un compañero EN MARCHA se le entrega en su siguiente paso', async () => {
    const b = await banco();
    await b.levantar('coding', 'algo');
    const r = b.eq.enviar('lider', 'm1', 'te falta el token');
    assertEqual(r.ok, true);
    // el gancho que agent.js llama en CADA paso del bucle: devuelve y vacía
    const leidos = b.creados[0].opts.buzon();
    assertEqual(leidos.length, 1);
    assertEqual(leidos[0].de, 'lider');
    assertEqual(leidos[0].texto, 'te falta el token');
    assertEqual(b.eq.bandejaDe('m1').length, 0, 'quien lee, consume:');
    assertEqual(b.corridas.length, 1, 'un mensaje no relanza a quien trabaja:');
    assertEqual(b.eq.estado('m1'), 'trabajando');
  });

  await test('a un compañero PARADO se le despierta con el mensaje como subtarea', async () => {
    const b = await banco();
    await b.levantar('coding', 'la primera');
    b.creados[0]._uso.costUsd = 0.3; // su gasto acumulado no se puede perder al despertarlo
    await b.terminar(0);
    assertEqual(b.eq.estado('m1'), 'terminado');
    const r = b.eq.enviar('lider', 'm1', 'ahora revisa el otro fichero');
    assertEqual(r.ok, true);
    await flush();
    assertEqual(b.corridas.length, 2, 'se le despierta con una vuelta nueva:');
    assertEqual(b.corridas[1].texto, 'ahora revisa el otro fichero');
    assertEqual(b.corridas[1].miembro.agent, b.creados[0], 'el MISMO Agent:');
    assertEqual(b.corridas[1].miembro.id, 'm1');
    assertEqual(b.eq.estado('m1'), 'trabajando');
    assertEqual(b.eq.gasto().costUsd, 0.3, 'el gasto se acumula:');
    assertEqual(b.eq.bandejaDe('m1').length, 0, 'el mensaje ya es su subtarea:');
  });

  await test('el mensaje dice de quién viene y a quién va', async () => {
    const b = await banco();
    await b.levantar('coding', 'a');
    await b.levantar('research', 'b');
    b.eq.enviar('m1', 'm2', 'mira esto');
    const ev = b.deTipo('team_message');
    assertEqual(ev.length, 1);
    assertEqual(ev[0].de, 'm1');
    assertEqual(ev[0].para, 'm2');
    assertEqual(ev[0].texto, 'mira esto');
    assertOk(typeof ev[0].ts === 'number', 'el evento lleva hora');
    assertEqual(b.eq.bandejaDe('m2')[0].de, 'm1');
  });

  await test('team_send a un id inexistente devuelve error accionable', () => {
    const b = banco();
    const r = b.eq.enviar('lider', 'm9', 'hola');
    assertEqual(r.ok, false);
    assertIncludes(r.error, 'no existe ningún compañero «m9»');
    assertIncludes(r.error, 'lider');
  });

  await test('«todos» entrega a los compañeros y al líder (sin devolverse al emisor)', async () => {
    const b = await banco();
    await b.levantar('coding', 'a');
    await b.levantar('research', 'b');
    const r = b.eq.enviar('m1', 'todos', 'aviso general');
    assertEqual(r.ok, true);
    assertEqual(b.eq.bandejaDe('m2')[0].texto, 'aviso general');
    const alLider = b.eq.bandejaDe('lider'); // se lee UNA vez: quien lee, consume
    assertEqual(alLider.length, 1);
    assertEqual(alLider[0].texto, 'aviso general');
    assertEqual(alLider[0].de, 'm1');
    assertEqual(b.eq.bandejaDe('m1').length, 0, 'el emisor no se manda a sí mismo:');
  });

  await test('un mensaje vacío no se entrega', () => {
    const b = banco();
    const r = b.eq.enviar('lider', 'm1', '   ');
    assertEqual(r.ok, false);
    assertIncludes(r.error, 'vacío');
    assertEqual(b.deTipo('team_message').length, 0);
  });

  await test(`el buzón de un compañero tiene tope (${MAX_MENSAJES_MIEMBRO})`, async () => {
    const b = await banco();
    await b.levantar('coding', 'a');
    for (let i = 0; i < MAX_MENSAJES_MIEMBRO; i++) {
      assertEqual(b.eq.enviar('lider', 'm1', `mensaje ${i}`).ok, true);
    }
    const r = b.eq.enviar('lider', 'm1', 'uno más');
    assertEqual(r.ok, false);
    assertIncludes(r.error, 'ya recibió');
    assertOk(MAX_MENSAJES_EQUIPO > MAX_MENSAJES_MIEMBRO, 'el tope del equipo es mayor que el de uno');
  });

  await test(`el equipo entero tiene tope de mensajes (${MAX_MENSAJES_EQUIPO})`, async () => {
    const b = await banco();
    for (let i = 1; i <= 4; i++) await b.levantar('coding', `tarea ${i}`);
    let enviados = 0;
    let ultimo = { ok: true };
    for (let i = 0; i < MAX_MENSAJES_EQUIPO + 1; i++) {
      ultimo = b.eq.enviar('lider', 'm' + ((i % 4) + 1), `mensaje ${i}`);
      if (ultimo.ok) enviados++;
    }
    assertEqual(enviados, MAX_MENSAJES_EQUIPO);
    assertEqual(ultimo.ok, false);
    assertIncludes(ultimo.error, 'tope de mensajes del equipo');
  });

  console.log('equipo.js — esperar sin bloquear a los demás');

  await test('esperar resuelve cuando el compañero termina, con su resultado', async () => {
    const b = await banco();
    await b.levantar('coding', 'algo');
    const p = b.eq.esperar(['m1'], 1000);
    await b.terminar(0, { resumen: 'terminado esto', evidencia: 'npm test: 12 ok' });
    const r = await p;
    assertEqual(r.ok, true);
    assertEqual(r.motivo, 'fin');
    assertEqual(r.miembros.length, 1);
    assertEqual(r.miembros[0].id, 'm1');
    assertEqual(r.miembros[0].estado, 'terminado');
    assertEqual(r.miembros[0].resumen, 'terminado esto');
    assertEqual(r.miembros[0].evidencia, 'npm test: 12 ok');
    assertEqual(r.pendientes.length, 0);
  });

  await test('esperar resuelve cuando alguien pide algo, sin parar a los demás', async () => {
    const b = await banco();
    await b.levantar('coding', 'a');
    await b.levantar('research', 'b');
    b.eq.tableroApunta({ quien: 'lider', que: 'repartir', estado: 'hecho' });
    const p = b.eq.esperar(['m1'], 1000);
    let resuelto = false;
    p.then(() => {
      resuelto = true;
    });
    await flush();
    assertEqual(resuelto, false, 'nada ha pasado todavía');
    b.creados[0].opts.atencion('permiso pendiente: write_file');
    assertEqual(b.eq.estado('m1'), 'esperando');
    const r = await p;
    assertEqual(r.motivo, 'atencion');
    assertEqual(r.miembros[0].atencion, 'permiso pendiente: write_file');
    assertEqual(b.eq.estado('m2'), 'trabajando', 'el otro compañero sigue trabajando:');
    // reanudar lo devuelve a trabajar
    b.creados[0].opts.reanudar();
    assertEqual(b.eq.estado('m1'), 'trabajando');
  });

  await test('un mensaje al líder también despierta al que espera', async () => {
    const b = await banco();
    await b.levantar('coding', 'a');
    const p = b.eq.esperar(['m1'], 1000);
    b.eq.enviar('m1', 'lider', 'necesito el token');
    const r = await p;
    assertEqual(r.motivo, 'atencion');
    assertEqual(r.mensajes.length, 1);
    assertEqual(r.mensajes[0].de, 'm1');
    assertEqual(r.mensajes[0].texto, 'necesito el token');
    assertEqual(b.eq.bandejaDe('lider').length, 0, 'el mensaje ya se lo ha llevado la espera:');
  });

  await test('esperar con timeout devuelve lo que sigue en marcha', async () => {
    const b = await banco();
    await b.levantar('coding', 'a');
    const r = await b.eq.esperar(['m1'], 5);
    assertEqual(r.motivo, 'timeout');
    assertEqual(r.pendientes.length, 1);
    assertEqual(r.pendientes[0], 'm1');
    assertEqual(b.eq.estado('m1'), 'trabajando', 'el timeout no para a nadie:');
  });

  await test('esperar sin ids espera a todos', async () => {
    const b = await banco();
    await b.levantar('coding', 'a');
    await b.levantar('research', 'b');
    const p = b.eq.esperar(undefined, 1000);
    await b.terminar(0);
    await b.terminar(1);
    const r = await p;
    assertEqual(r.motivo, 'fin');
    assertEqual(r.miembros.length, 2);
  });

  await test('esperar con un id desconocido devuelve error', async () => {
    const b = await banco();
    const r = await b.eq.esperar(['m7'], 50);
    assertEqual(r.ok, false);
    assertIncludes(r.error, 'no existe ningún compañero «m7»');
  });

  console.log('equipo.js — tablero, eventos y presupuesto');

  await test('el tablero apunta y actualiza el mismo ítem', () => {
    const b = banco();
    const alta = b.eq.tableroApunta({ quien: 'm1', que: 'buscar precios', estado: 'en_curso' });
    assertEqual(alta.ok, true);
    assertEqual(b.eq.tablero.length, 1);
    assertEqual(b.eq.tablero[0].quien, 'm1');
    assertEqual(b.eq.tablero[0].estado, 'en_curso');
    const act = b.eq.tableroApunta({ quien: 'm1', que: 'buscar precios', estado: 'hecho', nota: '3 fuentes' });
    assertEqual(act.ok, true);
    assertEqual(b.eq.tablero.length, 1, 'el mismo «que» actualiza, no duplica:');
    assertEqual(b.eq.tablero[0].estado, 'hecho');
    assertEqual(b.eq.tablero[0].nota, '3 fuentes');
    assertEqual(b.eq.tablero[0].id, alta.item.id);
    assertEqual(b.deTipo('team_board').length, 2, 'cada apunte emite el tablero:');
    assertEqual(b.deTipo('team_board')[1].items.length, 1);
  });

  await test('team_board sin argumentos solo lee', () => {
    const b = banco();
    b.eq.tableroApunta({ quien: 'lider', que: 'repartir' });
    const r = b.eq.tableroApunta({});
    assertEqual(r.ok, true);
    assertEqual(r.tablero.length, 1);
    assertEqual(b.deTipo('team_board').length, 1, 'leer no emite evento nuevo:');
  });

  await test('team_start lleva el reparto y team_end el gasto real', async () => {
    const b = await banco();
    await b.levantar('coding', 'a');
    await b.levantar('research', 'b');
    const start = b.deTipo('team_start');
    assertEqual(start.length, 1, 'un solo arranque de equipo:');
    assertEqual(start[0].miembros.length, 1, 'con el primer compañero levantado:');
    assertEqual(start[0].miembros[0].id, 'm1');
    assertEqual(start[0].miembros[0].spec, 'coding');
    assertEqual(b.deTipo('team_member').length, 2, 'cada levantamiento se anuncia:');
    assertEqual(b.deTipo('team_member')[1].estado, 'trabajando');
    b.creados[0]._uso = { tokens: 10, costUsd: 0.1, turns: 1 };
    b.creados[1]._uso = { tokens: 20, costUsd: 0.2, turns: 1 };
    const fin = b.eq.terminar({ ok: true, resumen: 'lo agregado' });
    assertEqual(fin.ok, true);
    const end = b.deTipo('team_end');
    assertEqual(end.length, 1);
    assertEqual(end[0].ok, true);
    assertEqual(end[0].resumen, 'lo agregado');
    assertEqual(end[0].gasto.tokens, 30);
    assertEqual(Math.round(end[0].gasto.costUsd * 1000) / 1000, 0.3);
    assertEqual(end[0].miembros.length, 2, 'el cierre lleva el estado REAL de cada compañero:');
    assertEqual(end[0].miembros.map((m) => m.id).join(','), 'm1,m2');
    assertEqual(end[0].miembros[0].estado, 'fallo', 'los que trabajaban se pararon:');
    const otra = b.eq.terminar({});
    assertEqual(otra.ok, false);
    assertIncludes(otra.error, 'ya estaba cerrado');
  });

  await test('al cerrar el turno no se para a un compañero que espera al usuario', async () => {
    const b = await banco();
    await b.levantar('file', 'escribe la nota');
    b.creados[0].opts.atencion('permiso pendiente: write_file'); // el compañero pide permiso
    assertEqual(b.eq.estado('m1'), 'esperando');
    const fin = b.eq.terminar({ ok: true, resumen: 'necesito tu permiso para la nota' });
    assertEqual(fin.ok, true);
    /* El líder acabó su parte, pero la respuesta que espera el compañero es del USUARIO:
       pararlo aquí dejaba el permiso sin nadie que lo esperara. */
    assertEqual(b.eq.estado('m1'), 'esperando', 'sigue esperando al usuario:');
    assertEqual(b.creados[0].parado, false, 'no se le paró: su vuelta tiene que seguir viva');
    const end = b.deTipo('team_end');
    assertEqual(end.length, 1);
    assertEqual(end[0].miembros.find((m) => m.id === 'm1').estado, 'esperando', 'y así viaja en el cierre:');
  });

  await test('si el turno muere, un compañero que esperaba sí se para', async () => {
    const b = await banco();
    await b.levantar('file', 'escribe la nota');
    b.creados[0].opts.atencion('permiso pendiente: write_file');
    b.eq.terminar({ ok: false, resumen: '' }); // Detener, un guardarraíl, una excepción
    assertEqual(b.eq.estado('m1'), 'fallo', 'sin turno no hay nada que autorizar:');
    assertEqual(b.creados[0].parado, true, 'se le para, que no quede trabajo a espaldas del usuario');
  });

  await test('un turno sin compañeros no abre ni cierra equipo', () => {
    const b = banco();
    const r = b.eq.terminar({ ok: true });
    assertEqual(r.ok, false);
    assertIncludes(r.error, 'no llegó a empezar');
    assertEqual(b.eventos.length, 0, 'sin compañeros no hay eventos de equipo:');
  });

  await test('el presupuesto corta a todos, lo dice y deja el tablero igual', async () => {
    const b = await banco({ presupuestoUsd: 0.5 });
    await b.levantar('coding', 'a');
    await b.levantar('research', 'b');
    b.eq.tableroApunta({ quien: 'm1', que: 'lo suyo', estado: 'en_curso' });
    const antes = JSON.stringify(b.eq.tablero);
    b.creados[0]._uso = { tokens: 10, costUsd: 0.6, turns: 1 };
    assertEqual(b.eq.revisar(), true, 'el corte se detecta:');
    assertEqual(b.eq.estado('m1'), 'fallo');
    assertEqual(b.eq.estado('m2'), 'fallo');
    assertEqual(b.creados[0].parado, true, 'se para al compañero:');
    assertEqual(b.creados[1].parado, true);
    assertIncludes(b.eq.motivoCorte(), 'presupuesto del equipo se agotó');
    const aviso = b.deTipo('team_message').find((e) => e.de === 'lider' && e.para === 'todos');
    assertOk(aviso, 'el corte se dice en el chat');
    assertIncludes(aviso.texto, 'presupuesto');
    assertEqual(JSON.stringify(b.eq.tablero), antes, 'el tablero se queda como estaba:');
    // el corte no se repite y no se levanta a nadie más
    assertEqual(b.eq.revisar(), false);
    const nuevo = b.eq.levantar(spec('coding'), { tarea: 'otra' });
    assertEqual(nuevo.ok, false);
    assertIncludes(nuevo.error, 'el equipo está parado');
    assertEqual(b.corridas.length, 2, 'nadie más arranca:');
  });

  await test('tras el corte, un mensaje a un compañero parado no lo despierta', async () => {
    const b = await banco({ presupuestoUsd: 0.5 });
    await b.levantar('coding', 'a');
    await b.terminar(0);
    b.creados[0]._uso = { tokens: 1, costUsd: 0.9, turns: 1 };
    b.eq.revisar();
    b.eq.enviar('lider', 'm1', 'sigue con esto');
    await flush();
    assertEqual(b.corridas.length, 1, 'el equipo parado no vuelve a trabajar:');
  });

  await test('con presupuesto 0 no hay corte propio', async () => {
    const b = await banco({ presupuestoUsd: 0 });
    await b.levantar('coding', 'a');
    b.creados[0]._uso = { tokens: 1, costUsd: 99, turns: 1 };
    assertEqual(b.eq.revisar(), false);
    assertEqual(b.eq.motivoCorte(), null);
    assertEqual(b.eq.estado('m1'), 'trabajando');
  });

  console.log('tools.js — las cinco herramientas, en el sitio correcto');

  await test('las cinco existen y son «safe»', () => {
    const nombres = tools.toolDefs.map((d) => d.function.name);
    for (const n of ['team_spawn', 'team_send', 'team_wait', 'team_board', 'team_done']) {
      assertOk(nombres.includes(n), `falta la herramienta ${n}`);
      assertEqual(tools.RISK[n], 'safe', `${n} debe ser safe:`);
      assertEqual(tools.esHerramientaDeEquipo(n), true);
    }
    assertEqual(tools.HERRAMIENTAS_EQUIPO.size, 5);
  });

  await test('un compañero ve tres (no levanta gente ni espera)', () => {
    const defs = tools.defsEquipoParaMiembro().map((d) => d.function.name);
    assertEqual(defs.slice().sort().join(','), 'team_board,team_done,team_send');
    assertOk(!defs.includes('team_spawn'), 'team_spawn no es de un compañero');
    assertOk(!defs.includes('team_wait'), 'team_wait no es de un compañero');
    assertEqual(tools.HERRAMIENTAS_EQUIPO_MIEMBRO.length, 3);
  });

  await test('fuera del modo EQUIPO el catálogo no las ofrece', () => {
    const sin = tools.defsSinEquipo().map((d) => d.function.name);
    for (const n of ['team_spawn', 'team_send', 'team_wait', 'team_board', 'team_done'])
      assertOk(!sin.includes(n), `no debe ofrecerse ${n} fuera de EQUIPO`);
    assertOk(sin.includes('read_file'), 'el resto del catálogo sigue intacto');
    assertOk(sin.includes('delegate'), 'y delegate también');
  });

  await test('team_spawn pide agente y tarea', () => {
    const d = tools.toolDefs.find((x) => x.function.name === 'team_spawn');
    assertEqual(d.function.parameters.required.join(','), 'agent,task');
    assertOk(d.function.description.includes('sin esperarlo') || d.function.description.includes('sin esperar'));
  });

  console.log('subagents.js — la guía del líder y el brief del compañero');

  await test('la guía del líder trae el registro con nombre y emoji', () => {
    const guia = subagents.teamGuide();
    assertIncludes(guia, 'LÍDER');
    assertIncludes(guia, 'team_spawn');
    const coding = subagents.rosterEquipo().find((s) => s.key === 'coding');
    assertOk(coding, 'el registro tiene que traer los de serie');
    assertIncludes(guia, `${coding.emoji} coding — ${coding.name}`);
    assertEqual(subagents.TEAM_GUIDE, subagents.TEAM_GUIDE.trim(), 'sin espacios sobrantes');
  });

  await test('el brief de un compañero lleva su id y con quién hablar', () => {
    const brief = subagents.buildSubagentBrief({
      task: 'revisa el diff',
      expect: 'hallazgos numerados',
      equipo: { id: 'm2', lider: 'lider', companeros: [{ id: 'm1', name: 'Research Agent', spec: 'research' }] },
    });
    assertIncludes(brief, 'ERES EL COMPAÑERO «m2»');
    assertIncludes(brief, '«lider»');
    assertIncludes(brief, 'm1 (Research Agent)');
    assertIncludes(brief, 'team_done');
    assertIncludes(brief, 'revisa el diff');
  });

  await test('sin equipo el brief es el de siempre', () => {
    const brief = subagents.buildSubagentBrief({ task: 'una subtarea', expect: 'algo' });
    assertEqual(brief.startsWith('SUBTAREA:'), true, 'la delegación empieza igual que antes:');
    assertOk(!brief.includes('COMPAÑERO'), 'no se cuela la línea de equipo');
  });

  console.log('agent.js — el buzón entra en el prompt y las confirmaciones tienen dueño');

  await test('el buzón se inyecta en el prompt y nunca se duplica', () => {
    const { Agent } = require(path.join(raiz, 'agent', 'agent.js'));
    const a = new Agent({ emit: () => {} });
    const pendientes = [{ de: 'lider', texto: 'te falta el token' }];
    a._buzon = () => pendientes.splice(0); // la lectura vacía: quien lee, consume
    const messages = [{ role: 'system', content: 'BASE' }];
    a._sincronizarBuzon(messages);
    assertIncludes(messages[0].content, 'BASE', 'el prompt no se pierde:');
    assertIncludes(messages[0].content, 'te falta el token');
    const antes = messages[0].content;
    a._sincronizarBuzon(messages); // sin mensajes nuevos no se toca (caché del proveedor)
    assertEqual(messages[0].content, antes);
    pendientes.push({ de: 'm2', texto: 'yo lo veo distinto' });
    a._sincronizarBuzon(messages);
    assertEqual(messages[0].content.split('MENSAJES DEL EQUIPO').length - 1, 1, 'un único bloque:');
    assertIncludes(messages[0].content, 'te falta el token', 'lo anterior sigue ahí:');
    assertIncludes(messages[0].content, 'yo lo veo distinto');
  });

  await test('los eventos de un compañero salen del líder con `member`', () => {
    const { Agent } = require(path.join(raiz, 'agent', 'agent.js'));
    const eventos = [];
    const visto = { atencion: [], reanudar: 0, revisar: 0 };
    const lider = new Agent({ emit: (e) => eventos.push(e) });
    lider._equipoSettings = { settings: {}, security: {} };
    const sub = lider._crearCompanero({
      miembro: { id: 'm1', name: 'Coding Agent', spec: { key: 'coding', name: 'Coding Agent', emoji: '💻' } },
      buzon: () => [],
      atencion: (m) => visto.atencion.push(m),
      reanudar: () => visto.reanudar++,
      equipo: { revisar: () => visto.revisar++ },
    });
    assertEqual(lider.subagents.has(sub), true, 'Detener del líder tiene que verlo:');
    sub.emit({ type: 'tool_result', name: 'read_file', ok: true });
    assertEqual(eventos.length, 1);
    assertEqual(eventos[0].member, 'm1');
    assertEqual(eventos[0].memberName, 'Coding Agent');
    assertEqual(eventos[0].subagent, 'coding');
    assertEqual(eventos[0].name, 'read_file');
    assertEqual(visto.reanudar, 1, 'un resultado ya no es «pide algo»:');
    assertEqual(visto.revisar, 1, 'y el tope del equipo se mira al vuelo:');
    sub.emit({ type: 'confirm_request', id: 'c9', tool: 'write_file' });
    assertEqual(eventos[1].member, 'm1');
    assertEqual(visto.atencion.length, 1);
    assertIncludes(visto.atencion[0], 'write_file');
  });

  await test('una confirmación pendiente de un compañero lleva su miembro', async () => {
    const { Agent } = require(path.join(raiz, 'agent', 'agent.js'));
    const sub = new Agent({ emit: () => {} });
    sub._miembro = { id: 'm2', nombre: 'Coding Agent', spec: 'coding' };
    assertEqual(JSON.stringify(sub._infoMiembro()), JSON.stringify({ member: 'm2', memberName: 'Coding Agent' }));
    const cid = 'c-test';
    Agent.CONFIRM_ROUTES.set(cid, sub); // el mismo registro que usa sec:resolve
    const p = sub._awaitConfirm(cid, new AbortController().signal);
    const de = sub.memberOfConfirm(cid);
    assertEqual(de.id, 'm2');
    assertEqual(Agent.memberOfConfirm(cid).nombre, 'Coding Agent');
    assertEqual(sub.resolveConfirm(cid, true), true, 'la ruta de siempre la resuelve:');
    assertEqual(await p, true);
    assertEqual(sub.memberOfConfirm(cid), null, 'resuelta, ya no hay pendiente:');
    Agent.CONFIRM_ROUTES.delete(cid);
    assertEqual(Agent.memberOfConfirm(cid), null);
  });

  await test('sin modo EQUIPO, una herramienta de equipo se rechaza diciendo qué hacer', async () => {
    const { Agent } = require(path.join(raiz, 'agent', 'agent.js'));
    const a = new Agent({ emit: () => {} });
    const r = await a._herramientaEquipo('team_spawn', { agent: 'coding', task: 'algo' }, { settings: { settings: { mode: 'act' } } });
    assertIncludes(r, 'Error:');
    assertIncludes(r, 'modo EQUIPO');
  });

  await test('en modo EQUIPO el líder levanta compañeros de verdad (y su fallo es honesto)', async () => {
    const os = require('os');
    const fs = require('fs');
    const { Agent } = require(path.join(raiz, 'agent', 'agent.js'));
    const eventos = [];
    const a = new Agent({ emit: (e) => eventos.push(e) });
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sagitari-equipo-'));
    const settings = { settings: { mode: 'equipo', workspace: ws, arbolesAislados: false }, security: {} };
    const r = await a._herramientaEquipo(
      'team_spawn',
      { agent: 'research', task: 'busca algo' },
      { settings, signal: new AbortController().signal },
    );
    assertIncludes(r, 'Compañero m1');
    const p = a._equipo.miembros.get('m1').promesa;
    assertOk(p, 'la vuelta arranca sin esperarla:');
    await p; // sin proveedor activo el compañero no puede trabajar: se asienta y lo dice
    assertEqual(a._equipo.estado('m1'), 'fallo');
    const done = eventos.filter((e) => e.type === 'team_done');
    assertEqual(done.length, 1);
    assertEqual(done[0].ok, false);
    assertIncludes(done[0].resumen, 'no pudo terminar');
    try {
      fs.rmSync(ws, { recursive: true, force: true });
    } catch {}
  });

  console.log(`\n${passed} pasaron, ${failed} fallaron`);
  process.exit(failed ? 1 : 0);
}

/* El runner del renderer carga los ficheros en SU proceso y espera la promesa que el
   módulo devuelve: así un fichero con `await` informa igual que uno síncrono. */
module.exports = main();
