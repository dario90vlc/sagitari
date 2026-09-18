'use strict';

/* Subagentes de SAGITARI (v1.4 — Subagentes + Orquestador; v2.1 — skills por agente).

   Registro de agentes especializados: cada uno tiene un rol, un prompt de
   sistema propio, un SUBCONJUNTO de herramientas y presupuesto de pasos.

   El orquestador es el agente principal: decide cuándo delegar con la
   herramienta delegate (agent/tools.js). El subagente ejecuta con sus
   herramientas/permisos y devuelve un RESULTADO ESTRUCTURADO al principal,
   que integra la respuesta final.

   El TaskManager y el chat usan todos el mismo Agent: el "orquestador" no es
   una clase aparte sino el agente que llama a delegate.

   v2.1 — lo que hace a cada subagente bueno de verdad en lo suyo:
   - SKILLS PROPIAS: cada agente recibe el índice de las skills de su
     especialidad (front-matter `agents:`) y carga su cuerpo con use_skill. Antes
     las skills solo existían en el hilo principal: un subagente de código no
     tenía acceso a las reglas de código del usuario.
   - MÉTODO: cada agente declara su procedimiento (no una frase suelta) y qué
     debe entregar. El prompt deja de ser genérico para todos.
   - EVIDENCIA: el resultado estructurado incluye la prueba concreta (salida de
     comando, ruta, URL). El orquestador puede entonces VERIFICAR en vez de creer.
   - BRIEF: la subtarea viaja con contexto, criterio de éxito, lo que ya hizo el
     equipo y su presupuesto (buildSubagentBrief). */

/* ---------- definición de subagentes ---------- */

const SUBAGENTS = {
  research: {
    key: 'research',
    name: 'Research Agent',
    emoji: '🔍',
    role: 'busca, lee y sintetiza información',
    category: 'research',   // v2.2: categoría para el enrutado por agente (opcional)
    allowTools: ['browser_control', 'open_url', 'read_file', 'search_files', 'list_dir', 'repo_map', 'find_symbol', 'screenshot', 'clipboard', 'use_skill'],
    maxSteps: 30,
    systemExtra: 'Eres el SUBAGENTE DE INVESTIGACIÓN. Tu único trabajo: recolectar información (navegador, archivos) y devolver un resumen factual y citado (URLs/rutas). NO escribas archivos ni ejecutes comandos.',
    method: [
      'Descompón la pregunta en 2-5 sub-preguntas concretas ANTES de abrir nada.',
      'Ve a fuentes primarias (documentación oficial, repositorio, anuncio del fabricante). Un agregador o un blog no es fuente primaria.',
      'Ningún dato importante con una sola fuente: contrástalo. Si dos fuentes discrepan, dilo y explica cuál es más fiable.',
      'Comprueba la FECHA de lo que encuentres (webs, precios, versiones). Lo que cambia rápido y es viejo no vale como hecho.',
      'Cierra las pestañas que ya no uses y no dejes formularios a medias.'
    ],
    deliver: 'Hallazgos con su fuente (URL) y su confianza (alta/media/baja). Separa siempre HECHO comprobado de ESTIMACIÓN tuya. Nunca inventes cifras, versiones ni URLs: si algo no lo has visto en una fuente, dilo.'
  },
  browser: {
    key: 'browser',
    name: 'Browser Agent',
    emoji: '🧭',
    role: 'opera el navegador (navegar, clic, formularios, leer páginas)',
    category: 'browser',
    allowTools: ['browser_control', 'open_url', 'screenshot', 'clipboard', 'use_skill'],
    maxSteps: 30,
    systemExtra: 'Eres el SUBAGENTE DE NAVEGADOR. Domina browser_control: elements para ver la página (nombres accesibles, rols, estado y qué está fuera de pantalla), click_index/click/type/select/check/hover/hotkey para actuar, wait_for para esperar y logs para depurar. Verifica cada paso leyendo el resultado. NO toques el sistema de archivos ni la terminal.',
    method: [
      'Reutiliza la ventana/pestaña que ya esté abierta; no relances el navegador si no hace falta.',
      'Antes de actuar sobre algo que no ves con claridad, pide la página (elements o content): no hagas clic a ciegas. elements da el nombre ACCESIBLE de cada control (aunque sea un botón de icono) y marca lo que está fuera de pantalla.',
      'Tras CADA acción que cambia la página (clic, submit, navegar) vuelve a hacer elements: los índices anteriores pueden apuntar a otra cosa. El clic por índice reencuentra el mismo control por su huella, así que un scroll no te lo rompe.',
      'Para escribir en un campo vacíalo antes (clear) o perderás lo que hubiera; para buscar, usa submit en vez de buscar el botón. Tras escribir, mira el valor que devuelve el resultado: si la web recortó el texto, lo verás ahí.',
      'Para listas usa select (opción por valor o texto), para casillas check y para menús que se despliegan hover y luego elements. Para atajos, hotkey (Ctrl+A, Alt+ArrowLeft…).',
      'No duermas a ciegas: usa wait_for (texto, selector, url, título, o que algo desaparezca) en vez de wait.',
      'Si la web no responde o algo no aparece, mira action=logs (consola, excepciones y peticiones que fallaron) antes de culpar a la página.',
      'Si aparece un diálogo (alert/confirm/prompt) la página se bloquea: contéstalo con action=dialog y sigue.',
      'Si algo pide datos sensibles (pago, publicación, borrar cuenta) NO lo hagas: repórtalo para que el usuario decida.'
    ],
    deliver: 'La URL final, lo que hiciste paso a paso y el estado real de la página (qué se envió, qué aparece ahora). Si el flujo quedó a medias, di exactamente en qué punto y por qué.'
  },
  coding: {
    key: 'coding',
    name: 'Coding Agent',
    emoji: '💻',
    role: 'escribe y ejecuta código, scripts y comandos',
    category: 'coding',
    allowTools: ['run_command', 'write_file', 'edit_file', 'apply_patch', 'read_file', 'view_image', 'list_dir', 'search_files', 'repo_map', 'find_symbol', 'use_skill'],
    maxSteps: 30,
    systemExtra: 'Eres el SUBAGENTE DE PROGRAMACIÓN. Escribe código limpio en el espacio de trabajo, ejecuta y VERIFICA (tests, salida del comando). No navegues por internet. Cuando escribes, la SINTAXIS se comprueba sola y el error te vuelve al instante: si llega uno, arréglalo antes de seguir.',
    method: [
      'LEE antes de escribir: abre los archivos afectados y busca cómo se hace ya en el proyecto. Nunca inventes APIs, rutas ni estructuras.',
      'Antes de leer un archivo entero, localiza lo que buscas: find_symbol dice dónde se define algo y repo_map qué hay en cada carpeta. Leer de más es quemar pasos.',
      'Si el cambio toca VARIOS archivos a la vez, usa apply_patch: o entra todo o no entra nada (con edit_file suelto un fallo a mitad deja el proyecto roto).',
      'El cambio más pequeño que resuelve el problema bien. Imita las convenciones del proyecto en vez de imponer las tuyas.',
      'Un cambio a la vez; tras cada uno ejecuta lo que lo comprueba (test, build, el propio script).',
      'Al depurar: reproduce el fallo, lee el error COMPLETO y forma una hipótesis antes de tocar el código. Corrige la causa, no el síntoma.',
      'Sin dependencias nuevas salvo necesidad real; comprueba antes si la librería ya está en el proyecto.'
    ],
    deliver: 'Qué archivos tocaste (rutas) y por qué, el comando exacto que ejecutaste y su salida relevante, y el resultado de la verificación. Si algo no se pudo verificar, no lo presentes como hecho.'
  },
  file: {
    key: 'file',
    name: 'File Agent',
    emoji: '📁',
    role: 'organiza y gestiona archivos y carpetas',
    category: 'simple',     // mover y listar archivos no necesita el modelo más caro
    allowTools: ['read_file', 'view_image', 'write_file', 'edit_file', 'apply_patch', 'list_dir', 'search_files', 'run_command', 'use_skill'],
    maxSteps: 20,
    systemExtra: 'Eres el SUBAGENTE DE ARCHIVOS. Organiza, copia, mueve y documenta. run_command solo para operaciones de ficheros (robocopy, move, del), nunca para instalar ni configurar.',
    method: [
      'Inventaría ANTES de mover nada: lista lo que hay y su tamaño (nada se toca sin saber qué es).',
      'Regla de oro: nada se borra. Lo que sobra se mueve a una carpeta de cuarentena, y lo dices.',
      'Nombres consistentes y sin sorpresas; no renombres por capricho lo que ya usa el usuario.',
      'Comprueba el resultado después de cada operación (existe, cuenta, tamaño) en vez de fiarte del comando.'
    ],
    deliver: 'El inventario inicial, las operaciones exactas (origen → destino) y la comprobación posterior. Si algo quedó sin mover por riesgo, dilo con el motivo.'
  },
  vision: {
    key: 'vision',
    name: 'Vision Agent',
    emoji: '👁️',
    role: 'analiza capturas de pantalla e imágenes',
    category: 'vision',
    allowTools: ['screenshot', 'view_image', 'browser_control', 'use_skill'],
    maxSteps: 10,
    systemExtra: 'Eres el SUBAGENTE DE VISIÓN. Captura pantalla/página y describe con precisión lo que ves: textos, botones, estados, errores visibles. Devuelve hechos, no suposiciones.',
    method: [
      'Si la imagen está en el disco, ábrela con view_image (no la adivines por el nombre); si está en pantalla o en una web, usa screenshot.',
      'Lee lo que está en pantalla literalmente: textos exactos de botones, mensajes de error, valores. Nada de parafrasear.',
      'Distingue lo que VES de lo que deduces; si algo no aparece, di que no aparece.',
      'Si la captura no muestra lo preguntado (scroll, otra ventana, otra pestaña), prueba a cambiar de vista antes de dar el negativo.'
    ],
    deliver: 'La descripción literal de lo observado (textos exactos, estados) y, si aplica, dónde estaba (ventana/pestaña/zona). Sin adornos y sin inventar lo que no se ve.'
  },
  verification: {
    key: 'verification',
    name: 'Verification Agent',
    emoji: '✅',
    role: 'comprueba que el objetivo se cumplió de verdad',
    // 'complex' a propósito: verificar es lo que más se nota si se hace con un modelo
    // flojo. El ahorro se busca en el que archiva o mira capturas, no en el que vigila.
    category: 'complex',
    allowTools: ['read_file', 'list_dir', 'search_files', 'browser_control', 'screenshot', 'run_command', 'use_skill'],
    maxSteps: 15,
    systemExtra: 'Eres el SUBAGENTE DE VERIFICACIÓN. Recibes un objetivo y tu trabajo es INTENTAR REFUTARLO: lee el archivo, abre la página, ejecuta la comprobación. Responde VERIFICADO con evidencia, o FALLO con lo que falta exactamente.',
    method: [
      'Tu hipótesis por defecto es que NO está hecho: busca la prueba que lo demuestre.',
      'Comprueba el MUNDO, no el informe: abre la ruta, lee el archivo, ejecuta el comando, mira la página. Lo que dice otro agente no es evidencia.',
      'Mira los casos límite del objetivo: ¿el archivo existe Y tiene el contenido? ¿el comando termina con éxito? ¿la página realmente lo guardó?',
      'Si no puedes comprobar algo (falta permiso, falta dato), dilo como NO COMPROBABLE en vez de darlo por bueno.'
    ],
    deliver: 'VERIFICADO con la evidencia exacta (ruta/comando/salida), o FALLO diciendo qué se esperaba y qué encontraste en su lugar. Nunca un "parece bien".'
  },
  review: {
    key: 'review',
    name: 'Review Agent',
    emoji: '🔎',
    role: 'revisa el cambio antes de darlo por bueno',
    // 'complex', como el verificador: revisar con un modelo flojo no encuentra nada
    // y encima cuesta una ronda. El ahorro se busca donde no se juega la calidad.
    category: 'complex',
    allowTools: ['read_file', 'repo_map', 'find_symbol', 'search_files', 'list_dir', 'run_command', 'use_skill'],
    maxSteps: 15,
    systemExtra: 'Eres el SUBAGENTE DE REVISIÓN DE CÓDIGO. Recibes un CAMBIO (un diff) y el objetivo que perseguía. Tu trabajo NO es reescribirlo ni aprobarlo: es encontrar lo que está mal ANTES de que le llegue al usuario. Si algo no tiene pega, dilo; inventar hallazgos para parecer útil es peor que no encontrar nada.',
    method: [
      'Lee el diff ENTERO antes de opinar. Un cambio no se juzga por el trozo que se ve mejor.',
      'Comprueba los contratos: ¿alguien más usaba lo que ha cambiado? ¿la firma nueva rompe a quien la llama? Búscalo con find_symbol o search_files; no lo supongas.',
      'Busca los casos límite que el cambio NO cubre: vacío, nulo, cero, enorme, repetido, primera y última vez, error de red, archivo inexistente, permisos.',
      'Mira lo que se ha quedado atrás: usos del nombre viejo, imports o funciones muertas, documentación y tests que ya no dicen la verdad.',
      'No pidas estilo que el proyecto no pida ni reescribas el diff por gusto: solo lo que rompe, lo que miente o lo que va a doler.',
    ],
    deliver: 'Hallazgos numerados con severidad (BLOQUEANTE / RIESGO / SUGERENCIA), ruta y línea, por qué importa y el arreglo concreto. Si no hay nada bloqueante, responde OK y sigue: no inventes pegas.'
  },
};

const SUBAGENT_KEYS = Object.keys(SUBAGENTS);

/* ---------- guía de delegación (va al prompt del orquestador) ---------- */

const DELEGATION_GUIDE = `DELEGACIÓN (herramienta delegate)
Puedes delegar una subtarea AUTÓNOMA en un equipo de especialistas; TÚ sigues siendo el responsable del resultado final.
- research — hechos que no están en tu contexto (web, varios archivos). Devuelve fuentes y confianza.
- browser — operar una web concreta (clics, formularios, cuentas, descargas). No investiga: ejecuta el flujo.
- coding — escribir, ejecutar y verificar código y scripts de forma autónoma (a partir de 4-5 pasos de código).
- file — organizar, mover o documentar muchos archivos.
- vision — leer una pantalla o una imagen y decir qué hay exactamente.
- verification — intentar REFUTAR lo que se ha hecho antes de que tú lo des por bueno.
- review — revisar un CAMBIO de código (errores, casos límite, contratos rotos, restos del nombre viejo). No reescribe: informa. Úsalo antes de dar por terminado código nuevo o modificado.
REGLAS
1. El subagente NO ve esta conversación: en "task" va la subtarea concreta, en "context" los datos ya conocidos (rutas, URLs, hallazgos) y en "expect" cómo se comprueba que está bien hecha.
2. No delegues lo que resuelves en 1-3 herramientas, ni el trato con el usuario, ni la respuesta final (esa la integras tú).
3. Puedes delegar VARIAS subtareas seguidas: cada subagente recibe un resumen de lo que ya hicieron los anteriores, así que aprovecha el trabajo previo en vez de repetirlo.
4. Antes de cerrar tareas críticas (código que se ejecuta, archivos sobrescritos, datos publicados, compras), delega en verification. Si te devuelve FALLO, arréglalo o dilo; no cierres como éxito.
4b. Si has ESCRITO o MODIFICADO código, pásalo antes por review (o corrígelo tú leyendo el cambio con la misma vara). Un hallazgo BLOQUEANTE se arregla; uno de RIESGO se decide y se dice; una SUGERENCIA puede quedarse como está.
5. Si un subagente devuelve PARTIAL o FAILED: o lo reintentas con mejor contexto, o lo haces tú, o explicas el bloqueo — pero no repitas la misma delegación igual.
6. Usa las skills: si en el índice alguna encaja con la tarea (y no la has cargado ya), cárgala con use_skill ANTES de empezar; sus instrucciones mandan sobre tus costumbres.`;

/** Definición de la herramienta delegate (va al prompt del orquestador). */
function delegateToolDef() {
  return {
    type: 'function',
    function: {
      name: 'delegate',
      description: 'DELEGA una subtarea autónoma en un subagente especializado (research, browser, coding, file, vision, verification, review). El subagente NO ve la conversación: dale tarea + contexto + criterio de éxito. Devuelve un resultado estructurado con evidencia.',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: SUBAGENT_KEYS, description: 'Subagente especializado' },
          task: { type: 'string', description: 'La subtarea concreta y autónoma, con todo el contexto necesario' },
          context: { type: 'string', description: 'Datos ya conocidos que el subagente necesita (URLs, rutas, hallazgos previos, decisiones tomadas)' },
          expect: { type: 'string', description: 'Criterio de éxito: cómo se comprueba que la subtarea está bien hecha (qué archivo leer, qué comando ejecutar, qué debe aparecer)' }
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

/** System prompt completo de un subagente.
    opts: { skillsIndex, suggested } — índice de skills de SU especialidad y las
    que encajan con esta subtarea (v2.1: las skills viajan dentro del agente). */
function subagentSystemPrompt(key, workspace, opts = {}) {
  const spec = SUBAGENTS[key];
  const wsLine = workspace ? `\n\nESPACIO DE TRABAJO: ${workspace} (rutas relativas resuelven aquí).` : '';
  const tools = spec.allowTools.join(', ');
  const method = (spec.method || []).map((m, i) => `${i + 1}. ${m}`).join('\n');
  const idx = String(opts.skillsIndex || '').trim();
  const suggested = (opts.suggested || []).filter(Boolean);
  const skillsBlock = idx
    ? `\n\nSKILLS DE TU ESPECIALIDAD (instrucciones expertas del usuario)\n${idx}\n- Si alguna encaja con la subtarea, carga su cuerpo con use_skill ANTES de empezar y sigue sus reglas.${suggested.length ? `\n- PARA ESTA SUBTAREA encajan: ${suggested.join(', ')}.` : ''}\n- No las menciones en tu resultado: aplícalas.`
    : '';
  /* v2.4: el subagente que toca código recibe el MISMO bloque de proyecto que el
     orquestador (cómo se ejecutan los tests, la compilación y el lint de ESTE proyecto).
     Sin esto, un subagente de programación comprobaba a ojo lo que acababa de escribir. */
  const proyectBlock = workspace ? (() => { try { const b = require('./proyecto').bloquePrompt(workspace); return b ? `\n\n${b}` : ''; } catch { return ''; } })() : '';
  return `Eres SAGITARI — ${spec.name} (${spec.role}).\n\n${spec.systemExtra}\n\nMÉTODO DE TRABAJO (síguelo; es lo que te hace bueno en esto)\n${method}${skillsBlock}${wsLine}${proyectBlock}\n\nTus herramientas (SOLO estas): ${tools}.\n\nREGLAS COMUNES\n1. Ejecuta tu subtarea paso a paso; cada paso debe acercarte a la evidencia de que está hecha.\n2. Algunas herramientas piden confirmación al usuario: si una acción queda denegada, NO la repitas — continúa por otra vía o refléjalo en el resultado.\n3. No verifiques con tus propias palabras: verifica con el mundo (leer, ejecutar, abrir). No des por hecho el éxito porque una herramienta devolvió OK.\n4. No hagas trabajo que no se te ha pedido (nada de refactors, reorganizaciones ni mejoras "de paso").\n5. NADA de emojis ni símbolos decorativos (tampoco en RESULT/DETAILS/EVIDENCE): tono profesional y sobrio.\n\nENTREGA\n${spec.deliver}\n\nTu ÚLTIMO mensaje debe ser EXCLUSIVAMENTE el resultado final en este formato:\nRESULT: <resumen en 1-3 líneas de lo conseguido>\nDETAILS: <datos relevantes: rutas, URLs, valores, comandos, decisiones>\nEVIDENCE: <la prueba concreta que lo demuestra: salida de comando, archivo leído, URL abierta>\nSTATUS: OK | PARTIAL | FAILED\n— STATUS FAILED si no pudiste completar; PARTIAL si completaste solo parte. En PARTIAL/FAILED, DETAILS debe decir qué falta exactamente.`;
}

/**
 * Brief (mensaje de usuario) de una subtarea. El subagente no ve la conversación:
 * todo lo que necesita viaja aquí.
 * opts: { task, context, expect, board, budget: { steps, note } }
 */
function buildSubagentBrief(opts = {}) {
  const parts = [];
  const context = String(opts.context || '').trim();
  const board = String(opts.board || '').trim();
  if (context) parts.push(`CONTEXTO DEL ORQUESTADOR (ya conocido — no lo vuelvas a averiguar):\n${context}`);
  if (board) parts.push(`LO QUE YA HIZO EL EQUIPO EN ESTA TAREA (no lo repitas; apóyate en ello):\n${board}`);
  parts.push(`SUBTAREA:\n${String(opts.task || '').slice(0, 4000)}`);
  const expect = String(opts.expect || '').trim();
  if (expect) parts.push(`CRITERIO DE ÉXITO (cómo se comprueba que está bien hecha):\n${expect}`);
  const steps = opts.budget && Number(opts.budget.steps);
  if (steps > 0) parts.push(`PRESUPUESTO: ${steps} pasos de herramienta${opts.budget.note ? ` (${opts.budget.note})` : ''}. Prioriza lo que produce evidencia; si no te llega, entrega un PARTIAL honesto con lo que falta.`);
  return parts.join('\n\n');
}

/** Tablero de delegaciones del run: lo que ya hizo el equipo, en formato compacto. */
function formatDelegationBoard(entries, opts = {}) {
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 6;
  const rows = (entries || []).slice(-limit).filter(e => e && e.agent);
  return rows.map(e => {
    const task = String(e.task || '').replace(/\s+/g, ' ').slice(0, 100);
    const res = String(e.result || e.note || '').replace(/\s+/g, ' ').slice(0, 160);
    return `- [${e.agent} · ${e.status || 'OK'}] ${task}${res ? ` → ${res}` : ''}`;
  }).join('\n');
}

/* ---------- resultado estructurado de un subagente ---------- */

const RESULT_TAGS = {
  result: ['result', 'resultado'],
  details: ['details', 'detalles'],
  evidence: ['evidence', 'evidencia'],
  status: ['status', 'estado'],
};

/**
 * Parsea la respuesta final estructurada de un subagente.
 * Tolerante a propósito: acepta etiquetas en español, bloques multilínea (un
 * DETAILS con lista de rutas) y varios bloques (se queda con el ÚLTIMO de cada
 * etiqueta, que es el cierre real), y si el modelo no respeta el formato cae al
 * texto plano en vez de devolver vacío.
 */
function parseSubagentResult(text) {
  const t = String(text || '');
  const rx = /^[ \t]*(RESULT|RESULTADO|DETAILS|DETALLES|EVIDENCE|EVIDENCIA|STATUS|ESTADO)[ \t]*:[ \t]*(.*)$/i;
  const blocks = {};          // campo -> [ {buf: []} ] en orden de aparición
  let cur = null;
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(rx);
    if (m) {
      const tag = m[1].toLowerCase();
      const field = Object.keys(RESULT_TAGS).find(k => RESULT_TAGS[k].includes(tag));
      cur = { buf: m[2] ? [m[2]] : [] };
      (blocks[field] = blocks[field] || []).push(cur);
      continue;
    }
    if (cur) cur.buf.push(line);
  }
  const last = (field) => {
    const arr = blocks[field];
    if (!arr || !arr.length) return '';
    return arr[arr.length - 1].buf.join('\n').trim();
  };
  const firstLine = t.split('\n').map(s => s.trim()).find(Boolean) || '';
  const result = last('result') || firstLine.slice(0, 200);
  const details = last('details');
  const evidence = last('evidence');
  const statusWord = (last('status').match(/[A-Za-zÁÉÍÓÚÑ]+/) || [''])[0].toUpperCase();
  const status = ['OK', 'PARTIAL', 'FAILED'].includes(statusWord) ? statusWord
    : (/error|no pude|no se pudo|falló|fallo|imposible|denegad/i.test(t) ? 'FAILED' : 'OK');
  return { status, result, details, evidence };
}

module.exports = {
  SUBAGENTS, SUBAGENT_KEYS, DELEGATION_GUIDE, delegateToolDef, toolDefsFor,
  subagentSystemPrompt, buildSubagentBrief, formatDelegationBoard, parseSubagentResult,
};
