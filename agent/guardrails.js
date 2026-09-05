'use strict';

/* Guardrails + permissions for the SAGITARI agent (v1.1 security block).
   Pure logic, no Electron / no I/O → fully unit-testable (test/guardrails.test.js).

   Permission levels:
     safe       → runs automatically
     confirm    → asks the user before running (once per tool+args if "remember")
     restricted → blocked unless the user explicitly allows it in Settings

   Guardrails (per run): max steps, max tool calls, max duration, max tokens,
   and repeated-call / loop detection with configurable similarity. */

const LEVELS = ['safe', 'confirm', 'restricted'];

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

class Guardrails {
  /**
   * @param {object} policy  { permissions: {toolName: level}, guardrails: {maxSteps, maxToolCalls, maxDurationMs, loopThreshold} }
   */
  constructor(policy = {}) {
    this.policy = {
      permissions: { ...policy.permissions },
      guardrails: {
        maxSteps: policy.guardrails?.maxSteps ?? 60,          // 0 or null = unlimited
        maxToolCalls: policy.guardrails?.maxToolCalls ?? 80,  // 0 or null = unlimited
        maxDurationMs: policy.guardrails?.maxDurationMs ?? 15 * 60 * 1000,
        maxTokens: policy.guardrails?.maxTokens ?? 0,         // 0 = unlimited (needs usage tracking)
        loopThreshold: policy.guardrails?.loopThreshold ?? 3, // identical consecutive calls before loop
      },
    };
    this.startedAt = 0;
    this.steps = 0;
    this.toolCalls = 0;
    this.tokensUsed = 0;
    this.recentCalls = [];       // signatures of last N tool calls
    this.approvals = new Map();  // remembered confirmations: signature -> expiry
  }

  /** Hot-reload policy from Settings without losing run counters. */
  setPolicy(policy = {}) {
    if (policy.permissions) this.policy.permissions = { ...policy.permissions };
    if (policy.guardrails) this.policy.guardrails = { ...this.policy.guardrails, ...policy.guardrails };
  }

  /* ---------- run lifecycle ---------- */
  beginRun() {
    this.startedAt = Date.now();
    this.steps = 0;
    this.toolCalls = 0;
    this.tokensUsed = 0;
    this.recentCalls = [];
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

  /** Accumulate usage reported by the provider. Returns {ok, reason?}. */
  addTokens(n) {
    if (!n) return { ok: true };
    this.tokensUsed += n;
    const max = this.policy.guardrails.maxTokens;
    if (max > 0 && this.tokensUsed >= max) {
      return { ok: false, reason: `Límite de tokens alcanzado (${max}).` };
    }
    return { ok: true };
  }

  /* ---------- loop detection ---------- */
  signature(name, args = {}) {
    let s;
    try { s = JSON.stringify(args); } catch { s = String(args); }
    return name + ' ' + s.replace(/\s+/g, ' ');
  }

  /**
   * Detects repetitive behavior. A call identical to the previous one repeated
   * `loopThreshold` times in a row (or a ping-pong A-B-A pattern) is a loop.
   * Returns {loop: bool, pattern?}.
   */
  isLoop(name, args = {}) {
    const sig = this.signature(name, args);
    const T = this.policy.guardrails.loopThreshold;
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
   */
  decide(name, args = {}) {
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

module.exports = { Guardrails, DEFAULT_RISK, LEVELS, describeAction, summarizeArgs };
