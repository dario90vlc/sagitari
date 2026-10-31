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

const fs = require('fs');
const path = require('path');
const i18n = require('./i18n');

const SUBAGENTS = {
  research: {
    key: 'research',
    name: 'Research Agent',
    emoji: '🔍',
    role: 'busca, lee y sintetiza información',
    category: 'research', // v2.2: categoría para el enrutado por agente (opcional)
    allowTools: [
      'browser_control',
      'open_url',
      'read_file',
      'search_files',
      'list_dir',
      'repo_map',
      'find_symbol',
      'screenshot',
      'clipboard',
      'use_skill',
    ],
    maxSteps: 30,
    systemExtra:
      'Eres el SUBAGENTE DE INVESTIGACIÓN. Tu único trabajo: recolectar información (navegador, archivos) y devolver un resumen factual y citado (URLs/rutas). NO escribas archivos ni ejecutes comandos.',
    method: [
      'Descompón la pregunta en 2-5 sub-preguntas concretas ANTES de abrir nada.',
      'Ve a fuentes primarias (documentación oficial, repositorio, anuncio del fabricante). Un agregador o un blog no es fuente primaria.',
      'Ningún dato importante con una sola fuente: contrástalo. Si dos fuentes discrepan, dilo y explica cuál es más fiable.',
      'Comprueba la FECHA de lo que encuentres (webs, precios, versiones). Lo que cambia rápido y es viejo no vale como hecho.',
      'Cierra las pestañas que ya no uses y no dejes formularios a medias.',
    ],
    deliver:
      'Hallazgos con su fuente (URL) y su confianza (alta/media/baja). Separa siempre HECHO comprobado de ESTIMACIÓN tuya. Nunca inventes cifras, versiones ni URLs: si algo no lo has visto en una fuente, dilo.',
  },
  browser: {
    key: 'browser',
    name: 'Browser Agent',
    emoji: '🧭',
    role: 'opera el navegador (navegar, clic, formularios, leer páginas)',
    category: 'browser',
    allowTools: ['browser_control', 'open_url', 'screenshot', 'clipboard', 'use_skill'],
    maxSteps: 30,
    systemExtra:
      'Eres el SUBAGENTE DE NAVEGADOR. Domina browser_control: elements para ver la página (nombres accesibles, rols, estado y qué está fuera de pantalla), click_index/click/type/select/check/hover/hotkey para actuar, wait_for para esperar y logs para depurar. Verifica cada paso leyendo el resultado. NO toques el sistema de archivos ni la terminal.',
    method: [
      'Reutiliza la ventana/pestaña que ya esté abierta; no relances el navegador si no hace falta.',
      'Antes de actuar sobre algo que no ves con claridad, pide la página (elements o content): no hagas clic a ciegas. elements da el nombre ACCESIBLE de cada control (aunque sea un botón de icono) y marca lo que está fuera de pantalla.',
      'Tras CADA acción que cambia la página (clic, submit, navegar) vuelve a hacer elements: los índices anteriores pueden apuntar a otra cosa. El clic por índice reencuentra el mismo control por su huella, así que un scroll no te lo rompe.',
      'Para escribir en un campo vacíalo antes (clear) o perderás lo que hubiera; para buscar, usa submit en vez de buscar el botón. Tras escribir, mira el valor que devuelve el resultado: si la web recortó el texto, lo verás ahí.',
      'Para listas usa select (opción por valor o texto), para casillas check y para menús que se despliegan hover y luego elements. Para atajos, hotkey (Ctrl+A, Alt+ArrowLeft…).',
      'No duermas a ciegas: usa wait_for (texto, selector, url, título, o que algo desaparezca) en vez de wait.',
      'Si la web no responde o algo no aparece, mira action=logs (consola, excepciones y peticiones que fallaron) antes de culpar a la página.',
      'Si aparece un diálogo (alert/confirm/prompt) la página se bloquea: contéstalo con action=dialog y sigue.',
      'Si algo pide datos sensibles (pago, publicación, borrar cuenta) NO lo hagas: repórtalo para que el usuario decida.',
    ],
    deliver:
      'La URL final, lo que hiciste paso a paso y el estado real de la página (qué se envió, qué aparece ahora). Si el flujo quedó a medias, di exactamente en qué punto y por qué.',
  },
  coding: {
    key: 'coding',
    name: 'Coding Agent',
    emoji: '💻',
    role: 'escribe y ejecuta código, scripts y comandos',
    category: 'coding',
    allowTools: [
      'run_command',
      'write_file',
      'edit_file',
      'apply_patch',
      'read_file',
      'view_image',
      'list_dir',
      'search_files',
      'repo_map',
      'find_symbol',
      'use_skill',
    ],
    maxSteps: 30,
    systemExtra:
      'Eres el SUBAGENTE DE PROGRAMACIÓN. Escribe código limpio en el espacio de trabajo, ejecuta y VERIFICA (tests, salida del comando). No navegues por internet. Cuando escribes, la SINTAXIS se comprueba sola y el error te vuelve al instante: si llega uno, arréglalo antes de seguir.',
    method: [
      'LEE antes de escribir: abre los archivos afectados y busca cómo se hace ya en el proyecto. Nunca inventes APIs, rutas ni estructuras.',
      'Antes de leer un archivo entero, localiza lo que buscas: find_symbol dice dónde se define algo y repo_map qué hay en cada carpeta. Leer de más es quemar pasos.',
      'Si el cambio toca VARIOS archivos a la vez, usa apply_patch: o entra todo o no entra nada (con edit_file suelto un fallo a mitad deja el proyecto roto).',
      'Si un anclaje falla SOLO por la sangría, el error te devuelve el texto exacto del archivo: repite la llamada con tolerar_espacios: true (se reajusta la sangría) en vez de adivinar la indentación o reescribir el archivo entero.',
      'El cambio más pequeño que resuelve el problema bien. Imita las convenciones del proyecto en vez de imponer las tuyas.',
      'Un cambio a la vez; tras cada uno ejecuta lo que lo comprueba (test, build, el propio script).',
      'Al depurar: reproduce el fallo, lee el error COMPLETO y forma una hipótesis antes de tocar el código. Corrige la causa, no el síntoma.',
      'Sin dependencias nuevas salvo necesidad real; comprueba antes si la librería ya está en el proyecto.',
    ],
    deliver:
      'Qué archivos tocaste (rutas) y por qué, el comando exacto que ejecutaste y su salida relevante, y el resultado de la verificación. Si algo no se pudo verificar, no lo presentes como hecho.',
  },
  file: {
    key: 'file',
    name: 'File Agent',
    emoji: '📁',
    role: 'organiza y gestiona archivos y carpetas',
    category: 'simple', // mover y listar archivos no necesita el modelo más caro
    allowTools: [
      'read_file',
      'view_image',
      'write_file',
      'edit_file',
      'apply_patch',
      'list_dir',
      'search_files',
      'run_command',
      'use_skill',
    ],
    maxSteps: 20,
    systemExtra:
      'Eres el SUBAGENTE DE ARCHIVOS. Organiza, copia, mueve y documenta. run_command solo para operaciones de ficheros (robocopy, move, del), nunca para instalar ni configurar.',
    method: [
      'Inventaría ANTES de mover nada: lista lo que hay y su tamaño (nada se toca sin saber qué es).',
      'Regla de oro: nada se borra. Lo que sobra se mueve a una carpeta de cuarentena, y lo dices.',
      'Nombres consistentes y sin sorpresas; no renombres por capricho lo que ya usa el usuario.',
      'Comprueba el resultado después de cada operación (existe, cuenta, tamaño) en vez de fiarte del comando.',
    ],
    deliver:
      'El inventario inicial, las operaciones exactas (origen → destino) y la comprobación posterior. Si algo quedó sin mover por riesgo, dilo con el motivo.',
  },
  vision: {
    key: 'vision',
    name: 'Vision Agent',
    emoji: '👁️',
    role: 'analiza capturas de pantalla e imágenes',
    category: 'vision',
    allowTools: ['screenshot', 'view_image', 'browser_control', 'use_skill'],
    maxSteps: 10,
    systemExtra:
      'Eres el SUBAGENTE DE VISIÓN. Captura pantalla/página y describe con precisión lo que ves: textos, botones, estados, errores visibles. Devuelve hechos, no suposiciones.',
    method: [
      'Si la imagen está en el disco, ábrela con view_image (no la adivines por el nombre); si está en pantalla o en una web, usa screenshot.',
      'Lee lo que está en pantalla literalmente: textos exactos de botones, mensajes de error, valores. Nada de parafrasear.',
      'Distingue lo que VES de lo que deduces; si algo no aparece, di que no aparece.',
      'Si la captura no muestra lo preguntado (scroll, otra ventana, otra pestaña), prueba a cambiar de vista antes de dar el negativo.',
    ],
    deliver:
      'La descripción literal de lo observado (textos exactos, estados) y, si aplica, dónde estaba (ventana/pestaña/zona). Sin adornos y sin inventar lo que no se ve.',
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
    systemExtra:
      'Eres el SUBAGENTE DE VERIFICACIÓN. Recibes un objetivo y tu trabajo es INTENTAR REFUTARLO: lee el archivo, abre la página, ejecuta la comprobación. Responde VERIFICADO con evidencia, o FALLO con lo que falta exactamente.',
    method: [
      'Tu hipótesis por defecto es que NO está hecho: busca la prueba que lo demuestre.',
      'Comprueba el MUNDO, no el informe: abre la ruta, lee el archivo, ejecuta el comando, mira la página. Lo que dice otro agente no es evidencia.',
      'Mira los casos límite del objetivo: ¿el archivo existe Y tiene el contenido? ¿el comando termina con éxito? ¿la página realmente lo guardó?',
      'Si no puedes comprobar algo (falta permiso, falta dato), dilo como NO COMPROBABLE en vez de darlo por bueno.',
    ],
    deliver:
      'VERIFICADO con la evidencia exacta (ruta/comando/salida), o FALLO diciendo qué se esperaba y qué encontraste en su lugar. Nunca un "parece bien".',
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
    systemExtra:
      'Eres el SUBAGENTE DE REVISIÓN DE CÓDIGO. Recibes un CAMBIO (un diff) y el objetivo que perseguía. Tu trabajo NO es reescribirlo ni aprobarlo: es encontrar lo que está mal ANTES de que le llegue al usuario. Si algo no tiene pega, dilo; inventar hallazgos para parecer útil es peor que no encontrar nada.',
    method: [
      'Lee el diff ENTERO antes de opinar. Un cambio no se juzga por el trozo que se ve mejor.',
      'Comprueba los contratos: ¿alguien más usaba lo que ha cambiado? ¿la firma nueva rompe a quien la llama? Búscalo con find_symbol o search_files; no lo supongas.',
      'Busca los casos límite que el cambio NO cubre: vacío, nulo, cero, enorme, repetido, primera y última vez, error de red, archivo inexistente, permisos.',
      'Mira lo que se ha quedado atrás: usos del nombre viejo, imports o funciones muertas, documentación y tests que ya no dicen la verdad.',
      'No pidas estilo que el proyecto no pida ni reescribas el diff por gusto: solo lo que rompe, lo que miente o lo que va a doler.',
    ],
    deliver:
      'Hallazgos numerados con severidad (BLOQUEANTE / RIESGO / SUGERENCIA), ruta y línea, por qué importa y el arreglo concreto. Si no hay nada bloqueante, responde OK y sigue: no inventes pegas.',
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

/* ---------- guía de equipo (va al prompt del LÍDER en modo EQUIPO) ---------- */

/** Guía del LÍDER de un equipo (v4.4). Igual que la de delegación, es material de prompt:
    vive aquí, junto al registro, porque habla de los especialistas que hay. */
const TEAM_GUIDE = `EQUIPO (herramientas team_spawn / team_send / team_wait / team_board / team_done)
En este modo ERES EL LÍDER: la orden del usuario sigue siendo TU responsabilidad, pero el trabajo se reparte entre compañeros especialistas que trabajan A LA VEZ.
CÓMO SE TRABAJA EN EQUIPO
1. DESCOMPÓN la orden ANTES de levantar a nadie: 2-4 partes que se puedan hacer EN PARALELO. Si una parte necesita el resultado de otra, no la mandes a la vez: mándala después con team_send o hazla tú con ese resultado.
2. REPARTE CON CRITERIO: una parte por compañero, con la subtarea concreta en «task» y su criterio de éxito en «expect». Un compañero NO ve esta conversación: todo lo que necesite (rutas, URLs, decisiones ya tomadas) va dentro de la subtarea.
3. LEVANTA varios seguidos: team_spawn NO espera, devuelve el id al momento. Después ESPERA con team_wait, que no bloquea a los que sigan trabajando; mientras esperas, haz tú la parte que no se puede repartir.
4. NO REPITAS el trabajo de un compañero ni le pidas lo que ya sabes: reparte lo que de verdad falta y apóyate en lo que devuelva.
5. EL TABLERO es la fuente de verdad del progreso: apunta cada parte con team_board (quién, qué, estado) y mantenlo al día; el usuario lo ve.
6. HABLA CON ELLOS: team_send con el id del compañero para darle un dato, corregir el rumbo o pedirle algo. Sigue con otra cosa si está ocupado: el mensaje le llega a su buzón.
7. AGREGA TÚ: la respuesta final es tuya, con lo que traigan tus compañeros. Si alguno falla o se queda a medias, dilo con lo que sí traiga evidencia; no presentes como hecho lo que nadie ha comprobado.
TOPE: 4 compañeros vivos a la vez (el quinto devuelve error).`;

/** Registro de especialistas que puede levantar el líder ({ key, name, emoji, role }). */
function rosterEquipo() {
  asegurarCarga();
  const out = [];
  for (const k of SUBAGENT_KEYS) {
    const s = SUBAGENTS[k];
    out.push({ key: s.key, name: s.name, emoji: s.emoji, role: s.role });
  }
  for (const [id, s] of DISCO) out.push({ key: id, name: s.name, emoji: s.emoji, role: s.role });
  return out;
}

/** Guía completa del líder: las reglas + a quién puede levantar y con qué nombre/emoji. */
function teamGuide() {
  const lineas = rosterEquipo()
    .map((s) => `- ${s.emoji} ${s.key} — ${s.name}: ${s.role}`)
    .join('\n');
  return `${TEAM_GUIDE}\nESPECIALISTAS QUE PUEDES LEVANTAR (team_spawn con su id; el id de cada compañero levantado —«m1», «m2»…— te lo devuelve team_spawn). Dirígete a ellos por ese id o por su nombre:\n${lineas}`;
}

/** Definición de la herramienta delegate (va al prompt del orquestador).
 *
 *  Es un SINGLETON a propósito: tools.js la registra una vez al cargarse y los agentes
 *  de usuario se leen en tiempo de ejecución, así que la única forma de que el enum los
 *  incluya es actualizar ESTE objeto in situ (ver `refrescarDelegate`). */
let DELEGATE_DEF = null;
function delegateToolDef() {
  if (!DELEGATE_DEF) {
    DELEGATE_DEF = {
      type: 'function',
      function: {
        name: 'delegate',
        description: descripcionDelegate(),
        parameters: {
          type: 'object',
          properties: {
            agent: { type: 'string', enum: [...SUBAGENT_KEYS], description: 'Subagente especializado' },
            task: { type: 'string', description: 'La subtarea concreta y autónoma, con todo el contexto necesario' },
            context: {
              type: 'string',
              description: 'Datos ya conocidos que el subagente necesita (URLs, rutas, hallazgos previos, decisiones tomadas)',
            },
            expect: {
              type: 'string',
              description:
                'Criterio de éxito: cómo se comprueba que la subtarea está bien hecha (qué archivo leer, qué comando ejecutar, qué debe aparecer)',
            },
          },
          required: ['agent', 'task'],
        },
      },
    };
  }
  return DELEGATE_DEF;
}

/** Texto del enum/descripción: los de serie y, si los hay, los agentes del usuario. */
function descripcionDelegate() {
  const base =
    'DELEGA una subtarea autónoma en un subagente especializado (research, browser, coding, file, vision, verification, review). El subagente NO ve la conversación: dale tarea + contexto + criterio de éxito. Devuelve un resultado estructurado con evidencia.';
  const propios = [...DISCO.values()].map((s) => `${s.key} — ${s.role}`);
  if (!propios.length) return base;
  return `${base} Además, el usuario ha definido estos agentes suyos: ${propios.join('; ')}.`;
}

/** Refresca el enum y el texto de delegate con el registro actual (lo llama `recargar`). */
function refrescarDelegate() {
  const d = delegateToolDef();
  d.function.description = descripcionDelegate();
  d.function.parameters.properties.agent.enum = [...SUBAGENT_KEYS, ...DISCO.keys()];
}

/* --------------------------------------------------------------------------- *
 *  v4.1: agentes del USUARIO (carpeta <datos>/agents/<id>/AGENT.md)
 *
 *  El registro de arriba es fijo (código). Aquí se le suman los que el usuario escribe
 *  en disco, con el MISMO front-matter que las skills (una sola convención de archivo
 *  con instrucciones). Lo que NO puede hacer un AGENT.md es darse más de lo que tiene un
 *  integrante: sus herramientas se cruzan con el catálogo real Y con el techo de los
 *  especialistas de serie, así que `delegate`, `notify` o `window_manage` no se pueden
 *  auto-conceder. Un archivo mal formado se reporta y se salta: jamás tumba la app.
 * --------------------------------------------------------------------------- */

const PASOS_DEFECTO = 25;
const PASOS_TECHO = 40; // el mismo orden de magnitud que los integrantes (máx. 30)
const METODO_DEFECTO = [
  'Entiende la subtarea y reúne lo que ya sabes antes de abrir nada.',
  'Trabaja paso a paso con TUS herramientas; cada paso debe acercarte a la evidencia.',
  'Comprueba en el mundo (leer, ejecutar, mirar) lo que afirmes: no te fíes de tu propio resumen.',
  'No hagas trabajo que no se te ha pedido ni toques nada fuera de la subtarea.',
];
const ENTREGA_DEFECTO =
  'Qué has hecho (pasos exactos), con qué evidencia (ruta, comando o salida) y qué ha quedado sin hacer o sin comprobar.';

const TECHO = new Set(Object.values(SUBAGENTS).flatMap((s) => s.allowTools));

let AGENTS_DIR = path.join(require('./datadir').dataDir(), 'agents');
let DISCO = new Map(); // id -> spec (solo los del usuario)
let AVISOS = []; // [{id, motivo}]: archivos que se saltaron y por qué
let FIRMA = null;
let CARGADO = false;

/** Carpeta donde el usuario deja sus agentes (la abre la interfaz). */
function carpetaUsuarios() {
  return AGENTS_DIR;
}

/* El parser de front-matter es el de skills.js: UNA sola convención de archivo con
   instrucciones. Hoy skills.js solo lo expone bajo `__test`, así que se reutiliza tal
   cual en vez de duplicarlo (duplicar una tabla de este repo ya acabó con dos copias
   divergentes). Lo correcto sería exportarlo de forma pública desde skills.js. */
function parseFrontMatter(raw) {
  const p = require('./skills').__test?.parseFrontMatter;
  if (typeof p !== 'function') return null;
  try {
    return p(raw);
  } catch {
    return null;
  }
}

/** Valor de front-matter como lista: acepta lista YAML, texto separado por comas o uno solo. */
function listaDe(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  const s = String(v == null ? '' : v).trim();
  if (!s) return [];
  return s
    .split(/[,\n]/)
    .map((x) => x.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/** Lee un campo del front-matter. El parser de skills normaliza las CLAVES a minúsculas
    (`maxSteps` acaba en `maxsteps`), así que se busca tal cual y en minúsculas. */
function campo(meta, nombre) {
  if (Object.prototype.hasOwnProperty.call(meta, nombre)) return meta[nombre];
  const l = String(nombre).toLowerCase();
  return Object.prototype.hasOwnProperty.call(meta, l) ? meta[l] : undefined;
}

/** Id de carpeta aceptable: sin `..`, sin barras y sin caracteres raros. */
function idValido(id) {
  const s = String(id || '').trim();
  if (!s || s === '.' || s === '..' || s.includes('..')) return i18n.t('agentes.id.invalido');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)) return i18n.t('agentes.id.caracteres');
  return null;
}

/** Firma barata de la carpeta (evita releer y reparsear en cada `listar`). */
function firmaDelAlmacen(dir) {
  let entradas = [];
  try {
    entradas = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }
  const partes = [];
  for (const e of entradas) {
    if (!e.isDirectory()) continue;
    try {
      const st = fs.statSync(path.join(dir, e.name, 'AGENT.md'));
      partes.push(`${e.name}:${st.mtimeMs}:${st.size}`);
    } catch {
      partes.push(`${e.name}:sin`);
    }
  }
  return partes.sort().join('|');
}

/** Convierte un AGENT.md en la spec que ya entienden el prompt y la delegación. */
function specDeDisco(id, raw) {
  const fm = parseFrontMatter(raw);
  if (!fm || !fm.meta) return { ok: false, motivo: i18n.t('agentes.sin.frontmatter') };
  const meta = fm.meta;
  const cuerpo = String(fm.body || '').trim();
  if (!cuerpo) return { ok: false, motivo: i18n.t('agentes.sin.cuerpo') };

  const pedidas = listaDe(campo(meta, 'tools'));
  const { toolDefs: catalogo } = require('./tools');
  const existe = new Set(catalogo.map((d) => d.function.name));
  const tools = pedidas.filter((t) => existe.has(t) && TECHO.has(t));
  const rechazadas = pedidas.filter((t) => !existe.has(t) || !TECHO.has(t));
  if (!tools.length) {
    return {
      ok: false,
      motivo: pedidas.length
        ? `en «tools» no queda ninguna herramienta que un especialista de serie pueda usar (ignoradas: ${rechazadas.join(', ')})`
        : 'falta la clave «tools» con las herramientas del agente',
    };
  }
  const pasos = Math.floor(Number(campo(meta, 'maxSteps')) || 0);
  const metodo = listaDe(campo(meta, 'method'));
  const entrega = listaDe(campo(meta, 'deliver'));
  return {
    ok: true,
    spec: {
      key: id,
      name:
        String(campo(meta, 'name') || id)
          .trim()
          .slice(0, 60) || id,
      emoji: '🧩', // agent.js lo pinta en el estado; sin él saldría «undefined Agente»
      role:
        String(campo(meta, 'description') || '')
          .trim()
          .slice(0, 200) || 'agente definido por ti',
      allowTools: tools,
      maxSteps: Math.min(pasos > 0 ? pasos : PASOS_DEFECTO, PASOS_TECHO),
      maxStepsExplicito: pasos > 0,
      model:
        String(campo(meta, 'model') || '')
          .trim()
          .slice(0, 80) || null,
      systemExtra: cuerpo,
      method: metodo.length >= 2 ? metodo : METODO_DEFECTO,
      deliver: entrega.length ? entrega.join(' ') : ENTREGA_DEFECTO,
      origen: 'disco',
      ignoradas: rechazadas,
    },
  };
}

/** Lee la carpeta entera y deja el registro vivo (SUBAGENTS) en sincronía. */
function cargarDisco() {
  const dir = carpetaUsuarios();
  const firma = firmaDelAlmacen(dir);
  const avisos = [];
  const nuevos = new Map();
  let entradas = [];
  try {
    entradas = fs.readdirSync(dir, { withFileTypes: true });
  } catch {} // sin carpeta no hay agentes de usuario: los de serie siguen funcionando igual
  for (const e of entradas.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const id = e.name;
    const malo = idValido(id);
    if (malo) {
      avisos.push({ id, motivo: malo });
      continue;
    }
    if (SUBAGENT_KEYS.includes(id)) {
      avisos.push({ id, motivo: i18n.t('agentes.id.reservado') });
      continue;
    }
    if (nuevos.has(id)) {
      avisos.push({ id, motivo: i18n.t('agentes.id.repetido') });
      continue;
    }
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, id, 'AGENT.md'), 'utf8');
    } catch {
      avisos.push({ id, motivo: i18n.t('agentes.sin.archivo') });
      continue;
    }
    const s = specDeDisco(id, raw);
    if (!s.ok) {
      avisos.push({ id, motivo: s.motivo });
      continue;
    }
    if (s.spec.ignoradas.length)
      avisos.push({ id, motivo: i18n.t('agentes.herramientas.ignoradas', { lista: s.spec.ignoradas.join(', ') }) });
    nuevos.set(id, s.spec);
  }
  for (const id of DISCO.keys()) delete SUBAGENTS[id]; // los que ya no están salen del registro
  for (const [id, spec] of nuevos) SUBAGENTS[id] = spec;
  DISCO = nuevos;
  AVISOS = avisos;
  FIRMA = firma;
  CARGADO = true;
  refrescarDelegate(); // el enum de `delegate` se entera aquí, tanto al arrancar como al recargar
}

/** Relee la carpeta solo si cambió (huella barata): `listar` es síncrono y lo llama la UI. */
function asegurarCarga() {
  const firma = firmaDelAlmacen(carpetaUsuarios());
  if (CARGADO && firma === FIRMA) return;
  cargarDisco();
}

/** Ficha para la interfaz. `origen` es 'integrante' (de serie) o 'disco' (del usuario). */
function fichaDe(spec, origen) {
  return {
    id: spec.key,
    nombre: spec.name,
    descripcion: spec.role || '',
    tools: [...(spec.allowTools || [])],
    modelo: spec.model || null,
    // null = usa el presupuesto por defecto (solo puede pasar con un agente de disco)
    maxSteps: spec.maxStepsExplicito === false ? null : spec.maxSteps || null,
    origen,
  };
}

/** Registro COMPLETO (de serie + del usuario), en orden estable. Nunca lanza. */
function listar() {
  try {
    asegurarCarga();
  } catch {
    AVISOS = [{ id: '(carpeta de agentes)', motivo: i18n.t('agentes.carpeta.ilegible') }];
  }
  const out = [];
  for (const k of SUBAGENT_KEYS) out.push(fichaDe(SUBAGENTS[k], 'integrante'));
  for (const [, spec] of DISCO) out.push(fichaDe(spec, 'disco'));
  return out;
}

/** Vuelve a leer los AGENT.md del usuario y devuelve el registro actualizado. */
function recargar() {
  cargarDisco(); // ya refresca el enum de `delegate` y las specs
  return listar();
}

/** Archivos de agente que se saltaron y por qué (para poder avisar al usuario). */
function avisos() {
  asegurarCarga();
  return AVISOS.map((a) => ({ ...a }));
}

/** Recorta toolDefs a las herramientas permitidas de un subagente.
    (require diferido de tools.js para evitar la dependencia circular) */
function toolDefsFor(key) {
  asegurarCarga(); // un agente de disco también tiene catálogo
  const spec = SUBAGENTS[key];
  if (!spec) return [];
  const { toolDefs } = require('./tools');
  return toolDefs.filter((d) => spec.allowTools.includes(d.function.name));
}

/** System prompt completo de un subagente.
    opts: { skillsIndex, suggested } — índice de skills de SU especialidad y las
    que encajan con esta subtarea (v2.1: las skills viajan dentro del agente). */
function subagentSystemPrompt(key, workspace, opts = {}) {
  asegurarCarga(); // el prompt de un agente del usuario sale de su AGENT.md
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
  const proyectBlock = workspace
    ? (() => {
        try {
          const b = require('./proyecto').bloquePrompt(workspace);
          return b ? `\n\n${b}` : '';
        } catch {
          return '';
        }
      })()
    : '';
  /* v2.5: las reglas de la casa también para el subagente. Un especialista que no las lee
     es la vía por la que un «no toques esta carpeta» se incumple desde abajo. */
  const instrBlock = workspace
    ? (() => {
        try {
          const b = require('./instrucciones').bloquePrompt(workspace);
          return b ? `\n\n${b}` : '';
        } catch {
          return '';
        }
      })()
    : '';
  return `Eres SAGITARI — ${spec.name} (${spec.role}).\n\n${spec.systemExtra}\n\nMÉTODO DE TRABAJO (síguelo; es lo que te hace bueno en esto)\n${method}${skillsBlock}${wsLine}${instrBlock}${proyectBlock}\n\nTus herramientas (SOLO estas): ${tools}.\n\nREGLAS COMUNES\n1. Ejecuta tu subtarea paso a paso; cada paso debe acercarte a la evidencia de que está hecha.\n2. Algunas herramientas piden confirmación al usuario: si una acción queda denegada, NO la repitas — continúa por otra vía o refléjalo en el resultado.\n3. No verifiques con tus propias palabras: verifica con el mundo (leer, ejecutar, abrir). No des por hecho el éxito porque una herramienta devolvió OK.\n4. No hagas trabajo que no se te ha pedido (nada de refactors, reorganizaciones ni mejoras "de paso").\n5. NADA de emojis ni símbolos decorativos (tampoco en RESULT/DETAILS/EVIDENCE): tono profesional y sobrio.\n\nENTREGA\n${spec.deliver}\n\nTu ÚLTIMO mensaje debe ser EXCLUSIVAMENTE el resultado final en este formato:\nRESULT: <resumen en 1-3 líneas de lo conseguido>\nDETAILS: <datos relevantes: rutas, URLs, valores, comandos, decisiones>\nEVIDENCE: <la prueba concreta que lo demuestra: salida de comando, archivo leído, URL abierta>\nSTATUS: OK | PARTIAL | FAILED\n— STATUS FAILED si no pudiste completar; PARTIAL si completaste solo parte. En PARTIAL/FAILED, DETAILS debe decir qué falta exactamente.`;
}

/**
 * Brief (mensaje de usuario) de una subtarea. El subagente no ve la conversación:
 * todo lo que necesita viaja aquí.
 * opts: { task, context, expect, board, budget: { steps, note }, equipo }
 *   `equipo` (v4.4) solo va con un COMPAÑERO de MODO EQUIPO: { id, lider, companeros }.
 *   Es lo que le dice quién es, quién es el líder y cómo dirigirse a los demás; sin él
 *   (delegación de siempre) el brief es exactamente el de antes.
 */
function buildSubagentBrief(opts = {}) {
  const parts = [];
  const context = String(opts.context || '').trim();
  const board = String(opts.board || '').trim();
  const eq = opts.equipo && opts.equipo.id ? opts.equipo : null;
  if (eq) {
    const jefe = String(eq.lider || 'lider');
    const otros = (eq.companeros || []).filter((c) => c && c.id && c.id !== eq.id);
    parts.push(
      `ERES EL COMPAÑERO «${eq.id}» DE UN EQUIPO (el LÍDER es «${jefe}»).` +
        (otros.length ? ` Tus compañeros: ${otros.map((c) => `${c.id} (${c.name || c.spec || c.id})`).join(', ')}.` : '') +
        ` Trabajas a la vez que ellos: no repitas su trabajo. Habla solo por las herramientas del equipo: team_send (to: «${jefe}» o el id de un compañero) para mandar un dato o pedir lo que te falte, team_board para apuntar tu progreso y team_done para cerrar tu encargo con evidencia.`,
    );
  }
  if (context) parts.push(`CONTEXTO DEL ORQUESTADOR (ya conocido — no lo vuelvas a averiguar):\n${context}`);
  if (board) parts.push(`LO QUE YA HIZO EL EQUIPO EN ESTA TAREA (no lo repitas; apóyate en ello):\n${board}`);
  parts.push(`SUBTAREA:\n${String(opts.task || '').slice(0, 4000)}`);
  const expect = String(opts.expect || '').trim();
  if (expect) parts.push(`CRITERIO DE ÉXITO (cómo se comprueba que está bien hecha):\n${expect}`);
  const steps = opts.budget && Number(opts.budget.steps);
  if (steps > 0)
    parts.push(
      `PRESUPUESTO: ${steps} pasos de herramienta${opts.budget.note ? ` (${opts.budget.note})` : ''}. Prioriza lo que produce evidencia; si no te llega, entrega un PARTIAL honesto con lo que falta.`,
    );
  return parts.join('\n\n');
}

/** Tablero de delegaciones del run: lo que ya hizo el equipo, en formato compacto. */
function formatDelegationBoard(entries, opts = {}) {
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 6;
  const rows = (entries || []).slice(-limit).filter((e) => e && e.agent);
  return rows
    .map((e) => {
      const task = String(e.task || '')
        .replace(/\s+/g, ' ')
        .slice(0, 100);
      const res = String(e.result || e.note || '')
        .replace(/\s+/g, ' ')
        .slice(0, 160);
      return `- [${e.agent} · ${e.status || 'OK'}] ${task}${res ? ` → ${res}` : ''}`;
    })
    .join('\n');
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
 *
 * `corte` (opcional) dice que la vuelta del subagente NO llegó a su informe final:
 * `{ cortado: true, motivo: 'limite' | 'detenido' }`. En ese caso no puede salir OK
 * —ver abajo—, porque el último texto es un preámbulo, no un cierre.
 */
function parseSubagentResult(text, corte = null) {
  const t = String(text || '');
  const rx = /^[ \t]*(RESULT|RESULTADO|DETAILS|DETALLES|EVIDENCE|EVIDENCIA|STATUS|ESTADO)[ \t]*:[ \t]*(.*)$/i;
  const blocks = {}; // campo -> [ {buf: []} ] en orden de aparición
  let cur = null;
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(rx);
    if (m) {
      const tag = m[1].toLowerCase();
      const field = Object.keys(RESULT_TAGS).find((k) => RESULT_TAGS[k].includes(tag));
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
  const firstLine =
    t
      .split('\n')
      .map((s) => s.trim())
      .find(Boolean) || '';
  let result = last('result') || firstLine.slice(0, 200);
  const details = last('details');
  const evidence = last('evidence');
  const statusWord = (last('status').match(/[A-Za-zÁÉÍÓÚÑ]+/) || [''])[0].toUpperCase();
  const explicito = ['OK', 'PARTIAL', 'FAILED'].includes(statusWord);
  let status = explicito
    ? statusWord
    : /error|no pude|no se pudo|falló|fallo|imposible|denegad/i.test(t)
      ? 'FAILED'
      : 'OK';
  /* v5.0.1: el estado por DEFECTO (no había bloque STATUS) no puede ser OK si el
     subagente no cerró: se agotó su presupuesto de pasos, lo detuvo el usuario o
     terminó sin decir nada. Su último texto es un preámbulo, y ese OK fantasma
     desactivaba la puerta de cierre del turno —peor aún viniendo del verificador—.
     Un STATUS explícito sí manda: si el informe llegó, se cree lo que dice. */
  if (!explicito && status === 'OK' && (corte || !t.trim())) status = 'PARTIAL';
  // sin texto que enseñar, se dice POR QUÉ no hay informe (el motivo lo sabe el bucle)
  if (!result && status === 'PARTIAL' && corte)
    result =
      corte.motivo === 'detenido'
        ? 'detenido por el usuario antes de dar su informe'
        : 'se agotó su presupuesto de pasos sin dar su informe final';
  return { status, result, details, evidence };
}

/* ---------- aislamiento por árbol git ---------- */

/**
 * ¿Esta vuelta puede ESCRIBIR en el proyecto del usuario?
 *
 * Un especialista de serie con `write_file`/`edit_file`/`apply_patch` sí. Y un agente
 * del USUARIO con `run_command`: una orden puede escribir (una redirección, un script,
 * `git checkout`) sin declarar ninguna herramienta de escritura, así que se le aísla
 * igual que a los que sí las declaran.
 *
 * Un integrado de serie con `run_command` (verificador, revisor) lo usa para LEER y
 * comprobar el proyecto REAL: aislarlo le cambiaría la ruta de su evidencia y le
 * añadiría una fusión que no tiene que hacer. Por eso NO cuenta aquí.
 */
function escribeProyecto(spec) {
  const t = (spec && spec.allowTools) || [];
  if (['write_file', 'edit_file', 'apply_patch'].some((x) => t.includes(x))) return true;
  return !!(spec && spec.origen === 'disco' && t.includes('run_command'));
}

module.exports = {
  SUBAGENTS,
  SUBAGENT_KEYS,
  DELEGATION_GUIDE,
  TEAM_GUIDE,
  teamGuide,
  rosterEquipo,
  delegateToolDef,
  toolDefsFor,
  subagentSystemPrompt,
  buildSubagentBrief,
  formatDelegationBoard,
  parseSubagentResult,
  escribeProyecto,
  // v4.1: agentes del usuario (carpeta <datos>/agents/<id>/AGENT.md)
  listar,
  recargar,
  carpetaUsuarios,
  avisos,
  /* Para las pruebas: apuntar la carpeta a un directorio temporal, como skills.js. */
  __test: {
    _resetForTests: (dir) => {
      if (dir !== undefined) AGENTS_DIR = dir;
      for (const id of DISCO.keys()) delete SUBAGENTS[id];
      DISCO = new Map();
      AVISOS = [];
      FIRMA = null;
      CARGADO = false;
    },
    cargarDisco,
    asegurarCarga,
    firmaDelAlmacen,
    specDeDisco,
    parseFrontMatter,
    listaDe,
    idValido,
    estado: () => ({ ids: [...DISCO.keys()], avisos: AVISOS.map((a) => ({ ...a })), cargado: CARGADO }),
  },
};
