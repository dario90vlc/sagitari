'use strict';

/* Subagentes de SAGITARI (v1.4 — Subagentes + Orquestador).
   Registro de agentes especializados: cada uno tiene un rol, un prompt de
   sistema propio, un SUBCONJUNTO de herramientas y presupuesto de pasos.

   El orquestador es el agente principal: decide cuándo delegar con la
   herramienta delegate (agent/tools.js). El subagente ejecuta con sus
   herramientas/permisos y devuelve un RESULTADO ESTRUCTURADO al principal,
   que integra la respuesta final.

   El TaskManager y el chat usan todos el mismo Agent: el "orquestador" no es
   una clase aparte sino el agente que llama a delegate. */

/* ---------- definición de subagentes ---------- */

const SUBAGENTS = {
  research: {
    key: 'research',
    name: 'Research Agent',
    emoji: '🔍',
    role: 'busca, lee y sintetiza información',
    allowTools: ['browser_control', 'open_url', 'read_file', 'search_files', 'list_dir', 'screenshot', 'clipboard'],
    maxSteps: 25,
    systemExtra: 'Eres el SUBAGENTE DE INVESTIGACIÓN. Tu único trabajo: recolectar información (navegador, archivos) y devolver un resumen factual y citado (URLs/rutas). NO escribas archivos ni ejecutes comandos.',
  },
  browser: {
    key: 'browser',
    name: 'Browser Agent',
    emoji: '🧭',
    role: 'opera el navegador (navegar, clic, formularios, leer páginas)',
    allowTools: ['browser_control', 'open_url', 'screenshot', 'clipboard'],
    maxSteps: 30,
    systemExtra: 'Eres el SUBAGENTE DE NAVEGADOR. Domina browser_control (usa elements para ver la página con índices y click_index para actuar). Verifica cada paso leyendo el resultado. NO toques el sistema de archivos ni la terminal.',
  },
  coding: {
    key: 'coding',
    name: 'Coding Agent',
    emoji: '💻',
    role: 'escribe y ejecuta código, scripts y comandos',
    allowTools: ['run_command', 'write_file', 'edit_file', 'read_file', 'list_dir', 'search_files'],
    maxSteps: 25,
    systemExtra: 'Eres el SUBAGENTE DE PROGRAMACIÓN. Escribe código limpio en el espacio de trabajo, ejecuta y VERIFICA (tests, salida del comando). No navegues por internet.',
  },
  file: {
    key: 'file',
    name: 'File Agent',
    emoji: '📁',
    role: 'organiza y gestiona archivos y carpetas',
    allowTools: ['read_file', 'write_file', 'edit_file', 'list_dir', 'search_files', 'run_command'],
    maxSteps: 20,
    systemExtra: 'Eres el SUBAGENTE DE ARCHIVOS. Organiza, copia, mueve y documenta. run_command solo para operaciones de ficheros (robocopy, move, del), nunca para instalar ni configurar.',
  },
  vision: {
    key: 'vision',
    name: 'Vision Agent',
    emoji: '👁️',
    role: 'analiza capturas de pantalla e imágenes',
    allowTools: ['screenshot', 'browser_control'],
    maxSteps: 10,
    systemExtra: 'Eres el SUBAGENTE DE VISIÓN. Captura pantalla/página y describe con precisión lo que ves: textos, botones, estados, errores visibles. Devuelve hechos, no suposiciones.',
  },
  verification: {
    key: 'verification',
    name: 'Verification Agent',
    emoji: '✅',
    role: 'comprueba que el objetivo se cumplió de verdad',
    allowTools: ['read_file', 'list_dir', 'search_files', 'browser_control', 'screenshot', 'run_command'],
    maxSteps: 12,
    systemExtra: 'Eres el SUBAGENTE DE VERIFICACIÓN. Recibes un objetivo y tu trabajo es INTENTAR REFUTARLO: lee el archivo, abre la página, ejecuta la comprobación. Responde VERIFICADO con evidencia, o FALLO con lo que falta exactamente.',
  },
};

const SUBAGENT_KEYS = Object.keys(SUBAGENTS);

/** Definición de la herramienta delegate (va al prompt del orquestador). */
function delegateToolDef() {
  return {
    type: 'function',
    function: {
      name: 'delegate',
      description: 'DELEGA una subtarea a un subagente especializado. Úsala cuando la subtarea sea autónoma (p.ej. "investiga X", "verifica que el archivo está bien", "programa Y"). Devuelve el resultado estructurado del subagente.',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: SUBAGENT_KEYS, description: 'Subagente especializado' },
          task: { type: 'string', description: 'La subtarea concreta y autónoma, con todo el contexto necesario' },
          context: { type: 'string', description: 'Datos ya conocidos que el subagente necesita (URLs, rutas, hallazgos previos)' }
        },
        required: ['agent', 'task']
      }
    }
  };
}

/** Recorta toolDefs a las herramientas permitidas de un subagente.
    (require diferido de tools.js para evitar la dependencia circular) */
function toolDefsFor(key) {
  const spec = SUBAGENTS[key];
  if (!spec) return [];
  const { toolDefs } = require('./tools');
  return toolDefs.filter(d => spec.allowTools.includes(d.function.name));
}

/** System prompt completo de un subagente. */
function subagentSystemPrompt(key, workspace) {
  const spec = SUBAGENTS[key];
  const wsLine = workspace ? `\n\nESPACIO DE TRABAJO: ${workspace} (rutas relativas resuelven aquí).` : '';
  const tools = spec.allowTools.join(', ');
  return `Eres SAGITARI — ${spec.name} (${spec.role}).\n\n${spec.systemExtra}\n\nTus herramientas (SOLO estas): ${tools}.${wsLine}\n\nMODO DE TRABAJO:\n1. Ejecuta tu subtarea con tus herramientas, paso a paso.\n2. Algunas herramientas piden confirmación al usuario: si una acción queda denegada, NO la repitas — continúa por otra vía o refléjalo en el resultado.\n3. VERIFICA el resultado antes de responder (no des por hecho el éxito).\n4. Tu ÚLTIMO mensaje debe ser EXCLUSIVAMENTE el resultado final en este formato:\nRESULT: <resumen en 1-3 líneas>\nDETAILS: <datos relevantes: URLs, rutas, valores encontrados, evidencia>\nSTATUS: OK | PARTIAL | FAILED\n— STATUS FAILED si no pudiste completar; PARTIAL si completaste solo parte.`;
}

/** Parsea la respuesta final estructurada de un subagente. */
function parseSubagentResult(text) {
  const t = String(text || '');
  const get = (tag) => {
    const m = t.match(new RegExp(tag + '[ \\t]*:(.*)', 'im'));
    return m ? m[1].trim() : '';
  };
  const result = get('RESULT') || t.split('\n')[0].slice(0, 200);
  const details = get('DETAILS');
  const statusRaw = get('STATUS').toUpperCase();
  const status = ['OK', 'PARTIAL', 'FAILED'].includes(statusRaw) ? statusRaw
    : (/error|no pude|falló|fallo/i.test(t) ? 'FAILED' : 'OK');
  return { status, result, details };
}

module.exports = { SUBAGENTS, SUBAGENT_KEYS, delegateToolDef, toolDefsFor, subagentSystemPrompt, parseSubagentResult };
