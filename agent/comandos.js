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
  { rx: /\bformat\s+[a-z]:/i, motivo: 'formatear una unidad de disco' },
  { rx: /\bdiskpart\b/i, motivo: 'diskpart: gestiona las particiones del disco' },
  { rx: /\bmkfs(\.[a-z0-9]+)?\b/i, motivo: 'crear un sistema de archivos sobre un dispositivo' },
  { rx: /\bdd\s+[^\n]*\bof=\s*(\/dev\/|[a-z]:)/i, motivo: 'escribir directamente sobre un dispositivo o unidad' },
  { rx: /\b(bcdedit|bootrec|bootsect)\b/i, motivo: 'modificar el arranque del sistema' },
  { rx: /\b(vssadmin|wbadmin)\s+delete\b/i, motivo: 'borrar las copias de seguridad o los puntos de restauración' },
  { rx: /\bcipher\s+\/w/i, motivo: 'sobrescribir el espacio libre de la unidad (irreversible)' },
  // borrar la RAÍZ de una unidad (del /s /q C:\ · rd /s /q C:\ · rm -rf /)
  { rx: /\b(del|erase|rd|rmdir)\b[^\n]*\s[a-z]:[\\/]?\s*$/i, motivo: 'borrar la raíz de una unidad' },
  { rx: /\b(del|erase|rd|rmdir)\b[^\n]*\s[a-z]:[\\/](?=\s|$)/i, motivo: 'borrar la raíz de una unidad' },
  { rx: /\brm\s+-[a-z]*[rf][a-z]*\s+\/(?:\s|$)/i, motivo: 'borrar la raíz del sistema de archivos' },
  { rx: /\bRemove-Item\b[^\n]*-[^\n]*Recurse[^\n]*\b(?:[a-z]:[\\/]\s*$|[a-z]:[\\/](?=\s|")|C:\\Windows|C:\\Program Files)/i, motivo: 'borrar de forma recursiva una raíz del sistema' },
  // borrar dentro de Windows / Program Files
  { rx: /\b(del|erase|rd|rmdir|rm|Remove-Item)\b[^\n]*\bC:[\\/](Windows|Program Files|ProgramData|Users[\\/][^\\/]+[\\/](AppData|Documents))[\\/]/i, motivo: 'borrar dentro de las carpetas del sistema' },
  { rx: /\bmls\b|\bcacls\b/i, motivo: 'operación no soportada en Windows' },
  { rx: /:\s*\(\s*\)\s*\{[^\n]*\|[^\n]*:&/, motivo: 'bomba de procesos' },
];

/* --------------------------------------------------------------------------- *
 *  SENSIBLES — se ejecutan solo si el usuario lo aprueba expresamente
 * --------------------------------------------------------------------------- */
const SENSIBLES = [
  // --- descargar y ejecutar en un tubo: la vía clásica de un script remoto ---
  { rx: /\|\s*(bash|sh|zsh|powershell|pwsh|cmd|node|python|perl)\b/i, motivo: 'pasar la salida de un comando a un intérprete' },
  { rx: /\|\s*(iex|Invoke-Expression)\b/i, motivo: 'ejecutar código descargado al vuelo (Invoke-Expression)' },

  // --- ofuscación y descarga remota (bypass del tubo clásico) ---
  { rx: /\b(powershell|pwsh)(\.exe)?\b[^\n]*?(?:\s-(e|en|enc|encodedcommand)\b|EncodedCommand|FromBase64String)/i, motivo: 'ejecutar código ofuscado o codificado en base64 (PowerShell)' },
  { rx: /DownloadString|DownloadFile|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|Net\.WebClient|FromBase64String/i, motivo: 'descargar código o datos remotos para su ejecución' },
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
  { rx: /\b(New-Service|Remove-Service|New-ScheduledTask|Register-ScheduledTask|Unregister-ScheduledTask)\b/i, motivo: 'registrar un servicio o una tarea programada' },
  { rx: /\bnet\s+(user|localgroup|share)\b/i, motivo: 'crear, borrar o modificar cuentas y recursos compartidos' },
  { rx: /\b(New-LocalUser|Remove-LocalUser|Add-LocalGroupMember)\b/i, motivo: 'modificar cuentas de usuario del equipo' },
  { rx: /\bSet-ExecutionPolicy\b/i, motivo: 'cambiar la política de ejecución de PowerShell' },
  { rx: /\b(Add|Set|Remove)-MpPreference\b/i, motivo: 'cambiar la configuración del antivirus' },
  { rx: /\b(New-NetFirewallRule|Remove-NetFirewallRule|Set-NetFirewallProfile)\b|\bnetsh\s+advfirewall\b/i, motivo: 'cambiar el cortafuegos' },
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
const PERMITIDOS = /^\s*(dir|ls|tree|type|cat|head|tail|find|findstr|where|which|echo|pwd|cd|whoami|hostname|date|time|ver|set\b|git\s+(status|log|diff|show|branch|remote|describe|rev-parse|ls-files|shortlog|blame|config\s+--get)|(node|npm|npx|pnpm|yarn|bun|python|py|pip|git|docker|java|go|cargo|rustc|dotnet|ffmpeg|rg|code)\s+(-{1,2}[a-z]|--version)\b|(npm|pnpm|yarn|bun)\s+(test|run|ls|list|outdated)\b)/i;

/** Cadena con algo más que una orden simple (encadenada, redirigida o sustituida). */
function compuesta(cmd) {
  return /(&&|\|\||;|`|\$\(|>>|>|<\()/.test(cmd) || /\|/.test(cmd);
}

/**
 * Clasifica un comando. Devuelve siempre un objeto:
 *   { nivel: 'normal'|'sensible'|'prohibido', motivo, regla }
 * `regla` es el índice legible de la lista que disparó el veredicto, para que la
 * prueba y el diagnóstico puedan citarlo.
 */
function clasificar(cmd) {
  const t = String(cmd == null ? '' : cmd).replace(/\s+/g, ' ').trim();
  if (!t) return { nivel: 'normal', motivo: '', regla: '' };

  for (let i = 0; i < PROHIBIDOS.length; i++) {
    if (PROHIBIDOS[i].rx.test(t)) {
      return { nivel: 'prohibido', motivo: PROHIBIDOS[i].motivo, regla: 'prohibido#' + i };
    }
  }

  // una orden sencilla y de solo lectura no se toca: ni aviso ni escalón
  if (!compuesta(t) && PERMITIDOS.test(t)) return { nivel: 'normal', motivo: '', regla: '' };

  for (let i = 0; i < SENSIBLES.length; i++) {
    if (SENSIBLES[i].rx.test(t)) {
      return { nivel: 'sensible', motivo: SENSIBLES[i].motivo, regla: 'sensible#' + i };
    }
  }

  return { nivel: 'normal', motivo: '', regla: '' };
}

/** ¿Solo lee? (lo usa la interfaz para explicar por qué un comando no molestó). */
function esSeguro(cmd) {
  const t = String(cmd == null ? '' : cmd).replace(/\s+/g, ' ').trim();
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
