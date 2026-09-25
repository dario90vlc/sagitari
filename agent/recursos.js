'use strict';

/* ============================================================================
   recursos.js — el semáforo por recurso del equipo.

   Con varios subagentes trabajando a la vez (o varias herramientas del mismo
   mensaje en paralelo) hay cosas que NO se pueden compartir:

     · el NAVEGADOR es UNA instancia: dos agentes clicando a la vez se pisan la
       pestaña activa y el inventario de elementos (el clic de uno acaba donde
       apuntaba el otro).
     · el DISCO tiene una cola de ESCRITURA: dos write_file sobre el mismo
       archivo, o dos apply_patch mezclados, dejan el proyecto a medias.
     · la TERMINAL admite dos o tres comandos a la vez sin problema, pero no
       cien (y menos si son `npm install`).

   Lo que se comparte SOLO se serializa si de verdad hay conflicto: leer archivos
   no toma el turno de escritura, y quien no toca el navegador no espera por él.
   Así el paralelismo se nota en lo que sí se puede hacer a la vez.

   El orden de adquisición es CANÓNICO (alfabético) a propósito: si una tarea
   pidiera {disco, terminal} y otra {terminal, disco} en su orden natural, cada
   una podría quedarse con la mitad y las dos esperarían para siempre.
   ============================================================================ */

const LIMITES = {
  navegador: 1,     // una instancia, un clic a la vez
  disco: 1,         // una escritura a la vez
  terminal: 2,      // dos comandos a la vez: útil y sin ahogar el equipo
  escritorio: 1,    // capturas, ventanas, multimedia: acciones globales del sistema
  mcp: 2,           // servidores MCP del usuario: no se sabe si aguantan concurrencia
  general: 4,       // lo demás (memoria, skills, notificaciones…)
};

/* Herramienta → recursos que necesita. Lo que no toca nada compartido va vacío:
   así no se encola por gusto. */
const POR_HERRAMIENTA = {
  browser_control: ['navegador'],
  write_file: ['disco'], edit_file: ['disco'], apply_patch: ['disco'],
  run_command: ['terminal'],
  open_app: ['escritorio'], window_manage: ['escritorio'],
  media_control: ['escritorio'], screenshot: ['escritorio'], clipboard: ['escritorio'],
  delegate: [],
  read_file: [], view_image: [], list_dir: [], search_files: [],
  repo_map: [], find_symbol: [], content: [],
  remember: [], use_skill: [], system_info: [], notify: [], todo_write: [],
};

/** Recursos que necesita una llamada. MCP es un mundo aparte (herramientas del usuario). */
function paraHerramienta(name, args = {}) {
  const n = String(name || '');
  if (n in POR_HERRAMIENTA) return POR_HERRAMIENTA[n];
  if (n.startsWith('mcp__')) return ['mcp'];
  // Contenido web/lectura de una página no existe como herramienta aparte, pero
  // un MCP que navegue no se puede detectar: queda en 'general'.
  return ['general'];
}

class Recursos {
  constructor(limites = {}) {
    this.limites = { ...LIMITES, ...limites };
    this.enUso = new Map();     // recurso -> cuántos lo tienen
    this.esperas = [];          // [{ lista, resolve }] en orden de llegada (FIFO)
    this.concedidos = 0;        // contador de servicios prestados (para los tests y el panel)
  }

  configurar(limites = {}) {
    this.limites = { ...this.limites, ...limites };
    this._despertar();
  }

  /** ¿Cabría ahora esta lista (canónica) en el estado actual? */
  _cabe(lista) {
    return lista.every((n) => (this.enUso.get(n) || 0) < (this.limites[n] || 1));
  }

  _tomar(lista) {
    for (const n of lista) this.enUso.set(n, (this.enUso.get(n) || 0) + 1);
  }

  _soltar(lista) {
    for (const n of lista) {
      const v = (this.enUso.get(n) || 0) - 1;
      if (v <= 0) this.enUso.delete(n); else this.enUso.set(n, v);
    }
    this._despertar();
  }

  /** Reparte lo que quepa, en orden de llegada. */
  _despertar() {
    for (let i = 0; i < this.esperas.length; i++) {
      const w = this.esperas[i];
      if (!this._cabe(w.lista)) continue;
      this.esperas.splice(i, 1);
      i--;
      this._tomar(w.lista);
      this.concedidos++;
      w.resolve(() => this._soltar(w.lista));
    }
  }

  /**
   * Toma los recursos y devuelve la función para soltarlos. Si no hay hueco,
   * espera a que lo haya (sin bloquear nada: es una promesa).
   */
  async adquirir(nombres) {
    const lista = [...new Set((nombres || []).filter(Boolean))].sort();
    if (!lista.length) return () => {};
    if (this._cabe(lista)) {
      this._tomar(lista);
      this.concedidos++;
      return () => this._soltar(lista);
    }
    return new Promise((resolve) => { this.esperas.push({ lista, resolve }); this._despertar(); });
  }

  /** Ejecuta `fn` con los recursos tomados y los suelta pase lo que pase. */
  async con(nombres, fn) {
    const soltar = await this.adquirir(nombres);
    try { return await fn(); } finally { soltar(); }
  }

  /** Estado legible (panel de diagnóstico y tests). */
  estado() {
    return {
      enUso: Object.fromEntries(this.enUso),
      esperando: this.esperas.length,
      limites: { ...this.limites },
      concedidos: this.concedidos,
    };
  }

  _resetForTests() {
    this.enUso.clear();
    this.esperas = [];
    this.concedidos = 0;
  }
}

module.exports = {
  Recursos,
  LIMITES,
  POR_HERRAMIENTA,
  paraHerramienta,
  // Instancia única de la app: el navegador y el disco son de todos los agentes
  recursos: new Recursos(),
};
