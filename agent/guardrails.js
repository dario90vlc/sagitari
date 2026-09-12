'use strict';

/* Guardrails + permissions for the SAGITARI agent (v1.1 security block, v1.2 cost+stall).
   Pure logic, no Electron / no I/O → fully unit-testable (test/guardrails.test.js).

   Permission levels:
     safe       → runs automatically
     confirm    → asks the user before running (once per tool+args if "remember")
     restricted → blocked unless the user explicitly allows it in Settings

   Guardrails (per run): max steps, max tool calls, max duration, max tokens,
   max estimated cost (USD), repeated-call / loop detection, and STALL detection
   (N steps without any new tool call or assistant output = no progress). */

const LEVELS = ['safe', 'confirm', 'restricted'];

/* Coste por 1M tokens (USD) — estimación para el límite de coste. Claves por
   familia de modelo; lo no reconocido usa el default. El override del usuario
   (config.security.modelPricing) siempre gana. */
const MODEL_PRICING = {
  'gpt-5': { in: 1.25, out: 10 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4': { in: 30, out: 60 },
  'claude-sonnet': { in: 3, out: 15 },
  'claude-opus': { in: 15, out: 75 },
  'claude-haiku': { in: 0.8, out: 4 },
  'gemini-2': { in: 1.25, out: 10 },
  'deepseek': { in: 0.27, out: 1.1 },
  'llama': { in: 0.2, out: 0.6 },
  __default: { in: 1, out: 3 },
};

function pricingFor(model, override) {
  if (override && typeof override === 'object') return override;
  const m = String(model || '').toLowerCase();
  for (const k of Object.keys(MODEL_PRICING)) {
    if (k.startsWith('__')) continue;
    if (m.includes(k)) return MODEL_PRICING[k];
  }
  return MODEL_PRICING.__default;
}

/* Default risk per tool. The registry (tools.js) declares intent; a user
   override in settings always wins over these defaults. */
const DEFAULT_RISK = {
  run_command: 'confirm',
  write_file: 'confirm',
  browser_control: 'confirm',
  open_app: 'confirm',
  open_url: 'safe',
  read_file: 'safe',
  list_dir: 'safe',
  search_files: 'safe',
  screenshot: 'safe',
  clipboard_read: 'confirm',
  clipboard: 'safe',
  notify: 'safe',
  media_control: 'safe',
  window_manage: 'confirm',
  system_info: 'safe',
  use_skill: 'safe',
  remember: 'safe',
  delegate: 'safe',   // delegar no pide permiso; las herramientas del subagente sí, con los mismos niveles
};

/* Arg summaries shown to the user in the confirmation card. */
function summarizeArgs(name, args = {}) {
  const a = args || {};
  switch (name) {
    case 'run_command': return String(a.command || '').slice(0, 200);
    case 'write_file': return String(a.path || '');
    case 'browser_control': return `${a.action || ''}${a.url ? ' → ' + a.url : ''}${a.text ? ' («' + a.text + '»)' : ''}`;
    case 'open_app': return String(a.name || '');
    case 'open_url': return String(a.url || '');
    case 'clipboard': return a.action === 'write' ? 'escribir en el portapapeles' : 'leer el portapapeles';
    case 'window_manage': return String(a.action || '');
    default: return Object.keys(a).length ? JSON.stringify(a).slice(0, 160) : '';
  }
}

/* Human description of what the tool is about to do (confirmation card title). */
function describeAction(name, args = {}) {
  const a = args || {};
  switch (name) {
    case 'run_command': return 'Ejecutar comando en la terminal';
    case 'write_file': return 'Crear o sobrescribir un archivo';
    case 'browser_control':
      if (a.action === 'click') return 'Hacer clic en la página web';
      if (a.action === 'type') return 'Escribir en la página web';
      if (a.action === 'navigate' || a.action === 'launch' || a.action === 'new_tab') return 'Abrir una página web';
      return 'Controlar el navegador (' + (a.action || '') + ')';
    case 'open_app': return 'Abrir una aplicación';
    case 'open_url': return 'Abrir una URL';
    case 'clipboard': return a.action === 'write' ? 'Escribir en el portapapeles' : 'Leer el portapapeles';
    case 'window_manage': return 'Gestionar ventanas';
    default: return 'Usar herramienta ' + name;
  }
}

/* Acciones del navegador SIEMPRE sensibles (v1.5): aunque browser_control esté
   en 'safe', estas acciones piden confirmación — comprar, pagar, eliminar,
   publicar, enviar datos o cambiar ajustes críticos nunca son automáticas. */
const SENSITIVE_BROWSER_RX = /(comprar|compra|pagar|pago|checkout|finalizar|eliminar|borrar|delete|suspender|cancelar suscripci|dar de baja|publicar|enviar|transferir|vender|contratar)/i;

/* Campos de datos sensibles: escribir en ellos también exige confirmación */
const SENSITIVE_FIELD_RX = /(card|cvv|cvc|expir|iban|tarjeta|password|contrase|passwd|pin\b|cuenta.*number|account.*num|ssn|dni\b)/i;

/* Ordena las claves de un valor de forma recursiva: dos argumentos equivalentes
   deben producir la misma firma aunque el modelo cambie el orden de las claves. */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}

function isSensitiveBrowserAction(name, args = {}) {
  if (name !== 'browser_control') return false;
  const a = args || {};
  if (!['click', 'type', 'press'].includes(a.action)) return false;
  if (SENSITIVE_BROWSER_RX.test(String(a.text || '') + ' ' + String(a.selector || ''))) return true;
  if (a.action === 'type' && SENSITIVE_FIELD_RX.test(String(a.selector || '') + ' ' + String(a.name || '') + ' ' + String(a.id || ''))) return true;
  return false;
}

class Guardrails {
  /**
   * @param {object} policy  { permissions: {toolName: level},
   *   guardrails: {maxSteps, maxToolCalls, maxDurationMs, maxTokens, maxCostUsd, loopThreshold, stallThreshold},
   *   modelPricing: {in, out} }
   */
  constructor(policy = {}) {
    this.policy = {
      permissions: { ...policy.permissions },
      modelPricing: policy.modelPricing || null,
      guardrails: {
        maxSteps: policy.guardrails?.maxSteps ?? 60,           // 0 or null = unlimited
        maxToolCalls: policy.guardrails?.maxToolCalls ?? 80,   // 0 or null = unlimited
        maxDurationMs: policy.guardrails?.maxDurationMs ?? 15 * 60 * 1000,
        maxTokens: policy.guardrails?.maxTokens ?? 0,          // 0 = unlimited
        maxCostUsd: policy.guardrails?.maxCostUsd ?? 0,        // 0 = unlimited (estimación)
        loopThreshold: policy.guardrails?.loopThreshold ?? 3,  // identical consecutive calls before loop
        stallThreshold: policy.guardrails?.stallThreshold ?? 6, // pasos sin señal de progreso
      },
    };
    this.startedAt = 0;
    this.steps = 0;
    this.toolCalls = 0;
    this.tokensUsed = 0;
    this.tokensIn = 0;
    this.tokensOut = 0;
    this.costUsd = 0;
    this.model = null;
    this.recentCalls = [];       // signatures of last N tool calls
    this.approvals = new Map();  // remembered confirmations: signature -> expiry
    this._stall = 0;             // pasos consecutivos sin progreso
  }

  /** Hot-reload policy from Settings without losing run counters. */
  setPolicy(policy = {}) {
    if (policy.permissions) this.policy.permissions = { ...policy.permissions };
    if (policy.modelPricing) this.policy.modelPricing = policy.modelPricing;
    if (policy.guardrails) this.policy.guardrails = { ...this.policy.guardrails, ...policy.guardrails };
  }

  /* ---------- run lifecycle ---------- */
  beginRun() {
    this.startedAt = Date.now();
    this.steps = 0;
    this.toolCalls = 0;
    this.tokensUsed = 0;
    this.tokensIn = 0;
    this.tokensOut = 0;
    this.costUsd = 0;
    this.recentCalls = [];
    this._stall = 0;
    this._lastToolName = null;   // si no, la señal de progreso quedaba contaminada entre ejecuciones
  }

  /** Call once per model turn. Returns {ok, reason?}. */
  checkStep() {
    this.steps++;
    const g = this.policy.guardrails;
    if (g.maxDurationMs > 0 && Date.now() - this.startedAt > g.maxDurationMs) {
      return { ok: false, reason: `Tiempo máximo de ejecución alcanzado (${Math.round(g.maxDurationMs / 60000)} min).` };
    }
    if (g.maxSteps > 0 && this.steps > g.maxSteps) {
      return { ok: false, reason: `Límite de pasos alcanzado (${g.maxSteps}). Auméntalo o quítalo en Ajustes → Seguridad.` };
    }
    return { ok: true };
  }

  /** Call once per tool execution. Returns {ok, reason?}. */
  checkToolCall() {
    this.toolCalls++;
    const g = this.policy.guardrails;
    if (g.maxToolCalls > 0 && this.toolCalls > g.maxToolCalls) {
      return { ok: false, reason: `Límite de llamadas a herramientas alcanzado (${g.maxToolCalls}).` };
    }
    return { ok: true };
  }

  /** Coste estimado (USD) del último turno según tokens y modelo. */
  _turnCost(promptTokens, completionTokens) {
    const p = pricingFor(this.model, this.policy.modelPricing);
    return (promptTokens / 1e6) * p.in + (completionTokens / 1e6) * p.out;
  }

  /**
   * Accumulate usage reported by the provider. Returns {ok, reason?}.
   * Enforce token budget AND estimated-cost budget.
   */
  addTokens(n, usage) {
    if (!n) return { ok: true };
    this.tokensUsed += n;
    if (usage) {
      this.tokensIn += usage.prompt_tokens || 0;
      this.tokensOut += usage.completion_tokens || 0;
      this.costUsd += this._turnCost(usage.prompt_tokens || 0, usage.completion_tokens || 0);
    }
    const g = this.policy.guardrails;
    if (g.maxTokens > 0 && this.tokensUsed >= g.maxTokens) {
      return { ok: false, reason: `Límite de tokens alcanzado (${g.maxTokens}).` };
    }
    if (g.maxCostUsd > 0 && this.costUsd >= g.maxCostUsd) {
      return { ok: false, reason: `Límite de coste estimado alcanzado ($${g.maxCostUsd}).` };
    }
    return { ok: true };
  }

  /** Para el panel: coste estimado de la ejecución en curso. */
  getCost() { return this.costUsd; }

  /**
   * Suma el consumo de otro Guardrails (un subagente) al presupuesto propio: el
   * gasto de una delegación debe contar para el límite global del usuario.
   * Devuelve {ok, reason?} con el estado del presupuesto tras absorber.
   */
  absorb(other) {
    if (other) {
      this.tokensUsed += other.tokensUsed || 0;
      this.tokensIn += other.tokensIn || 0;
      this.tokensOut += other.tokensOut || 0;
      this.costUsd += other.costUsd || 0;
      this.toolCalls += other.toolCalls || 0;
    }
    const g = this.policy.guardrails;
    if (g.maxTokens > 0 && this.tokensUsed >= g.maxTokens) {
      return { ok: false, reason: `Límite de tokens alcanzado (${g.maxTokens}) — incluye el consumo de los subagentes.` };
    }
    if (g.maxCostUsd > 0 && this.costUsd >= g.maxCostUsd) {
      return { ok: false, reason: `Límite de coste estimado alcanzado ($${g.maxCostUsd}) — incluye el consumo de los subagentes.` };
    }
    return { ok: true };
  }

  /* ---------- loop detection ---------- */

  /**
   * Firma estable de una llamada: el orden de las claves no puede servir para
   * evadir la detección (={"a":1,"b":2} y {"b":2,"a":1} son la misma acción).
   */
  signature(name, args = {}) {
    let s;
    try { s = JSON.stringify(canonical(args)); } catch { s = String(args); }
    return name + ' ' + s.replace(/\s+/g, ' ');
  }

  /**
   * Detects repetitive behavior. A call identical to the previous one repeated
   * `loopThreshold` times in a row (or a ping-pong A-B-A pattern) is a loop.
   * Returns {loop: bool, pattern?}.
   */
  isLoop(name, args = {}) {
    const sig = this.signature(name, args);
    // Un umbral 0/1 marcaría bucle en la PRIMERA llamada y mataría cualquier
    // tarea al arrancar; el mínimo que detecta algo es 2.
    const T = Math.max(2, Math.floor(Number(this.policy.guardrails.loopThreshold) || 3));
    const recent = this.recentCalls;
    this.recentCalls.push(sig);
    if (this.recentCalls.length > 12) this.recentCalls.shift();

    // N identical consecutive calls (recent already includes the current one)
    if (recent.length >= T - 1) {
      let run = 0;
      for (let i = recent.length - 1; i >= 0 && recent[i] === sig; i--) run++;
      if (run >= T) return { loop: true, pattern: 'llamada idéntica repetida' };
    }
    // ping-pong A-B-A-B…
    if (recent.length >= 4) {
      const a1 = recent[recent.length - 2], a2 = recent[recent.length - 4];
      if (a1 === a2 && recent[recent.length - 1] === recent[recent.length - 3] && a1 !== sig) {
        return { loop: true, pattern: 'alternancia repetida A-B-A-B' };
      }
    }
    return { loop: false };
  }

  /* ---------- stall detection (ausencia de progreso) ---------- */

  /** Señales de progreso: una herramienta NUEVA distinta de la anterior, o texto no vacío. */
  _lastSig() { return this.recentCalls[this.recentCalls.length - 1]; }

  /**
   * Llamar UNA vez por vuelta del modelo (antes de checkStep idealmente).
   * Si no hay herramientas nuevas y no hay texto → paso "estancado".
   * Detecta el bucle por firma de herramientas incluso si los args varían poco:
   * aquí interesa el ritmo, el bucle exacto lo cubre isLoop().
   */
  checkStall({ toolName = null, assistantText = '' } = {}) {
    const g = this.policy.guardrails;
    if (g.stallThreshold > 0) {
      const progressed = Boolean(assistantText && assistantText.trim()) || (toolName && toolName !== this._lastToolName);
      if (toolName) this._lastToolName = toolName;
      this._stall = progressed ? 0 : this._stall + 1;
      if (this._stall >= g.stallThreshold) {
        this._stall = 0;
        return { ok: false, reason: `Sin progreso: ${g.stallThreshold} pasos sin acciones ni respuestas nuevas. Ejecución detenida.` };
      }
    }
    return { ok: true };
  }

  /* ---------- permissions ---------- */
  /** Effective level for a tool: user override wins, else default. */
  levelFor(name) {
    const override = this.policy.permissions[name];
    if (LEVELS.includes(override)) return override;
    return DEFAULT_RISK[name] || 'confirm';
  }

  /**
   * Decide what to do with a pending tool call.
   * Returns {action:'allow'} | {action:'confirm', description, summary, signature}
   *                       | {action:'deny', reason}.
   * v1.5: las acciones sensibles del navegador fuerzan 'confirm' aunque el
   * usuario tenga browser_control en 'safe' (la seguridad gana a la comodidad).
   */
  decide(name, args = {}) {
    if (isSensitiveBrowserAction(name, args)) {
      const sig = this.signature(name, args);
      const memo = this.approvals.get(sig);
      if (!(memo && memo > Date.now())) {
        const a = args || {};
        return {
          action: 'confirm',
          tool: name,
          description: 'ACCIÓN SENSIBLE en la web: ' + (a.action === 'click' ? 'hacer clic en «' + (a.text || a.selector || '') + '»' : a.action === 'type' ? 'escribir en «' + (a.selector || '') + '»' : 'pulsar ' + (a.key || '')) + ' — parece una compra/pago/eliminación/publicación',
          summary: summarizeArgs(name, args),
          signature: sig,
          sensitive: true,
        };
      }
    }
    const level = this.levelFor(name);
    if (level === 'safe') return { action: 'allow' };
    const sig = this.signature(name, args);
    const memo = this.approvals.get(sig);
    if (memo && memo > Date.now()) return { action: 'allow' };
    if (level === 'restricted') {
      return {
        action: 'deny',
        reason: `La herramienta «${name}» está bloqueada por la configuración de seguridad del usuario.`
      };
    }
    return {
      action: 'confirm',
      tool: name,
      description: describeAction(name, args),
      summary: summarizeArgs(name, args),
      signature: sig,
    };
  }

  /** Remember an approved call for 10 minutes so plans don't nag on every step. */
  approve(signature) {
    this.approvals.set(signature, Date.now() + 10 * 60 * 1000);
  }

  /** User denied the confirmation. The signature is not persisted → asks again next time. */
  deny(signature) {
    this.approvals.delete(signature);
  }
}

module.exports = { Guardrails, DEFAULT_RISK, LEVELS, describeAction, summarizeArgs, pricingFor, MODEL_PRICING, isSensitiveBrowserAction, SENSITIVE_BROWSER_RX, SENSITIVE_FIELD_RX };
