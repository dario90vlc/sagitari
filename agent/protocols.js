'use strict';

/* Protocolos de proveedor de SAGITARI (multi-formato).

   Hasta ahora el agente hablaba SOLO el formato OpenAI `/chat/completions`.
   Eso deja fuera modelos que los proveedores sirven con otra forma de API:

     openai      → POST {base}/chat/completions   (OpenAI, Groq, Ollama, LM Studio,
                                                   OpenRouter, OpenCode Go*, Zen…)
     anthropic   → POST {base}/messages           (Claude, y en OpenCode Go los
                                                   MiniMax y Qwen3.x)
     responses   → POST {base}/responses          (API Responses de OpenAI, y en
                                                   OpenCode Go Grok 4.6, GPT 5.6
                                                   Luna y Muse Spark)

   Cada adaptador expone la MISMA interfaz, así que agent.js no necesita saber
   nada del proveedor:

     detectFormat({ baseUrl, providerId, model, format }) → 'openai'|'anthropic'|'responses'
     authHeaders(cfg, format)                             → cabeceras (Bearer o x-api-key)
     buildBody(format, cfg, messages, tools)              → cuerpo completo de la petición
     stream(cfg, { fetchFn, messages, tools, signal, onText })
        → { text, toolCalls, usage, aborted }   (toolCalls en formato OpenAI unificado)

   Unificado: el resto del agente sigue viendo `messages` estilo OpenAI
   (role assistant+tool_calls / role tool+tool_call_id) y `toolCalls` con
   `{ id, type:'function', function:{ name, arguments } }`.

   Puro Node (usa web stream nativo) → testeable sin red con un fetch falso. */

const opencode = require('./opencode');

const FORMATS = ['openai', 'anthropic', 'responses'];

/* ------------------------------------------------------------------------ *
 *  ¿Qué formato necesita cada modelo?
 * ------------------------------------------------------------------------ */

/* OpenCode Go sirve cada modelo en uno de los tres endpoints (docs /docs/go).
   Los que NO están aquí usan /chat/completions (el caso por defecto). */
const OPENCODE_MODEL_FORMAT = {
  // --- /messages (formato Anthropic) ---
  'minimax-m3': 'anthropic',
  'minimax-m2.7': 'anthropic',
  'minimax-m2.5': 'anthropic',
  'qwen3.8-max': 'anthropic',
  'qwen3.8-flash': 'anthropic',
  'qwen3.7-max': 'anthropic',
  'qwen3.7-plus': 'anthropic',
  'qwen3.6-plus': 'anthropic',
  // --- /responses (API Responses de OpenAI) ---
  'grok-4.6': 'responses',
  'gpt-5.6-luna': 'responses',
  'muse-spark-1.3-contributor': 'responses',
  'muse-spark-1.2-contributor': 'responses',
};

const norm = (s) => String(s || '').toLowerCase().trim();

/**
 * Decide el protocolo de una petición.
 * Prioridad: override explícito (`format`) → proveedor conocido → por defecto openai.
 */
function detectFormat(input = {}) {
  const explicit = norm(input.format);
  if (FORMATS.includes(explicit)) return explicit;
  const pid = norm(input.providerId);
  const bu = norm(input.baseUrl);
  const model = norm(input.model).split('/').pop();   // admite "opencode-go/glm-5.3-flash"
  if (pid.includes('anthropic') || bu.includes('anthropic.com')) return 'anthropic';
  if (pid.includes('opencode') || bu.includes('opencode.ai')) {
    return OPENCODE_MODEL_FORMAT[model] || 'openai';
  }
  return 'openai';
}

/* ------------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------------ */

const joinUrl = (baseUrl, path) => String(baseUrl || '').replace(/\/+$/, '') + path;

function httpError(resp, cfg, text) {
  const who = cfg.name || cfg.providerId || cfg.baseUrl || 'el proveedor';
  return new Error(`HTTP ${resp.status} de ${who}: ${String(text || '').slice(0, 300)}`);
}

/** Cabeceras de autenticación según el protocolo (Bearer vs x-api-key). */
function authHeaders(cfg, format) {
  const h = { 'Content-Type': 'application/json', 'User-Agent': opencode.userAgent() };
  if (format === 'anthropic') {
    h['anthropic-version'] = '2023-06-01';
    if (cfg.apiKey) h['x-api-key'] = cfg.apiKey;
  } else if (cfg.apiKey) {
    h.Authorization = 'Bearer ' + cfg.apiKey;
  }
  // OpenCode Go/Zen exige sesión (400 MissingSessionID sin ella)
  Object.assign(h, opencode.identityHeaders(cfg.baseUrl, cfg.sessionId));
  return h;
}

/** Texto plano de un contenido (string o array de partes). */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content ? String(content) : '';
  return content.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n');
}

/** Descompone un data-URL de imagen. */
function dataUrlParts(url) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/is.exec(String(url || ''));
  if (!m) return null;
  return { media_type: m[1] || 'image/png', base64: !!m[2], data: m[3] || '' };
}

/** Imágenes (data-URLs) incluidas en un contenido — p. ej. el screenshot de una
    herramienta. Los formatos no-OpenAI necesitan traducirlas a sus bloques. */
function imagesOf(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const part of content) {
    if (part && part.type === 'image_url' && part.image_url?.url) out.push(part.image_url.url);
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 *  Lectura de SSE (sirve para los tres protocolos)
 * ------------------------------------------------------------------------ */

function parseSSEBlock(raw) {
  const lines = String(raw).split('\n');
  let event = null;
  const data = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  return { event, data: data.join('\n') };
}

/* Silencio máximo del proveedor: si no llega NI UN byte en este tiempo, la
   lectura se corta con error y la cadena de fallback puede probar otro modelo.
   Era el fallo más traicionero: un proveedor que acepta la conexión y no envía
   nada dejaba el turno «ocupado» para siempre y la app parecía muerta.
   0 = sin límite (no recomendado); sin valor = el default de abajo. */
const DEFAULT_SILENCE_MS = 120000;

/**
 * Lee el cuerpo SSE de una respuesta y entrega cada evento ya parseado.
 * opts.silenceTimeoutMs: ms sin recibir nada antes de abortar con error.
 * Si `onEvent` devuelve false, la lectura termina ahí sin error: es la señal de
 * que el adaptador ya tiene la respuesta entera (terminador visto).
 * @returns {Promise<boolean>} true si se abortó a mitad
 * @throws {Error} si el proveedor se queda mudo más de `silenceTimeoutMs`
 */
async function readSSE(resp, signal, onEvent, opts = {}) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let aborted = false;
  let complete = false;   // el adaptador avisó de que la respuesta ya está entera
  let idleError = null;
  let idleTimer = null;
  let idleMs = DEFAULT_SILENCE_MS;
  if (opts && 'silenceTimeoutMs' in opts) {
    const v = Number(opts.silenceTimeoutMs);
    idleMs = v > 0 ? v : 0;
  }
  // El abort debe cortar la lectura AUNQUE el stream se haya quedado mudo: si el
  // proveedor no envía nada, `reader.read()` se quedaría esperando para siempre
  // y el botón Detener no haría nada. Cancelar el reader resuelve la lectura.
  const stop = () => {
    aborted = true;
    try { reader.cancel().catch(() => {}); } catch {}
  };
  if (signal) {
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  }
  // Y el silencio también: cada chunk reinicia el reloj; si vence, cortamos la
  // lectura y salimos con error en vez de colgar el turno eternamente.
  const disarmIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
  const armIdle = () => {
    disarmIdle();
    if (!idleMs) return;
    idleTimer = setTimeout(() => {
      // si el usuario abortó justo en la ventana del timeout, gana el abort: no
      // se reporta un timeout que en realidad fue una parada manual
      if (signal && signal.aborted) return;
      idleError = new Error(`timeout: el proveedor no envió datos durante ${Math.round(idleMs / 1000)} s (modelo saturado o bloqueado; prueba otro modelo en Ajustes).`);
      aborted = true;
      stop();
    }, idleMs);
  };
  armIdle();
  try {
    while (!aborted && !complete) {
      let step;
      try { step = await reader.read(); }
      catch (e) { if (aborted || (signal && signal.aborted)) { aborted = true; break; } throw e; }
      const { done, value } = step;
      if (done) break;
      armIdle();
      buf = (buf + decoder.decode(value, { stream: true })).replace(/\r/g, '');
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseSSEBlock(block);
        // onEvent devuelve false al ver el terminador ([DONE], message_stop,
        // response.completed). Sin esto, un proveedor (o un proxy con keep-alive)
        // que deja el socket abierto tras la respuesta completa hacía esperar al
        // temporizador de silencio: se tiraba una respuesta YA recibida y el
        // fallback la reintentaba en otro modelo, pagándola dos veces.
        if (ev && onEvent(ev) === false) { complete = true; break; }
      }
    }
  } finally {
    disarmIdle();
    if (signal) signal.removeEventListener('abort', stop);
  }
  if (complete) {
    // soltar la conexión aunque el proveedor no la cierre
    try { reader.cancel().catch(() => {}); } catch {}
  }
  if (idleError) throw idleError;
  if (!aborted && !complete) {
    const tail = parseSSEBlock(buf);
    if (tail) onEvent(tail);
  }
  return aborted;
}

/* ------------------------------------------------------------------------ *
 *  Protocolo OpenAI (/chat/completions)
 * ------------------------------------------------------------------------ */

function buildBodyOpenAI(cfg, messages, tools) {
  const body = {
    model: cfg.model,
    messages,
    stream: true,
    temperature: cfg.temperature,
    tools,
    tool_choice: 'auto',
  };
  if (cfg.maxTokens) body.max_tokens = cfg.maxTokens;
  // Pide el uso de tokens en el chunk final (los que lo ignoran, lo ignoran).
  if (!cfg.noUsage) body.stream_options = { include_usage: true };
  return body;
}

async function streamOpenAI(cfg, { fetchFn, messages, tools, signal, onText }) {
  const url = joinUrl(cfg.baseUrl, '/chat/completions');
  const resp = await fetchFn(url, {
    method: 'POST',
    signal,
    headers: authHeaders(cfg, 'openai'),
    body: JSON.stringify(buildBodyOpenAI(cfg, messages, tools)),
  });
  if (!resp.ok) throw httpError(resp, cfg, await resp.text().catch(() => ''));

  let text = '';
  let usage = null;
  let first = true;
  const toolCalls = [];
  const aborted = await readSSE(resp, signal, (ev) => {
    if (ev.data === '[DONE]') return false;   // respuesta completa: no esperar al cierre del socket
    let json;
    try { json = JSON.parse(ev.data); } catch { return; }
    if (json.usage) usage = json.usage;
    const delta = json.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) {
      if (first && /^\s*$/.test(delta.content)) return;
      first = false;
      text += delta.content;
      onText(delta.content);
    }
    for (const tc of delta.tool_calls || []) {
      const i = tc.index ?? 0;
      if (!toolCalls[i]) toolCalls[i] = { id: tc.id || 'call_' + i, type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) toolCalls[i].id = tc.id;
      if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
      if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
    }
  }, { silenceTimeoutMs: cfg.silenceTimeoutMs });
  return {
    text: text.trim(),
    toolCalls: toolCalls.filter(Boolean).filter(t => t.function.name),
    aborted,
    usage,
  };
}

/* ------------------------------------------------------------------------ *
 *  Protocolo Anthropic (/messages)
 * ------------------------------------------------------------------------ */

/** Coalesce mensajes con el mismo rol: Anthropic exige alternancia user/assistant. */
function mergeRoles(list) {
  const out = [];
  for (const m of list) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      const a = Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content || '') }];
      const b = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
      last.content = [...a, ...b];
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function toAnthropicMessages(messages) {
  const system = [];
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') { const t = textOf(m.content); if (t) system.push(t); continue; }

    if (m.role === 'tool') {
      // tool_result admite bloques de texto e imagen: no perdemos los screenshots
      const parts = [];
      const t = textOf(m.content);
      if (t) parts.push({ type: 'text', text: t });
      for (const url of imagesOf(m.content)) {
        const d = dataUrlParts(url);
        if (d && d.base64) parts.push({ type: 'image', source: { type: 'base64', media_type: d.media_type, data: d.data } });
      }
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: parts.length ? parts : 'OK' };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)
          && last.content.length && last.content.every(b => b.type === 'tool_result')) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (m.role === 'assistant') {
      const blocks = [];
      const t = textOf(m.content);
      if (t) blocks.push({ type: 'text', text: t });
      for (const tc of m.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
      continue;
    }

    // user
    if (typeof m.content === 'string') {
      if (m.content) out.push({ role: 'user', content: m.content });
      continue;
    }
    const blocks = [];
    for (const part of m.content || []) {
      if (!part) continue;
      if (part.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text });
      else if (part.type === 'image_url') {
        const d = dataUrlParts(part.image_url?.url);
        if (d && d.base64) blocks.push({ type: 'image', source: { type: 'base64', media_type: d.media_type, data: d.data } });
        else if (part.image_url?.url) blocks.push({ type: 'image', source: { type: 'url', url: part.image_url.url } });
      }
    }
    if (blocks.length) out.push({ role: 'user', content: blocks });
  }
  // Anthropic exige empezar por 'user'
  while (out.length && out[0].role !== 'user') out.shift();
  return { system: system.join('\n\n'), messages: mergeRoles(out) };
}

function buildBodyAnthropic(cfg, messages, tools) {
  const { system, messages: msgs } = toAnthropicMessages(messages);
  const body = {
    model: cfg.model,
    max_tokens: cfg.maxTokens || 4096,   // obligatorio en la API Messages
    stream: true,
    messages: msgs,
  };
  if (typeof cfg.temperature === 'number' && cfg.temperature > 0) body.temperature = cfg.temperature;
  if (system) body.system = system;
  if (tools && tools.length) {
    body.tools = tools.map(t => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description || '',
      input_schema: t.function?.parameters || t.parameters || { type: 'object', properties: {} },
    }));
  }
  return body;
}

async function streamAnthropic(cfg, { fetchFn, messages, tools, signal, onText }) {
  const url = joinUrl(cfg.baseUrl, '/messages');
  const resp = await fetchFn(url, {
    method: 'POST',
    signal,
    headers: authHeaders(cfg, 'anthropic'),
    body: JSON.stringify(buildBodyAnthropic(cfg, messages, tools)),
  });
  if (!resp.ok) throw httpError(resp, cfg, await resp.text().catch(() => ''));

  let text = '';
  let usage = null;
  let failure = null;
  const blocks = new Map();   // index -> { id, name, args }
  const aborted = await readSSE(resp, signal, (ev) => {
    let json;
    try { json = JSON.parse(ev.data); } catch { return; }
    const type = json.type || ev.event;
    switch (type) {
      case 'message_start':
        if (json.message?.usage) {
          usage = {
            prompt_tokens: json.message.usage.input_tokens || 0,
            completion_tokens: json.message.usage.output_tokens || 0,
          };
        }
        break;
      case 'content_block_start':
        if (json.content_block?.type === 'tool_use') {
          blocks.set(json.index ?? 0, { id: json.content_block.id, name: json.content_block.name, args: '' });
        }
        break;
      case 'content_block_delta': {
        const d = json.delta || {};
        if (d.type === 'text_delta' && d.text) { text += d.text; onText(d.text); }
        else if (d.type === 'input_json_delta') {
          const b = blocks.get(json.index ?? 0);
          if (b) b.args += d.partial_json || '';
        }
        break;   // thinking_delta se ignora: no exponemos el razonamiento interno
      }
      case 'message_delta':
        if (json.usage?.output_tokens != null) {
          usage = { ...(usage || {}), completion_tokens: json.usage.output_tokens };
        }
        break;
      case 'message_stop':
        return false;   // respuesta completa: no esperar al cierre del socket
      case 'error':
        failure = new Error(`Anthropic: ${json.error?.message || 'error de streaming'}`);
        break;
    }
  }, { silenceTimeoutMs: cfg.silenceTimeoutMs });
  if (failure) throw failure;

  if (usage) usage = { ...usage, total_tokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0) };
  return {
    text: text.trim(),
    toolCalls: [...blocks.values()].map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.args || '{}' } })),
    aborted,
    usage,
  };
}

/* ------------------------------------------------------------------------ *
 *  Protocolo OpenAI Responses (/responses)
 * ------------------------------------------------------------------------ */

function toResponsesInput(messages) {
  const instructions = [];
  const input = [];
  for (const m of messages) {
    if (m.role === 'system') { const t = textOf(m.content); if (t) instructions.push(t); continue; }

    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: textOf(m.content) || 'OK' });
      // las imágenes de una herramienta viajan como entrada de usuario aparte
      // (function_call_output solo admite texto en la API Responses)
      const imgs = imagesOf(m.content);
      if (imgs.length) input.push({ role: 'user', content: imgs.map(url => ({ type: 'input_image', image_url: url })) });
      continue;
    }

    if (m.role === 'assistant') {
      const t = textOf(m.content);
      if (t) input.push({ role: 'assistant', content: [{ type: 'output_text', text: t }] });
      for (const tc of m.tool_calls || []) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments || '{}' });
      }
      continue;
    }

    const content = [];
    if (typeof m.content === 'string') { if (m.content) content.push({ type: 'input_text', text: m.content }); }
    else for (const part of m.content || []) {
      if (!part) continue;
      if (part.type === 'text' && part.text) content.push({ type: 'input_text', text: part.text });
      else if (part.type === 'image_url' && part.image_url?.url) content.push({ type: 'input_image', image_url: part.image_url.url });
    }
    if (content.length) input.push({ role: 'user', content });
  }
  return { instructions: instructions.join('\n\n'), input };
}

function buildBodyResponses(cfg, messages, tools) {
  const { instructions, input } = toResponsesInput(messages);
  const body = { model: cfg.model, stream: true, input };
  if (instructions) body.instructions = instructions;
  if (typeof cfg.temperature === 'number') body.temperature = cfg.temperature;
  if (cfg.maxTokens) body.max_output_tokens = cfg.maxTokens;
  if (tools && tools.length) {
    body.tools = tools.map(t => ({
      type: 'function',
      name: t.function?.name || t.name,
      description: t.function?.description || t.description || '',
      parameters: t.function?.parameters || t.parameters || { type: 'object', properties: {} },
    }));
  }
  return body;
}

async function streamResponses(cfg, { fetchFn, messages, tools, signal, onText }) {
  const url = joinUrl(cfg.baseUrl, '/responses');
  const resp = await fetchFn(url, {
    method: 'POST',
    signal,
    headers: authHeaders(cfg, 'openai'),
    body: JSON.stringify(buildBodyResponses(cfg, messages, tools)),
  });
  if (!resp.ok) throw httpError(resp, cfg, await resp.text().catch(() => ''));

  let text = '';
  let usage = null;
  let failure = null;
  const calls = new Map();   // item_id -> { id, name, args }
  const aborted = await readSSE(resp, signal, (ev) => {
    let json;
    try { json = JSON.parse(ev.data); } catch { return; }
    const type = json.type || ev.event;
    switch (type) {
      case 'response.output_text.delta':
        if (json.delta) { text += json.delta; onText(json.delta); }
        break;
      case 'response.output_item.added':
        if (json.item?.type === 'function_call') {
          calls.set(json.item.id, { id: json.item.call_id || json.item.id, name: json.item.name, args: '' });
        }
        break;
      case 'response.function_call_arguments.delta': {
        const c = calls.get(json.item_id) || [...calls.values()].pop();
        if (c) c.args += json.delta || '';
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const u = json.response?.usage;
        if (u) usage = { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0, total_tokens: u.total_tokens || ((u.input_tokens || 0) + (u.output_tokens || 0)) };
        return false;   // respuesta completa: no esperar al cierre del socket
      }
      case 'response.failed':
        failure = new Error(`Responses: ${json.response?.error?.message || 'la respuesta falló'}`);
        break;
      case 'error':
        failure = new Error(`Responses: ${json.message || json.error?.message || 'error de streaming'}`);
        break;
    }
  }, { silenceTimeoutMs: cfg.silenceTimeoutMs });
  if (failure) throw failure;

  return {
    text: text.trim(),
    toolCalls: [...calls.values()].map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
    aborted,
    usage,
  };
}

/* ------------------------------------------------------------------------ *
 *  Punto de entrada
 * ------------------------------------------------------------------------ */

const ADAPTERS = { openai: streamOpenAI, anthropic: streamAnthropic, responses: streamResponses };

/**
 * Ejecuta una petición de chat con el protocolo adecuado.
 * @returns {Promise<{text, toolCalls, usage, aborted, format}>}
 */
async function stream(cfg, opts) {
  const format = cfg.format || detectFormat(cfg);
  const run = ADAPTERS[format] || streamOpenAI;
  // el límite de silencio viaja con la config efectiva: cada adaptador se lo pasa
  // a readSSE, que corta con error si el proveedor no manda nada (y el fallback
  // de _streamWithFallback puede probar el siguiente modelo)
  const res = await run({ ...cfg, format, silenceTimeoutMs: cfg.silenceTimeoutMs ?? DEFAULT_SILENCE_MS }, opts);
  return { ...res, format };
}

module.exports = {
  FORMATS, OPENCODE_MODEL_FORMAT, DEFAULT_SILENCE_MS, detectFormat, authHeaders,
  buildBodyOpenAI, buildBodyAnthropic, buildBodyResponses,
  toAnthropicMessages, toResponsesInput, parseSSEBlock, textOf, imagesOf,
  stream,
};
