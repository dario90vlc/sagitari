'use strict';

/* Motor del MODO EQUIPO (v4.4): compañeros vivos, buzón y tablero compartido.

   Este módulo NO sabe nada del modelo, del bucle ni de las herramientas: orquesta
   Agents que le llegan ya construidos. Los dos colaboradores se INYECTAN, como hace
   agent/tasks.js con `agentFactory`:

     agentFactory({ miembro, buzon, atencion, reanudar, equipo }) -> Agent del compañero
     correr(miembro, texto, opts) -> Promise<{ ok, resumen, evidencia }>

   `correr` lo implementa agent/agent.js (árbol aislado, prompt del especialista,
   herramientas del registro, absorción del gasto). Aquí solo se decide QUIÉN trabaja,
   CUÁNDO se le entrega lo que le llega y CUÁNDO el equipo se para.

   Entrega de verdad del buzón, que es lo que separa esto de una lista de mensajes:
   - A un compañero EN MARCHA se le inyecta en su siguiente paso del bucle. Para eso el
     motor le da al Agent un `buzon` (una función que devuelve los pendientes y los
     vacía) y agent.js la llama en cada paso, igual que la lista de tareas.
   - A uno PARADO (ya terminó su encargo) se le despierta con el mensaje como nueva
     subtarea: el MISMO Agent, el mismo árbol de trabajo y el mismo gasto acumulado.
*/

/** Tope de compañeros vivos por equipo. Es el número que citan el ajuste, la interfaz y
    el prompt del líder: vive aquí y solo aquí (`equipo.limiteMiembros` lo expone ya
    resuelto). */
const LIMITE_MIEMBROS = 4;

/* Techo de mensajes: un buzón sin tope es un bucle de dos compañeros hablándose hasta
   agotar el turno. Se cuenta por miembro Y por equipo (misma idea que el guardián de
   bucles: la señal que importa es la repetición, no el mensaje suelto). */
const MAX_MENSAJES_MIEMBRO = 12;
const MAX_MENSAJES_EQUIPO = 40;
const MAX_TEXTO = 2000; // caracteres por mensaje
const MAX_ITEM = 300; // caracteres por ítem del tablero
const MAX_NOTA = 600;
const MAX_TABLERO = 40; // ítems vivos del tablero
const ESPERA_DEFECTO_MS = 30000;
const ESPERA_MAX_MS = 300000;

/** Normaliza la spec del especialista. Se acepta el objeto del registro (lo normal) o su
    clave suelta, para que el motor no dependa de cómo le llegue. */
function specDe(spec) {
  if (!spec) return null;
  if (typeof spec === 'string') {
    const key = spec.trim().slice(0, 60);
    return key ? { key, name: key, emoji: '🧩' } : null;
  }
  const key = String(spec.key || '')
    .trim()
    .slice(0, 60);
  if (!key) return null;
  return { ...spec, key, name: String(spec.name || key).slice(0, 80), emoji: spec.emoji || '🧩' };
}

function texto(v, max) {
  return String(v == null ? '' : v)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function textoLargo(v, max) {
  return String(v == null ? '' : v)
    .trim()
    .slice(0, max);
}

/**
 * Crea un equipo. `lider` es el Agent del chat (solo se usa como identidad y para
 * etiquetar los mensajes que salen de él: el motor no le pide nada).
 */
function crearEquipo({ lider = null, limite = LIMITE_MIEMBROS, presupuestoUsd = 0, onEvento, agentFactory, correr } = {}) {
  const lim = Number(limite) > 0 ? Math.floor(Number(limite)) : LIMITE_MIEMBROS;
  const pres = Number(presupuestoUsd) > 0 ? Number(presupuestoUsd) : 0;

  const miembros = new Map(); // id -> Miembro
  const tablero = []; // Item[]
  const bandejaLider = []; // mensajes dirigidos al líder
  const esperas = new Set(); // { ids, fin, motivo }
  let seq = 0; // ids de miembro (m1…)
  let seqTablero = 0; // ids de ítem (b1…)
  let mensajes = 0; // mensajes entregados en este equipo
  let avisosLider = 0; // mensajes que han llegado al líder (despierta un `esperar`)
  let iniciado = false; // ya salió `team_start`
  let terminado = false; // ya salió `team_end`
  let corte = null; // motivo por el que el equipo se paró (presupuesto)

  function avisar(type, extra = {}) {
    if (typeof onEvento !== 'function') return;
    try {
      onEvento({ type, ...extra });
    } catch {}
  }

  /** Ficha del miembro tal y como viaja en los eventos y en las herramientas. */
  function ficha(m) {
    return {
      id: m.id,
      spec: m.spec.key,
      name: m.spec.name,
      emoji: m.spec.emoji,
      estado: estadoDe(m),
      tarea: m.tarea,
      expect: m.expect,
      atencion: m.pideAtencion ? m.motivoAtencion || 'pide algo' : null,
    };
  }

  /** Estado visible: `pideAtencion` (permiso pendiente o pregunta al líder) gana al
      «trabajando» mientras su ejecución sigue viva. */
  function estadoDe(m) {
    if (!m) return null;
    if (m.estado === 'trabajando' && m.pideAtencion) return 'esperando';
    return m.estado;
  }

  function estaParado(m) {
    return !m.corriendo;
  }

  /** Avisa a las esperas vivas de que algo cambió: cada una decide si ya toca resolverse. */
  function despertarEsperas() {
    if (!esperas.size) return;
    for (const w of [...esperas]) {
      const motivo = w.motivo();
      if (motivo) w.fin(motivo);
    }
  }

  /** ¿Por qué debería resolverse ya una espera sobre estos ids? */
  function motivoDeEspera(ids, avisosBase) {
    const lista = ids.map((id) => miembros.get(id)).filter(Boolean);
    if (!lista.length) return 'fin';
    if (lista.every(estaParado)) return 'fin';
    if (avisosLider > avisosBase) return 'atencion'; // alguien pidió algo al líder
    if (lista.some((m) => m.pideAtencion)) return 'atencion';
    return null;
  }

  /** Estado + resultado de unos miembros, tal y como lo devuelve `esperar`. */
  function resumenEspera(ids, motivo) {
    const mensajesRecibidos = bandejaLider.splice(0);
    return {
      ok: true,
      motivo,
      miembros: ids
        .map((id) => miembros.get(id))
        .filter(Boolean)
        .map((m) => ({
          id: m.id,
          spec: m.spec.key,
          name: m.spec.name,
          emoji: m.spec.emoji,
          estado: estadoDe(m),
          atencion: m.pideAtencion ? m.motivoAtencion || 'pide algo' : null,
          tarea: m.tarea,
          resumen: (m.resultado && m.resultado.resumen) || '',
          evidencia: (m.resultado && m.resultado.evidencia) || '',
        })),
      pendientes: ids.filter((id) => {
        const m = miembros.get(id);
        return m && !estaParado(m);
      }),
      mensajes: mensajesRecibidos,
    };
  }

  /** Suma de lo gastado por los compañeros (el líder no entra: su gasto es del chat). */
  function gasto() {
    let tokens = 0;
    let costUsd = 0;
    for (const m of miembros.values()) {
      const u = m.agent && m.agent._uso;
      if (!u) continue;
      tokens += Number(u.tokens) || 0;
      costUsd += Number(u.costUsd) || 0;
    }
    return { tokens, costUsd };
  }

  /** Tope de presupuesto, comprobado en cada entrada pública y en cada paso de un
      compañero (agent.js llama a `revisar()` desde su bucle de eventos). Al superarlo
      se para a TODOS, se dice en el chat y el tablero se queda como está. */
  function revisar() {
    if (!pres || corte || terminado) return false;
    const g = gasto();
    if (g.costUsd < pres) return false;
    corte = `presupuesto del equipo agotado: ${g.costUsd.toFixed(4)} $ de ${pres} $ (ajuste «Presupuesto de equipo»)`;
    const parados = [];
    for (const m of miembros.values()) {
      if (m.corriendo) {
        try {
          if (m.agent && typeof m.agent.stop === 'function') m.agent.stop();
        } catch {}
      }
      m.cortado = true;
      m.corriendo = false;
      m.estado = 'fallo';
      m.pideAtencion = false;
      parados.push(m);
    }
    avisar('team_message', {
      de: 'lider',
      para: 'todos',
      texto: `El equipo se para: ${corte}. El tablero se queda como está.`,
      ts: Date.now(),
    });
    for (const m of parados) avisar('team_member', ficha(m));
    despertarEsperas();
    return true;
  }

  /** Arranca la ejecución de un compañero SIN esperarla: el líder levanta varios en
      paralelo y sigue con su turno. */
  function arrancar(m, texto0, opts = {}) {
    const t = textoLargo(texto0, MAX_TEXTO * 2);
    m.estado = 'trabajando';
    m.pideAtencion = false;
    m.corriendo = true;
    if (typeof correr !== 'function') {
      m.corriendo = false;
      m.estado = 'fallo';
      m.resultado = { ok: false, resumen: 'el motor no tiene `correr` inyectado', evidencia: '' };
      avisar('team_done', { id: m.id, ok: false, resumen: m.resultado.resumen, evidencia: '' });
      return null;
    }
    m.promesa = Promise.resolve()
      .then(() => correr(m, t, opts))
      .then(
        (r) => asentar(m, r || {}),
        (e) => asentar(m, { ok: false, resumen: 'el compañero falló: ' + ((e && e.message) || e) }),
      );
    return m.promesa;
  }

  /** Cierra la vuelta de un compañero: estado final, evento y quien esperaba. */
  function asentar(m, r) {
    m.corriendo = false;
    m.promesa = null;
    if (m.cortado) m.estado = 'fallo';
    else m.estado = r.ok === false ? 'fallo' : 'terminado';
    /* Si el compañero ya cerró con `team_done` durante su vuelta, ESE es su resultado (lo
       dijo él, con su evidencia) y no se pisa con el texto final del bucle. */
    const cerradoPorEl = !!(m.cerrado && m.resultado);
    if (!cerradoPorEl) {
      m.resultado = { ok: m.estado !== 'fallo', resumen: textoLargo(r.resumen, 4000), evidencia: textoLargo(r.evidencia, 2000) };
    }
    if (!m.cerrado) avisar('team_done', { id: m.id, ok: m.resultado.ok, resumen: m.resultado.resumen, evidencia: m.resultado.evidencia });
    m.cerrado = true;
    m.pideAtencion = false;
    avisar('team_member', ficha(m));
    /* Un mensaje que llegó DURANTE su ÚLTIMA llamada se quedó en la bandeja:
       `despertarSiParado` lo descartó porque aún estaba corriendo. Aquí ya está parado, así
       que se le entrega ya como subtarea nueva; sin esto, `team_send` prometía entregarlo «en
       su siguiente paso y, si ya había terminado, despertándolo» y el mensaje no se consumía
       nunca. Se comprueba ANTES de despertarEsperas: si se le despierta, no está «parado» y
       una espera en vuelo no puede darlo por terminado. */
    if (despertarSiParado(m)) return;
    despertarEsperas();
    revisar();
  }

  const equipo = {
    lider,
    limiteMiembros: lim,
    presupuestoUsd: pres,
    miembros,
    tablero,

    /** Levanta un compañero y lo pone a trabajar. Devuelve el id ENSEGUIDA (no espera). */
    levantar(spec, { tarea, expect } = {}) {
      if (terminado) return { ok: false, error: 'el equipo de este turno ya está cerrado; no se levantan más compañeros.' };
      revisar(); // antes de traer más gente, se mira el tope de gasto del equipo
      if (corte) return { ok: false, error: `el equipo está parado (${corte}); no se levantan más compañeros en este turno.` };
      const s = specDe(spec);
      if (!s) return { ok: false, error: 'falta el especialista: pasa el id del registro (research, coding, review…).' };
      const vivos = [...miembros.values()].filter((m) => !m.cerrado).length;
      if (vivos >= lim) {
        return {
          ok: false,
          error: `el equipo ya tiene ${vivos} compañeros vivos (el tope de ${lim}): espera a que terminen con team_wait o reparte tú el trabajo que queda.`,
        };
      }
      const task = textoLargo(tarea, 4000);
      if (!task) return { ok: false, error: 'falta la subtarea: dile al compañero qué tiene que hacer (task).' };
      const id = 'm' + ++seq;
      const m = {
        id,
        spec: s,
        agent: null,
        estado: 'trabajando',
        tarea: task,
        expect: textoLargo(expect, 1000),
        bandeja: [],
        resultado: null,
        arbol: null,
        mensajesRecibidos: 0,
        pideAtencion: false,
        motivoAtencion: null,
        cerrado: false,
        cortado: false,
        corriendo: false,
        promesa: null,
      };
      miembros.set(id, m);
      try {
        if (typeof agentFactory !== 'function') throw new Error('falta agentFactory');
        m.agent = agentFactory({
          miembro: ficha(m),
          buzon: () => equipo.bandejaDe(id),
          atencion: (motivo) => equipo.pedirAtencion(id, motivo),
          reanudar: () => equipo.reanudar(id),
          equipo,
        });
      } catch (e) {
        miembros.delete(id);
        return { ok: false, error: `no pude crear el compañero ${s.name}: ${(e && e.message) || e}` };
      }
      if (!iniciado) {
        iniciado = true;
        avisar('team_start', { miembros: [ficha(m)], lider: lider ? lider.sessionId : undefined });
      }
      avisar('team_member', ficha(m));
      arrancar(m, task, { motivo: 'encargo' });
      return { ok: true, id, estado: estadoDe(m) };
    },

    /** Entrega un mensaje al buzón del destinatario ('m2', 'lider' o 'todos'). Si el
        destinatario está parado, se le despierta con el mensaje como nueva subtarea. */
    enviar(de, para, texto2) {
      const texto3 = textoLargo(texto2, MAX_TEXTO);
      const origen = String(de || 'lider').trim();
      const destino = String(para || '').trim();
      if (!texto3) return { ok: false, error: 'el mensaje está vacío: escribe qué quieres decir (text).' };
      if (origen !== 'lider' && !miembros.has(origen)) return { ok: false, error: `«${origen}» no es un compañero de este equipo.` };
      if (!destino) return { ok: false, error: 'falta el destinatario (to): un id (m1, m2…), «lider» o «todos».' };
      const destinos = destino === 'todos' ? ['lider', ...miembros.keys()].filter((id) => id !== origen) : [destino];
      const malo = destinos.find((id) => id !== 'lider' && !miembros.has(id));
      if (malo) {
        const vivos = [...miembros.keys()];
        return {
          ok: false,
          error: `no existe ningún compañero «${malo}» en este equipo${vivos.length ? ` (vivos: ${vivos.join(', ')})` : ''}: usa un id vivo, «lider» o «todos».`,
        };
      }
      if (mensajes >= MAX_MENSAJES_EQUIPO) {
        return {
          ok: false,
          error: `tope de mensajes del equipo (${MAX_MENSAJES_EQUIPO}) alcanzado: deja de hablar y termina el trabajo con lo que tienes.`,
        };
      }
      for (const id of destinos) {
        if (id === 'lider') continue;
        const m = miembros.get(id);
        if (m.mensajesRecibidos >= MAX_MENSAJES_MIEMBRO) {
          return {
            ok: false,
            error: `«${id}» ya recibió ${MAX_MENSAJES_MIEMBRO} mensajes (el tope): no le mandes más, escribe tú el resultado con lo que haya.`,
          };
        }
      }
      const msg = { de: origen, para: destino, texto: texto3, ts: Date.now() };
      mensajes++;
      for (const id of destinos) {
        if (id === 'lider') {
          bandejaLider.push({ ...msg, para: 'lider' });
          avisosLider++;
        } else {
          const m = miembros.get(id);
          m.bandeja.push({ ...msg, para: id });
          m.mensajesRecibidos++;
        }
      }
      avisar('team_message', msg);
      for (const id of destinos) if (id !== 'lider') despertarSiParado(miembros.get(id));
      despertarEsperas();
      return {
        ok: true,
        para: destino,
        entregado: destinos.map((id) => ({ id, estado: id === 'lider' ? 'lider' : estadoDe(miembros.get(id)) })),
      };
    },

    /** Mensajes pendientes del destinatario. VACÍA la bandeja: quien lee, consume (así el
        mismo mensaje no se le entrega dos veces al modelo). */
    bandejaDe(id) {
      const quien = String(id || '').trim();
      if (quien === 'lider') return bandejaLider.splice(0);
      const m = miembros.get(quien);
      return m ? m.bandeja.splice(0) : [];
    },

    /** 'trabajando' | 'esperando' | 'terminado' | 'fallo' (null si no existe). */
    estado(id) {
      const m = miembros.get(String(id || '').trim());
      return m ? estadoDe(m) : null;
    },

    /** Espera a que los compañeros terminen o pidan algo, sin bloquear a los demás.
        `signal` (opcional) es la señal del turno: al abortarse (Detener) la espera se
        suelta con motivo 'abortado' en vez de quedarse hasta el tope — sin esto, el botón
        Detener no tenía efecto sobre un `team_wait` en vuelo y la interfaz seguía «ocupada»
        hasta 30 s, o hasta los 5 min si el modelo pidió `timeoutMs` grande. */
    esperar(ids, timeoutMs, signal) {
      revisar();
      const lista =
        ids === undefined || ids === null
          ? [...miembros.keys()]
          : (Array.isArray(ids) ? ids : [ids]).map((x) => String(x || '').trim()).filter(Boolean);
      const malo = lista.find((id) => !miembros.has(id));
      if (malo) return Promise.resolve({ ok: false, error: `no existe ningún compañero «${malo}» en este equipo.` });
      const pedido = Number(timeoutMs);
      const tope = Number.isFinite(pedido) && pedido > 0 ? Math.min(pedido, ESPERA_MAX_MS) : ESPERA_DEFECTO_MS;
      const base = avisosLider;
      const yaEsta = motivoDeEspera(lista, base);
      if (yaEsta) return Promise.resolve(resumenEspera(lista, yaEsta));
      return new Promise((resolve) => {
        let hecho = false;
        let reloj = null;
        const alAbortar = () => w.fin('abortado');
        const w = {
          ids: lista,
          motivo: () => motivoDeEspera(lista, base),
          fin: (motivo) => {
            if (hecho) return;
            hecho = true;
            clearTimeout(reloj);
            if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', alAbortar);
            esperas.delete(w);
            resolve(resumenEspera(lista, motivo));
          },
        };
        /* El reloj NO se suelta del bucle de eventos: mientras alguien espera, la espera
           tiene que poder cumplirse hasta el final (un timeout «unref» se quedaría sin
           disparar si no hubiera nada más vivo, y el que esperaba no se enteraría nunca). */
        reloj = setTimeout(() => w.fin('timeout'), tope);
        esperas.add(w);
        if (signal) {
          if (signal.aborted) w.fin('abortado');
          else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', alAbortar, { once: true });
        }
      });
    },

    /** Lee el tablero (sin argumentos) o apunta/actualiza un ítem. */
    tableroApunta({ quien, que, estado, nota } = {}) {
      revisar();
      const deQuien = texto(quien, 60) || 'lider';
      const queTexto = texto(que, MAX_ITEM);
      const estadoItem = texto(estado, 40);
      const notaTexto = texto(nota, MAX_NOTA);
      if (!queTexto && !estadoItem && !notaTexto) return { ok: true, tablero: tablero.map((i) => ({ ...i })) };
      let item = queTexto ? [...tablero].reverse().find((i) => i.quien === deQuien && i.que === queTexto) : null;
      if (!item) {
        if (tablero.length >= MAX_TABLERO) {
          return { ok: false, error: `el tablero ya tiene ${MAX_TABLERO} ítems: actualiza uno que exista en vez de añadir más.` };
        }
        item = {
          id: 'b' + ++seqTablero,
          quien: deQuien,
          que: queTexto || estadoItem || notaTexto.slice(0, 80),
          estado: estadoItem || 'en_curso',
          nota: notaTexto,
          ts: Date.now(),
        };
        tablero.push(item);
      } else {
        if (estadoItem) item.estado = estadoItem;
        if (notaTexto) item.nota = notaTexto;
        item.ts = Date.now();
      }
      avisar('team_board', { items: tablero.map((i) => ({ quien: i.quien, que: i.que, estado: i.estado, nota: i.nota })) });
      return { ok: true, item: { ...item } };
    },

    /** Cierra el encargo de un compañero con lo que ha hecho y su evidencia. */
    cerrar(id, { resumen, evidencia } = {}) {
      const m = miembros.get(String(id || '').trim());
      if (!m) return { ok: false, error: `no existe ningún compañero «${id}».` };
      const res = textoLargo(resumen, 4000);
      const ev = textoLargo(evidencia, 2000);
      m.resultado = { ok: !m.cortado, resumen: res, evidencia: ev };
      if (!m.cortado) m.estado = 'terminado';
      m.cerrado = true;
      m.pideAtencion = false;
      avisar('team_done', { id: m.id, ok: m.resultado.ok, resumen: res, evidencia: ev });
      avisar('team_member', ficha(m));
      despertarEsperas();
      revisar();
      return { ok: true, id: m.id, estado: estadoDe(m) };
    },

    /** Lo gastado por los compañeros (el líder no entra). */
    gasto,

    /** Un compañero pide atención (permiso pendiente o pregunta): su estado pasa a
        «esperando» y quien esté en `esperar` se entera sin bloquear a los demás. */
    pedirAtencion(id, motivo) {
      const m = miembros.get(String(id || '').trim());
      if (!m || m.estado === 'terminado' || m.estado === 'fallo') return false;
      m.pideAtencion = true;
      m.motivoAtencion = texto(motivo, 200) || 'pide algo';
      avisar('team_member', ficha(m));
      despertarEsperas();
      return true;
    },

    /** Lo contrario: ya no pide nada (su permiso se resolvió y sigue trabajando). */
    reanudar(id) {
      const m = miembros.get(String(id || '').trim());
      if (!m) return false;
      if (!m.pideAtencion) return true;
      m.pideAtencion = false;
      m.motivoAtencion = null;
      avisar('team_member', ficha(m));
      return true;
    },

    /** Comprobación del tope de presupuesto (la llama agent.js desde el bucle del
        compañero y la llaman aquí todas las entradas públicas). */
    revisar,

    /** Motivo por el que el equipo se paró, o null. */
    motivoCorte: () => corte,

    /** Cierra el equipo del turno: el evento `team_end` con el gasto real. Para a los
        compañeros que sigan vivos (el turno del líder terminó y ya nadie espera). */
    terminar({ ok = true, resumen = '' } = {}) {
      if (terminado) return { ok: false, error: 'el equipo ya estaba cerrado.' };
      terminado = true;
      /* Un turno en modo EQUIPO que no llegó a levantar a nadie no tiene equipo: no hay
         `team_start` que cerrar y un `team_end` suelto abriría una tarjeta vacía. */
      if (!iniciado) return { ok: false, error: 'el equipo no llegó a empezar.' };
      for (const m of miembros.values()) {
        if (!m.corriendo) continue;
        /* Un compañero que está esperando al USUARIO (un permiso) no se para al cerrar el
           turno del líder: su vuelta sigue viva y la respuesta que espera es del usuario, no
           del líder. Al pararlo aquí, el permiso se quedaba sin nadie que lo esperara —el
           usuario podía autorizarlo y no pasaba nada— y su insignia decía «1 permiso»
           para siempre. Se para cuando el turno muere de verdad (Detener, guardarraíl, una
           excepción): ahí ya no hay nada que autorizar. */
        if (ok && m.pideAtencion) continue;
        try {
          if (m.agent && typeof m.agent.stop === 'function') m.agent.stop();
        } catch {}
        m.corriendo = false;
        if (!m.cortado) m.estado = 'fallo';
        avisar('team_member', ficha(m));
      }
      /* El estado REAL de cada compañero viaja en el cierre: quien sigue esperando al usuario
         no puede quedar «interrumpido» en la interfaz sólo porque el líder acabara su parte. */
      avisar('team_end', {
        ok: !!ok && !corte,
        resumen: textoLargo(resumen, 4000),
        gasto: gasto(),
        miembros: [...miembros.values()].map(ficha),
      });
      despertarEsperas();
      return { ok: true, gasto: gasto() };
    },
  };

  /** A un compañero parado que acaba de recibir algo se le despierta con ese mensaje como
      nueva subtarea: mismo Agent, mismo árbol, mismo gasto. */
  function despertarSiParado(m) {
    if (!m || m.corriendo || terminado || corte) return false;
    if (!m.bandeja.length) return false;
    const nuevo = m.bandeja
      .splice(0)
      .map((x) => x.texto)
      .join('\n');
    m.tarea = textoLargo(nuevo, MAX_TEXTO * 2);
    m.cerrado = false;
    m.resultado = null;
    // el aviso que despierta tiene que decir «trabajando»: si no, la interfaz seguía
    // enseñando el «terminado» de la vuelta anterior mientras ya estaba en marcha otra vez
    m.estado = 'trabajando';
    avisar('team_member', ficha(m));
    arrancar(m, m.tarea, { motivo: 'buzon' });
    return true;
  }

  return equipo;
}

module.exports = { crearEquipo, LIMITE_MIEMBROS, MAX_MENSAJES_MIEMBRO, MAX_MENSAJES_EQUIPO, __test: { specDe } };
