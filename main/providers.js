'use strict';

/* Provider presets.
   `format` indica el protocolo del proveedor (ver agent/protocols.js):
     openai    → /chat/completions  (Authorization: Bearer)
     anthropic → /messages          (x-api-key + anthropic-version)
     responses → /responses         (Authorization: Bearer)
   Un modelo puntual puede necesitar otro formato (p. ej. en OpenCode Go); de eso
   se encarga agent/protocols.detectFormat(). */
const protocols = require('../agent/protocols');

const PRESETS = [
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    needsKey: true,
    format: 'openai',
    hint: 'Modelos curated (GLM, Kimi, DeepSeek, Qwen…). Algunos usan /messages o /responses: se detecta solo',
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1',
    needsKey: true,
    format: 'anthropic',
    hint: 'Claude nativo, API Messages',
  },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true, format: 'openai', hint: 'GPT-4o, GPT-4.1, GPT-5…' },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    format: 'openai',
    hint: 'Cientos de modelos con una sola API key',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    format: 'openai',
    hint: 'Ultrarrápido, Llama 3.x gratis con límites',
  },
  {
    id: 'gemini',
    name: 'Google Gemini (compatibilidad OpenAI)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    needsKey: true,
    format: 'openai',
    hint: 'Nivel gratuito; herramientas, visión y streaming documentados en la misma página',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    needsKey: true,
    format: 'openai',
    hint: 'Modelos de código potentes y baratos; visión solo en deepseek-flash',
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    needsKey: true,
    format: 'openai',
    hint: 'Modelos de código de Grok; su shim de Anthropic está obsoleto',
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    needsKey: true,
    format: 'openai',
    hint: 'Host de la UE disponible (api.eu.mistral.ai/v1); tool calling compatible con OpenAI',
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.ai/v1',
    needsKey: true,
    format: 'openai',
    hint: 'Kimi serie K, contexto largo; también tiene base /anthropic, pero usa /v1 para el selector de modelos',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    needsKey: true,
    format: 'openai',
    hint: 'Los tokens/s más rápidos; la visión solo acepta base64, no URLs de imagen',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    needsKey: true,
    format: 'openai',
    hint: 'Nivel gratuito; su /models es público; los ids llevan prefijo del publicador (meta/…, openai/…)',
  },
  {
    id: 'sambanova',
    name: 'SambaNova Cloud',
    baseUrl: 'https://api.sambanova.ai/v1',
    needsKey: true,
    format: 'openai',
    hint: 'Muy rápido; ignora presence_penalty/frequency_penalty',
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp (servidor)',
    baseUrl: 'http://localhost:8080/v1',
    needsKey: false,
    format: 'openai',
    hint: 'llama-server; en builds recientes de master el puerto por defecto es 9931',
  },
  {
    id: 'vllm',
    name: 'vLLM',
    baseUrl: 'http://localhost:8000/v1',
    needsKey: false,
    format: 'openai',
    hint: 'Necesita --enable-auto-tool-choice y un --tool-call-parser para tool calling',
  },
  {
    id: 'jan',
    name: 'Jan (local)',
    baseUrl: 'http://127.0.0.1:1337/v1',
    needsKey: false,
    format: 'openai',
    hint: 'Hay que habilitar el servidor de API en Jan',
  },
  {
    id: 'koboldcpp',
    name: 'KoboldCpp',
    baseUrl: 'http://localhost:5001/v1',
    needsKey: false,
    format: 'openai',
    hint: 'Runtime local de un solo archivo',
  },
  {
    id: 'textgen',
    name: 'text-generation-webui',
    baseUrl: 'http://127.0.0.1:5000/v1',
    needsKey: false,
    format: 'openai',
    hint: 'Ejecútalo con --api',
  },
  {
    id: 'localai',
    name: 'LocalAI',
    baseUrl: 'http://localhost:8080/v1',
    needsKey: false,
    format: 'openai',
    hint: 'Runtime autoalojado compatible con OpenAI',
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    needsKey: false,
    format: 'openai',
    hint: 'Modelos locales, sin coste. Ejecuta "ollama serve"',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    needsKey: false,
    format: 'openai',
    hint: 'Activa el servidor local en LM Studio',
  },
  {
    id: 'custom',
    name: 'Personalizado (OpenAI-compatible)',
    baseUrl: '',
    needsKey: false,
    format: 'openai',
    hint: 'Cualquier endpoint compatible con OpenAI',
  },
];

const VISION_HINTS = /(gpt-4|gpt-5|4o|vision|llava|llama3\.2-vision|claude|gemini|minimax|pixtral|qwen.*vl|vl-)/i;

function isVisionModel(modelId) {
  return VISION_HINTS.test(modelId || '');
}

/** Tope de la respuesta de /models (2 MB): un endpoint malicioso no debe poder
    reventar la memoria con un JSON gigante (resp.json() lo buferiza entero). */
const MAX_MODELS_BYTES = 2 * 1024 * 1024;

/* Un error de proveedor, en castellano y sin volcar el JSON crudo.
   Antes se lanzaba `HTTP 401: {"error":{"type":"server_error","message":"Invalid
   credential"}}` tal cual: un volcado que no dice qué hacer y que además puede
   arrastrar la clave si el proveedor la refleja en su mensaje. */
function limpiarDetalle(t) {
  return String(t || '')
    .replace(/\b(sk|pk|rk|key)-[A-Za-z0-9_-]{8,}/gi, '[clave]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [clave]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** Saca el mensaje del cuerpo (JSON de error o texto) y lo deja legible. */
function detalleDeError(cuerpo) {
  const t = String(cuerpo || '');
  try {
    const j = JSON.parse(t);
    const m = (j && ((j.error && (j.error.message || j.error)) || j.message || j.detail)) || '';
    return limpiarDetalle(typeof m === 'string' ? m : '');
  } catch {
    return limpiarDetalle(t);
  }
}

/** @param {number} status @param {string} cuerpo @param {string} [quien] */
function errorDeProveedor(status, cuerpo, quien) {
  const conocido = {
    400: 'la petición no es válida',
    401: 'la clave no es válida o ha caducado',
    403: 'el proveedor rechaza esta clave para ese modelo',
    404: 'ese modelo o esa ruta no existen en el proveedor',
    429: 'demasiadas peticiones: espera un momento',
  }[status];
  const base = conocido || (status >= 500 ? 'el proveedor está fallando' : 'el proveedor devolvió un error');
  const detalle = detalleDeError(cuerpo);
  return new Error((quien ? quien + ': ' : '') + base + ' (HTTP ' + status + ')' + (detalle ? ' — «' + detalle + '»' : ''));
}

/** Lee el cuerpo con tope, abortando al pasarse (ver agent/skills.js:readCapped). */
async function readCappedText(resp, max) {
  const declared = Number((resp.headers && resp.headers.get('content-length')) || 0);
  if (declared && declared > max) throw new Error('respuesta demasiado grande (máx. 2 MB)');
  if (!resp.body || typeof resp.body.getReader !== 'function') {
    const t = await resp.text();
    if (t.length > max) throw new Error('respuesta demasiado grande (máx. 2 MB)');
    return t;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try {
        reader.cancel().catch(() => {});
      } catch {}
      throw new Error('respuesta demasiado grande (máx. 2 MB)');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Lista los modelos de un proveedor con el formato/cabeceras correctos.
 * El header de sesión de OpenCode Go/Zen se sigue mandando (es inocuo), pero
 * GET /models NO lo exige: solo los POST lo comprueban.
 * `opts` permite forzar el protocolo (format/providerId/model) para bases
 * Anthropic de terceros, cuyo path no basta para deducir el formato.
 */
async function listModels(baseUrl, apiKey, fetchFn = fetch, opts = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  // fetch solo habla http(s), pero un esquema raro o una ruta local no debe ni
  // intentarse: la misma regla que al guardar/activar proveedores.
  if (!/^https?:\/\//i.test(base) && !/^(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/i.test(base)) {
    throw new Error('baseUrl debe ser http(s) o localhost');
  }
  const format = protocols.detectFormat({
    baseUrl: base,
    providerId: opts.providerId,
    model: opts.model,
    format: opts.format,
  });
  const url = base + '/models';
  /* Una clave que no se pudo descifrar NO se manda. Ir al proveedor con el criptograma
     devolvía un 401 crudo («Invalid credential») que parece un problema de la API cuando
     el problema está aquí: el config llegó de otro perfil o de otro equipo. */
  if (/^enc:v1:/.test(String(apiKey || ''))) {
    throw new Error(
      'la clave guardada no se puede descifrar en este equipo (el config llegó de otro perfil o de otro equipo): vuelve a escribirla en Ajustes ▸ Proveedores',
    );
  }
  const resp = await fetchFn(url, {
    headers: protocols.authHeaders({ baseUrl: base, apiKey }, format),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    const t = await readCappedText(resp, 64 * 1024).catch(() => '');
    throw errorDeProveedor(resp.status, t, (opts && opts.nombre) || 'el proveedor');
  }
  const data = JSON.parse(await readCappedText(resp, MAX_MODELS_BYTES));
  const models = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
  return [...new Set(models)].sort();
}

module.exports = { PRESETS, listModels, isVisionModel, MAX_MODELS_BYTES, errorDeProveedor, detalleDeError };
