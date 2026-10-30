'use strict';

/* ============================================================================
   chatkit.js — la "inteligencia" del chat de SAGITARI, en funciones puras.

   Vive aquí (y no dentro de los scripts 1x) por dos razones:
     · el renderer no tiene estado ni DOM en estas funciones → testeables
     · se carga como <script> normal en la ventana y como require() en Node,
       así los tests cubren de verdad la lógica en vez de mirar si el HTML
       contiene una cadena.

   IMPORTANTE: todo va dentro de un IIFE. Estos scripts son clásicos y comparten
   un único ámbito global, así que un `const MODE_ORDER` en top-level aquí y otro
   en 40-vistas.js son un SyntaxError que deja la app entera sin arrancar (sin
   iconos, sin botones, sin nada). Lo único que sale de este fichero es window.ChatKit.

   Cubre: identidad de los modos ACT/PLAN/THINK/EQUIPO, el catálogo de herramientas
   (etiqueta humana + icono), el resumen de sus argumentos, el formato de
   duración y el parser de planes del modo PLAN.
   ============================================================================ */
const ChatKit = (function () {
  /* -------------------------------------------------------------------------
     0. IDIOMA — lo que se lee en pantalla son CLAVES del diccionario
     Las etiquetas de modos, herramientas, subagentes y órdenes son claves
     (`modo.*`, `herramienta.*`, `subagente.*`, `orden.*`) que se resuelven al
     LEERLAS, no al cargar: en index.html este fichero va ANTES que los
     diccionarios, así que se pregunta por el idioma en cada lectura. En Node (la
     suite del renderer) cae al diccionario español, que es el de casa.
     ------------------------------------------------------------------------- */
  function i18n() {
    return (typeof window !== 'undefined' && window.I18N) || null;
  }
  function t(clave, vars) {
    const motor = i18n();
    if (motor) return motor.t(clave, vars);
    /* Node sin I18N: el diccionario español se lee de su fichero. */
    const tabla = (typeof window !== 'undefined' && window.I18N_ES) || (typeof require === 'function' ? require('./i18n-es') : null) || {};
    return String(tabla[clave] || clave).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? String(vars[k]) : m));
  }

  /* -------------------------------------------------------------------------
     1. MODOS — cada uno con identidad propia y real
     Los CUATRO perfiles existen ya en el backend (agent/agent.js: MODE_PROFILES):
     distinta temperatura y distinto prompt (el presupuesto de pasos NO es del modo:
     lo fija el guardarraíl del usuario en Ajustes). Aquí sólo
     se les da una cara: color, icono, lema y en qué se diferencian.
     EQUIPO (v4.4) es el cuarto: el agente pasa a líder, reparte el encargo entre
     compañeros vivos y agrega lo que devuelven. Su color es el ámbar `245,158,66`,
     que es el valor FIJO que comparten la vista del chat, el segmento del
     compositor y la píldora del sidebar (styles.css).
     ------------------------------------------------------------------------- */
  const MODES = {
    act: {
      key: 'act',
      label: 'ACT',
      get name() {
        return t('modo.act.nombre');
      },
      icon: 'zap',
      dot: 'ok',
      color: '#34d399',
      rgb: '52,211,153',
      cls: 'act',
      get tagline() {
        return t('modo.act.lema');
      },
      get bullets() {
        return [t('modo.act.p1'), t('modo.act.p2'), t('modo.act.p3')];
      },
    },
    plan: {
      key: 'plan',
      label: 'PLAN',
      get name() {
        return t('modo.plan.nombre');
      },
      icon: 'map',
      dot: 'pur',
      color: '#a78bfa',
      rgb: '167,139,250',
      cls: 'plan',
      get tagline() {
        return t('modo.plan.lema');
      },
      get bullets() {
        return [t('modo.plan.p1'), t('modo.plan.p2'), t('modo.plan.p3')];
      },
    },
    think: {
      key: 'think',
      label: 'THINK',
      get name() {
        return t('modo.think.nombre');
      },
      icon: 'brain',
      dot: 'blu',
      color: '#7db4ff',
      rgb: '125,180,255',
      cls: 'think',
      get tagline() {
        return t('modo.think.lema');
      },
      get bullets() {
        return [t('modo.think.p1'), t('modo.think.p2'), t('modo.think.p3')];
      },
    },
    equipo: {
      key: 'equipo',
      label: 'EQUIPO',
      get name() {
        return t('modo.equipo.nombre');
      },
      icon: 'team',
      // el punto ámbar de siempre (.dot.a-y): el modo no estrena vocabulario visual
      dot: 'a-y',
      color: '#f59e42',
      rgb: '245,158,66',
      cls: 'equipo',
      get tagline() {
        return t('modo.equipo.lema');
      },
      get bullets() {
        return [t('modo.equipo.p1'), t('modo.equipo.p2'), t('modo.equipo.p3')];
      },
    },
  };

  const MODE_ORDER = ['act', 'plan', 'think', 'equipo'];

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
  /* Icono de cada herramienta. Etiqueta y verbo son claves del diccionario
     (herramienta.<nombre> y herramienta.<nombre>.verbo): se resuelven al leerlas. */
  const TOOL_ICONS = {
    run_command: 'terminal',
    read_file: 'file',
    write_file: 'save',
    edit_file: 'save',
    list_dir: 'folder',
    search_files: 'search',
    open_app: 'window',
    open_url: 'globe',
    browser_control: 'compass',
    screenshot: 'camera',
    view_image: 'eye',
    clipboard: 'clipboard',
    notify: 'bell',
    media_control: 'music',
    window_manage: 'window',
    system_info: 'monitor',
    remember: 'memory',
    use_skill: 'spark',
    repo_map: 'map',
    find_symbol: 'search',
    search_code: 'search',
    apply_patch: 'save',
    todo_write: 'list',
    delegate: 'agents',
    /* v4.4 — modo EQUIPO. También llevan ficha para que su tarjeta se lea como las
       demás (el arnés falla si una herramienta nace sin etiqueta ni icono). */
    team_spawn: 'agents',
    team_send: 'send',
    team_wait: 'clock',
    team_board: 'list',
    team_done: 'check',
    web_fetch: 'globe',
    git_status: 'list',
    git_diff: 'file',
    git_log: 'history',
    git_branch: 'map',
    git_commit: 'save',
  };

  const TOOLS = {};
  for (const [nombre, icon] of Object.entries(TOOL_ICONS)) {
    TOOLS[nombre] = {
      icon,
      get label() {
        return t('herramienta.' + nombre);
      },
      get verb() {
        return t('herramienta.' + nombre + '.verbo');
      },
    };
  }

  const FALLBACK_TOOL = {
    icon: 'tools',
    get label() {
      return t('herramienta.generica');
    },
    get verb() {
      return t('herramienta.generica.verbo');
    },
  };

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
    read_file: ['path'],
    view_image: ['path'],
    write_file: ['path'],
    edit_file: ['path'],
    list_dir: ['path'],
    search_files: ['pattern', 'path'],
    open_app: ['name', 'args'],
    open_url: ['url'],
    browser_control: ['action', 'url', 'text', 'selector', 'index', 'key', 'value', 'files'],
    clipboard: ['action', 'text'],
    media_control: ['action'],
    window_manage: ['action', 'title', 'name'],
    remember: ['text', 'key'],
    use_skill: ['name'],
    repo_map: ['path'],
    find_symbol: ['query', 'name'],
    search_code: ['query', 'q'],
    apply_patch: ['changes', 'summary'],
    todo_write: ['todos'],
    delegate: ['agent', 'task'],
    notify: ['title', 'message'],
    system_info: ['query', 'what'],
    web_fetch: ['url'],
    git_diff: ['path'],
    git_log: ['n'],
    git_branch: ['action', 'name'],
    git_commit: ['message'],
  };

  /** Un valor de argumento, aplanado a una línea corta y legible. */
  function flatValue(v, max) {
    const lim = max || 90;
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
      try {
        return clip(JSON.stringify(v).replace(/[[\]{}"]/g, ''), lim);
      } catch {
        return '';
      }
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
    // la lista de tareas: «3 tareas · 1 en curso», nunca el JSON crudo
    if (String(name) === 'todo_write' && Array.isArray(a.todos)) {
      const l = a.todos;
      const enCurso = l.filter((t) => t && t.status === 'in_progress').length;
      const hechas = l.filter((t) => t && t.status === 'completed').length;
      return (
        t('herramienta.tareas', { n: l.length }) +
        (enCurso ? ' · ' + t('chat.enCurso', { n: enCurso }) : '') +
        (hechas ? ' · ' + t('herramienta.tareas.hechas', { n: hechas }) : '')
      );
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

  /** Recorta a `max` caracteres, añadiendo puntos suspensivos sólo si corta.
      Corta por PUNTOS DE CÓDIGO, no por unidades UTF-16: un emoji fuera del BMP ocupa dos
      unidades y un corte en medio dejaba un sustituto suelto («�») en pantalla. */
  function clip(text, max) {
    const s = String(text === null || text === undefined ? '' : text);
    const lim = max || 120;
    if (s.length <= lim) return s; // ni un astral de más: no hay nada que cortar
    const puntos = Array.from(s);
    if (puntos.length <= lim) return s; // el corte en unidades no era real en puntos
    const cortados = puntos.slice(0, lim - 1);
    return cortados.join('').trimEnd() + '…';
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
      return dec === '60.0' ? '1 min' : dec.replace('.', i18n() && i18n().idioma === 'en' ? '.' : ',') + ' s';
    }
    // los segundos se redondean y PUEDEN valer 60 (1 min 59,6 s): hay que acarrearlos
    const m = Math.floor(n / 60000),
      s = Math.round((n % 60000) / 1000);
    const mins = s === 60 ? m + 1 : m,
      secs = s % 60;
    return mins + ' min' + (secs ? ' ' + secs + ' s' : '');
  }

  /** "3 herramientas" / "1 herramienta". */
  function toolCount(n) {
    return n === 1 ? t('herramienta.cuenta.una') : t('herramienta.cuenta.varias', { n });
  }

  /** Conteo con separador de miles del idioma (punto en español, coma en inglés). */
  function thousands(n) {
    return Number(n || 0).toLocaleString(i18n() && i18n().idioma === 'en' ? 'en-US' : 'es-ES');
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
    const clean = String(line || '')
      .replace(/[*_`#]/g, '')
      .trim();
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
      if (isPlanHeader(lines[i])) {
        start = i + 1;
        break;
      }
    }
    if (start < 0) return { steps: [], body: src };
    const steps = [];
    let end = start;
    for (let i = start; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) {
        // una línea en blanco sólo corta el plan si lo siguiente ya no es un paso
        const next = lines[i + 1];
        if (next === undefined) {
          end = i;
          break;
        }
        if (!PLAN_STEP.test(next)) {
          end = i;
          break;
        }
        end = i + 1;
        continue;
      }
      const m = line.match(PLAN_STEP);
      if (!m) {
        end = i;
        break;
      }
      steps.push({ n: steps.length + 1, text: m[2].replace(/\s*\*\*\s*$/g, '').trim() });
      end = i + 1;
    }
    if (!steps.length) return { steps: [], body: src };
    const body = lines
      .slice(0, start - 1)
      .concat(lines.slice(end))
      .join('\n')
      .trim();
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
    const crudo = String(result === null || result === undefined ? '' : result).replace(/\r/g, '');
    const lines = crudo
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const first = lines[0] || '';
    const extra = lines.length > 1 ? ' · ' + t('herramienta.lineas', { n: lines.length }) : '';
    return clip(first, max || 120) + extra;
  }

  /* Aspecto de cada subagente. La etiqueta es la clave `subagente.<clave>`: las claves
     son EXACTAMENTE las del registro del agente (agent/subagents.js) y `verify` sigue
     siendo alias del verificador. */
  const SUBAGENT_LOOK = {
    research: { icon: 'search', cls: 'a-b' },
    browser: { icon: 'compass', cls: 'a-c' },
    coding: { icon: 'code', cls: 'a-p2' },
    file: { icon: 'folder', cls: 'a-y' },
    vision: { icon: 'eye', cls: 'a-b2' },
    verification: { icon: 'check', cls: 'a-p' },
    review: { icon: 'list', cls: 'a-y2' },
  };
  const SUBAGENTS = {};
  for (const [k, look] of Object.entries(SUBAGENT_LOOK)) {
    SUBAGENTS[k] = {
      ...look,
      get label() {
        return t('subagente.' + k);
      },
    };
  }
  SUBAGENTS.verify = SUBAGENTS.verification;

  /**
   * Etiqueta de un subagente. NUNCA devuelve null para una clave no vacía: un agente
   * nuevo (o un nombre inesperado del proveedor) no puede dejar la tarjeta sin nombre
   * ni tumbar el manejador de eventos al leer `.label`.
   */
  function subagent(key) {
    const k = String(key || '');
    if (!k) return null;
    return SUBAGENTS[k] || { label: k, icon: 'agents', cls: 'a-p2' };
  }

  /**
   * Traduce el fallo crudo del proveedor a algo que se pueda leer y, sobre todo,
   * que diga qué hacer. Antes el turno fallido mostraba «Error: fetch failed» tal
   * cual, sin causa ni salida.
   * Devuelve { texto, pista } — `pista` es la acción concreta.
   */
  function explainError(raw) {
    const m = String(raw || '').toLowerCase();
    const par = (clave) => ({ texto: t('chat.error.' + clave + '.texto'), pista: t('chat.error.' + clave + '.pista') });
    if (/fetch failed|enotfound|econnrefused|network|socket hang up/.test(m)) return par('red');
    if (/401|403|unauthorized|invalid api key|incorrect api key/.test(m)) return par('credencial');
    if (/429|rate limit|too many requests/.test(m)) return par('limite');
    /* 402 en OpenCode Go no significa «paga»: llega con «Endpoint is unavailable» cuando
       el modelo se ha caído arriba. Caía en «El turno falló — revisa Ajustes», que manda
       a mirar la clave cuando no hay nada que arreglar aquí: solo cambiar de modelo o
       esperar. Medido con longcat-2.5-preview-free: 4 llamadas, 4 fallos, todos 402. */
    if (/402|endpoint is unavailable/.test(m)) return par('noDisponible');
    if (/timeout|timed out|aborted|tardó demasiado/.test(m)) return par('sinRespuesta');
    if (/context|token|maximum/.test(m)) return par('contexto');
    /* Los dos fallos que ve el usuario cuando el modelo no respeta el protocolo de
       herramientas: el texto en vez de la llamada (nuestro aviso) y el rechazo del
       proveedor por argumentos rotos. Antes caían en «El turno falló», que no dice nada
       ni deja salida. */
    if (/formato de herramientas|llamadas a herramientas como texto|invalid.{0,20}tool|tool.{0,20}arguments/.test(m))
      return par('formato');
    if (/400|bad request|invalid.{0,20}(json|request|argument)/.test(m)) return par('peticion');
    if (/404|not found|model/.test(m)) return par('modelo');
    return par('generico');
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
    const list = Array.isArray(providers) ? providers.filter((p) => p && p.baseUrl) : [];
    const prov = (active && list.find((p) => (active.providerId && p.id === active.providerId) || p.baseUrl === active.baseUrl)) || null;
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
    return { provider: prov ? { id: prov.id, name: prov.name || t('vistas.modelo.proveedor') } : null, models, current, known: !!(prov && seen.size) };
  }

  /* -------------------------------------------------------------------------
     6. ÓRDENES DE BARRA — el registro puro de los comandos del chat
     Una orden NO es un mensaje: el renderer la intercepta y no la manda al
     modelo. Esta lista es la ÚNICA fuente de verdad: la paleta («/») y la
     respuesta de «/help» pintan de aquí, así que no puede haber dos listas que
     se contradigan. Sólo los nombres de esta lista son órdenes: un «/loquesea»
     sigue siendo texto normal y se envía tal cual.
     ------------------------------------------------------------------------- */
  const COMMANDS = [
    /* Solo lo que la app HACE de verdad: `/compact` y `/cost` los ejecuta el proceso
       principal (`main/ipc-chat.js`); `/new` y `/help` los contesta el renderer (el
       botón «+» y esta misma lista). `clear` y `model` estuvieron aquí sin existir
       detrás —`/clear` era además lo mismo que `/new`— y el usuario recibía «orden
       desconocida» después de escribirla: la paleta no puede prometer lo que no hay. Si
       algún día se implementan, vuelven a esta lista y ya está. */
    { name: 'new', args: '', get descripcion() { return t('orden.new'); } },
    { name: 'compact', args: '', get descripcion() { return t('orden.compact'); } },
    { name: 'cost', args: '', get descripcion() { return t('orden.cost'); } },
    { name: 'help', args: '', get descripcion() { return t('orden.help'); } },
  ];

  /**
   * ¿Es este texto una orden de barra conocida?
   * Devuelve { name, args } o null. El nombre va en minúsculas y tolera
   * espacios delante; `args` es el resto ya recortado. Un «/» suelto, un
   * «/desconocido» o un mensaje que lleva «/» por dentro (una ruta, «y/o»)
   * devuelven null: no se toca el texto del usuario.
   */
  function parseCommand(text) {
    const m = /^\s*\/([A-Za-z]+)(\s+[\s\S]*)?$/.exec(String(text === null || text === undefined ? '' : text));
    if (!m) return null;
    const name = m[1].toLowerCase();
    if (!COMMANDS.some((c) => c.name === name)) return null;
    return { name, args: m[2] ? m[2].trim() : '' };
  }

  return {
    MODES,
    MODE_ORDER,
    COMMANDS,
    parseCommand,
    mode,
    nextMode,
    TOOLS,
    tool,
    summarizeArgs,
    flatValue,
    clip,
    fmtDuration,
    toolCount,
    thousands,
    parsePlan,
    isPlanHeader,
    looksFailed,
    resultSummary,
    SUBAGENTS,
    subagent,
    explainError,
    modelChoices,
  };
})();

if (typeof window !== 'undefined') window.ChatKit = ChatKit;
if (typeof module === 'object' && module.exports) module.exports = ChatKit;
