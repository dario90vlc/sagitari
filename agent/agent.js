'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { allToolDefs } = require('./tools');
const cambios = require('./cambios');
const proyecto = require('./proyecto');
const repomap = require('./repomap');
const { executeTool, ejecutarComandoVerificacion, ejecutarHook } = require('./executors');
const diagnosticos = require('./diagnosticos');   // v2.5: hallazgos del proyecto y comprobación de cierre
const contexto = require('./contexto');           // v2.5: presupuesto de contexto (y qué hacer cuando no cabe)
const hooks = require('./hooks');                 // v2.5: tus comandos enganchados al agente
const instrucciones = require('./instrucciones'); // v2.5: SAGITARI.md / AGENTS.md del proyecto
const skills = require('./skills');
const memory = require('./memory');
const checkpoints = require('./checkpoints');
const { Guardrails } = require('./guardrails');
const runlog = require('./runlog');
const subagents = require('./subagents');
const arboles = require('./arboles');       // v3.0: árboles de trabajo por subagente
const models = require('./models');
const habits = require('./habits');
const opencode = require('./opencode');   // identificación de sesión (OpenCode Go/Zen)
const { recursos, paraHerramienta } = require('./recursos');   // v2.5: bloqueo por recurso (navegador, disco, terminal)
const protocols = require('./protocols'); // multi-formato: OpenAI / Anthropic / Responses

function systemPrompt() {
  const home = os.homedir();
  return `Eres SAGITARI, un agente de IA con control total del PC con Windows del usuario. Estás integrado en un panel de control holográfico en la pantalla del usuario.

IDENTIDAD
- Personalidad: capaz, eficiente y con carisma sutil (como un mayordomo de élite).
- Idioma: responde SIEMPRE en el idioma del usuario (por defecto español).

CÓMO ESCRIBES (importa tanto como lo que haces)
- Tu respuesta final es lo ÚNICO que el usuario lee de todo tu trabajo: la lista de herramientas no cuenta la historia por ti. Escribe para alguien que no la ha visto.
- Prohibido el telegrama y la taquigrafía. Nada de frases nominales encadenadas, ni de abreviaturas inventadas para ahorrar caracteres: «divisor corregido de /2|9 a /7|9» no informa a nadie; se escribe la cifra o el concepto COMPLETO, en una frase con sujeto y verbo. Igual con «T+28s», «px=l/7», «OK/FAIL» y demás jerga: si un dato necesita una explicación, se da.
- Cuenta el trabajo así, sin recitar herramienta por herramienta:
  1. Qué has hecho, en una o dos frases.
  2. Qué encontraste o qué cambió, con los datos concretos que importan (archivos, cifras, nombres).
  3. Cómo lo comprobaste (si lo comprobaste).
  4. Qué queda pendiente y por qué, si queda algo.
- Si era una pregunta, la primera frase es la respuesta; el detalle va después.
- Si NO pudiste hacer algo, dilo en la primera frase y explica qué falta. Nunca cierres con un «sin hallazgos», un «revisado» o un OK a secas: eso no es una respuesta.
- Un turno cortado a medias se cuenta como tal: qué alcanzaste, dónde quedó y qué harías después.
- Longitud: la que haga falta para ser claro, y ni una más. Una tarea simple se cierra en dos frases; un trabajo con varios hallazgos, con apartados cortos y viñetas.

CAPACIDADES
- Controlas el PC: terminal, archivos, aplicaciones, navegador real (Chrome/Edge vía DevTools), portapapeles, multimedia, notificaciones y capturas de pantalla.
- Home del usuario: ${home}. Escritorio: ${home}\\\\Desktop.
- No pidas permiso para cosas triviales; actúa. Para acciones potencialmente destructivas (borrar datos, cerrar sesión, compras), confirma antes.

PROTOCOLO DE TRABAJO (síguelo en tareas con pasos; las conversacionales no lo necesitan)
UNDERSTAND → PLAN → EXECUTE → OBSERVE → VERIFY → (RECOVER) → DONE
- UNDERSTAND: asegúrate de entender el objetivo real (pregunta solo si es ambiguo de verdad).
- PLAN: en tareas largas, presenta un plan numerado breve antes de ejecutar (o usa el modo Plan).
- EXECUTE: usa las herramientas libremente y en cadena hasta completar la petición.
- OBSERVE: tras cada herramienta, evalúa el resultado real antes del siguiente paso.
- VERIFY: antes de dar la tarea por terminada, COMPRUEBA que el objetivo se consiguió de verdad (lee el archivo creado, verifica la salida del comando, revisa el estado de la página…). NO des por hecho el éxito solo porque una herramienta devolvió OK.
- RECOVER: si la verificación falla, corrige el problema y reintenta con otro enfoque antes de rendirte; si no puedes completarlo, explica exactamente qué falta.
- DONE: cierra con el resumen de CÓMO ESCRIBES (qué hiciste, qué cambió y cómo lo comprobaste). Corto si el trabajo fue corto, pero nunca un telegrama.

REGLAS DE HERRAMIENTAS
- Para navegar/controlar webs usa browser_control. REGLAS DE ORO:
  * Una sola ventana con pestañas: launch abre (o REUTILIZA si ya está abierto) el navegador con la url; nunca relances si ya está abierto — usa navigate, new_tab o select_tab.
  * Gestiona pestañas: tabs lista las abiertas (con la activa marcada), new_tab abre y selecciona, select_tab cambia (por número o texto del título), close_tab cierra.
  * Para hacer clic, prefiere text (texto visible del botón/enlace) antes que selector CSS. Si dudas de qué hay en pantalla: action=screenshot (mira la imagen) o action=content (lee el texto).
  * type escribe en un campo (clear=true vacía antes; submit=true pulsa Enter, ideal para búsquedas). navigate espera a que la página cargue; usa wait si un elemento tarda en aparecer.
  * Cada acción devuelve OK/Error con detalle: léelo y decide el siguiente paso; si un clic falla, haz screenshot antes de reintentar a ciegas.
- Con run_command usa sintaxis de cmd.exe de Windows. No uses comandos interactivos.
- FICHEROS: lee antes de escribir. Para modificar un archivo existente usa edit_file (reemplazo exacto de un fragmento); reserva write_file para crear archivos nuevos o reescribir el archivo entero. En archivos largos, léelos por tramos con offset/limit en vez de volcarlos completos.

${subagents.DELEGATION_GUIDE}

SKILLS DISPONIBLES (instrucciones especializadas del usuario, cargables)
Antes de una tarea donde una skill aplique, llama a use_skill con su nombre: te devolverá instrucciones expertas que debes seguir. No la cites al usuario; aplícala. Si la tarea se repite y ya conoces su contenido, no la recargues.
${skills.promptIndexSync('orchestrator')}

FORMATO
- Tus respuestas se muestran en un chat con soporte markdown ligero (negrita, listas, código). Sé claro y ordenado.
- Con dos o más cosas que contar, usa viñetas o apartados con nombre corto; con una sola, prosa. Nada de listas de una palabra por línea.
- NADA de emojis ni caritas en el texto (tampoco en títulos ni listas): tono profesional y sobrio. La interfaz ya pone sus propios iconos, así que el adorno sobra.`;
}

const MODE_PROFILES = {
  think: { temperature: 0.7, maxSteps: 20, planFirst: false, note: 'Piensas antes de actuar: razona paso a paso en tu respuesta final, explora alternativas, sé meticuloso.' },
  plan:  { temperature: 0.35, maxSteps: 20, planFirst: true,  note: 'PRIMERO presenta un PLAN numerado breve (3-6 pasos) y luego ejecútalo con herramientas, paso a paso.' },
  act:   { temperature: 0.25, maxSteps: 12, planFirst: false, note: 'Actúa directo y eficiente: no anuncies cada paso, ejecuta y reporta. El informe final se escribe igual de completo (ver CÓMO ESCRIBES).' }
};

/* ---------- integridad del historial ---------- */

/* Tope de mensajes que viajan al modelo (el historial completo vive en la UI). */
const MAX_HISTORY = 40;

/**
 * Recorta el historial sin partir un intercambio de herramientas: si el corte
 * dejara un mensaje 'tool' al principio, quedaría huérfano (sin su assistant) y
 * el proveedor rechazaría la petición.
 */
function trimHistory(history, max = MAX_HISTORY) {
  if (history.length <= max) return history;
  let start = history.length - max;
  while (start < history.length && history[start].role === 'tool') start++;
  return history.slice(start);
}

/**
 * Convierte el historial en mensajes válidos para la API. La API exige que cada
 * `tool_call` de un assistant tenga su respuesta `tool` con el mismo id; un corte
 * a mitad de un intercambio (error, Detener, recorte) dejaría el historial
 * inválido y el proveedor devolvería 400 en el siguiente turno. Aquí se
 * descartan los pares incompletos en vez de enviarlos.
 */
function payloadMessages(history) {
  const out = [];
  const pending = new Set();   // tool_call_id esperando su respuesta
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    if (h.role === 'tool') {
      if (!pending.has(h.tool_call_id)) continue;   // huérfano: se descarta
      pending.delete(h.tool_call_id);
      out.push({ role: 'tool', tool_call_id: h.tool_call_id, ...(h.name ? { name: h.name } : {}), content: h.content });
      continue;
    }
    if (h.role === 'assistant' && h.tool_calls && h.tool_calls.length) {
      const answered = new Set();
      for (let j = i + 1; j < history.length && history[j].role === 'tool'; j++) answered.add(history[j].tool_call_id);
      const calls = h.tool_calls.filter(tc => answered.has(tc.id));
      if (!calls.length) { if (h.content) out.push({ role: 'assistant', content: h.content }); continue; }
      const msg = { role: 'assistant', content: h.content || '', tool_calls: calls };
      if (!msg.content) delete msg.content;
      out.push(msg);
      for (const tc of calls) pending.add(tc.id);
      continue;
    }
    out.push({ role: h.role, content: h.content });
  }
  return out;
}

/* Tope de la narración guardada por turno (15k caracteres): un turno de 40
   herramientas narra mucho y la conversación se relee entera en cada arranque.
   Se recorta por el MEDIO (el principio dice qué se pidió, el final qué quedó),
   nunca por el final, que es lo que el usuario relee. Lógica pura. */
const MAX_TRANSCRIPT = 15000;
function recortarTranscripcion(t) {
  const s = String(t || '');
  if (s.length <= MAX_TRANSCRIPT) return s;
  return s.slice(0, 4000) + '\n\n[…se omite parte de la narración intermedia…]\n\n' + s.slice(-11000);
}

/* Id de confirmación irrepetible: dos tarjetas en el mismo milisegundo no deben
   poder confundirse al resolverlas desde la UI. */
let confirmSeq = 0;
function newConfirmId(prefix) {
  return prefix + Date.now().toString(36) + '-' + (++confirmSeq).toString(36) + Math.random().toString(36).slice(2, 5);
}

class Agent {
  /* v2.5: cuántas herramientas del mismo mensaje corren a la vez (las que pueden:
     el bloqueo por recurso decide). Es un tope del bucle, no del modelo. */
  static MAX_PARALELO = 4;
  static _callSeq = 0;

  constructor(opts) {
    this.fetchFn = opts.fetchFn || fetch;
    this.emit = opts.emit;               // (event) => void  (to renderer)
    this.screenshotFn = opts.screenshotFn;
    this.browser = opts.browser;
    this.mcp = opts.mcp || null;         // gestor de servidores MCP (Tools del usuario)
    this.history = [];                   // [{role, content, tool_calls?, tool_call_id?, name?, images?}]
    this.busy = false;
    this.abort = null;
    this.stopRequested = false;          // el usuario pulsó Detener en esta conversación
    this.pauseRequested = false;         // pausa solicitada (checkpoint + stop limpio)
    this.runningTool = null;             // { stop() } de la herramienta en ejecución (la última: compatibilidad)
    /* v2.5: varias herramientas del MISMO mensaje pueden correr a la vez (el modelo
       pide tres lecturas o dos delegaciones de golpe). Aquí van todas las killables
       para que Detener mate las que estén en vuelo, no solo una. */
    this.runningTools = new Map();       // callId -> { stop() }
    this.subagents = new Set();          // subagentes en curso (varios, si van en paralelo)
    this._currentRequest = '';           // petición del usuario del turno (criterio de reserva)
    this._plegado = [];                  // intercambios antiguos plegados (resumen rodante)
    this._transcript = [];               // narración del turno (los subagentes no pasan por el init de chat)
    this._resumen = '';
    this.toolsFired = new Map();         // name -> {count, lastAt}
    // v2.1: memoria del run para orquestar (se reinicia en cada _run)
    this._delegations = [];              // [{agent, task, status, result}] subtareas ya hechas por el equipo
    this._verified = false;              // alguna verificación delegada dio OK
    this._writes = 0;                    // archivos escritos/editados en este run
    this._cmds = 0;                      // comandos ejecutados con éxito
    this._toolSeq = 0;                   // orden de las herramientas del run
    this._lastWriteSeq = -1;
    this._lastCmdSeq = -1;
    this._gateUsed = false;              // la verificación de cierre solo puede pedirse una vez
    this._reviewed = false;              // la revisión del cambio también, una por turno
    this._cierreAuto = false;            // v2.5: la comprobación del proyecto (pruebas) ya se hizo
    this._avisadoCtx = false;            // v2.5: ya se avisó de que el contexto va apretado
    this._intentosArreglo = 0;           // v2.5: vueltas de «falló → arréglalo → repito» (0 y no undefined:
                                         // `undefined++` es NaN, y `NaN >= tope` siempre es falso)
    this._lastCmd = '';                  // v2.5: última orden del modelo (para no repetir sus pruebas)
    this._skillsLoaded = new Set();      // ids de skills ya cargadas en este turno (su cuerpo no se repite)
    this.guardrails = new Guardrails(opts.guardrailsPolicy || {});   // límites + permisos
    this._llmTimeoutMs = null;           // ms sin datos del proveedor antes de cortar (null = default)
    this.pendingConfirm = null;          // {resolve, call} mientras el usuario decide
    this.currentRun = null;              // checkpoint de la tarea en curso (checkpoints.js)
    this.meta = { model: null, tokensIn: 0, tokensOut: 0, llmCalls: 0, toolCalls: 0, startedAt: null, lastLatencyMs: null, lastError: null, costUsd: 0, paused: false };
    // ID de sesión que viaja en x-opencode-session (OpenCode Go lo exige): estable
    // por conversación para que el proveedor enrute y cachee bien el prompt.
    this.sessionId = opencode.newSessionId();
  }

  setPolicy(policy) { this.guardrails.setPolicy(policy); }

  /** Ata la identidad de sesión a una conversación (misma conv → misma sesión). */
  useSession(convId) {
    const nuevo = opencode.sessionFor(convId);
    // al cambiar de conversación el resumen plegado de la anterior no vale para nada
    // (y contarlo sería peor que no tenerlo)
    if (nuevo !== this.sessionId) { this._resumen = ''; this._plegado = []; }
    this.sessionId = nuevo;
  }

  /* ============ v2.2: resumen rodante del contexto ============
     El historial que viaja al modelo está acotado (MAX_HISTORY) para no crecer sin fin,
     pero al recortar se perdía el principio de la conversación EN SECO: una decisión
     tomada hace veinte turnos desaparecía sin avisar. Ahora lo recortado se pliega en un
     resumen compacto (una línea por intercambio: qué pidió y en qué quedó) que viaja como
     primer mensaje de contexto, así que el hilo largo mantiene su memoria sin cargar el
     prompt con los turnos antiguos enteros.

     Es EXTRACTIVO a propósito: no cuesta una llamada al modelo, no añade latencia al
     turno y no falla. Un resumen redactado por el modelo es una mejora posible, pero no
     puede ser el único camino: si falla, la conversación se queda sin memoria. */
  static MAX_PLEGADO = 12;                // intercambios que caben en el resumen
  static MAX_PLEGADO_CHARS = 2600;        // tope duro del bloque
  static MAX_IMAGENES = 3;                // imágenes que siguen viajando en el turno

  /** Pliega los mensajes que se van a descartar en el resumen del turno. */
  _plegarResumen(msgs) {
    const texto = (c) => typeof c === 'string' ? c : (Array.isArray(c) ? ((c.find(x => x.type === 'text') || {}).text || '') : '');
    const limpio = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
    const lineas = [];
    let actual = null;
    for (const m of msgs) {
      if (m.role === 'user') {
        if (actual) lineas.push(actual);
        actual = { pide: limpio(texto(m.content), 220), hizo: '' };
      } else if (m.role === 'assistant' && actual && !m.tool_calls) {
        actual.hizo = limpio(texto(m.content), 260);   // la conclusión del turno
      }
    }
    if (actual && actual.pide) lineas.push(actual);
    this._plegado = (this._plegado || []).concat(lineas).slice(-Agent.MAX_PLEGADO);
    this._resumen = this._renderResumen();
  }

  _renderResumen() {
    const l = (this._plegado || []).filter(e => e && e.pide);
    if (!l.length) return '';
    const cab = 'RESUMEN DE LA CONVERSACIÓN (turnos antiguos que ya no viajan completos; es CONTEXTO: no lo repitas ni lo cuentes como si acabara de pasar):';
    const cuerpo = l.map(e => `- pidió: ${e.pide}${e.hizo ? ` → quedó en: ${e.hizo}` : ''}`).join('\n');
    const total = cab + '\n' + cuerpo;
    return total.length > Agent.MAX_PLEGADO_CHARS ? total.slice(0, Agent.MAX_PLEGADO_CHARS) + '…' : total;
  }

  /** Criterio de éxito de reserva: la petición original del usuario. */
  _expectDeReserva() {
    const req = String(this._currentRequest || '').trim();
    if (!req) return '';
    return `(de reserva: el orquestador no lo precisó) comprueba que lo que entregues responde de verdad a la petición original del usuario: «${req.slice(0, 300)}»`;
  }

  /** Respuesta del usuario a una tarjeta de confirmación (toolbar del chat). */
  resolveConfirm(id, approved) {
    const pc = this.pendingConfirm;
    if (!pc || pc.id !== id) return false;
    this.pendingConfirm = null;
    pc.resolve(!!approved);
    return true;
  }

  /**
   * Espera la decisión del usuario para una confirmación. Se libera sola si la
   * ejecución se aborta: sin esto, Detener (o cancelar una tarea en segundo
   * plano) dejaba la promesa esperando para siempre y el agente colgado.
   */
  _awaitConfirm(id, signal) {
    // el reloj de maxDurationMs se para aquí: esperar a que el usuario decida
    // no es tiempo de ejecución (antes, tardar en responder mataba la tarea)
    this.guardrails.pauseClock();
    return new Promise((resolve) => {
      let settled = false;
      const onAbort = () => finish(false);
      const finish = (v) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (this.pendingConfirm && this.pendingConfirm.id === id) this.pendingConfirm = null;
        this.guardrails.resumeClock();
        resolve(v);
      };
      this.pendingConfirm = { id, resolve: finish };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  getMeta() { return { ...this.meta, busy: this.busy }; }

  isBusy() { return this.busy; }
  getToolsFired() {
    return [...this.toolsFired.entries()].map(([name, v]) => ({ name, count: v.count, lastAt: v.lastAt }));
  }

  activeConfig(settings) {
    return settings.active;
  }

  /* ============ v1.2: pausa / reanudación / recuperación de tareas ============ */

  /** Pausa la tarea en curso: marca el flag y aborta el trabajo en vuelo; el bucle
      de _run (o el catch de chat) detecta pauseRequested, guarda el checkpoint y emite 'paused'. */
  pause() {
    if (!this.busy) return { ok: false, error: 'No hay tarea en curso.' };
    // Un turno conversacional no genera checkpoint: no hay nada que reanudar,
    // pero el botón debe responder — lo tratamos como una parada limpia.
    if (!this.currentRun) { this.stop(); return { ok: true, note: 'sin tarea guardable: detenido' }; }
    this.pauseRequested = true;
    this.emit({ type: 'status', text: 'Pausando tarea — guardando checkpoint…' });
    if (this.abort) this.abort.abort();
    this._killRunning();
    return { ok: true };
  }  /** (v1.3) La reanudación vive en el TaskManager: agent/tasks.js orquesta
      la cola, la concurrencia y agentes dedicados por tarea. */
  get currentRunId() { return this.currentRun ? this.currentRun.runId : null; }


  /* ============ bucle principal ============ */

  async chat(userText, settings, imageDataUrl, opts = {}) {
    if (this.busy && !opts.background) { this.emit({ type: 'error', message: 'SAGITARI está ocupado terminando la tarea anterior.' }); return; }
    this.busy = true;
    this.stopRequested = false;
    this.pauseRequested = false;
    this.meta.paused = false;
    // El modo y el límite de silencio viajan con la llamada: _run los consulta
    // en cada intento de modelo (y las rellamadas internas los conservan).
    this._mode = MODE_PROFILES[settings.settings?.mode] || MODE_PROFILES.act;
    this._llmTimeoutMs = Number(settings.settings?.llmTimeoutMs);
    if (!Number.isFinite(this._llmTimeoutMs) || this._llmTimeoutMs < 0) this._llmTimeoutMs = null;   // 0 = sin límite
    const controller = new AbortController();
    this.abort = controller;
    try {
      await this._run(userText, settings, imageDataUrl, controller.signal, opts);
    } catch (e) {
      if (this.stopRequested || e.name === 'AbortError') {
        // pausa solicitada: checkpoint del último paso completado antes de parar
        if (this.pauseRequested && this.currentRun && !this.currentRun.closed) {
          checkpoints.pause(this.currentRun);
          this.currentRun.closed = true;
          this.meta.paused = true;
          this.emit({ type: 'paused', runId: this.currentRun.runId, goal: this.currentRun.goal });
        }
        // parada solicitada: no es un error, la UI ya muestra lo generado
        this.emit({ type: 'stopped' });
      } else {
        this.emit({ type: 'error', message: 'Error: ' + e.message });
      }
    } finally {
      this.busy = false;
      this.abort = null;
      this.stopRequested = false;
      this.emit({ type: 'busy', busy: false });
    }
  }

  /**
   * Regenerar la última respuesta (botón «Regenerar» del chat).
   * Deja el historial justo ANTES del último turno del usuario —incluida su
   * pregunta— y lo vuelve a enviar, de modo que el modelo no ve su propia
   * respuesta anterior y no se limita a repetirla o disculparse por ella.
   * Si el mensaje llevaba una imagen, la conserva.
   */
  async retry(settings, opts = {}) {
    if (this.busy) { this.emit({ type: 'error', message: 'Espera a que termine la ejecución actual para regenerar.' }); return { ok: false }; }
    let idx = -1;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === 'user') { idx = i; break; }
    }
    if (idx < 0) {
      this.emit({ type: 'error', message: 'No hay ninguna petición que regenerar en esta conversación.' });
      return { ok: false };
    }
    const last = this.history[idx];
    const parts = Array.isArray(last.content) ? last.content : null;
    const text = parts ? ((parts.find(c => c.type === 'text') || {}).text || '') : last.content;
    // conserva TODAS las imágenes del turno, no solo la primera
    const images = parts ? parts.filter(c => c.type === 'image_url').map(c => (c.image_url || {}).url).filter(Boolean) : [];

    this.history = this.history.slice(0, idx);
    this.toolsFired.clear();
    // la tarea abierta se descarta: el reintento empieza de cero con su propio run
    if (this.currentRun && !this.currentRun.closed) {
      try { checkpoints.cancel(this.currentRun); } catch {}
    }
    this.currentRun = null;
    runlog.log({ agent: 'sagitari', event: 'retry', kept: this.history.length });
    await this.chat(text, settings, images[0] || undefined, { ...opts, attachments: images.slice(1).map(u => ({ kind: 'image', dataUrl: u })) });
    return { ok: true, text };
  }

  /** Mata lo que esté en vuelo: la herramienta actual y, si estamos delegando, el
      subagente. Su comando se registra en el SUBagente (registerKillable es suyo),
      así que sin esto el proceso sobrevivía a Detener hasta agotar su timeout. */
  _killRunning() {
    const killables = [this.runningTool, ...this.runningTools.values()];
    for (const k of killables) {
      if (k && typeof k.stop === 'function') { try { k.stop(); } catch {} }
    }
    this.runningTools.clear();
    for (const sub of this.subagents) { try { sub.stop(); } catch {} }
    this.subagents.clear();
    if (this.subagent) { try { this.subagent.stop(); } catch {} }
  }

  // Detener de verdad: aborta el fetch del modelo Y mata el comando/herramienta
  // en ejecución (terminal, navegador, etc.). Sin esto el botón solo toma efecto
  // cuando la herramienta actual terminara sola.
  stop() {
    this.stopRequested = true;
    // si el agente estaba esperando una confirmación del usuario, libérala:
    // si no, la ejecución se quedaría colgada en el await para siempre
    if (this.pendingConfirm) {
      const pc = this.pendingConfirm;
      this.pendingConfirm = null;
      try { pc.resolve(false); } catch {}
    }
    if (this.abort) this.abort.abort();
    this._killRunning();
  }

  async _run(userText, settings, imageDataUrl, signal, opts = {}) {
    const cfg = this.activeConfig(settings);
    if (!cfg || !cfg.baseUrl || !cfg.model) {
      this.emit({ type: 'error', message: 'Configura un proveedor y modelo en Ajustes antes de hablar con Sagitari.' });
      return;
    }
    const mode = this._mode || MODE_PROFILES[settings.settings?.mode] || MODE_PROFILES.act;
    this._mode = mode;
    this._llmTimeoutMs = Number(settings.settings?.llmTimeoutMs);
    if (!Number.isFinite(this._llmTimeoutMs) || this._llmTimeoutMs < 0) this._llmTimeoutMs = null;   // 0 = sin límite
    this.meta.model = cfg.model || this.meta.model;
    this.meta.startedAt = Date.now();
    this.meta.lastError = null;
    // el panel de métricas muestra el TURNO en curso, no el acumulado desde que
    // arrancó la app (antes sumaba todos los turnos y todas las conversaciones)
    this.meta.tokensIn = 0;
    this.meta.tokensOut = 0;
    this.meta.llmCalls = 0;
    this.meta.toolCalls = 0;
    this.meta.costUsd = 0;
    this.meta.lastLatencyMs = null;
    this.guardrails.model = cfg.model;
    this.guardrails.beginRun();
    const runStart = Date.now();
    const runId = 'r' + runStart.toString(36);
    // ---- estado de orquestación del turno: tablero de delegaciones y control
    // de la verificación antes de cerrar (ver _needsVerification) ----
    this._delegations = [];
    this._verified = false;
    this._writes = 0;
    this._cmds = 0;
    this._toolSeq = 0;
    this._lastWriteSeq = -1;
    this._lastCmdSeq = -1;
    this._gateUsed = false;
    this._reviewed = false;
    this._cierreAuto = false;            // v2.5: comprobación del proyecto una vez por turno
    this._intentosArreglo = 0;           // v2.5: vueltas de «falló → arréglalo → repito»
    this._avisadoCtx = false;            // v2.5: aviso de contexto apretado, una vez por turno
    this._lastCmd = '';
    this._transcript = [];               // narración del turno, ronda a ronda (va en assistant_done)
    this._skillsLoaded = new Set();

    // ---- checkpoint: persistir la tarea si es suficientemente larga ----
    let task = opts.task || null;
    const isResume = !!(task && opts.task);
    if (!task) {
      const existing = this.currentRun;
      if (existing && !existing.closed && Date.parse(existing.updatedAt) > Date.now() - 30 * 60000) {
        task = existing;                       // continúa la tarea abierta reciente
      } else if (userText && userText.length >= 12 && /\b(tarea|investiga|busca|crea|genera|prepara|automatiza|analiza|organiza|compara|informe|lista|descarga)\b/i.test(userText)) {
        task = checkpoints.newRun({ goal: userText.slice(0, 300), mode: settings.settings?.mode || 'act' });
        checkpoints.save(task);
      }
    }
    this.currentRun = task;
    if (task && !task.closed) {
      runlog.log({ agent: 'sagitari', task: task.runId, event: 'run_start', mode: settings.settings?.mode || 'act', model: cfg.model });
      checkpoints.record(task, { step: 'UNDERSTAND', tool: null, ok: true, summary: userText ? String(userText).slice(0, 160) : (isResume ? 'reanudada' : '') });
    } else {
      runlog.log({ agent: 'sagitari', task: runId, event: 'run_start', mode: settings.settings?.mode || 'act', model: cfg.model });
    }
    const taskId = task ? task.runId : runId;

    // ---- adjuntos: TODAS las imágenes van como partes multimodales (la primera
    // por imageDataUrl, las demás en opts.attachments); el texto de documentos ya
    // llega inline dentro de userText (lo compone el proceso principal) ----
    const extraImgs = (opts.attachments || []).filter(a => a && a.kind === 'image' && a.dataUrl).map(a => a.dataUrl);
    const imgUrls = [imageDataUrl, ...extraImgs].filter(Boolean);
    const content = imgUrls.length
      ? [{ type: 'text', text: userText || (imgUrls.length > 1 ? 'Analiza estas imágenes' : 'Analiza esta imagen') },
         ...imgUrls.map(u => ({ type: 'image_url', image_url: { url: u } }))]
      : userText;
    // conversación nueva (o historial vaciado al borrarla): el resumen anterior no vale
    if (!this.history.length) { this._resumen = ''; this._plegado = []; }
    cambios.olvidar((settings.settings && settings.settings.workspace) || path.join(os.homedir(), 'Desktop', 'Sagitari'));
    this._currentRequest = userText || '';
    this.history.push({ role: 'user', content });
    // lo que el recorte va a descartar se pliega antes de perderlo
    const sobra = this.history.length > MAX_HISTORY ? this.history.slice(0, this.history.length - MAX_HISTORY) : [];
    this.history = trimHistory(this.history);
    if (sobra.length) this._plegarResumen(sobra);

    const ws = (settings.settings && settings.settings.workspace) || path.join(os.homedir(), 'Desktop', 'Sagitari');
    // ---- memoria relevante: solo la que aplica a esta conversación ----
    const recent = this.history.slice(-6).map(h => (typeof h.content === 'string' ? h.content : (h.content?.find(c => c.type === 'text')?.text) || '')).join(' ');
    const memSens = Number(settings.settings?.memSensitivity ?? 2);
    const mems = memory.relevantMemories(recent, { limit: 30, minScore: [0, 0.3, 0.45, 0.65][Math.max(0, Math.min(3, memSens))] });
    const memBlock = mems.map(m => `- ${m.mem.text}`).join('\n') || '(vacía)';
    // v1.7: skills sugeridas automáticamente según la tarea
    let skillsHint = '';
    try {
      const suggested = await skills.suggestSkillsFor(recent);
      if (suggested.length) skillsHint = `\n- SKILLS SUGERIDAS para esta petición (llama a use_skill): ${suggested.map(s => s.name).join(', ')}.`;
    } catch {}
    // v2.0: perfil de hábitos observados del usuario
    const habitsBlock = habits.profile();
    /* A PARTIR DE AQUÍ, LO QUE CAMBIA EN CADA TURNO. El prompt se compone en dos bloques
       a propósito: primero TODO lo estable (identidad, reglas, guía de delegación, índice
       de skills, espacio de trabajo y modo) y al final lo volátil (memoria, hábitos, skills
       sugeridas). Los proveedores con caché de prompt reutilizan el prefijo idéntico: antes
       la memoria —que cambia en cada turno— iba casi al principio y rompía el caché desde
       la décima línea. */
    const dinamico = `\n\nMEMORIA del usuario — recuerdos relevantes para esta conversación (úsalos si aplican, no los cites):\n${memBlock}`
      + '\n- Para guardar algo importante que el usuario te pida recordar (preferencias, datos, decisiones), usa la herramienta remember.'
      + '\n- Si la petición es conversacional (saludo, pregunta), responde directamente sin herramientas.'
      + (skillsHint || '')
      + (habitsBlock ? `\n\nPERFIL DEL USUARIO (hábitos observados — adáptate a ellos):\n${habitsBlock}` : '');
    const sys = systemPrompt()
      + `\n\nESPACIO DE TRABAJO: ${ws}`
      + '\n- Es la carpeta por defecto para crear/modificar archivos; las rutas relativas resuelven aquí.'
      + '\n- Solo toques otras ubicaciones si el usuario lo pide explícitamente (ruta absoluta).'
      // v2.5: las reglas de la casa (SAGITARI.md / AGENTS.md). Van las primeras del bloque
      // estable y marcadas como obligatorias: el usuario manda sobre las costumbres del modelo.
      + (() => { try { const b = instrucciones.bloquePrompt(ws); return b ? '\n\n' + b : ''; } catch { return ''; } })()
      // v2.4: lo que se sabe del proyecto (comandos que EXISTEN) y su mapa si es grande.
      // Van en el bloque estable: cambian poco y así el prefijo sigue siendo cacheable.
      + (() => { try { const b = proyecto.bloquePrompt(ws); return b ? '\n\n' + b : ''; } catch { return ''; } })()
      // El mapa se recalcula cada 2 minutos o al escribir (executors.invalidar): recorrer
      // el árbol en cada turno sería un tirón en el hilo principal sin ganar nada.
      + (() => { try { const b = repomap.bloquePrompt(ws, { ttlMs: 120000 }); return b ? '\n\n' + b : ''; } catch { return ''; } })()
      + `\n\nMODO ACTUAL (${settings.settings?.mode || 'act'}): ${mode.note}`
      + (mode.planFirst ? '\nFormato del plan: una línea por paso, empieza tu respuesta con "PLAN:" y numera los pasos.' : '')
      + (settings.settings?.verifyGate === false
          ? '\n\nVERIFICACIÓN DE CIERRE: desactivada por el usuario (no hace falta que delegues en verification para cerrar).'
          : '\n\nVERIFICACIÓN DE CIERRE: activa. Si has modificado archivos o ejecutado cambios, antes de dar la tarea por terminada comprueba el RESULTADO (leer lo escrito, volver a ejecutarlo, o delegar en verification) y dilo en tu cierre.')
      + (settings.settings?.reviewGate === false
          ? '\n\nREVISIÓN DEL CAMBIO: desactivada por el usuario.'
          : '\n\nREVISIÓN DEL CAMBIO: activa. Tu código pasa por una revisión automática antes de cerrar; si te devuelve un hallazgo BLOQUEANTE, arréglalo en el mismo turno.')
      + dinamico;
    // el resumen de lo plegado abre el contexto (mensaje de usuario: los proveedores no
    // aceptan un segundo system a mitad de conversación)
    const messages = [
      { role: 'system', content: sys },
      ...(this._resumen ? [{ role: 'user', content: this._resumen }] : []),
      ...payloadMessages(this.history),
    ];

    // ---- v2.5: presupuesto de contexto ----
    /* Se mide lo que va a viajar (mensajes + las definiciones de herramientas, que en un
       agente son miles de tokens que nadie cuenta). Si no sobra sitio, se le dice al modelo
       qué hacer con eso —no solo que hay poco— porque es él quien puede contestar más corto
       y leer por tramos en vez de volver a pegar archivos enteros. */
    try {
      const ctx0 = contexto.presupuesto({ messages, tools: allToolDefs(), cfg });
      this._ctxUso = ctx0.uso;
      const nota = contexto.notaPresupuesto(ctx0);
      if (nota && messages[0]) messages[0] = { ...messages[0], content: String(messages[0].content) + '\n\n' + nota };
      runlog.log({ agent: 'sagitari', task: taskId, event: 'context', uso: Math.round(ctx0.uso * 100) / 100, tokens: ctx0.total, ventana: ctx0.ventana, estado: ctx0.estado });
    } catch {}

    // ---- v1.6: router + cadena de fallback ----
    const { category, chain } = this._chainFor(settings, userText, { hasImage: !!imageDataUrl });
    runlog.log({ agent: 'sagitari', task: taskId, event: 'model_route', category, chain: chain.map(c => c.model) });

    // el modo viaja con el arranque: la UI lo necesita para estampar el turno y
    // pintar el estado en vivo sin volver a preguntar por la configuración
    this.emit({ type: 'busy', busy: true, mode: (settings.settings && settings.settings.mode) || 'act', model: cfg.model });
    return await this._loop(messages, chain, signal, {
      settings,
      tools: null,                        // catálogo completo (los subagentes filtran)
      history: true,
      account: true,                      // hábitos, runlog, checkpoints y verificación de cierre
      task, taskId, runStart,
      onStatus: (text) => this.emit({ type: 'status', text }),
      visionAllowsImages: cfg.vision !== false,
      background: !!opts.background,
      // razonamiento visible: solo en el chat y solo si el usuario lo activó
      showThinking: settings.settings?.showThinking === true,
      // v2.5: cuántas herramientas del mismo mensaje van a la vez (Ajustes)
      parallelTools: Number(settings.settings?.parallelTools) || Agent.MAX_PARALELO,
    });
  }

  /**
   * Bucle ÚNICO del agente (v2.2). Antes había dos copias —la del orquestador y la de los
   * subagentes— y ya habían vuelto a divergir: la del subagente no tenía detección de
   * estancamiento ni cierre verificado, y sus tarjetas de herramienta se quedaban «en
   * curso» para siempre porque nadie emitía su resultado. Un solo bucle con PERFIL evita
   * eso: cada arreglo vale para los dos y las diferencias son datos.
   *
   * p: { settings, tools, history, account, task, taskId, runStart, onStatus, onFinal,
   *      visionAllowsImages, background }
   *   history/account: true solo en el orquestador (historial e instrumentación).
   *   onStatus: dónde van los estados (null en subagentes: los resume el orquestador).
   *   onFinal:  entregar la respuesta final por callback (subagentes); si es null, el
   *             cierre es el del orquestador (assistant_done + tarea completada).
   */
  async _loop(messages, chain, signal, p = {}) {
    const settings = p.settings;
    const task = p.task || null;
    const taskId = p.taskId || ('r' + Date.now().toString(36));
    const runStart = p.runStart || Date.now();
    const onStatus = p.onStatus || null;
    let assistantSaidSomething = false;

    while (true) {
      // ---- guardrail: límites de pasos / tiempo (configurables; 0 = sin límite) ----
      const stepCheck = this.guardrails.checkStep();
      if (!stepCheck.ok) {
        if (onStatus) onStatus('Límite de seguridad alcanzado — detenido');
        this.emit({ type: 'guardrail', reason: stepCheck.reason });
        if (p.account) {
          runlog.log({ agent: 'sagitari', task: taskId, event: 'guardrail_stop', reason: stepCheck.reason });
          if (task && !task.closed) { checkpoints.interrupt(task); task.closed = true; }
          this._pushAssistant(assistantSaidSomething ? { role: 'assistant', content: 'Me he detenido al llegar al límite de seguridad de este turno (' + stepCheck.reason + '). Lo que alcancé a hacer está en las herramientas de arriba; dime si lo retomo o si prefieres otro enfoque.' } : null);
          return;
        }
        break;   // subagente: corta y entrega lo que tenga
      }
      if (signal.aborted) {
        if (p.account) {
          if (task && !task.closed) {
            if (this.pauseRequested) {
              checkpoints.pause(task);
              this.meta.paused = true;
              this.emit({ type: 'paused', runId: task.runId, goal: task.goal });
            } else {
              checkpoints.interrupt(task);
              this.emit({ type: 'task_interrupted', runId: task.runId, goal: task.goal });
            }
            // la ejecución abandona el run: ninguna vuelta posterior debe reutilizarlo
            task.closed = true;
          }
          this._pushAssistant(assistantSaidSomething ? { role: 'assistant', content: 'Detenido a tu petición. Lo que ya estaba hecho queda en las herramientas de arriba.' } : null);
          this.emit({ type: 'stopped' });
          return;
        }
        break;   // subagente detenido: entrega lo que tenga
      }
      /* v2.5 — presupuesto de contexto, en CADA paso. Un turno largo acumula volcados de
         archivos y salidas de comandos, y son justo lo que ya no hace falta volver a
         enviar. Se sueltan los bloques MÁS ANTIGUOS del request (con sus herramientas,
         que si no el proveedor rechaza la petición) hasta que vuelva a caber; el
         historial y la conversación que ve el usuario no se tocan. */
      try {
        const ctx = contexto.presupuesto({ messages, tools: toolsOverride || allToolDefs(), cfg: chain[0] || {} });
        this._ctxUso = ctx.uso;
        if (ctx.estado === 'apretado') {
          const rec = contexto.recortarMensajes(messages, toolsOverride || allToolDefs(), chain[0] || {});
          if (rec.quitados) {
            messages = rec.messages;   // solo el request: el historial sigue entero
            runlog.log({ agent: 'sagitari', task: taskId, event: 'context_trim', bloques: rec.quitados, tokensLiberados: rec.tokensLiberados, uso: Math.round(ctx.uso * 100) / 100 });
            if (onStatus && p.account) onStatus('Contexto al ' + Math.round(ctx.uso * 100) + '%: se sueltan ' + rec.quitados + ' bloque(s) antiguos del envío (~' + rec.tokensLiberados + ' tokens)');
          }
        }
        if (ctx.estado === 'apretado' && p.account && !this._avisadoCtx) {
          this._avisadoCtx = true;
          this.emit({ type: 'contexto', uso: ctx.uso, tokens: ctx.total, ventana: ctx.ventana });
        }
      } catch {}
      const t0 = Date.now();
      // si el stream falla (o lo aborta el usuario) la excepción sube tal cual:
      // el salto entre modelos ya lo resuelve _streamWithFallback
      const res = await this._streamWithFallback(chain, messages, signal, null, { thinking: p.showThinking });
      this.meta.llmCalls++;
      this.meta.lastLatencyMs = Date.now() - t0;
      // Narración acumulada del turno: cada ronda del modelo cuenta su parte y
      // la UI la enseña intercalada con las herramientas; al cerrar, el historial
      // guarda la historia COMPLETA, no solo el párrafo final (que es lo que
      // hacía que una respuesta larga se volviera corta al terminar el turno).
      if (res.text && res.text.trim()) this._transcript.push(res.text);
      // cierre del bloque de razonamiento: con su texto completo y su duración (los
      // deltas ya se pintaron en vivo, esto solo lo sella)
      if (p.showThinking && res.reasoning) {
        this.emit({ type: 'thinking_done', text: res.reasoning, durationMs: Date.now() - t0 });
      }
      if (res.usage) {
        this.meta.tokensIn += res.usage.prompt_tokens || 0;
        this.meta.tokensOut += res.usage.completion_tokens || 0;
        // el modelo que REALMENTE responde: la cadena puede haber saltado (y el coste
        // se tarifa con ese, no con el que se pedía)
        runlog.log({ agent: 'sagitari', task: taskId, event: 'llm', model: this.guardrails.model, durationMs: this.meta.lastLatencyMs, tokens: res.usage });
        const tok = this.guardrails.addTokens((res.usage.total_tokens || 0), res.usage);
        this.meta.costUsd = this.guardrails.getCost();
        if (!tok.ok) {
          this.emit({ type: 'guardrail', reason: tok.reason });
          if (p.account) {
            if (task && !task.closed) { checkpoints.interrupt(task); task.closed = true; }
            this._pushAssistant(assistantSaidSomething ? { role: 'assistant', content: 'Me he detenido al agotar el límite de tokens del turno (' + tok.reason + '). Puedes subir el límite en Ajustes ▸ Guardarraíles, o pedirme que continúe desde aquí.' } : null);
            return;
          }
          break;
        }
      }
      if (res.aborted) {
        // el abort puede llegar a mitad del stream, y entonces esta rama es la
        // única que se ejecuta: sin guardar aquí el checkpoint, la pausa perdía
        // la reanudación y la tarea quedaba marcada como interrumpida
        if (p.account) {
          if (task && !task.closed && this.pauseRequested) {
            checkpoints.pause(task);
            task.closed = true;
            this.meta.paused = true;
            this.emit({ type: 'paused', runId: task.runId, goal: task.goal });
          }
          this._pushAssistant(assistantSaidSomething ? { role: 'assistant', content: res.text || '(interrumpido)' } : null);
          this.emit({ type: 'stopped' });
          return;
        }
        break;
      }

      // ---- guardrail v1.2: detección de ausencia de progreso ----
      // (v2.2: también dentro de un subagente: un bucle de lectura que no avanza quemaba
      // su presupuesto entero hasta el límite de pasos, sin que nadie lo notara)
      const stall = this.guardrails.checkStall({ toolName: res.toolCalls?.[0]?.function?.name || null, assistantText: res.text });
      if (!stall.ok) {
        if (onStatus) onStatus('Sin progreso — detenido');
        this.emit({ type: 'guardrail', reason: stall.reason });
        if (p.account) {
          runlog.log({ agent: 'sagitari', task: taskId, event: 'stall_detected' });
          if (task && !task.closed) { checkpoints.interrupt(task); task.closed = true; }
          this._pushAssistant(assistantSaidSomething ? { role: 'assistant', content: 'Me he detenido porque llevaba varios pasos sin avanzar de verdad —repitiendo lo mismo sin que cambiara nada— y he preferido cortar antes de gastar el turno en el mismo bucle. Dime si lo retomo por otro camino y sigo desde aquí.' } : null);
          return;
        }
        break;
      }

      if (res.toolCalls && res.toolCalls.length) {
        const msg = { role: 'assistant', content: res.text || '', tool_calls: res.toolCalls };
        if (!res.text) delete msg.content;
        messages.push(msg);
        if (p.history) this.history.push(JSON.parse(JSON.stringify(msg)));

        // Al salir antes de tiempo (abort / guardrail / bucle) TODA tool_call debe
        // tener su mensaje 'tool' de respuesta: si no, el historial queda inválido
        // para la API (un assistant con tool_calls exige una respuesta por id).
        const answered = new Set();
        const closePendingCalls = (reason) => {
          for (const tc of res.toolCalls) {
            if (answered.has(tc.id)) continue;
            answered.add(tc.id);
            messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: reason });
            if (p.history) this.history.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: reason });
          }
        };

        /* ---- v2.5: PARALELISMO con bloqueo por recurso.

           El modelo suele pedir varias cosas en el MISMO mensaje (tres lecturas, dos
           investigaciones, una captura y un comando). Antes se hacían una detrás de otra
           y el turno duraba la suma; ahora salen a la vez hasta `parallelTools`, pero
           cada una toma los recursos que necesita (agent/recursos.js): el NAVEGADOR es
           uno solo (dos clics a la vez se pisarían la pestaña y el inventario), la
           ESCRITURA en disco va en cola y la TERMINAL admite dos comandos.

           Los guardarraíles (tope de llamadas, bucle, permisos y confirmaciones) se
           consultan en orden ANTES de lanzar nada, así que un tope o un bucle detectado
           cortan también lo que todavía no ha salido; y Detener mata TODO lo que esté en
           vuelo, no solo la última. */
        const envueltos = await this._runToolCalls(res.toolCalls, {
          signal, settings,
          tools: p.tools,                       // null = catálogo completo
          noDelegate: !p.account,               // un subagente no vuelve a delegar
          task: p.account ? task : null,        // el checkpoint es del orquestador
          onStatus,
        }, Number(p.parallelTools) || Agent.MAX_PARALELO);

        /* Se procesan EN ORDEN (aunque hayan terminado en otro): el historial y el
           feed del chat cuentan la misma historia que el modelo pidió, y el orden de
           los resultados es determinista. */
        for (let ci = 0; ci < res.toolCalls.length; ci++) {
          const tc = res.toolCalls[ci];
          const envuelto = envueltos[ci];
          // una llamada que no llegó a lanzarse (tope, bucle o Detener) se cierra abajo
          if (!envuelto) continue;
          if (p.account) {
            const tf = this.toolsFired.get(tc.function.name) || { count: 0, lastAt: 0 };
            this.toolsFired.set(tc.function.name, { count: tf.count + 1, lastAt: Date.now() });
          }
          const toolT0 = envuelto.t0;
          const r = envuelto.r;
          if (!r) continue;   // abortada a mitad: se cierra como no ejecutada
          const guardar = (text, modelContent) => {
            answered.add(tc.id);
            messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: modelContent === undefined ? text : modelContent });
            if (p.history) this.history.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: text });
            recortarImagenesViejas();
          };
          /* Las imágenes adjuntas siguen viajando en CADA petición siguiente del turno. En
             una tarea con varias capturas o con view_image (una imagen puede pesar 8 MB ≈
             10,7 MB en base64) la petición crecía sin freno hasta que el proveedor la
             rechazaba o cobraba de más. Se conservan las últimas tres y las anteriores
             quedan como texto: el modelo ya las describió y no las necesita otra vez. */
          const recortarImagenesViejas = () => {
            if (!p.visionAllowsImages) return;
            const conImagen = messages.filter(m => m.role === 'tool' && Array.isArray(m.content) && m.content.some(c => c.type === 'image_url'));
            while (conImagen.length > Agent.MAX_IMAGENES) {
              const m = conImagen.shift();
              const txt = (m.content.find(c => c.type === 'text') || {}).text || '';
              m.content = `${txt}\n(la imagen de este resultado ya no se adjunta: solo viajan las ${Agent.MAX_IMAGENES} últimas del turno)`;
            }
          };

          if (r.action === 'limit') {
            this.emit({ type: 'guardrail', reason: r.reason });
            closePendingCalls('(no ejecutada: límite de llamadas alcanzado)');
            break;
          }
          if (r.action === 'loop') {
            const reason = `Bucle detectado (${r.pattern}): la misma acción se repite sin avanzar. Ejecución detenida para proteger el sistema.`;
            if (onStatus) onStatus('Bucle detectado — detenido');
            this.emit({ type: 'guardrail', reason });
            closePendingCalls('(no ejecutada: bucle detectado)');
            if (p.account) {
              runlog.log({ agent: 'sagitari', task: taskId, event: 'loop_detected', tool: tc.function.name, pattern: r.pattern });
              if (task && !task.closed) { checkpoints.interrupt(task); task.closed = true; }
              this._pushAssistant(assistantSaidSomething ? { role: 'assistant', content: 'Me he detenido porque he detectado que repetía la misma acción en bucle (' + (r.pattern || 'acción repetida') + ') sin avanzar. Lo hecho hasta aquí queda arriba; dime si lo retomo con otro enfoque.' } : null);
              return;
            }
            break;
          }
          if (r.action === 'aborted') { closePendingCalls('(no ejecutada: ejecución detenida)'); break; }
          if (r.action !== 'ok') {
            // rechazada sin ejecutar (argumentos ilegibles, herramienta fuera de
            // alcance o desconocida, o denegada): se responde y el turno continúa
            if (r.action === 'denied' && r.reason === 'user' && p.account) {
              try { habits.observe('confirm', { approved: false, tool: tc.function.name }); } catch {}
            }
            guardar(r.text);
            this.emit({
              type: 'tool_result', name: tc.function.name, ok: false, durationMs: Date.now() - toolT0,
              result: (r.action === 'denied' && r.reason === 'user') ? 'Denegado por el usuario' : String(r.text).slice(0, 1200),
            });
            continue;
          }

          if (r.confirmed && p.account) { try { habits.observe('confirm', { approved: true, tool: tc.function.name }); } catch {} }
          const { text, images, failed } = r;
          if (p.account) {
            // ---- v2.1: traza de mutaciones del run (base del cierre verificado)
            this._toolSeq++;
            if (!failed) {
              const tname = tc.function.name;
              if (tname === 'write_file' || tname === 'edit_file' || tname === 'apply_patch') { this._writes++; this._lastWriteSeq = this._toolSeq; }
              else if (tname === 'run_command') {
                this._cmds++; this._lastCmdSeq = this._toolSeq;
                // v2.5: qué orden fue, para no volver a lanzar la misma comprobación
                // que el propio modelo ya ejecutó después de su última escritura
                this._lastCmd = String((r.args && r.args.command) || '');
              }
            }
            // v2.0: observar hábitos del usuario (hechos de uso, no conversación).
            // Se observan los args YA redactados: la memoria persiste en disco
            // igual que el runlog y no debe guardar contraseñas ni claves.
            try { habits.observe('tool', { name: tc.function.name, args: runlog.redactToolArgs(tc.function.name, r.args) }); } catch {}
            runlog.log({
              agent: 'sagitari', task: taskId, event: 'tool', tool: tc.function.name,
              args: r.args, durationMs: Date.now() - toolT0,
              success: !failed,
              error: failed ? String(text).slice(0, 200) : undefined,
            });
          }
          // ---- checkpoint: registrar el paso (éxito o fallo con su motivo) ----
          if (p.account && task && !task.closed) {
            checkpoints.record(task, { step: 'EXECUTE', tool: tc.function.name, ok: !failed, summary: String(text).slice(0, 160) });
            // OJO: aquí NO va checkpoints.fail(). fail() archiva el run como
            // 'failed' —lo saca de las tareas activas— y el bucle SIGUE ejecutando:
            // la tarea quedaba impausable e incancelable, la vista la pintaba como
            // fallida y «Reanudar» lanzaba una segunda ejecución del mismo run.
            // Un fallo de herramienta se anota; el cierre lo deciden los finales.
            if (failed) {
              task.lastError = { step: 'EXECUTE', tool: tc.function.name, message: String(text).slice(0, 500), ts: new Date().toISOString() };
              checkpoints.save(task);
            }
          }
          // Feed vision inputs (screenshots) back to the model when supported
          const toolContent = images && p.visionAllowsImages
            ? [{ type: 'text', text }, ...images.map(u => ({ type: 'image_url', image_url: { url: u } }))]
            : text;
          guardar(text, toolContent);
          // v2.0: la tarjeta del chat muestra el resultado completo posible, su
          // duración real y si falló, para que ver y entender sea lo mismo
          this.emit({ type: 'tool_result', name: tc.function.name, result: String(text).slice(0, 1200), ok: !failed, durationMs: Date.now() - toolT0 });
          assistantSaidSomething = true;
        }
        // toda tool_call necesita su respuesta por id, aunque no se haya llegado a lanzar
        closePendingCalls('(no ejecutada: ejecución detenida o tope alcanzado)');
        continue; // next loop: model reacts to tool results
      }

      /* ---- v2.5: COMPROBACIÓN DEL PROYECTO antes de cerrar.

         La diferencia con las puertas de abajo: esto no se lo pregunta al modelo, lo
         EJECUTA la app con el comando del proyecto (sus pruebas, o su compilación) y le
         devuelve la salida REAL. Si falla, el turno no cierra: se le pasa el fallo y
         vuelve a intentarlo, hasta el tope de intentos de Ajustes. Es el ciclo «prueba
         que falla → arreglo → repito» corriendo solo, en vez de depender de que el
         modelo se acuerde de comprobar lo que acaba de escribir. */
      if (p.account && await this._chequeoCierre({ settings, signal, messages, res })) continue;

      /* ---- v2.4: PUERTA DE CIERRE (revisión del CAMBIO + cierre verificado).

         Son dos preguntas distintas sobre el mismo turno:
           · ¿está bien lo que se ha ESCRITO? (revisión: contratos, casos límite, restos)
           · ¿funciona de verdad?            (verificación: leer, ejecutar, abrir)
         Van en UNA sola ronda a propósito: cada vuelta extra es una llamada más al
         modelo y una espera más para el usuario, y las dos comprobaciones se piden
         igual antes de cerrar. Cada una solo puede pedirse una vez por turno. */
      const puertaRev = p.account && this._needsReview(settings);
      const puertaVer = p.account && this._needsVerification(settings);
      if (puertaRev || puertaVer) {
        const instrucciones = [];
        const informes = [];
        if (puertaRev) {
          this._reviewed = true;
          const wsRev = (settings.settings && settings.settings.workspace) || path.join(os.homedir(), 'Desktop', 'Sagitari');
          const dif = cambios.diff(wsRev, {});
          if (dif) {
            runlog.log({ agent: 'sagitari', task: taskId, event: 'review_gate', writes: this._writes, chars: dif.length });
            instrucciones.push(REVIEW_GATE_PROMPT);
            const informe = await this._delegate(subagents.SUBAGENTS.review, {
              task: 'Revisa el CAMBIO de este turno: dime solo lo que está mal, lo que falta o lo que va a doler. Nada de estilo si el proyecto no lo pide.',
              context: `Petición del usuario: ${String(this._currentRequest || '').slice(0, 600)}\n\nDIFF DEL TURNO:\n${dif}`,
              expect: 'Hallazgos numerados con severidad y ruta, o un OK explícito si no hay nada bloqueante.',
            }, { settings, signal, screenshotFn: this.screenshotFn, browser: this.browser });
            informes.push(`REVISIÓN DEL CAMBIO (sobre lo que se ha escrito):\n${informe}`);
          }
        }
        if (puertaVer) {
          this._gateUsed = true;
          runlog.log({ agent: 'sagitari', task: taskId, event: 'verify_gate', writes: this._writes, cmds: this._cmds });
          instrucciones.push(VERIFY_GATE_PROMPT);
        }
        if (instrucciones.length) {
          const texto = puertaRev && puertaVer ? 'Revisando el cambio y verificando el resultado antes de cerrar…'
            : (puertaRev ? 'Revisando el cambio antes de cerrar…' : 'Verificando el resultado antes de cerrar…');
          this.emit({ type: 'status', text: texto });
          // lo que el modelo ya respondió se conserva: la ronda extra no repite la respuesta
          this.history.push({ role: 'assistant', content: res.text });
          messages.push({ role: 'assistant', content: res.text });
          messages.push({ role: 'user', content: instrucciones.join('\n\n') + (informes.length ? '\n\n' + informes.join('\n\n') : '') });
          continue;
        }
      }

      // Final text answer — un subagente la entrega a su orquestador
      if (p.onFinal) { p.onFinal(res.text); return; }

      // Final text answer — cierre del protocolo VERIFY → DONE
      this.history.push({ role: 'assistant', content: res.text });
      runlog.log({ agent: 'sagitari', task: taskId, event: 'run_end', durationMs: Date.now() - runStart, tokens: { prompt_tokens: this.meta.tokensIn, completion_tokens: this.meta.tokensOut } });
      if (task && !task.closed) {
        checkpoints.complete(task, res.text);
        task.closed = true;
        this.emit({ type: 'task_done', runId: task.runId, goal: task.goal });
      }
      this.currentRun = null;
      /* v2.5: si el turno ha tocado archivos, la interfaz ofrece deshacerlo con la
         pre-imagen que ya se guardó para revisar el cambio. Se avisa ANTES de cerrar la
         burbuja para que caiga en el mismo bloque de mensajes. */
      if (p.account) {
        try {
          const wsUndo = (settings.settings && settings.settings.workspace) || path.join(os.homedir(), 'Desktop', 'Sagitari');
          const plan = cambios.planDeshacer(wsUndo);
          if (plan.length) this.emit({ type: 'can_undo', files: plan.slice(0, 24).map(x => x.ruta) });
        } catch {}
      }
      this.emit({ type: 'assistant_done', text: res.text, transcript: this.transcriptFull(), runId: p.background ? (task && task.runId) : undefined });
      return;
    }

    // Salida por límite o por abort sin respuesta final: el subagente entrega lo último
    // que dijo (antes lo hacía el bucle propio con este mismo criterio), y así el
    // orquestador recibe un PARTIAL honesto en vez de un vacío.
    if (p.onFinal) {
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
      p.onFinal(lastAssistant ? String(lastAssistant.content) : '');
    }
  }

  _pushAssistant(msg) { if (msg) { this.history.push(msg); this.emit({ type: 'assistant_done', text: msg.content, transcript: this.transcriptFull() }); } }

  /** Narración completa del turno para guardar y repintar (con tope). */
  transcriptFull() { return recortarTranscripcion((this._transcript || []).join('\n\n')); }

  /* ============ v1.4: delegación en subagentes ============ */

  static CONFIRM_ROUTES = new Map();   // cid -> Agent (confirmaciones de subagentes)
  static routeConfirm(cid, approved) {
    const a = Agent.CONFIRM_ROUTES.get(cid);
    if (!a) return false;
    Agent.CONFIRM_ROUTES.delete(cid);
    try { a.resolveConfirm(cid, approved); } catch {}
    return true;
  }

  /**
   * Lanza las llamadas de un mensaje respetando `limite` de concurrencia, con la
   * seguridad de que Detener o un tope no lanzan ninguna más. Devuelve un array
   * alineado con `calls` (null donde no se llegó a ejecutar) con { r, t0 }.
   */
  async _runToolCalls(calls, ctx, limite) {
    const out = new Array(calls.length).fill(null);
    const max = Math.max(1, Math.min(Number(limite) || 1, calls.length, Agent.MAX_PARALELO));
    let siguiente = 0;
    let parar = false;
    const worker = async () => {
      for (;;) {
        if (parar || ctx.signal.aborted) { parar = true; return; }
        const i = siguiente++;
        if (i >= calls.length) return;
        const t0 = Date.now();
        const r = await this._runToolCall(calls[i], { ...ctx, callId: calls[i].id });
        out[i] = { r, t0 };
        // un tope de llamadas o un bucle detectado cortan lo que queda por lanzar:
        // da igual cuántos huecos libres haya, el mensaje ya ha fallado
        if (r && (r.action === 'limit' || r.action === 'loop')) parar = true;
      }
    };
    const workers = [];
    for (let k = 0; k < Math.min(max, calls.length); k++) workers.push(worker());
    await Promise.all(workers);
    return out;
  }

  /**
   * Prepara y ejecuta UNA tool_call: argumentos, límites, permisos, confirmación,
   * delegación y ejecución.
   *
   * Es el ÚNICO camino por el que se ejecuta una herramienta — lo usan el bucle
   * principal y el de subagentes — así que cualquier corrección (permisos,
   * límites, errores de formato) vale para los dos. Antes eran dos copias con
   * divergencias silenciosas y cada arreglo había que hacerlo dos veces.
   *
   * ctx: { signal, settings, tools?, noDelegate?, task?, onStatus? }
   *   tools: definiciones permitidas (los subagentes las filtran por spec)
   *   task:  checkpoint de la tarea en curso (solo el bucle interactivo)
   * Devuelve { action, text, images?, failed?, args?, reason?, pattern?, confirmed? }
   * con action ∈ ok | denied | bad-args | not-allowed | unknown | limit | loop | aborted.
   * En limit/loop/aborted la llamada queda SIN responder: el llamante decide cerrar
   * las pendientes y salir.
   */
  async _runToolCall(tc, ctx = {}) {
    const { signal, settings, tools, task, onStatus } = ctx;
    const name = tc.function.name;
    let args = {};
    let argsError = null;
    try { args = JSON.parse(tc.function.arguments || '{}'); }
    catch { argsError = 'Error: los argumentos de la herramienta no son JSON válido. Reenvía la llamada con argumentos correctos (objeto JSON).'; }
    // Un JSON válido que no es objeto (p. ej. "null") pasaba el parse y reventaba
    // más abajo leyendo args.path: el turno se caía con un TypeError en vez de
    // responderle al modelo que reenvíe la llamada.
    if (!argsError && (!args || typeof args !== 'object' || Array.isArray(args))) {
      args = {};
      argsError = 'Error: los argumentos de la herramienta deben ser un objeto JSON. Reenvía la llamada con argumentos correctos.';
    }
    this.emit({ type: 'tool', name, args });
    // Etiqueta real de una herramienta MCP (servidor y nombre tal cual los ve el
    // usuario): se resuelve ANTES de pintar el rail —que también la usa— y es
    // informativa, no funcional (el ejecutor despacha sólo con el nombre).
    if (String(name).startsWith('mcp__') && this.mcp) {
      const info = this.mcp.describe(name);
      if (info) args = { ...args, _mcp: { serverName: info.serverName, toolName: info.toolName } };
    }
    if (onStatus) onStatus(statusFor(name, args));

    // Argumentos ilegibles: NO se ejecuta nada (antes se ejecutaba con {} y
    // write_file acababa escribiendo en el workspace por un `path` vacío)
    if (argsError) return { action: 'bad-args', text: argsError, failed: true, args };
    // Alcance: los subagentes solo usan sus herramientas… y una herramienta
    // inexistente (alucinada) no debe llegar a pedir permiso al usuario
    if (tools && !tools.some(d => d.function && d.function.name === name)) {
      return {
        action: 'not-allowed', failed: true, args,
        text: ctx.noDelegate && name === 'delegate'
          ? 'Error: un subagente no puede delegar a otro.'
          : `Error: la herramienta «${name}» no está disponible para este subagente. Solo puedes usar: ${tools.map(d => d.function.name).join(', ')}.`,
      };
    }
    if (!tools && !allToolDefs().some(d => d.function && d.function.name === name)) {
      return { action: 'unknown', failed: true, args, text: `Error: herramienta desconocida «${name}».` };
    }

    const callCheck = this.guardrails.checkToolCall();
    if (!callCheck.ok) return { action: 'limit', reason: callCheck.reason, args };
    const loop = this.guardrails.isLoop(name, args);
    if (loop.loop) return { action: 'loop', pattern: loop.pattern, args };

    // ---- permisos: safe → ejecuta; confirm → pregunta; restricted → bloquea ----
    // Un clic por índice solo se puede juzgar con la etiqueta que guardó el
    // inventario: sin esto, click_index esquivaba la confirmación de acciones
    // sensibles (comprar/pagar/eliminar) que sí exige el clic por texto.
    if (name === 'browser_control' && args.action === 'click_index' && this.browser && typeof this.browser.labelForIndex === 'function') {
      args = { ...args, _label: this.browser.labelForIndex(args.index) };
    }
    const decision = this.guardrails.decide(name, args);
    let confirmed = false;
    // decide() devuelve {action:'deny'} para las restringidas: al unificar los dos
    // bucles esta comparación se escribió mal y una herramienta bloqueada por el
    // usuario llegaba a ejecutarse (lo cazó un test de regresión)
    if (decision.action === 'deny') return { action: 'denied', reason: 'restricted', text: decision.reason, failed: true, args };
    if (decision.action === 'confirm') {
      const cid = newConfirmId('c');
      Agent.CONFIRM_ROUTES.set(cid, this);
      this.emit({
        type: 'confirm_request', id: cid, tool: name,
        description: decision.description, summary: decision.summary, sensitive: decision.sensitive,
        runId: (task && !task.closed) ? task.runId : undefined,
      });
      const approved = await this._awaitConfirm(cid, signal);
      Agent.CONFIRM_ROUTES.delete(cid);
      // abortado (Detener / tarea cancelada) mientras esperábamos: no es una negativa
      if (signal.aborted) return { action: 'aborted', args };
      if (!approved) {
        return {
          action: 'denied', reason: 'user', failed: true, args,
          text: 'El usuario DENEGÓ esta acción. No la repitas; continúa con la tarea por otra vía o pregunta qué prefiere hacer.',
        };
      }
      confirmed = true;
      this.guardrails.approve(decision.signature);
    }

    const callKey = ctx.callId || ('call-' + (++Agent._callSeq));
    let result;
    let abortada = false;
    try {
      /* v2.5: bloqueo por recurso. Solo se espera si de verdad hay conflicto (el
         navegador es uno; dos escrituras sobre el disco van en cola), y mientras tanto
         el resto de llamadas del mensaje siguen en paralelo. */
      result = await recursos.con(paraHerramienta(name, args), () => {
        /* Detener mientras esta llamada esperaba su turno: la que ya estaba en vuelo
           se mata, pero la que estaba en la COLA no puede ejecutarse después de la
           parada (el navegador es uno: hasta dos clics encolados salían tras Detener
           porque el semáforo no sabe nada del abort). */
        if (signal && signal.aborted) { abortada = true; return ''; }
        return this._executeToolCall(name, args, { settings, signal, task, onStatus, callKey });
      });
    } catch (e) { result = 'Error: ' + e.message; }
    this.runningTools.delete(callKey);
    if (abortada) return { action: 'aborted', args };
    this.runningTools.delete(callKey);
    this.meta.toolCalls++;
    const images = result && typeof result === 'object' ? result.images : undefined;
    const text = result && typeof result === 'object' ? result.text : String(result);
    return { action: 'ok', text, images, failed: typeof text === 'string' && text.startsWith('Error'), args, confirmed };
  }

  /**
   * Ejecuta de verdad una llamada ya autorizada: delegación o herramienta del
   * ejecutor. Es el ÚLTIMO tramo del camino único de ejecución, extraído para que
   * el bloqueo por recurso envuelva justo lo que toca recursos.
   */
  async _executeToolCall(name, args, { settings, signal, task, onStatus, callKey }) {
    let result;
    try {
      if (name === 'delegate') {
        const spec = subagents.SUBAGENTS[String(args.agent || '')];
        // v2.2: tope de delegaciones por turno. Se comprueba AQUÍ (antes de arrancar el
        // subagente) y no corta el turno: se le dice al modelo que termine él la tarea.
        const cupo = spec ? this.guardrails.checkDelegation() : { ok: true };
        if (spec && !cupo.ok) {
          if (onStatus) onStatus('Tope de delegaciones alcanzado');
          // el evento lleva el motivo EN HUMANO (va a un aviso de la interfaz); la
          // instrucción —«no lances más subagentes, termina tú»— es para el modelo y
          // viaja en el resultado de la herramienta, que es quien tiene que obedecerla
          this.emit({ type: 'guardrail', reason: `Tope de subagentes de este turno alcanzado: SAGITARI continúa la tarea con lo que ya tiene.` });
          result = `Error: ${cupo.reason}`;
        } else {
          result = spec
            ? await this._delegate(spec, args, { settings, signal, screenshotFn: this.screenshotFn, browser: this.browser })
            : `Error: subagente desconocido "${args.agent}". Disponibles: ${subagents.SUBAGENT_KEYS.join(', ')}.`;
        }
      } else {
        result = await executeTool(name, args, {
          emit: (e) => this.emit(e),
          screenshotFn: this.screenshotFn,
          browser: this.browser,
          settings,
          home: os.homedir(),
          workspace: (settings.settings && settings.settings.workspace) || path.join(os.homedir(), 'Desktop', 'Sagitari'),
          // por llamada (no una sola): con varias en vuelo, Detener mata TODAS
          registerKillable: (k) => { this.runningTools.set(callKey, k); this.runningTool = k; },
          ownerId: this.sessionId,   // quién pide la acción (el navegador lo usa para no cruzar inventarios)
          mcp: this.mcp,             // servidores MCP del usuario (herramientas mcp__*)
          loadedSkills: this._skillsLoaded,   // v2.2: skills ya cargadas en este turno
        });
      }
    } catch (e) { result = 'Error: ' + e.message; }
    return result;
  }

  /**
   * v2.5: comprobación del proyecto antes de cerrar el turno.
   *
   * Ejecuta el comando de verificación que deduce `proyecto.js` (las pruebas del
   * proyecto; si no hay, la compilación o los tipos) sobre lo que hay ahora mismo en
   * disco y devuelve la salida real al modelo. Si falla, el turno NO cierra: se le da
   * el fallo y otra vuelta, hasta `intentosArreglo` veces.
   *
   * Tres cosas que evitan que estorbe: se hace UNA vez por turno; no se ejecuta si el
   * usuario lo apagó (`verificacionCierre: false`) o si el proyecto no declara cómo
   * comprobarse; y no se repite si el propio modelo ya lanzó esa misma orden después
   * de su última escritura.
   *
   * @returns {Promise<boolean>} true si ya ha inyectado el fallo y el bucle debe seguir.
   */
  async _chequeoCierre({ settings = {}, signal = null, messages = [], res = {} } = {}) {
    if (this._cierreAuto) return false;
    const policy = settings.settings || {};
    if (policy.verificacionCierre === false) return false;
    if (!this._writes) return false;
    const ws = policy.workspace || path.join(os.homedir(), 'Desktop', 'Sagitari');
    // v2.5: tu hook de cierre (Ajustes ▸ Agente). Manda: si falla, el turno no cierra.
    const plantillaHook = String(policy.hookCerrar || '').trim();
    let plan = null;
    try { plan = diagnosticos.planCierre(proyecto.perfil(ws)); } catch { plan = null; }
    if (!plan && !plantillaHook) { this._cierreAuto = true; return false; }   // no hay nada que ejecutar
    if (!plantillaHook && this._lastCmdSeq > this._lastWriteSeq && this._lastCmd.includes(plan.comando)) {
      this._cierreAuto = true;   // el modelo ya lo comprobó él mismo después de escribir
      return false;
    }
    /* OJO: `_cierreAuto` NO se marca aquí. Si se marcara al empezar, tras devolver el
       fallo al modelo la comprobación no volvería a ejecutarse nunca y el ciclo
       «falla → arreglo → repito» se quedaría en «falla → arreglo → me lo creo»: se
       marca cuando pasa, cuando el proyecto no tiene nada que ejecutar o cuando ya no
       quedan intentos. */
    const t0 = Date.now();
    const etiqueta = plan ? plan.etiqueta : 'Comprobación final';
    let r = null;
    let comando = plantillaHook;
    let texto = '';
    // El hook del usuario va primero: es su puerta y es la barata.
    if (plantillaHook) {
      this.emit({ type: 'status', text: etiqueta + ': ejecutando tu hook «' + plantillaHook + '»…' });
      let h = null;
      try { h = await ejecutarHook(plantillaHook, { ws, archivos: cambios.archivosTocados(ws), timeoutMs: 180000, registerKillable: (k) => { this.runningTools.set('cierre', k); this.runningTool = k; } }); }
      catch (e) { h = { ok: false, code: null, texto: String((e && e.message) || e), comando: plantillaHook }; }
      finally { this.runningTools.delete('cierre'); }
      if (signal && signal.aborted) return false;
      r = { code: h.ok ? 0 : (h.code === undefined ? null : h.code), stdout: h.texto, stderr: '' };
      texto = hooks.resumen(h, { etiqueta, comando: plantillaHook });
      comando = h.comando || plantillaHook;
      if (h.ok && plan) { r = null; comando = plan.comando; texto = ''; }   // el hook pasó: sigue la comprobación del proyecto
      else if (h.ok) { this._verified = true; this._cierreAuto = true;
        runlog.log({ agent: 'sagitari', event: 'close_check', check: 'hook', command: comando, ok: true, durationMs: Date.now() - t0 });
        this.emit({ type: 'tool_result', name: etiqueta, ok: true, durationMs: Date.now() - t0, result: hooks.recortar(texto, 1200) });
        return false; }
    }
    if (!r) {
      this.emit({ type: 'status', text: etiqueta + ': ejecutando «' + plan.comando + '»…' });
      try {
        r = await ejecutarComandoVerificacion(plan.comando, {
          cwd: ws, timeoutMs: plan.timeoutMs,
          registerKillable: (k) => { this.runningTools.set('cierre', k); this.runningTool = k; },
        });
      } catch (e) { r = { code: null, stdout: '', stderr: String((e && e.message) || e) }; }
      finally { this.runningTools.delete('cierre'); }
      if (signal && signal.aborted) return false;
      texto = diagnosticos.resumenEjecucion(r, { etiqueta, comando: plan.comando });
    }
    const ok = r.code === 0;
    runlog.log({
      agent: 'sagitari', task: this.currentRun ? this.currentRun.runId : undefined, event: 'close_check',
      check: plan ? plan.id : 'hook', command: comando, ok, code: r.code, durationMs: Date.now() - t0,
    });
    // La tarjeta del chat lo enseña como una herramienta más: el usuario ve QUÉ se ejecutó
    // y qué salió, en vez de tener que creerse un «verificado».
    this.emit({ type: 'tool_result', name: etiqueta, ok, durationMs: Date.now() - t0, result: String(texto).slice(0, 1200) });
    if (ok) { this._verified = true; this._cierreAuto = true; return false; }
    const intentos = Math.max(0, Math.min(5, Number(policy.intentosArreglo ?? 2)));
    if (this._intentosArreglo >= intentos) {
      this._cierreAuto = true;
      // Sin vueltas: se cierra igual (el fallo ya está a la vista) pero queda dicho.
      this.emit({ type: 'status', text: etiqueta + ': sigue fallando tras ' + this._intentosArreglo + ' intento(s); cierro y te lo dejo a la vista' });
      return false;
    }
    this._intentosArreglo++;
    runlog.log({ agent: 'sagitari', event: 'close_check_retry', check: plan ? plan.id : 'hook', attempt: this._intentosArreglo });
    this.emit({ type: 'status', text: etiqueta + ': ha fallado; se lo devuelvo al modelo para que lo arregle (' + this._intentosArreglo + '/' + intentos + ')' });
    this.history.push({ role: 'assistant', content: res.text });
    messages.push({ role: 'assistant', content: res.text });
    messages.push({ role: 'user', content: CIERRE_FALLO_PROMPT(etiqueta) + '\n\n' + texto });
    return true;
  }

  /**
   * ¿Hace falta comprobar el resultado antes de aceptar el cierre?
   * Sí cuando el run cambió varias cosas (2+ archivos, o archivo + comando) y
   * nada lo comprobó después: ni una verificación delegada, ni un comando
   * posterior a la última escritura. Una sola vez por run y desactivable en
   * Ajustes (`verifyGate: false`).
   */
  /**
   * v2.4: ¿toca revisar el cambio antes de cerrar? Se pide UNA vez por turno, solo si
   * se ha escrito algo y solo si el usuario no lo ha desactivado (`reviewGate`).
   * Si el propio modelo ya delegó en review, no se repite.
   */
  _needsReview(settings) {
    if (this._reviewed) return false;
    if (this._writes < 1) return false;
    const policy = (settings && settings.settings) || {};
    if (policy.reviewGate === false) return false;
    const ws = policy.workspace || path.join(os.homedir(), 'Desktop', 'Sagitari');
    return cambios.hay(ws);   // si no hay diff guardado, no hay nada que revisar
  }

  _needsVerification(settings) {
    if (this._gateUsed) return false;
    const policy = (settings && settings.settings) || {};
    if (policy.verifyGate === false) return false;
    const touched = this._writes >= 2 || (this._writes >= 1 && this._cmds >= 1);
    if (!touched) return false;
    if (this._verified) return false;
    if (this._lastCmdSeq > this._lastWriteSeq) return false;   // ya se comprobó ejecutando
    return true;
  }

  /**
   * v1.4: delega una subtarea en un subagente especializado. El subagente es
   * otro Agent con system prompt, herramientas y presupuesto propios; corre su
   * propio bucle y devuelve un RESULTADO ESTRUCTURADO al orquestador.
   *
   * v2.1: la subtarea viaja como brief (contexto + criterio de éxito + tablero de
   * lo ya hecho + presupuesto) y el subagente recibe las SKILLS de su
   * especialidad. El resultado queda en el tablero para las siguientes
   * delegaciones del mismo run.
   */
  async _delegate(spec, args, ctx) {
    const t0 = Date.now();
    const taskText = String(args.task || '').slice(0, 2000);
    const context = String(args.context || '').slice(0, 2000);
    /* v2.2: el criterio de éxito es obligatorio EN LA PRÁCTICA. Si el orquestador no lo
       precisa, se cae a la petición original del usuario (el subagente trabaja siempre
       contra un criterio, en vez de "hazlo bien"), y se le dice que es de reserva para
       que pida precisión si le hace falta. */
    const expectPedido = String(args.expect || '').trim();
    const expect = (expectPedido || this._expectDeReserva()).slice(0, 1000);
    const reserva = !expectPedido && !!expect;
    const ws = (ctx.settings.settings && ctx.settings.settings.workspace) || path.join(os.homedir(), 'Desktop', 'Sagitari');
    /* v3.0 — AISLAMIENTO (hueco 6). Si el especialista va a ESCRIBIR y el proyecto es
       un repositorio git, trabaja en su PROPIO árbol de trabajo: ve el proyecto
       entero —con los cambios sin commitear del usuario incluidosa— escribe donde
       quiera y al terminar sus cambios vuelven como un parche VERIFICADO.
       Es lo que permite que dos especialistas trabajen de verdad a la vez: sin esto
       el semáforo los serializa, pero se siguen leyendo los archivos a medio cambiar. */
    let arbol = null;
    const escribeElArbol = ['write_file', 'edit_file', 'apply_patch'].some((t) => spec.allowTools.includes(t));
    if (escribeElArbol && ctx.settings.settings && ctx.settings.settings.arbolesAislados !== false) {
      try { arbol = await arboles.crear(ws); } catch { arbol = null; }
      if (arbol) {
        this.emit({ type: 'status', text: `🌳 ${spec.name}: en un árbol aislado (sus cambios vuelven verificados)` });
        runlog.log({ agent: 'sagitari', event: 'arbol_crear', subagent: spec.key, id: arbol.id });
      }
    }
    // Todo el trabajo del subagente —sus herramientas, sus comprobadores, sus reglas—
    // apunta al árbol cuando lo hay: su «espacio de trabajo» es ese, no el del usuario.
    const settingsTrabajo = arbol
      ? { ...ctx.settings, settings: { ...(ctx.settings.settings || {}), workspace: arbol.dir } }
      : ctx.settings;
    // v2.2: el tablero del chat necesita saber que EMPIEZA una delegación (no solo que
    // acaba): quién, qué y con qué criterio, en vivo.
    this.emit({
      type: 'delegate_start', subagent: spec.key, task: taskText, expect, reserve: reserva,
      runId: (this.currentRun && !this.currentRun.closed) ? this.currentRun.runId : undefined,
    });
    const sub = new Agent({
      fetchFn: this.fetchFn,
      emit: (e) => { try { this.emit({ ...e, subagent: spec.key }); } catch {} },
      screenshotFn: ctx.screenshotFn,
      browser: ctx.browser,
      mcp: this.mcp,   // aunque su catálogo filtrado no incluya MCP, el ejecutor necesita el gestor
      guardrailsPolicy: {
        ...((ctx.settings && ctx.settings.security) || {}),
        guardrails: { ...((ctx.settings && ctx.settings.security && ctx.settings.security.guardrails) || {}), maxSteps: spec.maxSteps },
      },
    });
    const signal = (this.abort && this.abort.signal) || new AbortController().signal;
    this.subagent = sub;              // para que Detener/Pausar maten también su comando en curso
    this.subagents.add(sub);          // …y si van varios en paralelo, todos
    this.emit({ type: 'status', text: `${spec.emoji} ${spec.name}: ${taskText.slice(0, 80)}` });
    // ---- skills del agente: índice de SU especialidad + las que encajan con esta
    // subtarea (antes las skills solo existían en el hilo principal)
    let skillsIndex = '';
    let suggested = [];
    try {
      skillsIndex = skills.promptIndexSync(spec.key);
      suggested = (await skills.suggestSkillsFor(`${taskText} ${context}`, { agent: spec.key, limit: 2 })).map(s => s.name);
    } catch {}
    const brief = subagents.buildSubagentBrief({
      task: taskText,
      context,
      expect,
      // lo que ya hicieron las otras delegaciones de este run (no se repite trabajo)
      board: subagents.formatDelegationBoard(this._delegations),
      budget: { steps: spec.maxSteps, note: 'pasos de herramienta de esta subtarea' },
    });
    let finalText = '';
    try {
      await sub._runWithSystem(
        subagents.subagentSystemPrompt(spec.key, arbol ? arbol.dir : ws, { skillsIndex, suggested }),
        settingsTrabajo,
        brief,
        subagents.toolDefsFor(spec.key),
        signal,
        (text) => { finalText = text; },
        // v2.2: enrutado por especialidad (si el usuario lo activó) — el verificador y el
        // archivador no necesitan el modelo más caro para leer y comprobar
        { category: spec.category, elegirPorCategoria: ctx.settings.settings?.agentRouting === true }
      );
    } catch (e) {
      return `RESULT: delegación fallida (${e.message})\nSTATUS: FAILED`;
    } finally {
      this.subagents.delete(sub);
      this.subagent = null;
      // el gasto del subagente cuenta para el presupuesto global del usuario:
      // sin esto una delegación podía multiplicar el coste sin tope
      const over = this.guardrails.absorb(sub.guardrails);
      if (!over.ok) {
        runlog.log({ agent: 'sagitari', event: 'guardrail_budget', subagent: spec.key, reason: over.reason });
        this.emit({ type: 'status', text: over.reason });
      }
    }
    /* v3.0 — fusión VERIFICADA. El parche se comprueba con `git apply --check` antes
       de aplicarse: si no entra limpio, NO se toca el árbol del usuario y el
       subagente lo dice en vez de fingir que su trabajo está puesto. */
    let fusion = null;
    if (arbol && signal.aborted) {
      /* El usuario detuvo la tarea: fusionar aquí metería en su proyecto un trabajo
         a medias sin que lo haya pedido. Se descarta y se dice. */
      await arboles.descartar(arbol);
      this.emit({ type: 'status', text: `Se descartó el trabajo sin terminar de ${spec.name} (detuviste la tarea)` });
    } else if (arbol) {
      try {
        fusion = await arboles.fusionar(arbol, {
          // las pre-imágenes se registran ANTES de aplicar: así la fusión se puede
          // deshacer como cualquier otro cambio del turno
          preparar: (rels) => { for (const rel of rels) { try { cambios.recordar(ws, path.join(ws, rel)); } catch {} } },
        });
      } catch (e) {
        fusion = { ok: false, archivos: [], conflicto: String((e && e.message) || e) };
      }
      await arboles.descartar(arbol, { conservar: !!(fusion && !fusion.ok && !fusion.vacio) });
      runlog.log({
        agent: 'sagitari', event: 'arbol_fusionar', subagent: spec.key,
        ok: !!(fusion && fusion.ok), archivos: ((fusion && fusion.archivos) || []).length,
        conflicto: fusion && fusion.conflicto ? String(fusion.conflicto).slice(0, 200) : undefined,
      });
      if (fusion && fusion.ok && fusion.vacio) this.emit({ type: 'status', text: `${spec.name} terminó sin dejar cambios` });
      else if (fusion && fusion.ok) this.emit({ type: 'status', text: `Fusión al proyecto: ${fusion.archivos.length} archivo(s)` });
      else if (fusion) this.emit({ type: 'status', text: `No pude fusionar el árbol de ${spec.name}: ${fusion.conflicto}` });
    }
    const parsed = subagents.parseSubagentResult(finalText);
    // v2.1: una verificación que no falla cuenta como prueba para el cierre
    if (spec.key === 'verification' && parsed.status !== 'FAILED') this._verified = true;
    // v2.4: si el propio modelo pidió la revisión, la puerta del cierre no la repite
    if (spec.key === 'review') this._reviewed = true;
    this._delegations.push({ agent: spec.key, task: taskText, status: parsed.status, result: parsed.result });
    runlog.log({ agent: 'sagitari', event: 'delegate', subagent: spec.key, status: parsed.status, durationMs: Date.now() - t0, task: taskText.slice(0, 120) });
    // el cierre viaja con lo que el subagente aportó (resultado, detalles y la
    // evidencia): la tarjeta del chat puede entonces enseñarlo tal cual
    this.emit({
      type: 'delegate_done', subagent: spec.key, status: parsed.status,
      // `task` viaja también para que la interfaz cierre la MISMA fila que abrió al
      // empezar (evento delegate_start) en vez de buscar por agente
      task: taskText,
      result: parsed.result, details: parsed.details, evidence: parsed.evidence,
      durationMs: Date.now() - t0,
      // v3.0: qué volvió del árbol aislado (la tarjeta del chat lo puede enseñar)
      fusion: fusion ? { ok: !!fusion.ok, vacio: !!fusion.vacio, archivos: fusion.archivos || [], conflicto: fusion.conflicto || null, dir: arbol && arbol.conservado ? arbol.dir : null } : undefined,
    });
    const evidence = parsed.evidence ? `\nEVIDENCIA: ${parsed.evidence}` : '';
    const board = subagents.formatDelegationBoard(this._delegations);
    /* La fusión hay que contarla: si no entró, el orquestador NO puede presentar el
       trabajo como hecho — es justo el error que esto viene a evitar. */
    let notaFusion = '';
    if (arbol && fusion) {
      if (fusion.ok && !fusion.vacio) notaFusion = `\nFUSIÓN: aplicados ${fusion.archivos.length} archivo(s) al proyecto del usuario desde el árbol aislado${fusion.archivos.length ? ': ' + fusion.archivos.slice(0, 10).join(', ') : ''}.`;
      else if (fusion.ok) notaFusion = '\nFUSIÓN: el subagente terminó sin cambiar archivos.';
      else notaFusion = `\nFUSIÓN CON CONFLICTO: sus cambios NO se aplicaron al proyecto del usuario (${fusion.conflicto}). Dilo tal cual; no lo presentes como hecho. El árbol queda en ${arbol.dir} por si hay que mirarlo.`;
    }
    return `RESULTADO DE ${spec.name} (${parsed.status}):\n${parsed.result}${parsed.details ? '\nDETALLES: ' + parsed.details : ''}${evidence}${notaFusion}${board ? `\n\nTABLERO DE ESTE TURNO (subagentes ya usados):\n${board}` : ''}`;
  }

  /**
   * Turno de un subagente: system prompt propio, herramientas restringidas, sin
   * checkpoint ni memoria. Corre sobre el MISMO bucle que el orquestador (v2.2) con el
   * perfil silencioso, así que hereda sus arreglos: detección de estancamiento, cierre de
   * las tarjetas de herramienta y —nuevo— la cadena de modelos, que antes no existía aquí.
   */
  async _runWithSystem(sys, settings, userText, tools, signal, onFinalText, opts = {}) {
    const cfg = this.activeConfig(settings);
    if (!cfg || !cfg.baseUrl || !cfg.model) throw new Error('sin proveedor/modelo activo');
    this._mode = MODE_PROFILES.act;
    // El límite de silencio del usuario vale también dentro de un subagente: sin
    // esto, delegar ignoraba el ajuste (300 s o «sin límite») y cortaba a los 120 s
    // por defecto, con un error que contradecía lo que dice Ajustes.
    this._llmTimeoutMs = Number(settings.settings?.llmTimeoutMs);
    if (!Number.isFinite(this._llmTimeoutMs) || this._llmTimeoutMs < 0) this._llmTimeoutMs = null;   // 0 = sin límite
    this.guardrails.model = cfg.model;
    this.guardrails.beginRun();
    this._skillsLoaded = new Set();
    const messages = [{ role: 'system', content: sys }, { role: 'user', content: userText }];
    // v2.2: cadena de modelos TAMBIÉN aquí. Antes el subagente iba directo al modelo
    // activo: un 500 o un timeout del proveedor tiraba la delegación entera (30 pasos de
    // trabajo a la basura) mientras el hilo principal habría seguido con el secundario.
    const { chain } = this._chainFor(settings, userText, opts);
    await this._loop(messages, chain, signal, {
      settings,
      tools,                  // catálogo filtrado del subagente
      history: false,
      account: false,         // sin hábitos, checkpoints ni cierre verificado: es trabajo interno
      task: null, taskId: null, runStart: null,
      onStatus: null,         // los pasos del subagente los resume el orquestador
      onFinal: onFinalText,
      visionAllowsImages: cfg.vision !== false,
      background: false,
      // el razonamiento de un subagente es trabajo interno (y en Anthropic cuesta
      // tokens aparte): no se pide ni se muestra, su cierre va en la tarjeta
      showThinking: false,
      // v2.5: el subagente también puede pedir varias cosas a la vez; el bloqueo por
      // recurso es del EQUIPO, así que ni entre subagentes se pisan el navegador
      parallelTools: Number(settings.settings?.parallelTools) || Agent.MAX_PARALELO,
    });
  }

  /** v1.6: recorre la cadena de modelos; si uno falla (HTTP/red), prueba el
      siguiente y registra la salud de cada intento. */
  async _streamWithFallback(chain, messages, signal, toolsOverride = null, opts = {}) {
    let lastErr = null;
    let intento = 0;
    for (const entry of chain) {
      const t0 = Date.now();
      const cfg = { ...entry, format: entry.format || protocols.detectFormat(entry) };
      /* Un intento anterior pudo dejar razonamiento a medias en la interfaz: al saltar
         de modelo se avisa para que el bloque se vacíe, en vez de mezclar lo que pensó
         el modelo que falló con lo que piensa el que responde. */
      if (intento++ && opts.thinking) this.emit({ type: 'thinking_reset' });
      try {
        const res = await this._streamOnce(cfg, messages, signal, toolsOverride, opts);
        models.record(entry.model, {
          ok: !res.aborted,
          durationMs: Date.now() - t0,
          tokens: res.usage,
          costUsd: this.guardrails.turnCostFor(entry.model, res.usage),
        });
        this.meta.model = entry.model || this.meta.model;
        // el coste se tarifa con el modelo que REALMENTE responde: si el
        // primario falla y contesta otro más caro (o más barato), el límite de
        // coste y el panel deben reflejarlo
        if (entry.model) this.guardrails.model = entry.model;
        if (entry.role !== 'primary') this.emit({ type: 'status', text: `Modelo «${entry.model}» respondiendo…` });
        return res;
      } catch (e) {
        lastErr = e;
        models.record(entry.model, { ok: false, durationMs: Date.now() - t0, error: e.message, fallbackFrom: true });
        runlog.log({ agent: 'sagitari', event: 'model_fallback', model: entry.model, role: entry.role, error: String(e.message).slice(0, 150) });
        if (signal.aborted) throw e;
        this.emit({ type: 'status', text: `Modelo «${entry.model}» no disponible — probando el siguiente…` });
      }
    }
    throw lastErr || new Error('Ningún modelo disponible en la cadena de fallback.');
  }

  /**
   * Cadena de modelos de un turno: el primario activo y, si procede, los secundarios que
   * ordena el router según la tarea. La usan el orquestador Y los subagentes (v2.2: antes
   * un subagente iba directo al modelo activo, así que un hipo del proveedor tiraba la
   * delegación entera mientras el hilo principal habría cambiado de modelo).
   */
  _chainFor(settings, text, opts = {}) {
    const cfg = this.activeConfig(settings);
    const primary = { providerId: cfg.providerId, name: cfg.name, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, role: 'primary' };
    const category = opts.category || models.classify(text, { hasImage: !!opts.hasImage });
    let chain = settings.settings?.modelRouting === false ? [primary] : models.fallbackChain(settings, category);
    if (!chain.length) chain = [primary];
    /* v2.5: caché de prompt del proveedor. Viaja en cada entrada de la cadena para que el
       protocolo sepa si puede marcar los puntos de corte (y para poder apagarlo en Ajustes:
       hay proveedores compatibles que rechazan el campo). */
    chain = chain.map(c => ({ ...c, cachePrompt: settings.settings?.promptCache !== false }));
    /* v2.2: modelo por agente (opcional, `agentRouting`). El modelo ELEGIDO por el usuario
       manda siempre en el chat —hubo una queja legítima cuando el router lo cambiaba en
       silencio—; esto solo afecta a los subagentes, y solo si el usuario lo activa: al que
       verifica o al que archiva le vale el modelo barato del proveedor. Se busca en la
       lista REAL del proveedor del modelo activo; si no hay lista, no se toca nada. */
    if (opts.elegirPorCategoria && chain.length) {
      const prov = (settings.providers || []).find(p => p.id === (settings.active || {}).providerId);
      const lista = (prov && Array.isArray(prov.models)) ? prov.models : [];
      const elegido = lista.length ? models.pickModelFor(lista, category) : null;
      if (elegido && elegido !== chain[0].model) {
        chain = [{ ...chain[0], model: elegido, format: protocols.detectFormat({ baseUrl: chain[0].baseUrl, providerId: chain[0].providerId, model: elegido }) }, ...chain.slice(1)];
      }
    }
    return { cfg, category, chain };
  }

  /**
   * Una vuelta del modelo con el protocolo adecuado al proveedor/modelo.
   * El multi-formato (OpenAI / Anthropic / Responses) vive en agent/protocols.js:
   * aquí solo se fija la temperatura del modo y se reenvían los deltas a la UI.
   */
  async _streamOnce(cfg, messages, signal, toolsOverride = null, opts = {}) {
    const temperature = cfg.temperature ?? (this._mode ? this._mode.temperature : 0.4);
    /* Razonamiento visible: se emite a la interfaz SOLO si el usuario lo activó
       (`showThinking`), y el protocolo solo lo PIDE donde hay que pedirlo (Anthropic
       y la API Responses). En los compatibles con OpenAI llega igualmente, y cuando
       el ajuste está apagado sencillamente no se reenvía. */
    const verRazon = opts.thinking === true;
    return protocols.stream(
      { ...cfg, temperature, sessionId: this.sessionId, silenceTimeoutMs: this._llmTimeoutMs ?? undefined, thinking: verRazon },
      {
        fetchFn: this.fetchFn,
        messages,
        tools: toolsOverride || allToolDefs(),
        signal,
        onText: (text) => this.emit({ type: 'delta', text }),
        onThinking: verRazon ? (text) => this.emit({ type: 'thinking_delta', text }) : undefined,
      }
    );
  }
}

/* Instrucción del cierre verificado: el modelo ya respondió, así que no debe
   repetir la respuesta — solo comprobar y añadir la prueba. */
/* Instrucción de la revisión del cambio: el modelo ya respondió, así que no repite la
   respuesta — solo atiende lo que el revisor encontró. */
const REVIEW_GATE_PROMPT = `ANTES DE CERRAR: has modificado archivos en este turno y el equipo de revisión ha mirado el cambio. Sus hallazgos van abajo.
1. BLOQUEANTE: arréglalo con herramientas ahora y vuelve a comprobar. No lo dejes escrito y sin arreglar.
2. RIESGO: decide — arréglalo, o explica en una línea por qué se queda así.
3. SUGERENCIA: no obliga; ignóralas si no aportan.
4. No repitas lo que ya dijiste; añade lo que cambia, con una frase por hallazgo: qué era, qué hiciste y cómo quedó. Si no había nada que arreglar, dilo con una frase entera («Lo he revisado y no hay nada que cambiar») — nunca respondas solo «sin hallazgos».`;

/** Instrucción del ciclo automático: la comprobación del proyecto ha fallado de verdad. */
const CIERRE_FALLO_PROMPT = (etiqueta) => `ANTES DE CERRAR: has modificado archivos y «${etiqueta}» del proyecto ha FALLADO con lo que hay ahora en disco. La salida real va abajo.
1. Arréglalo con herramientas: el que no pasa es el código, no la comprobación. Nada de tocar la comprobación para que pase.
2. Vuelve a ejecutarla y mira la salida; si ya no puedes (falta algo del entorno), dilo tal cual.
3. NO repitas lo que ya dijiste. Cierra con una frase entera de cierre: «Lo he verificado: <qué ejecutaste y qué salió>».`;

const VERIFY_GATE_PROMPT = `ANTES DE CERRAR: has modificado archivos o ejecutado cambios en este turno y no hay ninguna comprobación posterior al último cambio. No cierres a ciegas.
1. Comprueba de verdad el resultado con herramientas: vuelve a leer lo escrito, ejecuta lo que creaste o modifica y mira la salida, o delega en verification con un criterio de éxito verificable (delegate con agent=verification y expect).
2. Si algo no cuadra, arréglalo antes de cerrar.
3. NO repitas lo que ya dijiste. Cierra con una frase entera: «Lo he comprobado: <qué comprobaste y qué salió>». Si algo no pudiste comprobarlo, dilo también, en esa misma frase.`;

function statusFor(name, args) {
  if (String(name).startsWith('mcp__')) return 'MCP · ' + (args._mcp ? args._mcp.toolName : name.slice(5));
  switch (name) {
    case 'run_command': return 'Terminal — ' + (args.command || '').slice(0, 90);
    case 'read_file': return 'Leyendo ' + args.path;
    case 'write_file': return 'Escribiendo ' + args.path;
    case 'edit_file': return 'Editando ' + args.path;
    case 'list_dir': return 'Explorando ' + args.path;
    case 'search_files': return 'Buscando «' + args.pattern + '»';
    case 'open_app': return 'Abriendo ' + args.name;
    case 'open_url': return 'Abriendo ' + args.url;
    case 'browser_control': return 'Navegador · ' + (args.action || '') + (args.url ? ' → ' + args.url : '');
    case 'screenshot': return 'Capturando pantalla';
    case 'clipboard': return 'Portapapeles · ' + args.action;
    case 'notify': return 'Enviando notificación';
    case 'media_control': return 'Multimedia · ' + args.action;
    case 'window_manage': return 'Ventanas · ' + args.action;
    case 'system_info': return 'Leyendo información del sistema';
    default: return name;
  }
}

module.exports = { Agent, systemPrompt, recortarTranscripcion, MAX_TRANSCRIPT };
