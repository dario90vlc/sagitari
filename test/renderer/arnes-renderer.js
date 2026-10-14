'use strict';

/* Arnés compartido por las pruebas de las VISTAS del renderer que no son módulos puros
   (10-chat.js, 30-ajustes.js, 40-vistas.js): monta el markup REAL de index.html en jsdom
   y carga los scripts como <script> clásicos (como la app), con `window.sagitari`
   sustituido por puentes falsos que apuntan lo que reciben. Así una prueba puede pulsar
   los mismos botones y leer los mismos ids que ve el usuario en vez de reimplementar el
   flujo.

   Se cargan sólo los scripts que estas vistas necesitan: 20-app.js (el rail y los adornos
   de ventana) queda fuera a propósito — su arranque no aporta a estas pruebas y sí
   arrastra dependencias del proceso principal. `init()` de 40-vistas.js sí se ejecuta
   (es código del fichero que se prueba) contra los puentes falsos.

   Los scripts van inyectados como elementos <script> y no como `window.eval(...)`: un
   `let`/`const` de nivel superior en un eval vive en el ámbito del propio eval y no en el
   entorno léxico global, así que 30-ajustes.js no vería el `$` que define 10-chat.js.

   Sin spawn: bloqueado en el sandbox de Windows. Se ejecuta directo con node. */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const RAIZ = path.join(__dirname, '..', '..');
const leer = (f) => fs.readFileSync(path.join(RAIZ, 'renderer', f), 'utf8');

const HTML = leer('index.html');

/** El esc() real del renderer (idéntico al de 10-chat.js/30-ajustes.js). */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Configuración mínima con la forma que espera el renderer (`config:get`). */
function configBase(extra = {}) {
  return {
    providers: [],
    active: null,
    presets: [],
    settings: {},
    ...extra,
  };
}

/** Puentes falsos de `window.sagitari`: los canales declarados en `api` y, para
    cualquier otro, un resolvedor que apunta la llamada y devuelve una lista vacía (los
    canales del renderer devuelven listas: skills, tareas, conversaciones, catálogo…, y
    una lista vacía se deja recorrer sin romper el pintado). Los `on…` devuelven su
    función para desuscribirse, como los reales. */
function fakeSagitari(api, llamadas) {
  const declarados = { ...api };
  return new Proxy(declarados, {
    get(t, k) {
      if (typeof k !== 'string') return t[k];
      if (k in t) return t[k];
      if (/^on[A-Z]/.test(k)) return () => () => {};
      return (...args) => {
        llamadas.push({ canal: k, args });
        return Promise.resolve([]);
      };
    },
    has: () => true,
  });
}

/** Observers falsos para poder contar altas y bajas (jsdom no trae ResizeObserver). */
function observadoresFalsos(w) {
  const creados = [];
  class ResizeObserverFalso {
    constructor(cb) {
      this.cb = cb;
      this.targets = [];
      this.desconectado = false;
      creados.push(this);
    }
    observe(el) {
      this.targets.push(el);
    }
    unobserve(el) {
      this.targets = this.targets.filter((t) => t !== el);
    }
    disconnect() {
      // Como el de verdad: tras desconectar ya no observa nada.
      this.desconectado = true;
      this.targets = [];
    }
  }
  w.ResizeObserver = ResizeObserverFalso;
  return creados;
}

/**
 * Monta la app. Devuelve la ventana, helpers de consulta y los registros de llamadas.
 *
 * opts.api        — canales de window.sagitari (el resto son resolvedores vacíos)
 * opts.antesDeCargar — (window) => void, justo antes de inyectar los scripts: sirve
 *                   para instalar espías que el arranque de los propios guiones usa.
 */
function montar(opts = {}) {
  const erroresCarga = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => erroresCarga.push(e));
  const dom = new JSDOM(HTML, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const w = dom.window;
  const llamadas = [];
  const avisos = [];
  const toasts = [];

  w.esc = esc;
  w.showToast = (t) => avisos.push(String(t));
  w.toast = (t) => toasts.push(String(t));
  w.copyText = () => {};
  w.askConfirm = async () => true;
  w.sagitari = fakeSagitari(opts.api || {}, llamadas);

  const observadores = observadoresFalsos(w);
  if (opts.antesDeCargar) opts.antesDeCargar(w);

  // `icons.js` real: los `<i data-i>` de index.html lo necesitan.
  const scripts = [
    'icons.js',
    'marked.min.js',
    'chatkit.js',
    '10-chat.js',
    '20-app.js',
    '30-ajustes.js',
    'ajustes-util.js',
    'memoria-ui.js',
    '40-vistas.js',
  ];
  for (const f of scripts) {
    const s = w.document.createElement('script');
    s.textContent = leer(f);
    w.document.head.appendChild(s);
  }

  return {
    dom,
    w,
    llamadas,
    avisos,
    toasts,
    observadores,
    erroresCarga,
    /** Espera a que se asienten los microtareas/tiempos de las vistas. */
    async listo(ms = 20) {
      await new Promise((r) => setTimeout(r, ms));
    },
    $(sel) {
      return w.document.querySelector(sel);
    },
    $$(sel) {
      return Array.from(w.document.querySelectorAll(sel));
    },
    /** Pulsa un elemento por selector, con el clic real que oirían sus handlers. */
    clic(sel) {
      const el = typeof sel === 'string' ? w.document.querySelector(sel) : sel;
      if (!el) throw new Error('no existe ' + sel);
      el.click();
      return el;
    },
  };
}

module.exports = { montar, esc, configBase, fakeSagitari, observadoresFalsos, HTML, leer };
