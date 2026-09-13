'use strict';

/* Raíz de datos de SAGITARI — ÚNICA fuente para los módulos del agente.
 *
 * Cada módulo calculaba su ruta por su cuenta con «SagitariAI» escrito a mano, así
 * que los arranques de prueba (--smoke/--hidden/--test) aislaban la configuración
 * pero seguían escribiendo en los skills, logs, memoria, hábitos, checkpoints y
 * salud de modelos REALES del usuario. Con un único sitio no se puede olvidar
 * ninguno: main.js fija SAGITARI_DATA_DIR antes de cargar estos módulos.
 */

const path = require('path');
const os = require('os');

function dataDir() {
  return process.env.SAGITARI_DATA_DIR || path.join(process.env.APPDATA || os.homedir(), 'SagitariAI');
}

module.exports = { dataDir };
