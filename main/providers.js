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
  { id: 'opencode-go', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', needsKey: true, format: 'openai', hint: 'Modelos curated (GLM, Kimi, DeepSeek, Qwen…). Algunos usan /messages o /responses: se detecta solo' },
  { id: 'anthropic', name: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com/v1', needsKey: true, format: 'anthropic', hint: 'Claude nativo, API Messages' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true, format: 'openai', hint: 'GPT-4o, GPT-4.1, GPT-5…' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, format: 'openai', hint: 'Cientos de modelos con una sola API key' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true, format: 'openai', hint: 'Ultrarrápido, Llama 3.x gratis con límites' },
  { id: 'ollama', name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', needsKey: false, format: 'openai', hint: 'Modelos locales, sin coste. Ejecuta "ollama serve"' },
  { id: 'lmstudio', name: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', needsKey: false, format: 'openai', hint: 'Activa el servidor local en LM Studio' },
  { id: 'custom', name: 'Personalizado (OpenAI-compatible)', baseUrl: '', needsKey: false, format: 'openai', hint: 'Cualquier endpoint compatible con OpenAI' }
];

const VISION_HINTS = /(gpt-4|gpt-5|4o|vision|llava|llama3\.2-vision|claude|gemini|minimax|pixtral|qwen.*vl|vl-)/i;

function isVisionModel(modelId) {
  return VISION_HINTS.test(modelId || '');
}

/**
 * Lista los modelos de un proveedor con el formato/cabeceras correctos.
 * (OpenCode Go exige sesión también aquí: sin ella responde 400 MissingSessionID.)
 */
async function listModels(baseUrl, apiKey, fetchFn = fetch) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const format = protocols.detectFormat({ baseUrl: base });
  const url = base + '/models';
  const resp = await fetchFn(url, {
    headers: protocols.authHeaders({ baseUrl: base, apiKey }, format),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  const models = (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean);
  return [...new Set(models)].sort();
}

module.exports = { PRESETS, listModels, isVisionModel };
