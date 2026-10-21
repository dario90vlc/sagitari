'use strict';
/* Runner de la suite SAGITARI (Node, sin Electron).
   Usage: node test/run.js   (exit code 0 = all green)
   Los ayudantes (test/eq/ok, cola QUEUE, fakes SSE, esperas, cierre runAll)
   viven en ./helpers.js; el entorno compartido en ./comun.js; los tests en
   10-nucleo, 20-chat, 30-sistema, 40-agente y los bloques de hardening
   (42-guardarrailes, 43-sistema-hardening, 45-todos) se cargan en este orden. */

(async () => {
  const { runAll } = require('./comun');
  require('./10-nucleo');
  require('./20-chat');
  require('./30-sistema');
  require('./40-agente');
  require('./42-guardarrailes');
  require('./43-sistema-hardening');
  require('./45-todos');
  require('./46-publicacion');
  await runAll();
})();
