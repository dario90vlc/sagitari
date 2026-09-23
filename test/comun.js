'use strict';
/* Entorno compartido de la suite (antes líneas 1-3463 de run.js):
   ayudantes ./helpers, almacenes aislados en tmp y módulos que varios
   bloques usan. Los bloques 10-40 lo requieren y se cargan en orden. */

const { fs, path, os, TMP_DIRS, tmpDir, QUEUE, test, eq, ok,
  SUITE_TIMEOUT_MS, suiteTimer, wait, waitFor,
  sseResponse, fakeFetch, evData, evNamed, noSignal,
  sseTurn, toolTurn, autoApprove, SETTINGS_BASE, sseRota, runAll } = require('./helpers');
const { Guardrails, describeAction, summarizeArgs } = require('../agent/guardrails');
const skills = require('../agent/skills');
const { pricingFor } = require('../agent/guardrails');
const memory = require('../agent/memory');
const MEM_DIR = tmpDir('sagi-mem-');
memory.__test._resetForTests(path.join(MEM_DIR, 'memory.json'));
const checkpoints = require('../agent/checkpoints');
const TASKS_TMP = tmpDir('sagi-tasks-');
checkpoints.__test._resetForTests(TASKS_TMP);
const { executeTool } = require('../agent/executors');
const subagents = require('../agent/subagents');
const modelsMod = require('../agent/models');
const HEALTH_TMP = tmpDir('sagi-health-');
modelsMod._resetForTests(path.join(HEALTH_TMP, 'health.json'));
const SKILLS_TMP = tmpDir('sagi-skills-');
skills.__test._resetForTests(SKILLS_TMP);   // redirige el almacén para los tests
const { spawnSync } = require('child_process');
const habits = require('../agent/habits');
const HABITS_TMP = tmpDir('sagi-habits-');
habits.__test._resetForTests(path.join(HABITS_TMP, 'habits.json'));
const opencode = require('../agent/opencode');
const protocols = require('../agent/protocols');
const ChatKit = require('../renderer/chatkit');
const MAIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8');
const MAIN_ALL = fs.readdirSync(path.join(__dirname, '..', 'main')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(__dirname, '..', 'main', f), 'utf8')).join('\n');
const ico = require('../scripts/ico');
const updater = require('../main/updater');
const { Browser } = require('../agent/browser');
const profiles = require('../agent/browser-profiles');
const runlog = require('../agent/runlog');
const PROF_TMP = tmpDir('sagi-profiles-');
profiles.__test._resetForTests(PROF_TMP);   // nunca escribir en %APPDATA% real
const toolCall = (name, args) => ({ id: 't1', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args || {}) } });
// renderer partido (10-chat/20-voz/30-ajustes/40-vistas): el JS de la UI como un todo.
const RENDERER_JS = ['10-chat.js', '20-voz.js', '30-ajustes.js', '40-vistas.js'];
const readRenderer = () => RENDERER_JS.map((f) => fs.readFileSync(path.join(__dirname, '..', 'renderer', f), 'utf8')).join('\n');

module.exports = { fs, path, os, TMP_DIRS, tmpDir, QUEUE, test, eq, ok,
  SUITE_TIMEOUT_MS, suiteTimer, wait, waitFor, sseResponse, fakeFetch, evData,
  evNamed, noSignal, sseTurn, toolTurn, autoApprove, SETTINGS_BASE, sseRota, runAll,
  Guardrails, describeAction, summarizeArgs, skills, pricingFor, memory, MEM_DIR,
  checkpoints, TASKS_TMP, executeTool, subagents, modelsMod, HEALTH_TMP, SKILLS_TMP,
  spawnSync, habits, HABITS_TMP, opencode, protocols, ChatKit, MAIN_SRC, MAIN_ALL,
  ico, updater, Browser, profiles, runlog, PROF_TMP, toolCall, RENDERER_JS, readRenderer };
