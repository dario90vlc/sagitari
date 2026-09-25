'use strict';
/* Runner de la suite SAGITARI (Node, sin Electron).
   Usage: node test/run.js   (exit code 0 = all green)
   Los ayudantes (test/eq/ok, cola QUEUE, fakes SSE, esperas, cierre runAll)
   viven en ./helpers.js; el entorno compartido en ./comun.js; los tests en
   10-nucleo, 20-chat, 30-sistema y 40-agente (se cargan en este orden). */

(async () => {
  const { runAll } = require('./comun');
  require('./10-nucleo');
  require('./20-chat');
  require('./30-sistema');
  require('./40-agente');
  require('./45-todos');
  await runAll();
})();
