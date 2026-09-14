'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { allToolDefs } = require('./tools');
const { executeTool } = require('./executors');
const skills = require('./skills');
const memory = require('./memory');
const checkpoints = require('./checkpoints');
const { Guardrails } = require('./guardrails');
const runlog = require('./runlog');
const subagents = require('./subagents');
const models = require('./models');
const habits = require('./habits');
const opencode = require('./opencode');   // identificación de sesión (OpenCode Go/Zen)
const protocols = require('./protocols'); // multi-formato: OpenAI / Anthropic / Responses

function systemPrompt() {
  const home = os.homedir();
  return `Eres SAGITARI, un agente de IA con control total del PC con Windows del usuario. Estás integrado en un panel de control holográfico en la pantalla del usuario.

IDENTIDAD
- Personalidad: capaz, eficiente y con carisma sutil (como un mayordomo de élite). Respuestas breves y claras; nada de relleno.
- Idioma: responde SIEMPRE en el idioma del usuario (por defecto español).

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
- DONE: resume en 1-3 líneas qué hiciste, el resultado y cómo lo verificaste.

REGLAS DE HERRAMIENTAS
- Para navegar/controlar webs usa browser_control. REGLAS DE ORO:
  * Una sola ventana con pestañas: launch abre (o REUTILIZA si ya está abierto) el navegador con la url; nunca relances si ya está abierto — usa navigate, new_tab o select_tab.
  * Gestiona pestañas: tabs lista las abiertas (con la activa marcada), new_tab abre y selecciona, select_tab cambia (por número o texto del título), close_tab cierra.
  * Para hacer clic, prefiere text (texto visible del botón/enlace) antes que selector CSS. Si dudas de qué hay en pantalla: action=screenshot (mira la imagen) o action=content (lee el texto).
  * type escribe en un campo (clear=true vacía antes; submit=true pulsa Enter, ideal para búsquedas). navigate espera a que la página cargue; usa wait si un elemento tarda en aparecer.
  * Cada acción devuelve OK/Error con detalle: léelo y decide el siguiente paso; si un clic falla, haz screenshot antes de reintentar a ciegas.
- Con run_command usa sintaxis de cmd.exe de Windows. No uses comandos interactivos.
- FICHEROS: lee antes de escribir. Para modificar un archivo existente usa edit_file (reemplazo exacto de un fragmento); reserva write_file para crear archivos nuevos o reescribir el archivo entero. En archivos largos, léelos por tramos con offset/limit en vez de volcarlos completos.

DELEGACIÓN (v1.4)
- Para subtareas autónomas y especializadas, usa delegate (research, browser, coding, file, vision, verification).
- El subagente trabaja con sus propias herramientas y permisos y te devuelve un resultado estructurado; TÚ integras la respuesta final para el usuario.
- Delega en verification antes de dar por terminadas tareas críticas si tienes dudas razonables.

SKILLS DISPONIBLES (instrucciones especializadas cargables)
Antes de tareas donde una skill aplique, llama a use_skill con su nombre: te devolverá instrucciones expertas que debes seguir. No la cites al usuario; aplícala.
${skills.promptIndexSync()}

MEMORIA del usuario — recuerdos relevantes para esta conversación (úsalos si aplican, no los cites):
{{MEMORY}}
- Para guardar algo importante que el usuario te pida recordar (preferencias, datos, decisiones), usa la herramienta remember.
- Si la petición es conversacional (saludo, pregunta), responde directamente sin herramientas.

FORMATO
- Tus respuestas se muestran en un chat con soporte markdown ligero (negrita, listas, código). Sé visual y ordenado.`;
}

const MODE_PROFILES = {
  think: { temperature: 0.7, maxSteps: 20, planFirst: false, note: 'Piensas antes de actuar: razona paso a paso en tu respuesta final, explora alternativas, sé meticuloso.' },
  plan:  { temperature: 0.35, maxSteps: 20, planFirst: true,  note: 'PRIMERO presenta un PLAN numerado breve (3-6 pasos) y luego ejecútalo con herramientas, paso a paso.' },
  act:   { temperature: 0.25, maxSteps: 12, planFirst: false, note: 'Actúa directo y eficiente: minimiza explicaciones, ejecuta y reporta el resultado.' }
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

/* Id de confirmación irrepetible: dos tarjetas en el mismo milisegundo no deben
   poder confundirse al resolverlas desde la UI. */
let confirmSeq = 0;
function newConfirmId(prefix) {
  return prefix + Date.now().toString(36) + '-' + (++confirmSeq).toString(36) + Math.random().toString(36).slice(2, 5);
}

class Agent {
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
    this.runningTool = null;             // { stop() } de la herramienta en ejecución
    this.subagent = null;                // subagente en curso (para matar su comando al Detener)
    this.toolsFired = new Map();         // name -> {count, lastAt}
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
  useSession(convId) { this.sessionId = opencode.sessionFor(convId); }

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
    if (this.runningTool && typeof this.runningTool.stop === 'function') {
      try { this.runningTool.stop(); } catch {}
    }
    if (this.subagent) {
      try { this.subagent.stop(); } catch {}
    }
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
    this.history.push({ role: 'user', content });
    this.history = trimHistory(this.history);

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
    const sys = systemPrompt().replace('{{MEMORY}}', memBlock)
      + (skillsHint || '')
      + (habitsBlock ? `\n\nPERFIL DEL USUARIO (hábitos observados — adáptate a ellos):\n${habitsBlock}` : '')
      + `\n\nESPACIO DE TRABAJO: ${ws}`
      + '\n- Es la carpeta por defecto para crear/modificar archivos; las rutas relativas resuelven aquí.'
      + '\n- Solo toques otras ubicaciones si el usuario lo pide explícitamente (ruta absoluta).'
      + `\n\nMODO ACTUAL (${settings.settings?.mode || 'act'}): ${mode.note}`
      + (mode.planFirst ? '\nFormato del plan: una línea por paso, empieza tu respuesta con "PLAN:" y numera los pasos.' : '');
    const messages = [{ role: 'system', content: sys }, ...payloadMessages(this.history)];

    // ---- v1.6: router + cadena de fallback ----
    const category = models.classify(userText, { hasImage: !!imageDataUrl });
    let chain = settings.settings?.modelRouting === false
      ? [{ providerId: cfg.providerId, name: cfg.name, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, role: 'primary' }]
      : models.fallbackChain(settings, category);
    if (!chain.length) chain = [{ providerId: cfg.providerId, name: cfg.name, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, role: 'primary' }];
    runlog.log({ agent: 'sagitari', task: taskId, event: 'model_route', category, chain: chain.map(c => c.model) });

    // el modo viaja con el arranque: la UI lo necesita para estampar el turno y
    // pintar el estado en vivo sin volver a preguntar por la configuración
    this.emit({ type: 'busy', busy: true, mode: (settings.settings && settings.settings.mode) || 'act', model: cfg.model });
    let assistantSaidSomething = false;

    while (true) {
      // ---- guardrail: límites de pasos / tiempo (configurables; 0 = sin límite) ----
      const stepCheck = this.guardrails.checkStep();
      if (!stepCheck.ok) {
        this.emit({ type: 'status', text: 'Límite de seguridad alcanzado — detenido' });
        this.emit({ type: 'guardrail', reason: stepCheck.reason });
        runlog.log({ agent: 'sagitari', task: taskId, event: 'guardrail_stop', reason: stepCheck.reason });
        if (task && !task.closed) { checkpoints.interrupt(task); task.closed = true; }
        this._pushAssistant(assistantSaidSomething ? { role: 'assistant', content: '(detenido por límite de seguridad)' } : null);
        return;
      }
      if (signal.aborted) {
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
        this._pushAssistant(assistantSaidSomething ? { role: 'assistant', content: '(detenido por el usuario)' } : null);
        this.emit({ type: 'stopped' });
        return;
      }
      const t0 = Date.now();
      // si el stream falla (o lo aborta el usuario) la excepción sube tal cual:
      // el salto entre modelos ya lo resuelve _streamWithFallback
      const res = await this._streamWithFallback(chain, messages, signal);
      this.meta.llmCalls++;
      this.meta.lastLatencyMs = Date.now() - t0;
      if (res.usage) {
        this.meta.tokensIn += res.usage.prompt_tokens || 0;
        this.meta.tokensOut += res.usage.completion_tokens || 0;
        runlog.log({ agent: 'sagitari', task: taskId, event: 'llm', model: cfg.model, durationMs: this.meta.lastLatencyMs, tokens: res.usage });
        const tok = this.guardrails.addTokens((res.usage.total_tokens || 0), res.usage);
        this.meta.costUsd = this.guardrails.getCost();
        if (!tok.ok) {
          this.emit({ type: 'guardrail', reason: tok.reason });
          if (task && !task.closed) { checkpoints.interrupt(task); task.closed = true; }
          this._pushAssistant(assistantSaidSomething ? { role: 'assistant', content: '(detenido por límite de tokens)' } : null);
          return;
        }
      }
      if (res.aborted) {
        // el abort puede llegar a mitad del stream, y entonces esta rama es la
        // única que se ejecuta: sin guardar aquí el checkpoint, la pausa perdía
        // la reanudación y la tarea quedaba marcada como interrumpida
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

      // ---- guardrail v1.2: detección de ausencia de progreso ----
      const stall = this.guardrails.checkStall({ toolName: res.toolCalls?.[0]?.function?.name || null, assistantText: res.text });
      if (!stall.ok) {
        this.emit({ type: 'status', text: 'Sin progreso — detenido' });
        this.emit({ type: 'guardrail', reason: stall.reason });
        runlog.log({ agent: 'sagitari', task: taskId, event: 'stall_detected' });
        if (task && !task.closed) { checkpoints.interrupt(task); task.closed = true; }
        this._pushAssistant(assistantSaidSomething ? { role: 'assistant', content: '(detenido: sin progreso)' } : null);
        return;
      }

      if (res.toolCalls && res.toolCalls.length) {
        const msg = { role: 'assistant', content: res.text || '', tool_calls: res.toolCalls };
        if (!res.text) delete msg.content;
        messages.push(msg);
        this.history.push(JSON.parse(JSON.stringify(msg)));

        // Al salir antes de tiempo (abort / guardrail / bucle) TODA tool_call debe
        // tener su mensaje 'tool' de respuesta: si no, el historial queda inválido
        // para la API (un assistant con tool_calls exige una respuesta por id).
        const answered = new Set();
        const closePendingCalls = (reason) => {
          for (const tc of res.toolCalls) {
            if (answered.has(tc.id)) continue;
            answered.add(tc.id);
            messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: reason });
            this.history.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: reason });
          }
        };

        for (const tc of res.toolCalls) {
          if (signal.aborted) { closePendingCalls('(no ejecutada: ejecución detenida por el usuario)'); break; }
          const tf = this.toolsFired.get(tc.function.name) || { count: 0, lastAt: 0 };
          this.toolsFired.set(tc.function.name, { count: tf.count + 1, lastAt: Date.now() });
          const toolT0 = Date.now();

          // un solo camino de ejecución (permisos, límites, confirmación y errores
          // incluidos) compartido con los subagentes
          const r = await this._runToolCall(tc, {
            signal, settings, task,
            onStatus: (text) => this.emit({ type: 'status', text }),
          });
          const guardar = (text, modelContent) => {
            answered.add(tc.id);
            messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: modelContent === undefined ? text : modelContent });
            this.history.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: text });
          };

          if (r.action === 'limit') {
            this.emit({ type: 'guardrail', reason: r.reason });
            closePendingCalls('(no ejecutada: límite de llamadas alcanzado)');
            break;
          }
          if (r.action === 'loop') {
            const reason = `Bucle detectado (${r.pattern}): la misma acción se repite sin avanzar. Ejecución detenida para proteger el sistema.`;
            this.emit({ type: 'status', text: 'Bucle detectado — detenido' });
            this.emit({ type: 'guardrail', reason });
            runlog.log({ agent: 'sagitari', task: taskId, event: 'loop_detected', tool: tc.function.name, pattern: r.pattern });
            closePendingCalls('(no ejecutada: bucle detectado)');
            if (task && !task.closed) { checkpoints.interrupt(task); task.closed = true; }
            this._pushAssistant(assistantSaidSomething ? { role: 'assistant', content: '(detenido: bucle detectado)' } : null);
            return;
          }
          if (r.action === 'aborted') { closePendingCalls('(no ejecutada: ejecución detenida)'); break; }
          if (r.action !== 'ok') {
            // rechazada sin ejecutar (argumentos ilegibles, herramienta fuera de
            // alcance o desconocida, o denegada): se responde y el turno continúa
            if (r.action === 'denied' && r.reason === 'user') {
              try { habits.observe('confirm', { approved: false, tool: tc.function.name }); } catch {}
            }
            guardar(r.text);
            this.emit({
              type: 'tool_result', name: tc.function.name, ok: false, durationMs: Date.now() - toolT0,
              result: (r.action === 'denied' && r.reason === 'user') ? 'Denegado por el usuario' : String(r.text).slice(0, 1200),
            });
            continue;
          }

          if (r.confirmed) { try { habits.observe('confirm', { approved: true, tool: tc.function.name }); } catch {} }
          const { text, images, failed } = r;
          // v2.0: observar hábitos del usuario (hechos de uso, no conversación)
          try { habits.observe('tool', { name: tc.function.name, args: r.args }); } catch {}
          runlog.log({
            agent: 'sagitari', task: taskId, event: 'tool', tool: tc.function.name,
            args: r.args, durationMs: Date.now() - toolT0,
            success: !failed,
            error: failed ? String(text).slice(0, 200) : undefined,
          });
          // ---- checkpoint: registrar el paso (éxito o fallo con su motivo) ----
          if (task && !task.closed) {
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
          const toolContent = images && cfg.vision !== false
            ? [{ type: 'text', text }, ...images.map(u => ({ type: 'image_url', image_url: { url: u } }))]
            : text;
          guardar(text, toolContent);
          // v2.0: la tarjeta del chat muestra el resultado completo posible, su
          // duración real y si falló, para que ver y entender sea lo mismo
          this.emit({ type: 'tool_result', name: tc.function.name, result: String(text).slice(0, 1200), ok: !failed, durationMs: Date.now() - toolT0 });
          assistantSaidSomething = true;
        }
        continue; // next loop: model reacts to tool results
      }

      // Final text answer — cierre del protocolo VERIFY → DONE
      this.history.push({ role: 'assistant', content: res.text });
      runlog.log({ agent: 'sagitari', task: taskId, event: 'run_end', durationMs: Date.now() - runStart, tokens: { prompt_tokens: this.meta.tokensIn, completion_tokens: this.meta.tokensOut } });
      if (task && !task.closed) {
        checkpoints.complete(task, res.text);
        task.closed = true;
        this.emit({ type: 'task_done', runId: task.runId, goal: task.goal });
      }
      this.currentRun = null;
      this.emit({ type: 'assistant_done', text: res.text, runId: opts.background ? (task && task.runId) : undefined });
      return;
    }
  }

  _pushAssistant(msg) { if (msg) { this.history.push(msg); this.emit({ type: 'assistant_done', text: msg.content }); } }

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
    // Etiqueta real de una herramienta MCP (servidor y nombre tal cual los ve el
    // usuario) para la tarjeta de confirmación y el rail: es informativa, no
    // funcional — el ejecutor despacha sólo con el nombre.
    if (String(name).startsWith('mcp__') && this.mcp) {
      const info = this.mcp.describe(name);
      if (info) args = { ...args, _mcp: { serverName: info.serverName, toolName: info.toolName } };
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

    let result;
    try {
      if (name === 'delegate') {
        const spec = subagents.SUBAGENTS[String(args.agent || '')];
        result = spec
          ? await this._delegate(spec, args, { settings, signal, screenshotFn: this.screenshotFn, browser: this.browser })
          : `Error: subagente desconocido "${args.agent}". Disponibles: ${subagents.SUBAGENT_KEYS.join(', ')}.`;
      } else {
        result = await executeTool(name, args, {
          emit: (e) => this.emit(e),
          screenshotFn: this.screenshotFn,
          browser: this.browser,
          settings,
          home: os.homedir(),
          workspace: (settings.settings && settings.settings.workspace) || path.join(os.homedir(), 'Desktop', 'Sagitari'),
          registerKillable: (k) => { this.runningTool = k; },   // para poder matar el comando al Detener
          ownerId: this.sessionId,   // quién pide la acción (el navegador lo usa para no cruzar inventarios)
          mcp: this.mcp,             // servidores MCP del usuario (herramientas mcp__*)
        });
      }
    } catch (e) { result = 'Error: ' + e.message; }
    this.runningTool = null;
    this.meta.toolCalls++;
    const images = result && typeof result === 'object' ? result.images : undefined;
    const text = result && typeof result === 'object' ? result.text : String(result);
    return { action: 'ok', text, images, failed: typeof text === 'string' && text.startsWith('Error'), args, confirmed };
  }

  /**
   * v1.4: delega una subtarea en un subagente especializado. El subagente es
   * otro Agent con system prompt, herramientas y presupuesto propios; corre su
   * propio bucle y devuelve un RESULTADO ESTRUCTURADO al orquestador.
   */
  async _delegate(spec, args, ctx) {
    const t0 = Date.now();
    const taskText = String(args.task || '').slice(0, 2000);
    const context = String(args.context || '').slice(0, 2000);
    const ws = (ctx.settings.settings && ctx.settings.settings.workspace) || path.join(os.homedir(), 'Desktop', 'Sagitari');
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
    this.subagent = sub;   // para que Detener/Pausar maten también su comando en curso
    this.emit({ type: 'status', text: `${spec.emoji} ${spec.name}: ${taskText.slice(0, 80)}` });
    let finalText = '';
    try {
      await sub._runWithSystem(
        subagents.subagentSystemPrompt(spec.key, ws),
        ctx.settings,
        (context ? `CONTEXTO DEL ORQUESTADOR: ${context}\n\n` : '') + `SUBTAREA: ${taskText}`,
        subagents.toolDefsFor(spec.key),
        signal,
        (text) => { finalText = text; }
      );
    } catch (e) {
      return `RESULT: delegación fallida (${e.message})\nSTATUS: FAILED`;
    } finally {
      this.subagent = null;
      // el gasto del subagente cuenta para el presupuesto global del usuario:
      // sin esto una delegación podía multiplicar el coste sin tope
      const over = this.guardrails.absorb(sub.guardrails);
      if (!over.ok) {
        runlog.log({ agent: 'sagitari', event: 'guardrail_budget', subagent: spec.key, reason: over.reason });
        this.emit({ type: 'status', text: over.reason });
      }
    }
    const parsed = subagents.parseSubagentResult(finalText);
    runlog.log({ agent: 'sagitari', event: 'delegate', subagent: spec.key, status: parsed.status, durationMs: Date.now() - t0, task: taskText.slice(0, 120) });
    this.emit({ type: 'delegate_done', subagent: spec.key, status: parsed.status, result: parsed.result });
    return `RESULTADO DE ${spec.name} (${parsed.status}):\n${parsed.result}${parsed.details ? '\nDETALLES: ' + parsed.details : ''}`;
  }

  /** Bucle independiente para subagentes: system prompt propio, herramientas
      restringidas, sin checkpoint ni memoria; entrega la respuesta final por callback. */
  async _runWithSystem(sys, settings, userText, tools, signal, onFinalText) {
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
    const messages = [{ role: 'system', content: sys }, { role: 'user', content: userText }];
    while (true) {
      if (!this.guardrails.checkStep().ok) break;
      if (signal.aborted) break;
      const res = await this._streamOnce(cfg, messages, signal, tools);
      // los límites del usuario (tokens/coste) también cuentan dentro del subagente
      if (res.usage) {
        const tok = this.guardrails.addTokens(res.usage.total_tokens || 0, res.usage);
        if (!tok.ok) { this.emit({ type: 'guardrail', reason: tok.reason }); break; }
      }
      if (res.aborted) break;
      if (!res.toolCalls || !res.toolCalls.length) { onFinalText(res.text); return; }
      const msg = { role: 'assistant', content: res.text || '', tool_calls: res.toolCalls };
      if (!res.text) delete msg.content;
      messages.push(msg);
      // toda tool_call debe recibir su respuesta: cortar el bucle a mitad dejaría
      // un assistant con tool_calls sin responder y la API devolvería 400
      const answered = new Set();
      const closePending = (reason) => {
        for (const tc of res.toolCalls) {
          if (answered.has(tc.id)) continue;
          answered.add(tc.id);
          messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: reason });
        }
      };
      for (const tc of res.toolCalls) {
        if (signal.aborted) { closePending('(no ejecutada: ejecución detenida)'); break; }
        // Mismo camino de ejecución que el bucle principal: antes esto era una
        // copia que iba por detrás (sin alcance real de herramientas, sin marcar
        // sensibilidad en la confirmación y sin los arreglos del otro bucle).
        const r = await this._runToolCall(tc, {
          signal, settings, tools, noDelegate: true,
          onStatus: null,   // los pasos del subagente los resume el orquestador
        });
        if (r.action === 'limit') { closePending('(no ejecutada: límite de llamadas alcanzado)'); break; }
        if (r.action === 'loop') { closePending('(no ejecutada: bucle detectado)'); break; }
        if (r.action === 'aborted') { closePending('(no ejecutada: ejecución detenida)'); break; }
        answered.add(tc.id);
        const content = r.action === 'ok' && r.images && cfg.vision !== false
          ? [{ type: 'text', text: r.text }, ...r.images.map(u => ({ type: 'image_url', image_url: { url: u } }))]
          : r.text;
        messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content });
      }
    }
    // si el bucle terminó por límite/abort, entrega lo último que dijo el subagente
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
    onFinalText(lastAssistant ? String(lastAssistant.content) : '');
  }

  /** v1.6: recorre la cadena de modelos; si uno falla (HTTP/red), prueba el
      siguiente y registra la salud de cada intento. */
  async _streamWithFallback(chain, messages, signal) {
    let lastErr = null;
    for (const entry of chain) {
      const t0 = Date.now();
      const cfg = { ...entry, format: entry.format || protocols.detectFormat(entry) };
      try {
        const res = await this._streamOnce(cfg, messages, signal);
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
   * Una vuelta del modelo con el protocolo adecuado al proveedor/modelo.
   * El multi-formato (OpenAI / Anthropic / Responses) vive en agent/protocols.js:
   * aquí solo se fija la temperatura del modo y se reenvían los deltas a la UI.
   */
  async _streamOnce(cfg, messages, signal, toolsOverride = null) {
    const temperature = cfg.temperature ?? (this._mode ? this._mode.temperature : 0.4);
    return protocols.stream(
      { ...cfg, temperature, sessionId: this.sessionId, silenceTimeoutMs: this._llmTimeoutMs ?? undefined },
      {
        fetchFn: this.fetchFn,
        messages,
        tools: toolsOverride || allToolDefs(),
        signal,
        onText: (text) => this.emit({ type: 'delta', text }),
      }
    );
  }
}

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

module.exports = { Agent, systemPrompt };
