'use strict';

/* Perfiles de navegador de SAGITARI (v1.5): cada perfil tiene SU propia carpeta
   de datos (cookies, sesiones, logins) bajo %APPDATA%/SagitariAI/browser-profiles.
   Módulo puro, sin dependencias → testeable sin Electron ni ws. */

const path = require('path');
const fs = require('fs');

const PROFILE_BASE_DEFAULT = path.join(require('./datadir').dataDir(), 'browser-profiles');
let PROFILE_BASE = PROFILE_BASE_DEFAULT;

/* FNV-1a de 32 bits: hash corto, estable y sin dependencias. */
function shortHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

/** Id canónico del perfil: slug legible + hash del nombre ORIGINAL. El hash evita
    que nombres distintos («mi perfil» vs «mi_perfil», o prefijos largos truncados)
    colapsen al mismo id y compartan --user-data-dir. */
function profileId(profile) {
  const raw = String(profile || 'default');
  const slug = raw.toLowerCase().replace(/[^\w.-]+/g, '_').slice(0, 32) || 'default';
  return `${slug}-${shortHash(raw)}`;
}

/** Carpeta de datos asociada al perfil. */
function profileDirFor(profile) {
  return path.join(PROFILE_BASE, profileId(profile));
}

/* Nombre de carpeta que usaban las versiones anteriores al hash. */
function legacyDirFor(profile) {
  return path.join(PROFILE_BASE, String(profile || 'default').toLowerCase().replace(/[^\w.-]+/g, '_').slice(0, 40) || 'default');
}

/**
 * Carpeta de datos del perfil, migrando de una sola vez la carpeta antigua (sin
 * hash) a la nueva: si no, al actualizar se perderían las cookies y los logins
 * que el usuario tenía guardados en ese perfil.
 */
function ensureProfileDir(profile) {
  const dir = profileDirFor(profile);
  const legacy = legacyDirFor(profile);
  if (legacy !== dir) {
    try {
      if (fs.existsSync(legacy) && !fs.existsSync(dir)) fs.renameSync(legacy, dir);
    } catch {}
  }
  return dir;
}

module.exports = { PROFILE_BASE, profileDirFor, profileId, ensureProfileDir, legacyDirFor, __test: { _resetForTests: (dir) => { PROFILE_BASE = dir || PROFILE_BASE_DEFAULT; } } };
