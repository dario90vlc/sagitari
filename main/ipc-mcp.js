'use strict';

/* ipc-mcp.js — router IPC del dominio MCP (servidores Model Context Protocol).
 *
 * Fase 4 (sigue el patrón de ipc-memory.js / ipc-skills.js): los 10 handlers
 * `mcp:*` viven aquí. Todo lo que tocan de main.js viaja en `ctx`:
 *   - config: el objeto de configuración vivo (se muta: servers, enabled, permisos)
 *   - wireMcp(): devuelve el McpManager (lo crea/conecta si hace falta)
 *   - persistConfig(): guarda config en disco, devuelve { ok, error }
 *   - mcpState(): vista para la UI (con secretos enmascarados)
 *   - mcpExport(): vista de exportación (con secretos en claro, la UI avisa)
 *   - setAgentPolicy(sec): aplica la política de seguridad al agente vivo (o no-op)
 *   - mcpConfig, serverSlug: utilidades puras (validación, ids)
 */

function registerMcpIpc(ipcMain, ctx) {
  // config es un getter (() => config de main): el objeto es único y vivo,
  // se lee fresco en cada handler para no capturar una foto vieja.
  const cfg = () => (typeof ctx.config === 'function' ? ctx.config() : ctx.config);
  const { wireMcp, persistConfig, mcpState, mcpExport, setAgentPolicy, mcpConfig, serverSlug } = ctx;

  ipcMain.handle('mcp:list', () => mcpState());

  ipcMain.handle('mcp:save', (e, raw) => {
    const config = cfg();
    const payload = raw && typeof raw === 'object' ? raw : {};
    const v = mcpConfig.validateServer(payload);
    if (!v.ok) return { ok: false, error: v.error };
    const server = v.value;
    // el formulario no reenvía los secretos: un valor vacío conserva el guardado
    const previo = (config.mcp.servers || []).find(s => s.id === server.id);
    if (previo) {
      server.env = mcpConfig.mergeSecrets(previo.env, server.env);
      server.headers = mcpConfig.mergeSecrets(previo.headers, server.headers);
      // El formulario no reenvía estos campos: se conservan del servidor guardado para
      // que editar no reactive un servidor apagado ni pierda autoStart/timeout/cwd.
      if (payload.enabled === undefined) server.enabled = previo.enabled !== false;
      if (payload.autoStart === undefined) server.autoStart = previo.autoStart === true;
      if (payload.timeoutMs === undefined) server.timeoutMs = previo.timeoutMs;
      if (payload.cwd === undefined && server.transport === 'stdio') server.cwd = previo.cwd || '';
    }
    config.mcp.servers = [...(config.mcp.servers || []).filter(s => s.id !== server.id), server];
    wireMcp();
    const r = persistConfig();
    // el id saneado y su comodín de permisos viajan de vuelta: la UI necesita el comodín
    // ya normalizado (el id crudo no vale para `mcp__<id>__*` si trae guiones)
    return r.ok
      ? { ok: true, id: server.id, permKey: 'mcp__' + serverSlug(server.id) + '__*', servers: mcpState().servers }
      : { ok: false, error: r.error };
  });

  ipcMain.handle('mcp:delete', (e, id) => {
    const config = cfg();
    const sid = mcpConfig.rawId(id);
    config.mcp.servers = (config.mcp.servers || []).filter(s => s.id !== sid);
    // los permisos de un servidor borrado quedarían huérfanos (y si vuelve, con
    // los niveles de antes, que el usuario ya no ve en ningún sitio). Las claves se
    // buscan con el slug del nombre expuesto, NO con el id crudo: si no, un id con
    // guion o de más de 16 caracteres dejaría sus permisos ahí para siempre.
    const prefijo = 'mcp__' + serverSlug(sid) + '__';
    for (const k of Object.keys(config.security.permissions || {})) {
      if (k.startsWith(prefijo)) delete config.security.permissions[k];   // cubre `mcp__<slug>__*` y cada `mcp__<slug>__<tool>`
    }
    setAgentPolicy(config.security);
    wireMcp();
    // Si el disco falla, el servidor NO está borrado: decirlo ahora evita que el panel
    // cante «eliminado» y el servidor vuelva a estar ahí al reiniciar.
    const r = persistConfig();
    return r.ok ? { ok: true, servers: mcpState().servers } : { ok: false, error: r.error };
  });

  ipcMain.handle('mcp:toggle', (e, { id, enabled }) => {
    const config = cfg();
    const sid = mcpConfig.rawId(id);
    const s = (config.mcp.servers || []).find(x => x.id === sid);
    if (!s) return { ok: false, error: 'servidor MCP desconocido' };
    s.enabled = enabled !== false;
    // reconfigure aplica el cambio: apagado suelta el proceso y deja de ofrecer herramientas
    wireMcp();
    // activar una fila debe dejarla lista, no solo marcar la bandera
    if (config.mcp.enabled !== false && s.enabled) wireMcp().ensure(s.id).catch(() => {});
    const r = persistConfig();
    return r.ok ? { ok: true, servers: mcpState().servers } : { ok: false, error: r.error };
  });

  ipcMain.handle('mcp:setGlobal', (e, enabled) => {
    const config = cfg();
    config.mcp.enabled = enabled !== false;
    const m = wireMcp();
    // Al reencender el interruptor hay que reconectar lo que el arranque no arrancó:
    // sin esto los servidores autoStart se quedan en 'idle' y MCP no aporta nada.
    if (config.mcp.enabled) for (const s of config.mcp.servers || []) if (s.autoStart && s.enabled) m.ensure(s.id).catch(() => {});
    return persistConfig();
  });

  ipcMain.handle('mcp:refresh', async (e, id) => {
    const sid = mcpConfig.rawId(id);
    const r = await wireMcp().ensure(sid);
    return { ok: r.ok, error: r.error || null, server: mcpState().servers.find(s => s.id === sid) };
  });

  ipcMain.handle('mcp:test', async (e, id) => {
    const sid = mcpConfig.rawId(id);
    const r = await wireMcp().ensure(sid);
    return { ok: r.ok, error: r.error || null, server: mcpState().servers.find(s => s.id === sid) };
  });

  ipcMain.handle('mcp:log', (e, id) => {
    const s = mcpState().servers.find(x => x.id === mcpConfig.rawId(id));
    return { ok: !!s, log: (s && s.logTail) || '', error: (s && s.error) || null };
  });

  ipcMain.handle('mcp:export', () => ({ ok: true, json: JSON.stringify(mcpExport(), null, 2) }));

  ipcMain.handle('mcp:import', (e, json) => {
    const config = cfg();
    // NO escribe: devuelve la vista previa con conflictos para que el usuario confirme
    const r = mcpConfig.parseMcpImport(String(json || ''));
    if (!r.ok) return r;
    const existentes = new Set((config.mcp.servers || []).map(s => s.id));
    return { ok: true, servers: r.servers.map(s => ({ ...s, conflict: existentes.has(s.id) })) };
  });
}

module.exports = { registerMcpIpc };
