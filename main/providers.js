'use strict';

// Provider presets. All OpenAI-compatible (chat/completions + /models).
const PRESETS = [
  { id: 'opencode-go', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', needsKey: true, hint: 'Modelos curated para agentes (Claude, GPT, Gemini, DeepSeek…)' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, hint: 'Cientos de modelos con una sola API key' },
  { id: 'ollama', name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', needsKey: false, hint: 'Modelos locales, sin coste. Ejecuta "ollama serve"' },
  { id: 'lmstudio', name: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', needsKey: false, hint: 'Activa el servidor local en LM Studio' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true, hint: 'Ultrarrápido, Llama 3.x gratis con límites' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true, hint: 'GPT-4o, GPT-4.1…' },
  { id: 'custom', name: 'Personalizado (OpenAI-compatible)', baseUrl: '', needsKey: false, hint: 'Cualquier endpoint compatible con OpenAI' }
];

const VISION_HINTS = /(gpt-4|gpt-5|4o|vision|llava|llama3\.2-vision|claude|gemini|minimax|pixtral|qwen.*vl|vl-)/i;

function isVisionModel(modelId) {
  return VISION_HINTS.test(modelId || '');
}

async function listModels(baseUrl, apiKey, fetchFn = fetch) {
  const url = baseUrl.replace(/\/+$/, '') + '/models';
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  const resp = await fetchFn(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  const models = (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean);
  return [...new Set(models)].sort();
}

module.exports = { PRESETS, listModels, isVisionModel };
