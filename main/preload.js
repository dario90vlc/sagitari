const { contextBridge, ipcRenderer, webUtils } = require('electron');

/* Idioma resuelto por main y pasado como argumento del renderer: sin canal IPC nuevo y
   disponible antes de que el renderer cargue (window.sagitari.idioma). */
const idiomaUI = (process.argv.find((a) => a.startsWith('--sag-idioma=')) || '').split('=')[1] === 'en' ? 'en' : 'es';

/* Suscripción con baja. Cada on* devuelve la función que la cancela: sin ella,
   volver a llamar a un on* (reinit del renderer, recableado de estado) dejaba
   dos listeners vivos y el mismo evento se atendía dos veces. */
const on = (channel, make) => (cb) => {
  const h = (e, ...args) => cb(...make(args));
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('sagitari', {
  // Idioma de la interfaz ('es'|'en') tal como lo resolvió main al arrancar.
  idioma: idiomaUI,
  // Electron ≥32 eliminó File.path: la ruta real de un archivo soltado/pegado
  // sólo se obtiene por aquí (compatible con sandbox: true)
  filePath: (file) => webUtils.getPathForFile(file),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveProvider: (p) => ipcRenderer.invoke('provider:save', p),
  deleteProvider: (id) => ipcRenderer.invoke('provider:delete', id),
  /* `opts` (format/providerId/model) es opcional y viaja a main para que la detección
     use el protocolo elegido: las llamadas de dos argumentos de siempre siguen valiendo. */
  listModels: (baseUrl, apiKey, opts) => ipcRenderer.invoke('provider:models', { baseUrl, apiKey, ...(opts || {}) }),
  activateProvider: (cfg) => ipcRenderer.invoke('provider:activate', cfg),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  /* El primer argumento de todo lo que trabaja POR conversación es su id (convId):
     con varias conversaciones abiertas a la vez, el proceso principal no puede
     adivinar a cuál se refiere la llamada (mandar un mensaje, detener, deshacer…).
     Si no llega (llamadas de antes), main usa la conversación abierta. */
  sendChat: (convId, text, imageDataUrl, attachments) => ipcRenderer.invoke('chat:send', { convId, text, imageDataUrl, attachments }),
  attachmentsPick: () => ipcRenderer.invoke('attachments:pick'),
  attachmentsRead: (p) => ipcRenderer.invoke('attachments:read', p),
  stopChat: (convId) => ipcRenderer.invoke('chat:stop', convId),
  retryChat: (convId) => ipcRenderer.invoke('chat:retry', convId),
  /* Órdenes de barra (/compact, /cost): el renderer las reconoce y NO las manda como
     mensaje; las que necesitan el proceso principal entran por aquí. */
  chatCommand: (convId, name, args) => ipcRenderer.invoke('chat:command', { convId, name, args }),
  glow: (mode, color) => ipcRenderer.send('glow:set', { mode, color }),
  onAgentEvent: on('agent:event', ([ev]) => [ev]),
  onGlow: on('glow:set', ([v]) => [v]),
  onThemeChanged: on('theme:changed', ([v]) => [v]),
  quit: () => ipcRenderer.invoke('app:quit'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  minimize: () => ipcRenderer.invoke('app:minimize'),
  maximize: () => ipcRenderer.invoke('app:maximize'),
  onWinState: on('win:maximized', ([v]) => [v]),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
  pickFolder: () => ipcRenderer.invoke('shell:pickFolder'),
  workspaceGet: () => ipcRenderer.invoke('workspace:get'),
  workspaceSet: (dir) => ipcRenderer.invoke('workspace:set', dir),
  workspacePick: () => ipcRenderer.invoke('workspace:pick'),
  memoryList: () => ipcRenderer.invoke('memory:list'),
  memoryAdd: (text, importance) => ipcRenderer.invoke('memory:add', { text, importance }),
  memoryUpdate: (id, patch) => ipcRenderer.invoke('memory:update', { id, patch }),
  memoryRemove: (id) => ipcRenderer.invoke('memory:remove', id),
  /* Memoria v2 — bandeja de aprobación («Recién aprendido»): las propuestas de hechos
     que aún no se han guardado. Aceptar consolida (fusiona si ya se sabía algo parecido). */
  memoryTrayList: () => ipcRenderer.invoke('memory:tray:list'),
  memoryTrayAccept: (id) => ipcRenderer.invoke('memory:tray:accept', { id }),
  memoryTrayDiscard: (id) => ipcRenderer.invoke('memory:tray:discard', { id }),
  /* Papelera: lo olvidado, recuperable 30 días. */
  memoryTrashList: () => ipcRenderer.invoke('memory:trash:list'),
  memoryTrashRestore: (id) => ipcRenderer.invoke('memory:trash:restore', { id }),
  memoryTrashEmpty: () => ipcRenderer.invoke('memory:trash:empty'),
  /* Exportar (JSON legible), olvidarlo todo y recuperar la copia si el almacén no se pudo leer. */
  memoryExport: () => ipcRenderer.invoke('memory:export'),
  memoryWipe: () => ipcRenderer.invoke('memory:wipe'),
  memoryRestoreBackup: () => ipcRenderer.invoke('memory:restore-backup'),
  /* Olvidar una categoría de hábitos (herramientas, webs, modos, permisos; 'todo' = el perfil entero). */
  habitsForget: (categoria) => ipcRenderer.invoke('habits:forget', { categoria }),
  /* Aviso en vivo de que la extracción ha dejado una propuesta nueva en la bandeja. */
  onMemoriaNueva: on('memory:nueva', ([p]) => [p]),
  tasksList: () => ipcRenderer.invoke('tasks:list'),
  taskEnqueue: (data) => ipcRenderer.invoke('tasks:enqueue', data),
  taskPause: (runId) => ipcRenderer.invoke('tasks:pause', runId),
  taskResume: (runId) => ipcRenderer.invoke('tasks:resume', runId),
  taskCancel: (runId) => ipcRenderer.invoke('tasks:cancel', runId),
  taskRemove: (runId) => ipcRenderer.invoke('tasks:remove', runId),
  pauseChat: (convId) => ipcRenderer.invoke('chat:pause', convId),
  skillsList: () => ipcRenderer.invoke('skills:list'),
  skillsToggle: (id, enabled) => ipcRenderer.invoke('skills:toggle', { id, enabled }),
  skillsImport: (repo, opts) => ipcRenderer.invoke('skills:import', opts && typeof opts === 'object' ? { repo, ...opts } : repo),
  skillsCreate: (data) => ipcRenderer.invoke('skills:create', data),
  skillsDelete: (id) => ipcRenderer.invoke('skills:delete', id),
  skillsSearch: (q) => ipcRenderer.invoke('skills:search', q),
  skillsUpdate: (id) => ipcRenderer.invoke('skills:update', id),
  skillsUpdateAll: () => ipcRenderer.invoke('skills:updateAll'),
  marketCatalog: () => ipcRenderer.invoke('market:catalog'),
  marketSearch: (q) => ipcRenderer.invoke('market:search', q),
  healthGet: () => ipcRenderer.invoke('health:get'),
  habitsGet: () => ipcRenderer.invoke('habits:get'),
  habitsReset: () => ipcRenderer.invoke('habits:reset'),
  skillsRead: (id) => ipcRenderer.invoke('skills:read', id),
  skillsOpenFolder: () => ipcRenderer.invoke('skills:openFolder'),
  convList: () => ipcRenderer.invoke('conv:list'),
  convNew: () => ipcRenderer.invoke('conv:new'),
  convOpen: (id) => ipcRenderer.invoke('conv:open', id),
  convRename: (title) => ipcRenderer.invoke('conv:rename', title),
  convDel: (id) => ipcRenderer.invoke('conv:del', id),
  /* Bifurcar (copia con hilo propio) y rebobinar (volver el hilo a un punto). */
  convFork: (id) => ipcRenderer.invoke('conv:fork', id),
  convRebobinar: (id, index) => ipcRenderer.invoke('conv:rebobinar', { id, index }),
  setMode: (m) => ipcRenderer.invoke('mode:set', m),
  getAgentsLive: (convId) => ipcRenderer.invoke('agents:live', convId),
  /* Registro de agentes: los de serie y los que el usuario define en disco. */
  agentsCustom: () => ipcRenderer.invoke('agents:list'),
  agentsCustomRecargar: () => ipcRenderer.invoke('agents:reload'),
  secResolve: (convId, id, approved, runId) => ipcRenderer.invoke('sec:resolve', { convId, id, approved, runId }),
  secSetToolPerm: (tool, level) => ipcRenderer.invoke('sec:setToolPerm', { tool, level }),
  /* Atajo «permitir todo» / «volver a lo recomendado»: una sola escritura para
     todas las claves, en vez de N llamadas que reescribían el config N veces. */
  secSetToolPermMany: (tools, level) => ipcRenderer.invoke('sec:setToolPermMany', { tools, level }),
  secSetGuardrail: (patch) => ipcRenderer.invoke('sec:setGuardrail', patch),
  metaGet: (convId) => ipcRenderer.invoke('meta:get', convId),
  logsRecent: (n) => ipcRenderer.invoke('logs:recent', n),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: (opts) => ipcRenderer.invoke('update:install', opts || {}),
  updateRetry: (opts) => ipcRenderer.invoke('update:retry', opts || {}),
  undoChanges: (convId) => ipcRenderer.invoke('cambios:deshacer', convId),
  undoState: (convId) => ipcRenderer.invoke('cambios:estado', convId),
  /* Revisión del cambio: el diff estructurado del turno para el panel, y la vuelta
     atrás de UN archivo (no de todo el turno, que es `undoChanges`). Los tres van por
     conversación: los cambios de una pestaña no son los de otra. */
  cambiosDiff: (convId) => ipcRenderer.invoke('cambios:diff', convId),
  cambiosRevertir: (convId, archivo) => ipcRenderer.invoke('cambios:revertir', convId, archivo),
  instruccionesInfo: () => ipcRenderer.invoke('agent:instrucciones'),
  instruccionesCrear: () => ipcRenderer.invoke('agent:instrucciones-crear'),
  updatePage: () => ipcRenderer.invoke('update:page'),
  onUpdate: on('update:event', ([ev]) => [ev]),

  // ---- v3.1: servidores MCP del usuario ----
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  mcpSave: (server) => ipcRenderer.invoke('mcp:save', server),
  mcpDelete: (id) => ipcRenderer.invoke('mcp:delete', id),
  mcpToggle: (id, enabled) => ipcRenderer.invoke('mcp:toggle', { id, enabled }),
  mcpSetGlobal: (enabled) => ipcRenderer.invoke('mcp:setGlobal', enabled),
  mcpTest: (id) => ipcRenderer.invoke('mcp:test', id),
  mcpRefresh: (id) => ipcRenderer.invoke('mcp:refresh', id),
  mcpLog: (id) => ipcRenderer.invoke('mcp:log', id),
  mcpImport: (json) => ipcRenderer.invoke('mcp:import', json),
  mcpExport: () => ipcRenderer.invoke('mcp:export'),
});
