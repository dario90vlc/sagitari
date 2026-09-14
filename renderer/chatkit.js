'use strict';

/* ============================================================================
   chatkit.js — la "inteligencia" del chat de SAGITARI, en funciones puras.

   Vive aquí (y no dentro de app.js) por dos razones:
     · el renderer no tiene estado ni DOM en estas funciones → testeables
     · se carga como <script> normal en la ventana y como require() en Node,
       así los tests cubren de verdad la lógica en vez de mirar si el HTML
       contiene una cadena.

   IMPORTANTE: todo va dentro de un IIFE. Estos scripts son clásicos y comparten
   un único ámbito global, así que un `const MODE_ORDER` aquí y otro en app.js
   son un SyntaxError que deja la app entera sin arrancar (sin iconos, sin
   botones, sin nada). Lo único que sale de este fichero es window.ChatKit.

   Cubre: identidad de los modos ACT/PLAN/THINK, el catálogo de herramientas
   (etiqueta humana + icono), el resumen de sus argumentos, el formato de
   duración y el parser de planes del modo PLAN.
   ============================================================================ */
const ChatKit = (function () {

  /* -------------------------------------------------------------------------
     1. MODOS — cada uno con identidad propia y real
     Los tres perfiles existen ya en el backend (agent/agent.js: MODE_PROFILES):
     distinta temperatura, distintos pasos máximos y distinto prompt. Aquí sólo
     se les da una cara: color, icono, lema y en qué se diferencian.
     ------------------------------------------------------------------------- */
  const MODES = {
    act: {
      key: 'act', label: 'ACT', name: 'Actuar', icon: 'zap', dot: 'ok',
      color: '#34d399', rgb: '52,211,153', cls: 'act',
      tagline: 'Ejecuta y reporta, sin plan previo',
      bullets: ['Va directo a la acción', 'Mínima explicación', 'Para tareas claras y cortas'],
    },
    plan: {
      key: 'plan', label: 'PLAN', name: 'Planificar', icon: 'map', dot: 'pur',
      color: '#a78bfa', rgb: '167,139,250', cls: 'plan',
      tagline: 'Presenta un plan y lo ejecuta paso a paso',
      bullets: ['Plan numerado antes de actuar', 'Verás los pasos marcarse solos', 'Para tareas largas o delicadas'],
    },
    think: {
      key: 'think', label: 'THINK', name: 'Razonar', icon: 'brain', dot: 'blu',
      color: '#7db4ff', rgb: '125,180,255', cls: 'think',
      tagline: 'Razona en profundidad antes de responder',
      bullets: ['Explora alternativas', 'Explica su razonamiento', 'Para decisiones y análisis'],
    },
  };

  const MODE_ORDER = ['act', 'plan', 'think'];

  /** Metadatos de un modo, con salto a ACT si el valor no existe. */
  function mode(key) {
    return MODES[String(key || '').toLowerCase()] || MODES.act;
  }

  /** El siguiente modo en el ciclo (Alt+M / clic en el botón del sidebar). */
  function nextMode(key) {
    const i = MODE_ORDER.indexOf(mode(key).key);
    return MODE_ORDER[(i + 1) % MODE_ORDER.length];
  }

  /* -------------------------------------------------------------------------
     2. HERRAMIENTAS — nombre técnico → cómo se lo contamos al usuario
     ------------------------------------------------------------------------- */
  const TOOLS = {
    run_command:     { label: 'Terminal',        icon: 'terminal',  verb: 'Ejecutando' },
    read_file:       { label: 'Leer archivo',    icon: 'file',      verb: 'Leyendo' },
    write_file:      { label: 'Escribir archivo', icon: 'save',     verb: 'Escribiendo' },
    edit_file:       { label: 'Editar archivo',  icon: 'save',     verb: 'Editando' },
    list_dir:        { label: 'Explorar carpeta', icon: 'folder',   verb: 'Explorando' },
    search_files:    { label: 'Buscar en archivos', icon: 'search', verb: 'Buscando' },
    open_app:        { label: 'Abrir aplicación', icon: 'window',   verb: 'Abriendo' },
    open_url:        { label: 'Abrir web',        icon: 'globe',    verb: 'Abriendo' },
    browser_control: { label: 'Navegador',        icon: 'compass',  verb: 'Controlando el navegador' },
    screenshot:      { label: 'Captura de pantalla', icon: 'camera', verb: 'Capturando' },
    clipboard:       { label: 'Portapapeles',     icon: 'clipboard', verb: 'Usando el portapapeles' },
    notify:          { label: 'Notificación',     icon: 'bell',     verb: 'Notificando' },
    media_control:   { label: 'Multimedia',       icon: 'music',    verb: 'Controlando multimedia' },
    window_manage:   { label: 'Ventanas',         icon: 'window',   verb: 'Gestionando ventanas' },
    system_info:     { label: 'Sistema',          icon: 'monitor',  verb: 'Consultando el sistema' },
    remember:        { label: 'Recordar',         icon: 'memory',   verb: 'Guardando en memoria' },
    use_skill:       { label: 'Skill',            icon: 'spark',    verb: 'Aplicando skill' },
    delegate:        { label: 'Subagente',        icon: 'agents',   verb: 'Delegando' },
  };

  const FALLBACK_TOOL = { label: 'Herramienta', icon: 'tools', verb: 'Ejecutando' };

  /** Metadatos de una herramienta; si es desconocida, intenta humanizar el nombre. */
  function tool(name) {
    const key = String(name || '');
    if (TOOLS[key]) return TOOLS[key];
    const pretty = key.replace(/_/g, ' ').trim();
    return Object.assign({}, FALLBACK_TOOL, pretty ? { label: pretty.charAt(0).toUpperCase() + pretty.slice(1) } : null);
  }

  /* Claves que, por orden, mejor resumen lo que hace una llamada. */
  const ARG_HINTS = {
    run_command: ['command'],
    read_file: ['path'], write_file: ['path'], edit_file: ['path'], list_dir: ['path'],
    search_files: ['pattern', 'path'],
    open_app: ['name', 'args'],
    open_url: ['url'],
    browser_control: ['action', 'url', 'selector', 'text', 'index'],
    clipboard: ['action', 'text'],
    media_control: ['action'],
    window_manage: ['action', 'title', 'name'],
    remember: ['text', 'key'],
    use_skill: ['name'],
    delegate: ['agent', 'task'],
    notify: ['title', 'message'],
    system_info: ['query', 'what'],
  };

  /** Un valor de argumento, aplanado a una línea corta y legible. */
  function flatValue(v, max) {
    const lim = max || 90;
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
      try { return clip(JSON.stringify(v).replace(/[{}\[\]"]/g, ''), lim); } catch { return ''; }
    }
    return clip(String(v).replace(/\s+/g, ' ').trim(), lim);
  }

  /**
   * Resumen de una línea con los argumentos de la herramienta.
   * Ej: summarizeArgs('run_command', {command:'npm test'}) → 'npm test'
   *     summarizeArgs('browser_control', {action:'navigate', url:'...'}) → 'navigate → https://...'
   */
  function summarizeArgs(name, args) {
    const a = args && typeof args === 'object' ? args : {};
    // delegar a un subagente: su nombre humano dice más que la clave interna
    if (String(name) === 'delegate' && a.agent) {
      const s = SUBAGENTS[String(a.agent)];
      const who = s ? s.label : String(a.agent);
      const task = flatValue(a.task, 80);
      return task ? who + ' → ' + task : who;
    }
    // hasOwnProperty: el modelo puede emitir una herramienta llamada `constructor`
    // (o `toString`, `__proto__`…); leerlas del prototipo daba un valor no iterable
    // y el `for…of` lanzaba, dejando la tarjeta y el rail a medias
    const hints = Object.prototype.hasOwnProperty.call(ARG_HINTS, String(name || '')) ? ARG_HINTS[String(name || '')] : null;
    if (Array.isArray(hints)) {
      const parts = [];
      for (const k of hints) {
        // sólo el primer campo vacío se omite; el resto se une con flechas
        if (a[k] === undefined || a[k] === null || a[k] === '') continue;
        parts.push(flatValue(a[k], k === 'command' || k === 'path' || k === 'url' ? 110 : 70));
        if (parts.length >= 2) break;
      }
      if (parts.length) return parts.join(' → ');
    }
    // sin pistas: los primeros campos escalares, "clave: valor"
    const out = [];
    for (const k of Object.keys(a)) {
      const v = flatValue(a[k], 60);
      if (!v) continue;
      out.push(k + ': ' + v);
      if (out.length >= 2) break;
    }
    return out.join(' · ');
  }

  /* -------------------------------------------------------------------------
     3. FORMATO — duración, tamaños y conteos en castellano
     ------------------------------------------------------------------------- */

  /** Recorta a `max` caracteres, añadiendo puntos suspensivos sólo si corta. */
  function clip(text, max) {
    const s = String(text === null || text === undefined ? '' : text);
    const lim = max || 120;
    return s.length > lim ? s.slice(0, lim - 1).trimEnd() + '…' : s;
  }

  /** Duración legible: 640 ms · 1,4 s · 1 min 12 s. */
  function fmtDuration(ms) {
    const n = Number(ms);
    if (!isFinite(n) || n < 0) return '';
    if (n < 1000) return Math.round(n) + ' ms';
    if (n < 60000) {
      // sub-minuto: se conservan las décimas (1,4 s); si el redondeo llega a 60,0
      // (59,96 s) se lee mejor como 1 min que como «60,0 s»
      const dec = (n / 1000).toFixed(1);
      return dec === '60.0' ? '1 min' : dec.replace('.', ',') + ' s';
    }
    // los segundos se redondean y PUEDEN valer 60 (1 min 59,6 s): hay que acarrearlos
    const m = Math.floor(n / 60000), s = Math.round((n % 60000) / 1000);
    const mins = s === 60 ? m + 1 : m, secs = s % 60;
    return mins + ' min' + (secs ? ' ' + secs + ' s' : '');
  }

  /** "3 herramientas" / "1 herramienta". */
  function toolCount(n) {
    return n + (n === 1 ? ' herramienta' : ' herramientas');
  }

  /** Conteo con separador de miles castellano (punto). */
  function thousands(n) {
    return Number(n || 0).toLocaleString('es-ES');
  }

  /* -------------------------------------------------------------------------
     4. PLANES — modo PLAN
     El prompt del modo PLAN pide empezar la respuesta con "PLAN:" y pasos
     numerados. Extraemos esos pasos para pintarlos como checklist interactiva,
     dejando el resto del texto como respuesta normal.
     ------------------------------------------------------------------------- */
  const PLAN_STEP = /^\s*(?:(\d+)\s*[.)\-:]|[-*•])\s+(.+?)\s*$/;

  /**
   * ¿Es esta línea la cabecera del plan?
   * Los modelos la escriben de mil formas —"PLAN:", "PLAN", "**PLAN:**",
   * "__Plan__:"— así que se limpia el énfasis markdown antes de comparar.
   */
  function isPlanHeader(line) {
    const clean = String(line || '').replace(/[*_`#]/g, '').trim();
    return /^plan:?$/i.test(clean);
  }

  /**
   * Separa el plan del resto de la respuesta.
   * → { steps: [{ n, text }], body }  ·  steps vacío si no hay plan.
   */
  function parsePlan(text) {
    const src = String(text || '');
    if (!src.trim()) return { steps: [], body: '' };
    const lines = src.split('\n');
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (isPlanHeader(lines[i])) { start = i + 1; break; }
    }
    if (start < 0) return { steps: [], body: src };
    const steps = [];
    let end = start;
    for (let i = start; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) {
        // una línea en blanco sólo corta el plan si lo siguiente ya no es un paso
        const next = lines[i + 1];
        if (next === undefined) { end = i; break; }
        if (!PLAN_STEP.test(next)) { end = i; break; }
        end = i + 1;
        continue;
      }
      const m = line.match(PLAN_STEP);
      if (!m) { end = i; break; }
      steps.push({ n: steps.length + 1, text: m[2].replace(/\s*\*\*\s*$/g, '').trim() });
      end = i + 1;
    }
    if (!steps.length) return { steps: [], body: src };
    const body = lines.slice(0, start - 1).concat(lines.slice(end)).join('\n').trim();
    return { steps, body };
  }

  /* -------------------------------------------------------------------------
     5. RESULTADOS DE HERRAMIENTA — resumen y clasificación
     ------------------------------------------------------------------------- */

  /** ¿El resultado de una herramienta parece un error? */
  function looksFailed(result) {
    const t = String(result === null || result === undefined ? '' : result).trim();
    if (!t) return false;
    return /^(error|error:|no se pudo|no pude|falló|fallo|denegado|permission denied|command failed|enoent)/i.test(t);
  }

  /** Primera línea útil de un resultado, para la cabecera de la tarjeta. */
  function resultSummary(result, max) {
    const t = String(result === null || result === undefined ? '' : result).replace(/\r/g, '');
    const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
    const first = lines[0] || '';
    const extra = lines.length > 1 ? ` · ${lines.length} líneas` : '';
    return clip(first, max || 120) + extra;
  }

  /** Nombre corto de un subagente para etiquetar sus pasos. */
  const SUBAGENTS = {
    research: { label: 'Investigador', icon: 'search', cls: 'a-b' },
    browser:  { label: 'Navegador', icon: 'compass', cls: 'a-c' },
    coding:   { label: 'Programador', icon: 'code', cls: 'a-p2' },
    file:     { label: 'Archivador', icon: 'folder', cls: 'a-y' },
    vision:   { label: 'Analista visual', icon: 'eye', cls: 'a-b2' },
    verify:   { label: 'Verificador', icon: 'check', cls: 'a-p' },
  };

  function subagent(key) {
    return SUBAGENTS[String(key || '')] || null;
  }

  /**
   * Traduce el fallo crudo del proveedor a algo que se pueda leer y, sobre todo,
   * que diga qué hacer. Antes el turno fallido mostraba «Error: fetch failed» tal
   * cual, sin causa ni salida.
   * Devuelve { texto, pista } — `pista` es la acción concreta.
   */
  function explainError(raw) {
    const m = String(raw || '').toLowerCase();
    if (/fetch failed|enotfound|econnrefused|network|socket hang up/.test(m)) {
      return { texto: 'No se pudo conectar con el proveedor', pista: 'Comprueba tu conexión y la URL/clave en Ajustes › Modelo.' };
    }
    if (/401|403|unauthorized|invalid api key|incorrect api key/.test(m)) {
      return { texto: 'El proveedor rechazó la credencial', pista: 'Revisa la clave de API en Ajustes › Modelo.' };
    }
    if (/429|rate limit|too many requests/.test(m)) {
      return { texto: 'El proveedor está limitando las peticiones', pista: 'Espera un momento o cambia de modelo en Ajustes.' };
    }
    if (/timeout|timed out|aborted|tardó demasiado/.test(m)) {
      return { texto: 'El proveedor dejó de responder', pista: 'Reintenta; si se repite, prueba otro modelo.' };
    }
    if (/context|token|maximum/.test(m)) {
      return { texto: 'La conversación no cabe en el modelo', pista: 'Empieza una conversación nueva o usa un modelo con más contexto.' };
    }
    if (/404|not found|model/.test(m)) {
      return { texto: 'El proveedor no reconoce ese modelo', pista: 'Elige otro en Ajustes › Modelo.' };
    }
    return { texto: 'El turno falló', pista: 'Vuelve a intentarlo; si sigue, revisa Ajustes › Modelo.' };
  }

  /**
   * Modelos entre los que el usuario puede cambiar: los que ofrece su API para el
   * proveedor que tiene activo (la lista detectada al guardarlo) más, siempre, el
   * que está en uso. `providers` viene de la configuración; se empareja por id y,
   * si la activación no trajo id, por baseUrl.
   *
   * Devuelve { provider, models, current, known }: `known` distingue «la lista es
   * la de tu API» de «solo sabemos el modelo activo porque el proveedor no tiene
   * lista guardada», que es lo que la UI necesita para ofrecer detectarlos.
   */
  function modelChoices(active, providers) {
    const list = Array.isArray(providers) ? providers.filter(p => p && p.baseUrl) : [];
    const prov = (active && list.find(p => (active.providerId && p.id === active.providerId) || p.baseUrl === active.baseUrl)) || null;
    const current = (active && active.model) || null;
    const seen = new Set();
    const models = [];
    for (const m of (prov && prov.models) || []) {
      const id = String(m || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push(id);
    }
    // el activo siempre aparece, aunque se activara a mano y no esté en la lista
    if (current && !seen.has(current)) models.unshift(current);
    return { provider: prov ? { id: prov.id, name: prov.name || 'Proveedor' } : null, models, current, known: !!(prov && seen.size) };
  }

  return {
    MODES, MODE_ORDER, mode, nextMode,
    TOOLS, tool, summarizeArgs, flatValue,
    clip, fmtDuration, toolCount, thousands,
    parsePlan, isPlanHeader, looksFailed, resultSummary,
    SUBAGENTS, subagent,
    explainError, modelChoices,
  };
})();

if (typeof window !== 'undefined') window.ChatKit = ChatKit;
if (typeof module === 'object' && module.exports) module.exports = ChatKit;
