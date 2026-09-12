'use strict';

const { exec } = require('child_process');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const skills = require('./skills');
const memory = require('./memory');

// cmd.exe y otras herramientas nativas emiten en la página de códigos OEM (CP850 en
// Windows en español), no en UTF-8: si los bytes no forman UTF-8 válido los decodificamos
// como CP850 para que los acentos no lleguen corruptos. (Los acentos españoles coinciden
// en CP850 y CP437, así que la tabla sirve también en equipos con OEM 437.)
const CP850 = '\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00f8\u00a3\u00d8\u00d7\u0192' +
  '\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u00ae\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u00c1\u00c2\u00c0\u00a9\u2563\u2551\u2557\u255d\u00a2\u00a5\u2510' +
  '\u2514\u2534\u252c\u251c\u2500\u253c\u00e3\u00c3\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u00a4\u00f0\u00d0\u00ca\u00cb\u00c8\u0131\u00cd\u00ce\u00cf\u2518\u250c\u2588\u2584\u00a6\u00cc\u2580' +
  '\u00d3\u00df\u00d4\u00d2\u00f5\u00d5\u00b5\u00fe\u00de\u00da\u00db\u00d9\u00fd\u00dd\u00af\u00b4\u00ad\u00b1\u2017\u00be\u00b6\u00a7\u00f7\u00b8\u00b0\u00a8\u00b7\u00b9\u00b3\u00b2\u25a0\u00a0';
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });
function decodeOut(buf) {
  buf = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'utf8');
  try { return UTF8_STRICT.decode(buf); } catch {}
  const s = buf.toString('latin1');
  let out = '';
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out += c < 0x80 ? s[i] : CP850[c - 0x80]; }
  return out;
}

// En Windows, matar el hijo directo deja nietos huérfanos: taskkill /T /F elimina
// todo el árbol de procesos. Se usa tanto al pulsar Detener como al expirar el timeout.
function killTree(child) {
  const pid = child && child.pid;
  if (pid && process.platform === 'win32') {
    // taskkill primero, con el padre aún vivo para poder enumerar el árbol; child.kill() como respaldo
    try {
      exec(`taskkill /PID ${pid} /T /F`, { windowsHide: true }, () => { try { child.kill(); } catch {} });
      return;
    } catch {}
  }
  try { child.kill(); } catch {}
}

function run(cmd, opts = {}) {
  return new Promise((resolve) => {
    const timeout = opts.timeout || 60000;
    let done = false, outChunks = [], errChunks = [];
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: decodeOut(Buffer.concat(outChunks)), stderr: decodeOut(Buffer.concat(errChunks)) });
    };
    // sin `timeout` de exec: lo gestionamos nosotros para poder matar el árbol completo
    const child = exec(cmd, { windowsHide: true, maxBuffer: opts.maxBuffer || 16 * 1024 * 1024, cwd: opts.cwd, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (!outChunks.length) outChunks = [stdout || Buffer.alloc(0)];
      if (!errChunks.length) errChunks = [stderr && stderr.length ? stderr : Buffer.from((err && err.message) || '')];
      finish(err ? (err.code ?? 1) : 0);
    });
    child.stdout?.on('data', (d) => { outChunks.push(d); });
    child.stderr?.on('data', (d) => { errChunks.push(d); });
    const timer = setTimeout(() => {
      killTree(child);
      // margen para que se cierren los handles; si no, resolvemos igualmente
      setTimeout(() => finish(1), 300);
    }, timeout);
    // el agente puede matar el comando al pulsar Detener
    if (opts.registerKillable) opts.registerKillable({ stop: () => killTree(child) });
  });
}

const clip = (s, n = 8000) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n...[truncado, ${s.length} caracteres]` : s;
};

const MEDIA_KEYS = { play_pause: 0xB3, next: 0xB0, previous: 0xB1, volume_up: 0xAF, volume_down: 0xAE, mute: 0xAD };

async function sendVK(vk) {
  const ps = `
Add-Type -Namespace J -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);'
[J.K]::keybd_event(${vk},0,0,[UIntPtr]::Zero); Start-Sleep -m 40; [J.K]::keybd_event(${vk},0,2,[UIntPtr]::Zero)`;
  return run(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { timeout: 15000 });
}

// ---- File helpers -------------------------------------------------------

async function walk(root, depth, maxDepth, out, budget) {
  if (depth > maxDepth || out.length >= budget.count) return;
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= budget.count) return;
    if (['node_modules', '.git', '$RECYCLE.BIN', 'AppData'].includes(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      out.push('  '.repeat(depth) + e.name + '/');
      await walk(full, depth + 1, maxDepth, out, budget);
    } else {
      let size = '';
      try { size = ' (' + Math.round(e.size === undefined ? (fs.statSync(full).size) : e.size) + ' b)'; } catch {}
      out.push('  '.repeat(depth) + e.name + size);
    }
  }
}

async function searchIn(dir, regex, searchContent, out, budget) {
  if (out.length >= budget.count || budget.files >= 20000) return;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= budget.count || budget.files >= 20000) return;
    if (['node_modules', '.git', 'AppData'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { await searchIn(full, regex, searchContent, out, budget); continue; }
    budget.files++;
    if (regex.test(e.name)) out.push(`NOMBRE: ${full}`);
    if (!searchContent || out.length >= budget.count) continue;
    try {
      const st = await fsp.stat(full);
      if (st.size > 512 * 1024) continue;
      const buf = Buffer.alloc(8192);
      const fd = await fsp.open(full, 'r');
      const { bytesRead } = await fd.read(buf, 0, 8192, 0);
      await fd.close();
      if (buf.subarray(0, bytesRead).includes(0)) continue;
      const text = await fsp.readFile(full, 'utf8');
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) { out.push(`${full}:${i + 1}: ${clip(lines[i].trim(), 200)}`); if (out.length >= budget.count) break; }
      }
    } catch {}
  }
}

// ---- Main dispatcher ----------------------------------------------------

async function executeTool(name, args, ctx) {
  const { emit, screenshotFn, browser, settings, home, workspace } = ctx;
  // rutas relativas y vacías resuelven en el ESPACIO DE TRABAJO (no en el home):
  // así "crea un informe.md" aterriza en la carpeta del usuario sin rutas absolutas
  const inWs = (p) => {
    if (!p || p === '.' || p === './') return workspace;
    if (/^~(?=\/|\\|$)/.test(p)) return p.replace(/^~/, home);
    return path.isAbsolute(p) ? p : path.join(workspace, p);
  };
  switch (name) {
    case 'remember': {
      const m = memory.add({
        text: args.text,
        source: 'agent',
        importance: Number.isFinite(Number(args.importance)) ? Number(args.importance) : 0.6,
        confidence: Number.isFinite(Number(args.confidence)) ? Number(args.confidence) : 0.8,
      });
      return m ? `OK: recuerdo guardado (importancia ${m.importance}). Estará disponible en conversaciones futuras.` : 'Error: no pude guardar el recuerdo (texto vacío).';
    }
    case 'use_skill': {
      const s = await skills.getSkill(args.name || '');
      if (!s) return `Error: skill "${args.name}" no encontrada. Skills disponibles: ${(await skills.listSkills()).filter(x => x.enabled).map(x => x.name).join(', ') || '(ninguna)'}`;
      // límite declarado de herramientas (informativo para el agente; los permisos reales los decide el usuario en Ajustes)
      const scope = s.allowTools ? `\n\nHERRAMIENTAS AUTORIZADAS POR ESTA SKILL: ${s.allowTools}. Evita usar otras salvo necesidad justificada.` : '';
      return `# Skill: ${s.name}\n\n${s.body}${scope}`;
    }
    case 'run_command': {
      const timeout = Math.min(Math.max(args.timeout_seconds || 60, 5), 300) * 1000;
      // chcp 65001 fuerza UTF-8 en cmd.exe para que los acentos no lleguen corruptos
      const r = await run(`chcp 65001>nul & ${args.command}`, { cwd: args.cwd ? inWs(args.cwd) : workspace, timeout, registerKillable: ctx.registerKillable });
      return `exit=${r.code}\nSTDOUT:\n${clip(r.stdout)}\nSTDERR:\n${clip(r.stderr, 3000)}`;
    }
    case 'read_file': {
      const p = inWs(args.path);
      let st;
      try { st = await fsp.stat(p); }
      catch (e) { return `Error: no pude leer ${p} (${e.code || e.message}).`; }
      if (!st.isFile()) return `Error: ${p} no es un archivo.`;
      // rechaza archivos enormes antes de cargarlos enteros en memoria
      if (st.size > 32 * 1024 * 1024) return `Error: archivo demasiado grande (${(st.size / 1048576).toFixed(1)} MB; el límite es 32 MB).`;
      const buf = await fsp.readFile(p);
      if (buf.subarray(0, 8192).includes(0)) return 'Error: archivo binario (no legible como texto).';
      const text = buf.toString('utf8');
      if (args.offset === undefined && args.limit === undefined) return clip(text, 60000);
      const lines = text.split(/\r?\n/);
      const total = lines.length;
      const start = Math.min(Math.max(Number(args.offset) || 1, 1), total);
      const limit = Math.min(Math.max(Number(args.limit) || 2000, 1), 2000);
      const end = Math.min(start + limit - 1, total);
      const rest = end < total ? `\n...[quedan ${total - end} líneas; continúa con offset: ${end + 1}]` : '';
      return clip(`[líneas ${start}-${end} de ${total}]\n${lines.slice(start - 1, end).join('\n')}${rest}`, 60000);
    }
    case 'write_file': {
      const p = inWs(args.path);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, args.content, 'utf8');
      return `OK: ${args.content.length} bytes escritos en ${p}`;
    }
    case 'edit_file': {
      const p = inWs(args.path);
      const oldStr = String(args.old_string ?? '');
      const newStr = String(args.new_string ?? '');
      if (!oldStr) return 'Error: old_string es obligatorio y no puede estar vacío.';
      let buf;
      try { buf = await fsp.readFile(p); }
      catch (e) { return `Error: no pude leer ${p} (${e.code === 'ENOENT' ? 'no existe; para crear el archivo usa write_file' : (e.code || e.message)}).`; }
      if (buf.subarray(0, 8192).includes(0)) return `Error: ${p} es binario (no editable como texto).`;
      const text = buf.toString('utf8');
      const count = text.split(oldStr).length - 1;
      if (count === 0) return `Error: old_string no encontrado en ${p}. Copia el texto exacto con read_file (respeta espacios y saltos de línea).`;
      if (count > 1 && !args.replace_all) return `Error: old_string aparece ${count} veces en ${p}; incluye más contexto para que sea único o usa replace_all: true.`;
      // la función evita que un `$&`/`$1` dentro del texto nuevo se interprete
      // como patrón de reemplazo (el modelo edita código, no plantillas)
      const replaced = args.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr);
      await fsp.writeFile(p, replaced, 'utf8');
      return `OK: ${args.replace_all ? count : 1} reemplazo(s) en ${p}`;
    }
    case 'list_dir': {
      const root = inWs(args.path);
      const out = [];
      const budget = { count: 500 };
      await walk(root, 0, Math.min(Math.max(args.depth || 2, 1), 4), out, budget);
      return out.join('\n') || '(directorio vacío)';
    }
    case 'search_files': {
      const root = inWs(args.path);
      let regex;
      try { regex = new RegExp(args.pattern, 'i'); }
      catch { return 'Error: patrón de búsqueda inválido (no es una expresión regular válida). Simplifícalo: "informe", "config.*json", "function\\s+nombre"…'; }
      const out = [];
      const budget = { count: 60, files: 0 };
      await searchIn(root, regex, args.search_content !== false, out, budget);
      return out.length ? out.join('\n') : 'Sin resultados.';
    }
    case 'open_app': {
      // `start` se ejecuta dentro de cmd.exe: rechazamos metacaracteres para evitar inyección de shell
      const n = String(args.name ?? '');
      if (!n.trim()) return 'Error: falta el nombre de la aplicación.';
      if (/["&|^<>%\r\n]/.test(n)) return 'Error: el nombre de la aplicación no puede contener comillas ni metacaracteres de cmd (" & | ^ < > %) ni saltos de línea.';
      const r = await run(`start "" "${n}"`, { timeout: 15000 });
      return r.code === 0 ? `OK: intentando abrir "${n}"` : `Error: ${r.stderr}`;
    }
    case 'open_url': {
      const { shell } = require('electron');
      await shell.openExternal(args.url);
      return `OK: ${args.url} abierta en el navegador por defecto`;
    }
    case 'browser_control':
      return browser.handle(args);
    case 'screenshot': {
      const shot = await screenshotFn();
      emit({ type: 'image', role: 'tool', dataUrl: shot.dataUrl });
      return { text: `Captura de pantalla tomada (${shot.w}x${shot.h}). Analízala junto a este resultado.`, images: [shot.dataUrl] };
    }
    case 'clipboard': {
      const { clipboard } = require('electron');
      if (args.action === 'write') { clipboard.writeText(args.text || ''); return 'OK: portapapeles actualizado'; }
      return clip(clipboard.readText() || '(vacío)', 4000);
    }
    case 'notify': {
      const { Notification } = require('electron');
      if (Notification.isSupported()) new Notification({ title: args.title || 'SAGITARI', body: args.message || '' }).show();
      emit({ type: 'toast', title: args.title, message: args.message });
      return 'OK';
    }
    case 'media_control': {
      const vk = MEDIA_KEYS[args.action];
      if (!vk) return 'Acción desconocida';
      await sendVK(vk);
      return `OK: ${args.action}`;
    }
    case 'window_manage': {
      const cmd = args.action === 'show_desktop'
        ? `powershell -NoProfile -Command "(New-Object -ComObject Shell.Application).ToggleDesktop()"`
        : `powershell -NoProfile -Command "(New-Object -ComObject Shell.Application).MinimizeAll()"`;
      await run(cmd, { timeout: 15000 });
      return `OK: ${args.action}`;
    }
    case 'system_info': {
      const nets = os.networkInterfaces();
      const ips = Object.values(nets).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
      const total = os.totalmem(), free = os.freemem();
      return [
        `SO: ${os.type()} ${os.release()} (${os.arch()})`,
        `Host: ${os.hostname()} | Usuario: ${os.userInfo().username}`,
        `CPU: ${os.cpus()[0]?.model} x${os.cpus().length}`,
        `RAM: ${(total / 1e9).toFixed(1)} GB total, ${(free / 1e9).toFixed(1)} GB libres`,
        `Uptime: ${(os.uptime() / 3600).toFixed(1)} h`,
        `IPs: ${ips.join(', ') || 'ninguna'}`,
        `Escritorio: ${path.join(home, 'Desktop')}`
      ].join('\n');
    }
    default:
      return `Error: herramienta desconocida "${name}"`;
  }
}

module.exports = { executeTool };
