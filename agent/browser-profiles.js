'use strict';

/* Perfiles de navegador de SAGITARI (v1.5): cada perfil tiene SU propia carpeta
   de datos (cookies, sesiones, logins) bajo %APPDATA%/SagitariAI/browser-profiles.
   Módulo puro, sin dependencias → testeable sin Electron ni ws. */

const path = require('path');

const PROFILE_BASE = path.join(process.env.APPDATA || require('os').homedir(), 'SagitariAI', 'browser-profiles');

/** Nombre de perfil saneado + carpeta de datos asociada. */
function profileDirFor(profile) {
  const id = String(profile || 'default').toLowerCase().replace(/[^\w.-]+/g, '_').slice(0, 40) || 'default';
  return path.join(PROFILE_BASE, id);
}

function profileId(profile) {
  return String(profile || 'default').toLowerCase().replace(/[^\w.-]+/g, '_').slice(0, 40) || 'default';
}

module.exports = { PROFILE_BASE, profileDirFor, profileId };
