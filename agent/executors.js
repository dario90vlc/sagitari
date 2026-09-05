'use strict';

const { exec } = require('child_process');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const skills = require('./skills');

function run(cmd, opts = {}) {
  return new Promise((resolve) => {
    const child = exec(cmd, { windowsHide: true, timeout: opts.timeout || 60000, maxBuffer: 4 * 1024 * 1024, cwd: opts.cwd, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: (stdout || '').toString(), stderr: (stderr || (err && err.message) || '').toString() });
    });
    // el agente puede matar el comando al pulsar Detener
    if (opts.registerKillable) opts.registerKillable({ stop: () => { try { child.kill(); } catch {} } });
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
    case 'use_skill': {
      const s = await skills.getSkill(args.name || '');
      if (!s) return `Error: skill "${args.name}" no encontrada. Skills disponibles: ${(await skills.listSkills()).filter(x => x.enabled).map(x => x.name).join(', ') || '(ninguna)'}`;
      // límite declarado de herramientas (informativo para el agente; los permisos reales los decide el usuario en Ajustes)
      const scope = s.allowTools ? `\n\nHERRAMIENTAS AUTORIZADAS POR ESTA SKILL: ${s.allowTools}. Evita usar otras salvo necesidad justificada.` : '';
      return `# Skill: ${s.name}\n\n${s.body}${scope}`;
    }
    case 'run_command': {
      const timeout = Math.min(Math.max(args.timeout_seconds || 60, 5), 300) * 1000;
      const r = await run(args.command, { cwd: args.cwd ? inWs(args.cwd) : workspace, timeout, registerKillable: ctx.registerKillable });
      return `exit=${r.code}\nSTDOUT:\n${clip(r.stdout)}\nSTDERR:\n${clip(r.stderr, 3000)}`;
    }
    case 'read_file': {
      const p = inWs(args.path);
      const buf = await fsp.readFile(p);
      if (buf.subarray(0, 8192).includes(0)) return 'Error: archivo binario (no legible como texto).';
      return clip(buf.toString('utf8'), 60000);
    }
    case 'write_file': {
      const p = inWs(args.path);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, args.content, 'utf8');
      return `OK: ${args.content.length} bytes escritos en ${p}`;
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
      const r = await run(`start "" "${args.name}"`, { timeout: 15000 });
      return r.code === 0 ? `OK: intentando abrir "${args.name}"` : `Error: ${r.stderr}`;
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
