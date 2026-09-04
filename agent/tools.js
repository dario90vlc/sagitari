'use strict';

const defs = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Ejecuta un comando en la terminal de Windows (cmd.exe) y devuelve stdout/stderr. Úsalo para tareas de sistema, scripts, git, instalar cosas, etc. Para abrir aplicaciones o URLs usa open_app / open_url.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Comando a ejecutar' },
          cwd: { type: 'string', description: 'Directorio de trabajo (opcional)' },
          timeout_seconds: { type: 'number', description: 'Timeout en segundos (default 60, máx 300)' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Lee el contenido de un archivo de texto.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Ruta absoluta del archivo' } },
        required: ['path']
      }
    }
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
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    }
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
          depth: { type: 'number', description: 'Profundidad (default 2, máx 4)' }
        },
        required: ['path']
      }
    }
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
          search_content: { type: 'boolean', description: 'Buscar también dentro de los archivos (default true)' }
        },
        required: ['path', 'pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_app',
      description: 'Abre una aplicación instalada (ej: "chrome", "notepad", "spotify", "explorer") o un documento.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Abre una URL en el navegador por defecto.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_control',
      description: 'Controla un navegador Chrome/Edge real mediante DevTools Protocol: navegar, leer, hacer clic, escribir, capturar. Acciones: launch, navigate, click, type, press, scroll, content, eval, screenshot, tabs, close.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['launch', 'navigate', 'click', 'type', 'press', 'scroll', 'content', 'eval', 'screenshot', 'tabs', 'close'] },
          url: { type: 'string', description: 'Para launch/navigate' },
          selector: { type: 'string', description: 'Selector CSS para click/type' },
          text: { type: 'string', description: 'Texto para type, o texto visible a buscar para click' },
          key: { type: 'string', description: 'Tecla para press: Enter, Tab, Escape, ArrowDown, ArrowUp, Backspace' },
          direction: { type: 'string', description: 'up|down para scroll' },
          amount: { type: 'number', description: 'Píxeles de scroll' },
          expression: { type: 'string', description: 'JS para eval' },
          query: { type: 'string', description: 'Selector opcional para content/screenshot' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: 'Captura la pantalla completa y te la muestra como imagen para que la analices.',
      parameters: { type: 'object', properties: {} }
    }
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
          text: { type: 'string' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notify',
      description: 'Muestra una notificación nativa de Windows al usuario.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' }, message: { type: 'string' } },
        required: ['title', 'message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'media_control',
      description: 'Controla multimedia del sistema: play/pause, next, previous, volume_up, volume_down, mute.',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['play_pause', 'next', 'previous', 'volume_up', 'volume_down', 'mute'] } },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'window_manage',
      description: 'Gestiona ventanas: minimize_all (minimiza todo), show_desktop (Win+D), close_active_windows (cierra ventanas activas).',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['minimize_all', 'show_desktop'] } },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'system_info',
      description: 'Devuelve información del sistema: CPU, RAM, SO, uptime, IPs.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'use_skill',
      description: 'Carga las instrucciones especializadas de una skill instalada (código, investigación, diseño, ahorro de tokens…). Úsala ANTES de empezar una tarea en la que alguna skill del índice aplique: seguirás sus instrucciones expertas para esa tarea. Devuelve el cuerpo completo de la skill.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nombre de la skill tal como aparece en el índice de skills' } },
        required: ['name']
      }
    }
  }
];

module.exports = { toolDefs: defs };
