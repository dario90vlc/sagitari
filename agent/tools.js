'use strict';

/* Every tool declares its risk level (shown in the agent prompt, used by the
   permission engine in guardrails.js; user overrides in Settings win):
     safe       → runs automatically
     confirm    → asks the user before running
     restricted → blocked unless explicitly allowed

   ESTA tabla es la ÚNICA fuente de niveles por defecto: guardrails.js la
   importa (y la reexporta como DEFAULT_RISK para el resto de la app). Antes
   existían dos tablas copiadas que ya habían divergido (edit_file faltaba en
   una, y la otra declaraba una herramienta inexistente). */
const { delegateToolDef } = require('./subagents');
const RISK = {
  run_command: 'confirm',
  write_file: 'confirm',
  edit_file: 'confirm',
  open_app: 'confirm',
  // open_url pide confirmación: en Windows shell.openExternal invoca el handler
  // del sistema, no sólo http(s) — file://, ms-msdt:, search-ms: y cualquier
  // protocolo registrado se abrirían sin que el usuario lo vea
  open_url: 'confirm',
  read_file: 'safe',
  view_image: 'safe', // leer una imagen que el usuario señala: mismo nivel que leer un archivo
  repo_map: 'safe', // leer el índice del proyecto: no toca nada
  search_code: 'safe', // buscar en el proyecto: solo lee
  find_symbol: 'safe',
  apply_patch: 'confirm', // escribe: varios archivos, pero escribe
  list_dir: 'safe',
  search_files: 'safe',
  browser_control: 'confirm',
  screenshot: 'safe',
  clipboard: 'safe',
  notify: 'safe',
  media_control: 'safe',
  window_manage: 'confirm',
  system_info: 'safe',
  remember: 'safe', // guardar un recuerdo no toca el sistema: no pide permiso
  use_skill: 'safe',
  todo_write: 'safe', // la lista de tareas es estado del propio agente: no toca nada del sistema
  delegate: 'safe', // v1.4: la delegación no pide permiso; las herramientas del SUBAGENTE sí (con los mismos niveles)
  /* v4.4 — MODO EQUIPO. Ninguna de las cinco toca el sistema: levantan compañeros, hablan
     con ellos o apuntan en el tablero. Las herramientas que EJECUTA un compañero sí piden
     su permiso, con los mismos niveles y atribuidas a su miembro. */
  team_spawn: 'safe',
  team_send: 'safe',
  team_wait: 'safe',
  team_board: 'safe',
  team_done: 'safe',
  // Solo lee una página pública por GET (con filtro SSRF y topes): es lectura, como read_file
  web_fetch: 'safe',
  // Git de lectura: mirar no cambia nada
  git_status: 'safe',
  git_diff: 'safe',
  git_log: 'safe',
  /* git_branch LISTA (lectura) pero también CREA y CAMBIA de rama (escribe): su nivel
     declarado es el de la peor acción. guardrails.decide abarata `action: 'list'` —y solo
     eso— cuando el usuario no ha fijado un nivel propio para la herramienta. */
  git_branch: 'confirm',
  git_commit: 'confirm',
};

const defs = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Ejecuta un comando en la terminal de Windows (cmd.exe) y devuelve stdout/stderr. Úsalo para tareas de sistema, scripts, git, instalar cosas, etc. Para abrir aplicaciones o URLs usa open_app / open_url.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Comando a ejecutar' },
          cwd: { type: 'string', description: 'Directorio de trabajo (opcional)' },
          timeout_seconds: { type: 'number', description: 'Timeout en segundos (default 60, máx 300)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Lee el contenido de un archivo de texto. Con offset/limit lee solo un rango de líneas (útil para archivos largos, devuelve cabecera "[líneas A-B de N]").',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta absoluta del archivo' },
          offset: { type: 'number', description: 'Línea inicial, 1-based (opcional)' },
          limit: { type: 'number', description: 'Máximo de líneas a devolver (opcional, tope 2000)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'view_image',
      description:
        'Abre una imagen del disco (PNG, JPEG, GIF o WEBP) y la mira de verdad: sirve para leer una captura, un diagrama o una foto que el usuario tenga en una carpeta. La imagen llega al modelo, así que describe lo que VEAS en ella, no lo que supongas por el nombre del archivo.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta del archivo de imagen (absoluta o relativa al espacio de trabajo)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'repo_map',
      description:
        'Muestra el índice del proyecto: qué archivos hay por carpeta y qué símbolos define cada uno (funciones, clases, tipos, secciones). Úsalo ANTES de leer archivos sueltos cuando no conozcas el proyecto: es barato y evita leer diez archivos para encontrar uno.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Carpeta a mapear (por defecto, el espacio de trabajo)' },
          max_chars: { type: 'number', description: 'Tope de tamaño del mapa (por defecto 7000)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description:
        'Busca en el proyecto por CONTENIDO, no por nombre: devuelve las coincidencias exactas y, además, los sitios más relacionados con lo que pides (aunque no aparezcan esas palabras). Úsalo cuando no sepas cómo se llama algo («dónde se decide si una actualización se puede aplicar») o para saber dónde se usa un símbolo. Es la forma barata de orientarte antes de leer archivos.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Qué buscas (palabras sueltas: se buscan por separado y se puntúa la relevancia)' },
          limit: { type: 'number', description: 'Máximo de resultados (por defecto 12)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_symbol',
      description:
        'Busca dónde se define un símbolo (función, clase, tipo) o qué archivos coinciden con un nombre. Devuelve ruta y línea. Es la forma rápida de ir a un sitio concreto sin leer directorios enteros.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre a buscar (admite varias palabras; también encuentra archivos)' },
          limit: { type: 'number', description: 'Máximo de resultados (por defecto 30)' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description:
        'Aplica VARIOS cambios de texto en uno o varios archivos en una sola llamada, y de forma atómica: si algún anclaje (old_string) no existe o es ambiguo, no se escribe nada. Úsalo para cambios que abarcan varios archivos (renombrar una función y sus llamadas, añadir un campo y sus usos) en vez de encadenar edit_file. Si un anclaje falla solo por la SANGRAFÍA, el error te devuelve el texto exacto que hay en el archivo: repite la llamada con tolerar_espacios: true y se aplicará reajustando la sangría.',
      parameters: {
        type: 'object',
        properties: {
          changes: {
            type: 'array',
            description: 'Lista de cambios. Cada uno: {path, old_string, new_string, replace_all?, tolerar_espacios?}',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                old_string: { type: 'string', description: 'Texto exacto que hay en el archivo (con su sangría)' },
                new_string: { type: 'string' },
                replace_all: { type: 'boolean', description: 'Reemplazar todas las apariciones (por defecto: solo si es única)' },
                tolerar_espacios: {
                  type: 'boolean',
                  description:
                    'Acepta el anclaje aunque la sangría o el final de línea no coincidan exactamente (se reajusta la sangría al archivo). Úsalo tras un error que te haya enseñado el texto exacto.',
                },
              },
              required: ['path', 'old_string', 'new_string'],
            },
          },
          tolerar_espacios: { type: 'boolean', description: 'Aplica lo mismo a TODOS los cambios del parche' },
        },
        required: ['changes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Crea o sobrescribe un archivo con el contenido dado. Crea directorios padre si no existen.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Edita un archivo existente con un reemplazo anclado por texto exacto: cambia old_string por new_string y escribe el resultado. old_string debe ser único en el archivo; si aparece varias veces y quieres cambiarlas todas, usa replace_all: true. El archivo debe existir (no lo crea): para crear un archivo nuevo o reescribirlo entero usa write_file. Si el anclaje falla solo por la SANGRAFÍA, el error te devuelve el texto exacto que hay en el archivo: repite la llamada con tolerar_espacios: true y se aplicará reajustando la sangría.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta del archivo a editar' },
          old_string: { type: 'string', description: 'Texto exacto a reemplazar (debe ser único salvo replace_all: true)' },
          new_string: { type: 'string', description: 'Texto de reemplazo' },
          replace_all: { type: 'boolean', description: 'Reemplaza todas las ocurrencias (default false)' },
          tolerar_espacios: {
            type: 'boolean',
            description:
              'Acepta el anclaje aunque la sangría o el final de línea no coincidan exactamente: se aplica reajustando la sangría al archivo. Úsalo cuando un error te haya enseñado el texto exacto del bloque.',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'Lista el contenido de un directorio de forma recursiva (profundidad limitada).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          depth: { type: 'number', description: 'Profundidad (default 2, máx 4)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Busca un texto o regex dentro de archivos (contenido) y por nombre de archivo, de forma recursiva.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directorio raíz de la búsqueda' },
          pattern: { type: 'string', description: 'Texto o regex a buscar' },
          search_content: { type: 'boolean', description: 'Buscar también dentro de los archivos (default true)' },
        },
        required: ['path', 'pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_app',
      description: 'Abre una aplicación instalada (ej: "chrome", "notepad", "spotify", "explorer") o un documento.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Abre una URL en el navegador por defecto.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_control',
      description:
        'Controla un navegador Chrome/Edge real (DevTools Protocol). UNA sola ventana con varias pestañas. FLUJO: launch → navigate → elements (inventario con nombres accesibles e índices) → click_index/type/select/check → wait_for → content o screenshot.\n' +
        'Acciones: launch, profile (perfil de cookies), navigate, new_tab, select_tab, close_tab, tabs, elements, click_index, click (por texto o selector), type, hover, select, check, press, hotkey (Ctrl+Shift+T…), upload, scroll, wait, wait_for (espera a que aparezca/desaparezca algo), content, eval, screenshot, logs (consola y errores de red), back, forward, reload, dialog (contesta a alert/confirm/prompt), close.\n' +
        'Consejos: tras una acción que cambia la página (clic, submit, navegar) vuelve a hacer elements; el clic por índice reencuentra el MISMO elemento por su huella, así que sobrevive a un scroll o a que el DOM se mueva; si algo tapa el elemento, el error dice QUÉ lo tapa; para depurar una web que falla, mira action=logs.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'launch',
              'profile',
              'navigate',
              'new_tab',
              'select_tab',
              'close_tab',
              'tabs',
              'elements',
              'click_index',
              'click',
              'type',
              'hover',
              'select',
              'check',
              'press',
              'hotkey',
              'upload',
              'scroll',
              'wait',
              'wait_for',
              'content',
              'eval',
              'screenshot',
              'logs',
              'back',
              'forward',
              'reload',
              'dialog',
              'close',
            ],
          },
          profile: {
            type: 'string',
            description:
              'profile: nombre del perfil (default, personal, work, research, shopping, development). Cada perfil tiene sus propias cookies y sesiones',
          },
          index: {
            type: 'number',
            description:
              'Número de elemento del inventario de action=elements (para click_index, click, type, hover, select, check, upload y screenshot)',
          },
          url: { type: 'string', description: 'URL para launch/navigate/new_tab. Dominio simple vale (ej: "wikipedia.org")' },
          selector: { type: 'string', description: 'Selector CSS (alternativa al índice y al texto)' },
          text: {
            type: 'string',
            description:
              'click/hover/select/check: texto visible (nombre accesible) del elemento. type: texto a escribir. wait_for: texto que debe aparecer en la página. dialog: texto de un prompt',
          },
          nth: { type: 'number', description: 'Cuando hay varias coincidencias de text/selector, cuál pulsar (1 = la primera)' },
          force: { type: 'boolean', description: 'Pulsar aunque algo tape el elemento (el error normal dice qué lo tapa)' },
          tab: { type: ['string', 'number'], description: 'select_tab/close_tab: número (de action=tabs) o texto del título/URL' },
          clear: {
            type: 'boolean',
            description: 'type: vaciar el campo antes de escribir (default true). logs: vaciar el registro después de leerlo',
          },
          submit: { type: 'boolean', description: 'type: pulsar Enter después de escribir (búsquedas)' },
          human: {
            type: 'boolean',
            description: 'type: teclear tecla a tecla (default true en textos cortos; más compatible con webs que validan al escribir)',
          },
          key: {
            type: 'string',
            description:
              'press: Enter, Tab, Escape, ArrowDown/Up/Left/Right, Backspace, Delete, PageDown/Up, Home, End, Space. hotkey: atajo completo, ej. "Ctrl+Shift+T", "Alt+ArrowLeft", "Ctrl+A"',
          },
          value: { type: 'string', description: 'select: opción a elegir (su valor, su texto o su posición)' },
          on: { type: 'boolean', description: 'check: marcar (true, default) o desmarcar (false)' },
          files: { type: 'array', items: { type: 'string' }, description: 'upload: rutas absolutas de los archivos a subir' },
          accept: { type: 'boolean', description: 'dialog: aceptar (default) o cancelar el diálogo de la página' },
          direction: { type: 'string', description: 'scroll: up|down' },
          amount: { type: 'number', description: 'Píxeles de scroll' },
          ms: { type: 'number', description: 'wait: milisegundos (max 10000)' },
          timeoutMs: { type: 'number', description: 'wait_for: cuánto esperar (default 8000, máximo 60000)' },
          gone: { type: 'boolean', description: 'wait_for: esperar a que DESAPAREZCA el texto o el selector' },
          title: { type: 'string', description: 'wait_for: esperar a que el título de la página contenga esto' },
          limit: { type: 'number', description: 'logs: cuántos mensajes devolver (default 40)' },
          expression: { type: 'string', description: 'eval: JS a ejecutar en la página' },
          query: { type: 'string', description: 'content: selector opcional para leer solo una parte' },
          html: { type: 'boolean', description: 'content: devolver el HTML en vez del texto' },
          fullPage: { type: 'boolean', description: 'screenshot: capturar toda la página (scroll incluido)' },
          screenshot: {
            type: 'boolean',
            description:
              'elements: adjuntar también una captura de la página (por defecto no, para no gastar tokens); para ver la página usa action=screenshot',
          },
          browser: { type: 'string', description: 'launch: chrome|edge' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: 'Captura la pantalla completa y te la muestra como imagen para que la analices.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clipboard',
      description: 'Lee o escribe el portapapeles.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'write'] },
          text: { type: 'string' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notify',
      description: 'Muestra una notificación nativa de Windows al usuario.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' }, message: { type: 'string' } },
        required: ['title', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'media_control',
      description: 'Controla multimedia del sistema: play/pause, next, previous, volume_up, volume_down, mute.',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['play_pause', 'next', 'previous', 'volume_up', 'volume_down', 'mute'] } },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'window_manage',
      description: 'Gestiona ventanas: minimize_all (minimiza todas) o show_desktop (Win+D, mostrar el escritorio).',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['minimize_all', 'show_desktop'] } },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'system_info',
      description: 'Devuelve información del sistema: CPU, RAM, SO, uptime, IPs.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        'Guarda un hecho duradero sobre el usuario para futuras conversaciones: su nombre, cómo quiere que le hables, preferencias y hábitos estables, en qué proyecto o carpeta trabaja, decisiones que pidió recordar. Úsala sobre todo cuando te CORRIJA un dato suyo («en realidad me llamo…», «no, mejor dicho…», «no trabajo en esa carpeta»): guarda siempre el dato NUEVO, aunque exista uno viejo. Si ya sabía algo de ESE MISMO dato (su nombre, su idioma, dónde vive, su proyecto), la memoria se queda con el nuevo y manda el anterior a la papelera, de donde se puede recuperar; si es un dato distinto (otra preferencia, otra carpeta), se guardan los dos. No la uses para lo pasajero (qué archivo tocamos hoy, el resultado de este turno) ni para repetir un hecho que ya está en tu memoria y no ha cambiado.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'El hecho, en una frase clara y autónoma (por ejemplo: «El usuario prefiere respuestas cortas»)',
          },
          importance: { type: 'number', description: '0-1: 1 = crítico (siempre relevante), 0.5 = normal, 0.2 = detalle menor' },
          confidence: { type: 'number', description: '0-1: cómo de seguro estás del recuerdo (0.8 por defecto)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description:
        'Crea o actualiza tu LISTA DE TAREAS del turno: un plan de trabajo vivo que el usuario ve en pantalla y que sobrevive a los turnos largos y a los recortes de contexto (viaja en tu prompt en cada paso). Úsala en tareas de 3 o más pasos: mándala al empezar con todos los pasos en "pending", y vuelve a llamarla cuando empieces un paso ("in_progress") y cuando lo termines ("completed"). Envía SIEMPRE la lista COMPLETA y actualizada, no solo el paso que cambia: así el estado nunca se corrompe. Solo puede haber un paso "in_progress" a la vez. Para una tarea de uno o dos pasos no la uses.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'La lista COMPLETA de tareas, en orden. Enviar [] borra la lista.',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'Qué hay que hacer, en imperativo y breve (ej: "Añadir el campo url al modelo").' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Estado del paso.' },
                activeForm: {
                  type: 'string',
                  description: 'El mismo paso en presente mientras se hace (ej: "Añadiendo el campo url"). Opcional.',
                },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'use_skill',
      description:
        'Carga las instrucciones especializadas de una skill instalada (código, investigación, diseño, ahorro de tokens…). Úsala ANTES de empezar una tarea en la que alguna skill del índice aplique: seguirás sus instrucciones expertas para esa tarea. Devuelve el cuerpo completo de la skill.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nombre de la skill tal como aparece en el índice de skills' } },
        required: ['name'],
      },
    },
  },
];

// v1.4: la herramienta delegate se añade al final (definida en subagents.js)
defs.push(delegateToolDef());
/* v4.1: las definiciones viven en su módulo (como delegate) y aquí solo se registran,
   para que esta tabla siga siendo el ÚNICO sitio donde se declaran niveles y catálogo. */
defs.push(require('./web').webFetchDef());
defs.push(...require('./git').gitToolDefs());

/* --------------------------------------------------------------------------- *
 *  v4.4 — MODO EQUIPO: las cinco herramientas del equipo
 *
 *  El LÍDER (modo EQUIPO) ve las cinco. Un COMPAÑERO ve tres: puede hablar
 *  (team_send), apuntar en el tablero (team_board) y cerrar su encargo
 *  (team_done), pero NO levanta gente ni espera a nadie — el tope de 4 y la
 *  espera se quedan en el líder (`HERRAMIENTAS_EQUIPO_MIEMBRO`).
 *
 *  El motor (agent/equipo.js) es quien las ejecuta; aquí solo viven su texto y
 *  su nivel de riesgo, en la MISMA tabla que el resto del catálogo.
 * --------------------------------------------------------------------------- */

const HERRAMIENTAS_EQUIPO = new Set(['team_spawn', 'team_send', 'team_wait', 'team_board', 'team_done']);
const HERRAMIENTAS_EQUIPO_MIEMBRO = ['team_send', 'team_board', 'team_done'];

const defsEquipo = [
  {
    type: 'function',
    function: {
      name: 'team_spawn',
      description:
        'Levanta un COMPAÑERO de equipo con una subtarea autónoma y sigue TÚ sin esperarlo: devuelve su id (m1, m2…) para poder mandarle mensajes con team_send o esperarlo con team_wait. Úsalo para repartir la orden en partes que se puedan hacer a la vez, cada una con su criterio de éxito. Máximo 4 compañeros vivos: el quinto devuelve error.',
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description:
              'Especialista a levantar: los del registro (research, browser, coding, file, vision, verification, review) o un agente definido por el usuario',
          },
          task: { type: 'string', description: 'La subtarea concreta y autónoma de ese compañero, con el contexto que necesita' },
          expect: {
            type: 'string',
            description:
              'Criterio de éxito: cómo se comprueba que esa subtarea está bien hecha (qué archivo leer, qué comando ejecutar, qué debe aparecer)',
          },
        },
        required: ['agent', 'task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'team_send',
      description:
        'Entrega un mensaje al buzón de otro miembro del equipo. A un compañero en marcha se le inyecta en su siguiente paso; a uno que ya terminó se le despierta con el mensaje como nueva subtarea. Úsalo para dar un dato que le falta, corregir el rumbo o pedir lo que necesitas.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Destinatario: el id de un compañero (m1, m2…), «lider» o «todos»' },
          text: { type: 'string', description: 'El mensaje, concreto y autónomo (quien lo recibe no ve tu conversación)' },
        },
        required: ['to', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'team_wait',
      description:
        'Espera a que los compañeros terminen o pidan algo (un permiso, una pregunta) y devuelve su estado, su resultado y los mensajes que te hayan mandado. NO bloquea a los que no esperas: siguen trabajando. Úsalo tras repartir el trabajo, antes de agregar el resultado final.',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: 'Ids a esperar (por defecto, todos los compañeros del equipo)' },
          timeoutMs: { type: 'number', description: 'Tiempo máximo de espera en ms (por defecto 30000, tope 300000)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'team_board',
      description:
        'El tablero compartido del equipo, que es la fuente de verdad del progreso. SIN argumentos lo lee; con «que» apunta un ítem nuevo (o actualiza el tuyo con ese mismo texto) y con «estado»/«nota» lo va actualizando mientras trabajas.',
      parameters: {
        type: 'object',
        properties: {
          quien: { type: 'string', description: 'De quién es el ítem: un id de compañero o «lider» (por defecto, quien llama)' },
          que: { type: 'string', description: 'El ítem: qué se está haciendo o qué falta (identifica el ítem para poder actualizarlo)' },
          estado: { type: 'string', description: 'Estado del ítem: pendiente, en_curso, hecho, fallo…' },
          nota: { type: 'string', description: 'Detalle o resultado: qué ha salido, con qué evidencia, qué falta' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'team_done',
      description:
        'Cierra tu encargo con lo que has hecho y la evidencia que lo prueba. Llámalo cuando termines (o cuando no puedas seguir): el líder deja de esperarte y agrega con tu resultado.',
      parameters: {
        type: 'object',
        properties: {
          resumen: { type: 'string', description: 'Qué has hecho y en qué ha quedado, en pocas líneas' },
          evidencia: { type: 'string', description: 'La prueba concreta: ruta, comando ejecutado y su salida, URL, mensaje exacto' },
        },
        required: ['resumen'],
      },
    },
  },
];
defs.push(...defsEquipo);

/** ¿Es una herramienta del equipo? (el ejecutor y el modo EQUIPO lo consultan). */
function esHerramientaDeEquipo(nombre) {
  return HERRAMIENTAS_EQUIPO.has(String(nombre || ''));
}

/** Las definiciones que ve un COMPAÑERO: hablar, apuntar y cerrar — nunca levantar gente
    ni esperar (el tope y la espera son del líder). */
function defsEquipoParaMiembro() {
  return defsEquipo.filter((d) => HERRAMIENTAS_EQUIPO_MIEMBRO.includes(d.function.name));
}

/** El catálogo SIN las herramientas de equipo: es el que viaja al modelo en los modos que
    no son EQUIPO, para no ofrecerle al chat herramientas que no tienen equipo detrás.
    Incluye las dinámicas (MCP): filtra el catálogo real, no la tabla. */
function defsSinEquipo() {
  return allToolDefs().filter((d) => !esHerramientaDeEquipo(d.function && d.function.name));
}

/* Qué herramientas pueden usarse en modo PLAN: SOLO leer e inspeccionar. Nada que
   escriba, ejecute comandos, maneje el navegador, el portapapeles o la ventana. Es el
   predicado que consulta agent.js antes de cada llamada.

   La lista es EXPLÍCITA a propósito, no un patrón por prefijo: un futuro `git_reset`
   (que reescribe la historia) no puede colarse en modo PLAN por empezar por `git_`, y
   `git_branch` tampoco entra aunque su `list` sea lectura, porque la misma herramienta
   crea y cambia de rama según `action`. */
const SOLO_LECTURA = new Set([
  'read_file',
  'list_dir',
  'search_files',
  'search_code',
  'repo_map',
  'find_symbol',
  'view_image',
  'screenshot',
  'system_info',
  'web_fetch',
  'git_status',
  'git_diff',
  'git_log',
  'remember',
  'todo_write',
  'use_skill',
]);
function esSoloLectura(nombre) {
  return SOLO_LECTURA.has(String(nombre || ''));
}

/* Herramientas que no vienen de la tabla: hoy, los servidores MCP del usuario.
   El proveedor lo instala main.js; si no hay ninguno, el catálogo es el nativo. */
let dynamicProvider = null;
function setDynamicToolProvider(fn) {
  dynamicProvider = typeof fn === 'function' ? fn : null;
}
function allToolDefs() {
  return dynamicProvider ? defs.concat(dynamicProvider()) : defs;
}

module.exports = {
  toolDefs: defs,
  allToolDefs,
  setDynamicToolProvider,
  RISK,
  esSoloLectura,
  // v4.4 — MODO EQUIPO
  esHerramientaDeEquipo,
  defsEquipoParaMiembro,
  defsSinEquipo,
  HERRAMIENTAS_EQUIPO,
  HERRAMIENTAS_EQUIPO_MIEMBRO,
};

/* Los agentes del usuario (carpeta de datos) entran en el registro al arrancar: es lo que
   hace que se puedan delegar en ellos y que el enum de `delegate` los incluya sin tener
   que abrir antes la vista de Agentes. Va AL FINAL, cuando este módulo ya exportó el
   catálogo: subagents.js lo necesita para cruzar las herramientas de cada AGENT.md con las
   reales. Si algo falla, los de serie siguen funcionando igual. */
try {
  require('./subagents').recargar();
} catch {}
