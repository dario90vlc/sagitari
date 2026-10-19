'use strict';

/* v3.0 — Seguridad de los comandos (hueco 6: aislamiento).

   Hasta ahora `run_command` tenía UN nivel de riesgo: el de la herramienta
   entera. Eso significa que el usuario que la pone en «safe» —o que aprueba
   una vez un comando— autoriza por igual `git status` y `format C:`. El nivel
   se decidía por QUIÉN ejecuta, nunca por QUÉ se ejecuta.

   Aquí se mira el TEXTO del comando y se clasifica en tres escalones:

     normal     → se comporta como siempre (lo decide el nivel de la herramienta)
     sensible   → exige confirmación SIEMPRE, aunque run_command esté en «safe»
                  (la seguridad gana a la comodidad, la misma regla que ya se
                  aplica a las acciones sensibles del navegador)
     prohibido  → no se ejecuta. No hay confirmación que valga: lo que destruye
                  el sistema o los datos del usuario no se automatiza.

   Es lógica pura (sin Electron ni I/O) para poder probarla entera.

   Lo que este módulo NO pretende ser: un sandbox. No aísla el proceso —el
   comando sigue corriendo con los permisos del usuario—. Es una barrera de
   juicio: evita el desastre por descuido, no el ataque dirigido. Un sandbox de
   verdad (proceso aparte, sin red, con la carpeta del proyecto montada) es otro
   trabajo y está anotado como pendiente en el spec. */

/* --------------------------------------------------------------------------- *
 *  PROHIBIDOS — lo que no se ejecuta nunca
 *
 *  El criterio es estrecho a propósito: solo cae aquí lo que destruye de forma
 *  irreversible y a gran escala (el sistema, una unidad entera, la copia de
 *  seguridad). Un borrado dentro del proyecto es «sensible», no «prohibido»:
 *  negarlo ahí convertiría la barrera en un estorbo y el usuario la apagaría.
 * --------------------------------------------------------------------------- */
const PROHIBIDOS = [
  { rx: /^format\s+[a-z]:/i, motivo: 'formatear una unidad de disco' },
  { rx: /^diskpart\b/i, motivo: 'diskpart: gestiona las particiones del disco' },
  { rx: /^mkfs(\.[a-z0-9]+)?\b/i, motivo: 'crear un sistema de archivos sobre un dispositivo' },
  { rx: /^dd\s+[^\n]*\bof=\s*(\/dev\/|[a-z]:)/i, motivo: 'escribir directamente sobre un dispositivo o unidad' },
  { rx: /^(bcdedit|bootrec|bootsect)\b/i, motivo: 'modificar el arranque del sistema' },
  { rx: /^(vssadmin|wbadmin)\s+delete\b/i, motivo: 'borrar las copias de seguridad o los puntos de restauración' },
  { rx: /^cipher\s+\/w/i, motivo: 'sobrescribir el espacio libre de la unidad (irreversible)' },
  // borrar la RAÍZ de una unidad (del /s /q C:\ · rd /s /q C:\ · rm -rf /)
  { rx: /^(del|erase|rd|rmdir)\b[^\n]*\s[a-z]:[\\/]?\s*$/i, motivo: 'borrar la raíz de una unidad' },
  { rx: /^(del|erase|rd|rmdir)\b[^\n]*\s[a-z]:[\\/](?=\s|$)/i, motivo: 'borrar la raíz de una unidad' },
  { rx: /^rm\s+-[a-z]*[rf][a-z]*\s+\/(?:\s|$)/i, motivo: 'borrar la raíz del sistema de archivos' },
  {
    rx: /^Remove-Item\b[^\n]*-[^\n]*Recurse[^\n]*\b(?:[a-z]:[\\/]\s*$|[a-z]:[\\/](?=\s|")|C:\\Windows|C:\\Program Files)/i,
    motivo: 'borrar de forma recursiva una raíz del sistema',
  },
  // borrar dentro de Windows / Program Files
  {
    rx: /^(del|erase|rd|rmdir|rm|Remove-Item)\b[^\n]*\bC:[\\/](Windows|Program Files|ProgramData|Users[\\/][^\\/]+[\\/](AppData|Documents))[\\/]/i,
    motivo: 'borrar dentro de las carpetas del sistema',
  },
  { rx: /^(mls|cacls)\b/i, motivo: 'operación no soportada en Windows' },
  { rx: /^:\s*\(\s*\)\s*\{[^\n]*\|[^\n]*:&/, motivo: 'bomba de procesos' },
];

/* --------------------------------------------------------------------------- *
 *  SENSIBLES — se ejecutan solo si el usuario lo aprueba expresamente
 * --------------------------------------------------------------------------- */
const SENSIBLES = [
  // --- descargar y ejecutar en un tubo: la vía clásica de un script remoto ---
  { rx: /\|\s*(bash|sh|zsh|powershell|pwsh|cmd|node|python|perl)\b/i, motivo: 'pasar la salida de un comando a un intérprete' },
  { rx: /\|\s*(iex|Invoke-Expression)\b/i, motivo: 'ejecutar código descargado al vuelo (Invoke-Expression)' },

  // --- ofuscación y descarga remota (bypass del tubo clásico) ---
  {
    rx: /\b(powershell|pwsh)(\.exe)?\b[^\n]*?(?:\s-(e|en|enc|encodedcommand)\b|EncodedCommand|FromBase64String)/i,
    motivo: 'ejecutar código ofuscado o codificado en base64 (PowerShell)',
  },
  {
    rx: /DownloadString|DownloadFile|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|Net\.WebClient|FromBase64String/i,
    motivo: 'descargar código o datos remotos para su ejecución',
  },
  { rx: /\b(mshta|rundll32)(\.exe)?\b[^\n]*https?:/i, motivo: 'ejecutar código remoto con un binario del sistema (LOLBin)' },
  { rx: /\bcertutil(\.exe)?\b[^\n]*-urlcache/i, motivo: 'descargar un archivo remoto con certutil' },
  { rx: /(^|[\s&;|])start\s+"[^"]*"\s*https?:|(^|[\s&;|])start\s+https?:/i, motivo: 'abrir una URL desde la terminal' },

  // --- borrados (dentro del proyecto, pero borrados) ---
  { rx: /\b(del|erase)\b[^\n]*\s\/[a-z]*s/i, motivo: 'borrar de forma recursiva' },
  { rx: /\b(rd|rmdir)\b[^\n]*\s\/[a-z]*s/i, motivo: 'borrar carpetas de forma recursiva' },
  { rx: /\brm\s+-[a-z]*[rf]/i, motivo: 'borrar de forma recursiva o forzada' },
  { rx: /\bRemove-Item\b[^\n]*(Recurse|-[a-z]*Force)/i, motivo: 'borrar de forma recursiva o forzada' },
  { rx: /\bgit\s+clean\b[^\n]*-[a-z]*[fdx]/i, motivo: 'descartar archivos no versionados' },

  // --- historia de git y ramas: lo que no se deshace ---
  { rx: /\bgit\s+reset\s+--hard\b/i, motivo: 'descartar cambios locales (git reset --hard)' },
  { rx: /\bgit\s+checkout\s+--\s/i, motivo: 'descartar cambios locales de archivos' },
  { rx: /\bgit\s+restore\b[^\n]*(--source|-s)\b/i, motivo: 'restaurar archivos desde otro punto de la historia' },
  { rx: /\bgit\s+push\b[^\n]*(--force|--force-with-lease|-f\b)/i, motivo: 'sobrescribir la historia remota (push forzado)' },
  { rx: /\bgit\s+push\b[^\n]*--delete\b/i, motivo: 'borrar una rama en el remoto' },
  { rx: /\bgit\s+branch\s+-D\b/i, motivo: 'borrar una rama sin fusionar' },
  { rx: /\bgit\s+filter-(branch|repo)\b/i, motivo: 'reescribir la historia del repositorio' },

  // --- publicar ---
  { rx: /\b(npm|pnpm|yarn)\s+publish\b/i, motivo: 'publicar un paquete' },
  { rx: /\bcargo\s+publish\b/i, motivo: 'publicar un paquete' },
  { rx: /\bgh\s+release\s+create\b/i, motivo: 'publicar una release en GitHub' },
  { rx: /\bdocker\s+(rmi|rm|prune|system\s+prune)\b/i, motivo: 'borrar imágenes o contenedores de Docker' },

  // --- instalar software en el equipo ---
  { rx: /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b[^\n]*(\s-g\b|--global)/i, motivo: 'instalar un paquete global en el equipo' },
  { rx: /\b(pip|pip3|python\s+-m\s+pip)\s+install\b/i, motivo: 'instalar un paquete de Python' },
  { rx: /\b(winget|choco|scoop|apt|apt-get|brew|dnf|yum|pacman)\s+install\b/i, motivo: 'instalar software en el equipo' },

  // --- sistema: registro, servicios, tareas, usuarios, red, energía ---
  { rx: /\breg\s+(add|delete|import|restore)\b/i, motivo: 'modificar el registro de Windows' },
  { rx: /\b(sc|net)\s+(start|stop|config|create|delete)\b/i, motivo: 'crear, borrar o configurar un servicio' },
  { rx: /\bschtasks\b[^\n]*\/(create|delete|change)/i, motivo: 'crear, borrar o modificar una tarea programada' },
  {
    rx: /\b(New-Service|Remove-Service|New-ScheduledTask|Register-ScheduledTask|Unregister-ScheduledTask)\b/i,
    motivo: 'registrar un servicio o una tarea programada',
  },
  { rx: /\bnet\s+(user|localgroup|share)\b/i, motivo: 'crear, borrar o modificar cuentas y recursos compartidos' },
  { rx: /\b(New-LocalUser|Remove-LocalUser|Add-LocalGroupMember)\b/i, motivo: 'modificar cuentas de usuario del equipo' },
  { rx: /\bSet-ExecutionPolicy\b/i, motivo: 'cambiar la política de ejecución de PowerShell' },
  { rx: /\b(Add|Set|Remove)-MpPreference\b/i, motivo: 'cambiar la configuración del antivirus' },
  {
    rx: /\b(New-NetFirewallRule|Remove-NetFirewallRule|Set-NetFirewallProfile)\b|\bnetsh\s+advfirewall\b/i,
    motivo: 'cambiar el cortafuegos',
  },
  { rx: /\bnetsh\b/i, motivo: 'reconfigurar la red del equipo' },
  { rx: /\b(powercfg|shutdown|Stop-Computer|Restart-Computer)\b/i, motivo: 'cambiar el estado o la energía del equipo' },
  { rx: /\b(taskkill|Stop-Process)\b[^\n]*\/?[fF]\b|\btaskkill\b[^\n]*\/f\b/i, motivo: 'matar procesos a la fuerza' },
  { rx: /\bwmic\b[^\n]*\bdelete\b/i, motivo: 'borrar un recurso del sistema' },
  { rx: /\b(icacls|takeown|attrib)\b[^\n]*(\/grant|\/deny|\/f\b|-r\b)/i, motivo: 'cambiar los permisos o los atributos de archivos' },
  { rx: /\bSet-ItemProperty\b[^\n]*H[KC]LM/i, motivo: 'modificar el registro de Windows' },

  // --- escribir fuera del proyecto ---
  { rx: />>?\s*"?(C:[\\/](Windows|Program Files|ProgramData)|\/etc\/|\/usr\/)/i, motivo: 'escribir dentro de las carpetas del sistema' },
];

/* --------------------------------------------------------------------------- *
 *  PERMITIDOS — solo leen
 *
 *  Una lista de comandos que no cambian nada. Sirve para lo contrario que las
 *  dos anteriores: que una regla amplia no convierta en «sensible» algo
 *  inocente (mirar la versión de Node, ver el estado de git). Solo aplica si el
 *  comando es UNA orden sencilla: en cuanto encadena (`&&`, `;`, `|`, `>`), la
 *  lista blanca deja de valer, porque ya no se sabe qué se ejecuta después.
 * --------------------------------------------------------------------------- */
const PERMITIDOS =
  /^\s*(dir|ls|tree|type|cat|head|tail|find|findstr|where|which|echo|pwd|cd|whoami|hostname|date|time|ver|set\b|git\s+(status|log|diff|show|branch|remote|describe|rev-parse|ls-files|shortlog|blame|config\s+--get)|(node|npm|npx|pnpm|yarn|bun|python|py|pip|git|docker|java|go|cargo|rustc|dotnet|ffmpeg|rg|code)\s+(-{1,2}[a-z]|--version)\b|(npm|pnpm|yarn|bun)\s+(test|run|ls|list|outdated)\b)/i;

/** Cadena con algo más que una orden simple (encadenada, redirigida o sustituida). */
function compuesta(cmd) {
  return /(&&|\|\||;|`|\$\(|>>|>|<\()/.test(cmd) || /\|/.test(cmd);
}

/* --------------------------------------------------------------------------- *
 *  TROCEADO — de la línea a la orden
 *
 *  Clasificar sobre el texto crudo deja dos agujeros con la misma raíz. La regla
 *  exige un espacio entre el nombre del ejecutable y sus argumentos, así que
 *  basta escribirlo de otra forma (`format.com C:`, `cipher.exe /w:C:`,
 *  `C:\Windows\System32\format.exe C:`) para que no la vea; y al revés, una
 *  palabra peligrosa que solo se MENCIONA (un `echo`, el mensaje de un
 *  `git commit -m`) contaba como si fuera la orden. Por eso las reglas de las
 *  listas se escriben contra UN subcomando —ancladas con `^`, que es donde va
 *  la orden— y aquí se parte la línea en subcomandos (los separadores de cmd:
 *  `&`, `&&`, `|`, `||`, y el `;` de PowerShell) y cada uno en tokens, para
 *  aplicarlas al subcomando normalizado: el ejecutable pierde la ruta y la
 *  extensión, y las comillas se caen (la barrera mira QUÉ orden es, no cómo se
 *  escribió).
 * --------------------------------------------------------------------------- */

/* Separadores que parten la línea en órdenes independientes. Dentro de comillas
   dobles no separan, que es como los trata cmd.exe en el caso corriente. */
const SEPARADORES_ORDEN = new Set(['&', '|', ';']);

/** Trocea una línea en subcomandos; cada uno es su lista de tokens, sin comillas. */
function trocear(linea) {
  const subcomandos = [];
  let tokens = [];
  let token = '';
  let hayToken = false;
  let enComillas = false;
  const cerrarToken = () => {
    if (!hayToken) return;
    tokens.push(token);
    token = '';
    hayToken = false;
  };
  const cerrarSubcomando = () => {
    cerrarToken();
    if (tokens.length) subcomandos.push(tokens);
    tokens = [];
  };
  for (const ch of String(linea)) {
    if (ch === '"') {
      enComillas = !enComillas;
      hayToken = true;
      continue;
    }
    if (!enComillas && SEPARADORES_ORDEN.has(ch)) {
      cerrarSubcomando();
      continue;
    }
    if (!enComillas && /\s/.test(ch)) {
      cerrarToken();
      continue;
    }
    token += ch;
    hayToken = true;
  }
  cerrarSubcomando();
  return subcomandos;
}

/** Nombre del ejecutable sin ruta ni extensión: `C:\...\format.com` → `format`. */
function nombreEjecutable(token) {
  const partes = String(token).split(/[\\/]/);
  const base = partes[partes.length - 1] || String(token);
  const limpio = base.replace(/\.(exe|com)$/i, '');
  /* `%COMSPEC%` (y sus primos de PowerShell) ES cmd.exe: sin traducirlo, `%COMSPEC% /c
     format C:` pasaba la barrera porque el «ejecutable» era un nombre de variable. */
  const min = limpio.toLowerCase();
  if (min === '%comspec%' || min === '$env:comspec' || min === '${env:comspec}') return 'cmd';
  return limpio;
}

/* Palabras que se limitan a lanzar la orden que va detrás (elevar, medir el
   tiempo, fijar el entorno). Si la barrera se quedara en ellas, anteponer un
   `sudo` esquivaría la lista entera. */
const LANZADORES = new Set([
  'sudo', 'doas', 'runas', 'time', 'nice', 'nohup', 'env', 'setsid', 'exec',
  'command', 'stdbuf', 'timeout', 'ionice', 'chrt', 'taskset', 'busybox', 'wsl',
  'call', 'xargs',
]);

/* Lanzadores que no están en la lista de arriba porque su nombre no se escribe igual en
   los dos mundos (`start` de cmd, `Start-Process` de PowerShell): se comparan en
   minúsculas, igual que los demás. */
const LANZADORES_TEXTO = new Set(['start', 'start-process']);

/* Intérpretes cuyo argumento ES una línea de órdenes: su interior se vuelve a
   trocear para que la barrera juzgue la orden de dentro (`cmd /c del …`,
   `powershell -Command "Remove-Item …"`) y no el nombre del intérprete. */
const BANDERAS_INTERIOR = {
  cmd: ['/c', '/k'],
  powershell: ['-command', '-c', '-commandwithargs'],
  pwsh: ['-command', '-c', '-commandwithargs'],
  bash: ['-c'],
  sh: ['-c'],
  dash: ['-c'],
  ksh: ['-c'],
  zsh: ['-c'],
};

/** Accesorio de un lanzador: una opción, una variable de entorno o un número. */
function esAccesorio(token) {
  const t = String(token);
  return /^[-/][a-z0-9]/i.test(t) || /^[a-z_][a-z0-9_]*=/i.test(t) || /^\d+$/.test(t);
}

/* Opciones de `start` que CONSUMEN el token siguiente (`start /d C:\dir format C:`). */
const START_CON_VALOR = new Set(['/d', '/node', '/affinity', '/machine', '/i', '/min', '/max', '/low', '/normal', '/high', '/realtime', '/abovenormal', '/belownormal']);

/**
 * Quita de delante lo que NO cambia QUÉ orden se ejecuta: decoradores de cmd.exe (`@`),
 * redirecciones (`>nul`, `2>nul`, `>>log`), lanzadores (`start`, `sudo`…), la construcción
 * `if <condición>`, `for … do`, `ftype nombre=` y paréntesis.
 *
 * Sin esto, anteponer una palabra dejaba la orden fuera del alcance de las reglas (que van
 * ancladas al principio del subcomando): `start format C: /q` se quedaba en «start»,
 * «inocuo», y la barrera de prohibidos se esquivaba — la MISMA clase de evasión que
 * escribir el ejecutable con su extensión o con comillas.
 */
function desnudar(tokens) {
  let t = tokens.slice();
  let seguir = true;
  while (seguir && t.length) {
    seguir = false;
    /* 0) tokens vacíos (las comillas de `start "" /b format C:` dejan uno) y prefijos de
       entorno (`FOO=1 format C: /q`), que son decoradores igual que `@`: si se quedan
       delante, el «ejecutable» es un nombre de variable y la orden se esconde. */
    while (t.length && (String(t[0]) === '' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(t[0])))) {
      t.shift();
      seguir = true;
    }
    if (!t.length) break;
    // 1) decoradores de eco y redirecciones al principio (`@`, `>nul`, `2>nul`, `>>log`)
    while (t.length) {
      const p = String(t[0]);
      if (/^@+$/.test(p)) {
        t.shift();
        continue;
      }
      if (/^\d*(>>?|>&)/.test(p)) {
        t.shift();
        /* `> archivo` escrito en DOS tokens: el destino se va con la redirección. Si el
           token ya trae el destino (`>nul`, `2>nul`, `>>log`, `>&1`), no hay nada más
           que quitar — quitarlo se comía la orden de detrás. */
        if (/^\d*(>>?|>&)$/.test(p) && t.length) t.shift();
        continue;
      }
      if (/^@/.test(p)) {
        t[0] = p.slice(1); // `@echo` o `@format`: el `@` es del shell, no de la orden
        if (!t[0]) t.shift();
        continue;
      }
      break;
    }
    // 2) lanzadores (con sus opciones): `start`, `sudo`, `wsl`, `cmd /c`…
    while (t.length && (LANZADORES.has(String(t[0]).toLowerCase()) || LANZADORES_TEXTO.has(String(t[0]).toLowerCase()))) {
      const lanzador = String(t.shift()).toLowerCase();
      while (t.length && String(t[0]) === '') t.shift(); // `start "" /b …`
      while (t.length && (esAccesorio(t[0]) || (lanzador === 'start' && START_CON_VALOR.has(String(t[0]).toLowerCase())))) {
        const opcion = String(t.shift()).toLowerCase();
        // opciones que se comen el valor siguiente (`start /d C:\dir …`)
        if (START_CON_VALOR.has(opcion) && t.length && !esAccesorio(t[0])) t.shift();
      }
      seguir = true;
    }
    // 3) `if <condición> <orden>`: se salta la condición (formas documentadas de cmd)
    if (t.length && String(t[0]).toLowerCase() === 'if') {
      let k = 1;
      if (String(t[k] || '').toLowerCase() === 'not') k++;
      const forma = String(t[k] || '').toLowerCase();
      if (forma === 'exist' || forma === 'defined' || forma === 'errorlevel' || forma === 'cmdextversion') k += 2;
      else if (/==/.test(String(t[k] || ''))) k += 1;
      else k += 2;
      t = t.slice(k);
      seguir = true;
    }
    // 4) `for … do <orden>`
    const iDo = t.findIndex((x) => String(x).toLowerCase() === 'do');
    if (t.length && String(t[0]).toLowerCase() === 'for' && iDo > 0) {
      t = t.slice(iDo + 1);
      seguir = true;
    }
    // 5) `ftype nombre=<orden>` / `assoc .ext=<orden>`
    if (t.length && ['ftype', 'assoc'].includes(String(t[0]).toLowerCase())) {
      const iIgual = t.findIndex((x, n) => n > 0 && String(x).includes('='));
      if (iIgual > 0) {
        const cola = String(t[iIgual]).slice(String(t[iIgual]).indexOf('=') + 1);
        t = (cola ? [cola] : []).concat(t.slice(iIgual + 1));
        seguir = true;
      }
    }
    // 6) paréntesis que agrupan (`(format C: /q)` o `( format C: /q )`)
    if (t.length && String(t[0]).startsWith('(')) {
      const primero = String(t.shift()).replace(/^\(+/, '');
      if (primero) t.unshift(primero);
      seguir = true;
    }
    if (t.length && String(t[t.length - 1]).endsWith(')')) {
      const ultimo = String(t.pop()).replace(/\)+$/, '');
      if (ultimo) t.push(ultimo);
      seguir = true;
    }
  }
  return t;
}

/**
 * Subcomandos de una línea, ya normalizados: `{ exe: 'format', texto: 'format C: /q' }`.
 * `texto` empieza por el nombre del ejecutable (sin ruta ni extensión) y sigue con
 * sus argumentos sin comillas: es contra eso contra lo que se aplican las reglas.
 */
function subcomandosDe(linea, profundidad = 0) {
  const lista = [];
  for (const tokens of trocear(linea)) {
    if (!tokens.length) continue;
    /* Primero se quitan decoradores y construcciones (`start`, `@`, `>nul`, `if`, `for…do`,
       `ftype x=`): si no, la orden de dentro queda escondida detrás de una palabra que no
       está prohibida y la barrera se esquiva anteponiéndola. */
    const resto = desnudar(tokens);
    if (!resto.length) continue;
    const exe = nombreEjecutable(resto[0]);
    const args = resto.slice(1);
    lista.push({ exe, texto: [exe].concat(args).join(' ') });
    if (profundidad >= 3) continue;
    const banderas = BANDERAS_INTERIOR[String(exe).toLowerCase()];
    if (!banderas) continue;
    const corte = args.findIndex((a) => banderas.includes(String(a).toLowerCase()));
    if (corte < 0) continue;
    // las comillas simples las gasta el shell de fuera: al intérprete le llega la orden ya sin ellas
    const interior = args
      .slice(corte + 1)
      .join(' ')
      .replace(/'/g, '');
    if (interior) lista.push(...subcomandosDe(interior, profundidad + 1));
  }
  return lista;
}

/**
 * Clasifica un comando. Devuelve siempre un objeto:
 *   { nivel: 'normal'|'sensible'|'prohibido', motivo, regla }
 * `regla` es el índice legible de la lista que disparó el veredicto, para que la
 * prueba y el diagnóstico puedan citarlo.
 */
function clasificar(cmd) {
  const t = String(cmd == null ? '' : cmd)
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return { nivel: 'normal', motivo: '', regla: '' };

  /* Las reglas van ancladas al principio del subcomando, así que se prueban
     contra cada subcomando normalizado; la línea entera se prueba también para
     no depender de cómo se trocee (una bomba de procesos vive en los propios
     separadores). */
  const subcomandos = subcomandosDe(t);
  const dispara = (rx) => rx.test(t) || subcomandos.some((s) => rx.test(s.texto));

  for (let i = 0; i < PROHIBIDOS.length; i++) {
    if (dispara(PROHIBIDOS[i].rx)) {
      return { nivel: 'prohibido', motivo: PROHIBIDOS[i].motivo, regla: 'prohibido#' + i };
    }
  }

  // una orden sencilla y de solo lectura no se toca: ni aviso ni escalón
  if (!compuesta(t) && PERMITIDOS.test(t)) return { nivel: 'normal', motivo: '', regla: '' };

  for (let i = 0; i < SENSIBLES.length; i++) {
    if (dispara(SENSIBLES[i].rx)) {
      return { nivel: 'sensible', motivo: SENSIBLES[i].motivo, regla: 'sensible#' + i };
    }
  }

  return { nivel: 'normal', motivo: '', regla: '' };
}

/** ¿Solo lee? (lo usa la interfaz para explicar por qué un comando no molestó). */
function esSeguro(cmd) {
  const t = String(cmd == null ? '' : cmd)
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || compuesta(t)) return false;
  return PERMITIDOS.test(t);
}

/** Frase para la tarjeta de confirmación, o null si no hay nada que avisar. */
function avisoSensible(cmd) {
  const c = clasificar(cmd);
  if (c.nivel === 'sensible') return 'COMANDO SENSIBLE: ' + c.motivo;
  return null;
}

/** Mensaje con el que se rechaza un comando prohibido (lo devuelve la herramienta). */
function mensajeProhibido(cmd) {
  const c = clasificar(cmd);
  if (c.nivel !== 'prohibido') return '';
  return `Error: no voy a ejecutar este comando. Motivo: ${c.motivo}. Si de verdad lo necesitas, ejecútalo tú, consciente de lo que hace.`;
}

module.exports = { clasificar, esSeguro, avisoSensible, mensajeProhibido, compuesta, PROHIBIDOS, SENSIBLES, PERMITIDOS };
