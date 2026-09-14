'use strict';

const { exec } = require('child_process');

// En Windows, matar el hijo directo deja nietos huérfanos: taskkill /T /F elimina
// todo el árbol de procesos. Se usa tanto al pulsar Detener como al expirar el
// timeout. OJO: taskkill se lanza con el padre AÚN VIVO (el child.kill() va en su
// callback) porque si el hijo muere antes, taskkill no encuentra el árbol y los
// nietos quedan huérfanos. Vive aquí porque el transporte stdio de MCP también
// necesita matar el árbol de un servidor: una sola implementación.
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

module.exports = { killTree };
