'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { toolDefs } = require('./tools');
const { executeTool } = require('./executors');
const skills = require('./skills');
const { Guardrails } = require('./guardrails');
const runlog = require('./runlog');

function loadMemory() {
  try {
    const p = path.join(process.env.APPDATA || os.homedir(), 'SagitariAI', 'memory.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return []; }
}

function systemPrompt() {
  const home = os.homedir();
  return `Eres SAGITARI, un agente de IA con control total del PC con Windows del usuario. Estás integrado en un panel de control holográfico en la pantalla del usuario.

IDENTIDAD
- Personalidad: capaz, eficiente y con carisma sutil (como un mayordomo de élite). Respuestas breves y claras; nada de relleno.
- Idioma: responde SIEMPRE en el idioma del usuario (por defecto español).

CAPACIDADES
- Controlas el PC: terminal, archivos, aplicaciones, navegador real (Chrome/Edge vía DevTools), portapapeles, multimedia, notificaciones y capturas de pantalla.
- Home del usuario: ${home}. Escritorio: ${home}\\Desktop.
- No pidas permiso para cosas triviales; actúa. Para acciones potencialmente destructivas (borrar datos, cerrar sesión, compras), confirma antes.

REGLAS DE HERRAMIENTAS
- Usa las herramientas libremente y en cadena hasta completar la petición. Tras usar una, evalúa el resultado y decide el siguiente paso.
- Para navegar/controlar webs usa browser_control. REGLAS DE ORO:
  * Una sola ventana con pestañas: launch abre (o REUTILIZA si ya está abierto) el navegador con la url; nunca relances si ya está abierto — usa navigate, new_tab o select_tab.
  * Gestiona pestañas: tabs lista las abiertas (con la activa marcada), new_tab abre y selecciona, select_tab cambia (por número o texto del título), close_tab cierra.
  * Para hacer clic, prefiere text (texto visible del botón/enlace) antes que selector CSS. Si dudas de qué hay en pantalla: action=screenshot (mira la imagen) o action=content (lee el texto).
  * type escribe en un campo (clear=true vacía antes; submit=true pulsa Enter, ideal para búsquedas). navigate espera a que la página cargue; usa wait si un elemento tarda en aparecer.
  * Cada acción devuelve OK/Error con detalle: léelo y decide el siguiente paso; si un clic falla, haz screenshot antes de reintentar a ciegas.
- Con run_command usa sintaxis de cmd.exe de Windows. No uses comandos interactivos.

SKILLS DISPONIBLES (instrucciones especializadas cargables)
Antes de tareas donde una skill aplique, llama a use_skill con su nombre: te devolverá instrucciones expertas que debes seguir. No la cites al usuario; aplícala.
${skills.promptIndexSync()}
- MEMORIA PERSISTENTE del usuario (usala si es relevante, no la cites completa):
${(loadMemory() || []).slice(0, 30).map(m => '- ' + m.text).join('\n') || '(vacía)'}
- Cuando termines una tarea con pasos, resume en 1-3 líneas lo que hiciste y el resultado.
- Si la petición es conversacional (saludo, pregunta), responde directamente sin herramientas.

FORMATO
- Tus respuestas se muestran en un chat con soporte markdown ligero (negrita, listas, código). Sé visual y ordenado.`;
}

const MODE_PROFILES = {
  think: { temperature: 0.7, maxSteps: 20, planFirst: false, note: 'Piensas antes de actuar: razona paso a paso en tu respuesta final, explora alternativas, sé meticuloso.' },
  plan:  { temperature: 0.35, maxSteps: 20, planFirst: true,  note: 'PRIMERO presenta un PLAN numerado breve (3-6 pasos) y luego ejecútalo con herramientas, paso a paso.' },
  act:   { temperature: 0.25, maxSteps: 12, planFirst: false, note: 'Actúa directo y eficiente: minimiza explicaciones, ejecuta y reporta el resultado.' }
};

class Agent {
  constructor(opts) {
    this.fetchFn = opts.fetchFn || fetch;
    this.emit = opts.emit;               // (event) => void  (to renderer)
    this.screenshotFn = opts.screenshotFn;
    this.browser = opts.browser;
    this.history = [];                   // [{role, content, tool_calls?, tool_call_id?, name?, images?}]
    this.busy = false;
    this.abort = null;
    this.stopRequested = false;       // el usuario pulsó Detener en esta conversación
    this.runningTool = null;          // { stop() } de la herramienta en ejecución
    this.toolsFired = new Map();      // name -> {count, lastAt}
    this.guardrails = new Guardrails(opts.guardrailsPolicy || {});   // límites + permisos
    this.pendingConfirm = null;       // {resolve, call} mientras el usuario decide
    this.meta = { model: null, tokensIn: 0, tokensOut: 0, llmCalls: 0, toolCalls: 0, startedAt: null, lastLatencyMs: null, lastError: null };
  }

  setPolicy(policy) { this.guardrails.setPolicy(policy); }

  /** Respuesta del usuario a una tarjeta de confirmación (toolbar del chat). */
  resolveConfirm(id, approved) {
    const pc = this.pendingConfirm;
    if (!pc || pc.id !== id) return false;
    this.pendingConfirm = null;
    pc.resolve(!!approved);
    return true;
  }

  getMeta() { return { ...this.meta, busy: this.busy }; }

  isBusy() { return this.busy; }
  getToolsFired() {
    return [...this.toolsFired.entries()].map(([name, v]) => ({ name, count: v.count, lastAt: v.lastAt }));
  }

  activeConfig(settings) {
    return settings.active;
  }

  async chat(userText, settings, imageDataUrl) {
    if (this.busy) { this.emit({ type: 'error', message: 'SAGITARI está ocupado terminando la tarea anterior.' }); return; }
    this.busy = true;
    this.stopRequested = false;
    const controller = new AbortController();
    this.abort = controller;
    try {
      await this._run(userText, settings, imageDataUrl, controller.signal);
    } catch (e) {
      if (this.stopRequested || e.name === 'AbortError') {
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

  // Detener de verdad: aborta el fetch del modelo Y mata el comando/herramienta
  // en ejecución (terminal, navegador, etc.). Sin esto el botón solo tomba efecto
  // cuando la herramienta actual terminara sola.
  stop() {
    this.stopRequested = true;
    if (this.abort) this.abort.abort();
    if (this.runningTool && typeof this.runningTool.stop === 'function') {
      try { this.runningTool.stop(); } catch {}
    }
  }

  async _run(userText, settings, imageDataUrl, signal) {
    const cfg = this.activeConfig(settings);
    if (!cfg || !cfg.baseUrl || !cfg.model) {
      this.emit({ type: 'error', message: 'Configura un proveedor y modelo en Ajustes antes de hablar con Sagitari.' });
      return;
    }
    const mode = MODE_PROFILES[settings.settings?.mode] || MODE_PROFILES.act;
    this._mode = mode;
    this.meta.model = cfg.model || this.meta.model;
    this.meta.startedAt = Date.now();
    this.meta.lastError = null;
    this.guardrails.beginRun();
    const runStart = Date.now();
    const runId = 'r' + runStart.toString(36);
    runlog.log({ agent: 'sagitari', task: runId, event: 'run_start', mode: settings.settings?.mode || 'act', model: cfg.model });

    const content = imageDataUrl
      ? [{ type: 'text', text: userText || 'Analiza esta imagen' }, { type: 'image_url', image_url: { url: imageDataUrl } }]
      : userText;
    this.history.push({ role: 'user', content });
    if (this.history.length > 40) this.history = this.history.slice(-40);

    const ws = (settings.settings && settings.settings.workspace) || path.join(os.homedir(), 'Desktop', 'Sagitari');
    const sys = systemPrompt()
      + `\n\nESPACIO DE TRABAJO: ${ws}`
      + '\n- Es la carpeta por defecto para crear/modificar archivos; las rutas relativas resuelven aquí.'
      + '\n- Solo toques otras ubicaciones si el usuario lo pide explícitamente (ruta absoluta).'
      + `\n\nMODO ACTUAL (${settings.settings?.mode || 'act'}): ${mode.note}`
      + (mode.planFirst ? '\nFormato del plan: una línea por paso, empieza tu respuesta con "PLAN:" y numera los pasos.' : '');
    const messages = [{ role: 'system', content: sys }, ...this.history.map(h => ({ role: h.role, content: h.content, ...(h.tool_calls ? { tool_calls: h.tool_calls } : {}), ...(h.tool_call_id ? { tool_call_id: h.tool_call_id } : {}), ...(h.name ? { name: h.name } : {}) }))];

    this.emit({ type: 'busy', busy: true });
    let assistantSaidSomething = false;

    while (true) {
      // ---- guardrail: límites de pasos / tiempo (configurables; 0 = sin límite) ----
      const stepCheck = this.guardrails.checkStep();
      if (!stepCheck.ok) {
        this.emit({ type: 'status', text: 'Límite de seguridad alcanzado — detenido' });
        this.emit({ type: 'guardrail', reason: stepCheck.reason });
        runlog.log({ agent: 'sagitari', task: runId, event: 'guardrail_stop', reason: stepCheck.reason });
        this._pushAssistant(assistantSaidSomething ? { role: 'assistant', content: '(detenido por límite de seguridad)' } : null);
        return;
      }
      if (signal.aborted) {
        this._pushAssistant(assistantSaidSomething ? { role: 'assistant', content: '(detenido por el usuario)' } : null);
        this.emit({ type: 'stopped' });
        return;
      }
      const t0 = Date.now();
      const res = await this._streamOnce(cfg, messages, signal);
      this.meta.llmCalls++;
      this.meta.lastLatencyMs = Date.now() - t0;
      if (res.usage) {
        this.meta.tokensIn += res.usage.prompt_tokens || 0;
        this.meta.tokensOut += res.usage.completion_tokens || 0;
        runlog.log({ agent: 'sagitari', task: runId, event: 'llm', model: cfg.model, durationMs: this.meta.lastLatencyMs, tokens: res.usage });
        const tok = this.guardrails.addTokens((res.usage.total_tokens || 0));
        if (!tok.ok) {
          this.emit({ type: 'guardrail', reason: tok.reason });
          this._pushAssistant(assistantSaidSomething ? { role: 'assistant', content: '(detenido por límite de tokens)' } : null);
          return;
        }
      }
      if (res.aborted) { this._pushAssistant(assistantSaidSomething ? { role: 'assistant', content: res.text || '(interrumpido)' } : null); this.emit({ type: 'stopped' }); return; }

      if (res.toolCalls && res.toolCalls.length) {
        const msg = { role: 'assistant', content: res.text || '', tool_calls: res.toolCalls };
        if (!res.text) delete msg.content;
        messages.push(msg);
        this.history.push(JSON.parse(JSON.stringify(msg)));

        for (const tc of res.toolCalls) {
          if (signal.aborted) break;
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
          this.emit({ type: 'tool', name: tc.function.name, args });
          this.emit({ type: 'status', text: statusFor(tc.function.name, args) });
          const tf = this.toolsFired.get(tc.function.name) || { count: 0, lastAt: 0 };
          this.toolsFired.set(tc.function.name, { count: tf.count + 1, lastAt: Date.now() });

          // ---- guardrail: límite de llamadas + detección de bucles ----
          const callCheck = this.guardrails.checkToolCall();
          if (!callCheck.ok) { this.emit({ type: 'guardrail', reason: callCheck.reason }); break; }
          const loop = this.guardrails.isLoop(tc.function.name, args);
          if (loop.loop) {
            const reason = `Bucle detectado (${loop.pattern}): la misma acción se repite sin avanzar. Ejecución detenida para proteger el sistema.`;
            this.emit({ type: 'status', text: 'Bucle detectado — detenido' });
            this.emit({ type: 'guardrail', reason });
            runlog.log({ agent: 'sagitari', task: runId, event: 'loop_detected', tool: tc.function.name, pattern: loop.pattern });
            this._pushAssistant(assistantSaidSomething ? { role: 'assistant', content: '(detenido: bucle detectado)' } : null);
            return;
          }

          // ---- permisos: safe → ejecuta; confirm → pregunta; restricted → bloquea ----
          const decision = this.guardrails.decide(tc.function.name, args);
          if (decision.action === 'deny') {
            const text = decision.reason;
            messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: text });
            this.history.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: text });
            this.emit({ type: 'tool_result', name: tc.function.name, result: text.slice(0, 400) });
            continue;
          }
          if (decision.action === 'confirm') {
            const cid = 'c' + Date.now().toString(36);
            this.emit({ type: 'confirm_request', id: cid, tool: tc.function.name, description: decision.description, summary: decision.summary });
            runlog.log({ agent: 'sagitari', task: runId, event: 'confirm_request', tool: tc.function.name, args });
            const approved = await new Promise((resolve) => { this.pendingConfirm = { id: cid, resolve }; });
            if (!approved) {
              const text = 'El usuario DENEGÓ esta acción. No la repitas; continúa con la tarea por otra vía o pregunta qué prefiere hacer.';
              messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: text });
              this.history.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: text });
              this.emit({ type: 'tool_result', name: tc.function.name, result: 'Denegado por el usuario' });
              continue;
            }
            this.guardrails.approve(decision.signature);
          }

          const toolT0 = Date.now();
          let result;
          try {
            result = await executeTool(tc.function.name, args, {
              emit: (e) => this.emit(e),
              screenshotFn: this.screenshotFn,
              browser: this.browser,
              settings,
              home: os.homedir(),
              workspace: (settings.settings && settings.settings.workspace) || path.join(os.homedir(), 'Desktop', 'Sagitari'),
              registerKillable: (k) => { this.runningTool = k; }   // para poder matar el comando al Detener
            });
          } catch (e) { result = 'Error: ' + e.message; }
          this.runningTool = null;
          this.meta.toolCalls++;
          const images = result && typeof result === 'object' ? result.images : undefined;
          const text = result && typeof result === 'object' ? result.text : String(result);
          runlog.log({
            agent: 'sagitari', task: runId, event: 'tool', tool: tc.function.name,
            args, durationMs: Date.now() - toolT0,
            success: !(typeof text === 'string' && text.startsWith('Error')),
            error: (typeof text === 'string' && text.startsWith('Error')) ? String(text).slice(0, 200) : undefined,
          });
          // Feed vision inputs (screenshots) back to the model when supported
          const toolContent = images && cfg.vision !== false
            ? [{ type: 'text', text }, ...images.map(u => ({ type: 'image_url', image_url: { url: u } }))]
            : text;
          messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: toolContent });
          this.history.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: text });
          this.emit({ type: 'tool_result', name: tc.function.name, result: String(text).slice(0, 400) });
          assistantSaidSomething = true;
        }
        continue; // next loop: model reacts to tool results
      }

      // Final text answer
      this.history.push({ role: 'assistant', content: res.text });
      runlog.log({ agent: 'sagitari', task: runId, event: 'run_end', durationMs: Date.now() - runStart, tokens: { prompt_tokens: this.meta.tokensIn, completion_tokens: this.meta.tokensOut } });
      this.emit({ type: 'assistant_done', text: res.text });
      return;
    }
  }

  _pushAssistant(msg) { if (msg) { this.history.push(msg); this.emit({ type: 'assistant_done', text: msg.content }); } }

  async _streamOnce(cfg, messages, signal) {
    const body = {
      model: cfg.model,
      messages,
      stream: true,
      temperature: cfg.temperature ?? (this._mode ? this._mode.temperature : 0.4),
      tools: toolDefs,
      tool_choice: 'auto'
    };
    if (cfg.maxTokens) body.max_tokens = cfg.maxTokens;
    // Ask OpenAI-compatible providers to include usage in the final SSE chunk
    // (harmless for those that ignore it; Ollama's OpenAI layer includes usage anyway).
    if (!cfg.noUsage) body.stream_options = { include_usage: true };

    const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const resp = await this.fetchFn(url, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {})
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status} de ${cfg.name || cfg.baseUrl}: ${t.slice(0, 300)}`);
    }

    let text = '';
    let aborted = false;
    let usage = null;
    const toolCalls = [];
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let first = true;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal.aborted) { aborted = true; try { reader.cancel(); } catch {} break; }
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json;
        try { json = JSON.parse(payload); } catch { continue; }
        if (json.usage) usage = json.usage;   // chunk final (choices vacías) con tokens
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          if (first && /^\s*$/.test(delta.content)) continue;
          first = false;
          text += delta.content;
          this.emit({ type: 'delta', text: delta.content });
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!toolCalls[i]) toolCalls[i] = { id: tc.id || 'call_' + i, type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) toolCalls[i].id = tc.id;
            if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
          }
        }
      }
    }
    return { text: text.trim(), toolCalls: toolCalls.filter(Boolean).filter(t => t.function.name), aborted, usage };
  }
}

function statusFor(name, args) {
  switch (name) {
    case 'run_command': return 'Terminal — ' + (args.command || '').slice(0, 90);
    case 'read_file': return 'Leyendo ' + args.path;
    case 'write_file': return 'Escribiendo ' + args.path;
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
