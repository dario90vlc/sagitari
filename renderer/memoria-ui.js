/* SAGITARI renderer — memoria-ui.js: la vista Memoria (fase 1 del spec de memoria).

   Script clásico: comparte el scope global con los demás scripts del renderer (se carga
   antes de 40-vistas.js). Nada de IIFE aquí a propósito: `renderMemoria` tiene que ser
   una global de verdad, porque el router de vistas la llama por su nombre y las pruebas
   de la suite leen el fuente del renderer concatenado.

   Escribe solo con los puentes de main/preload.js (memoryList, memoryUpdate, memoryRemove,
   memoryTrashList/Restore/Empty, memoryTrayList/Accept/Discard, memoryExport, memoryWipe,
   memoryRestoreBackup, habitsGet, habitsForget, setSettings, onMemoriaNueva): si un canal
   no existe todavía, la sección lo explica en español en vez de reventar. La heurística y
   el almacén viven en el proceso principal; aquí solo se enseña y se decide.

   Campos de un hecho (contrato v2, los nombres de la v1): { id, text, date, lastUsed, uses,
   importance (0..1), confidence, origen, origenTexto, etiquetas, hash, papelera }. La vista
   enseña la importancia en tres niveles: Alta 1 · Normal 0,6 · Baja 0,3. */

/* exported renderMemoria */
/* global $, esc, ic, vListEmpty, copyText, showToast, askConfirm, CFG, I18N */

/* ---------- 1. lenguaje humano ---------- */

/** «hoy» / «ayer» / «hace 3 días» / «hace 4 meses» a partir de un instante ISO. */
function haceDe(iso) {
  const d = Date.parse(iso);
  if (!d) return I18N.t('memoria.hace.nunca');
  const dias = Math.floor((Date.now() - d) / 86400000);
  if (dias <= 0) return I18N.t('memoria.hace.hoy');
  if (dias === 1) return I18N.t('memoria.hace.ayer');
  if (dias < 30) return I18N.t('memoria.hace.dias', { n: dias });
  const meses = Math.floor(dias / 30);
  if (meses < 12) return meses === 1 ? I18N.t('memoria.hace.unMes') : I18N.t('memoria.hace.meses', { n: meses });
  const años = Math.floor(dias / 365);
  return años === 1 ? I18N.t('memoria.hace.unAnio') : I18N.t('memoria.hace.anios', { n: años });
}

/** De dónde salió un hecho, en una frase legible. Una fecha que no se puede leer no se
    pinta: un fichero migrado o editado a mano puede traer cualquier cosa en `date`, y
    «de tu frase del Invalid Date» es un texto roto en pantalla. */
function procedencia(m) {
  const d = Date.parse((m && m.date) || '');
  const cuando = d ? new Date(d).toLocaleDateString(I18N.idioma, { day: 'numeric', month: 'short' }) : '';
  const origen =
    {
      mensaje: 'memoria.origen.mensaje',
      conversacion: 'memoria.origen.conversacion',
      conversación: 'memoria.origen.conversacion',
      herramienta: 'memoria.origen.herramienta',
      habitos: 'memoria.origen.habitos',
      usuario: 'memoria.origen.usuario',
      user: 'memoria.origen.usuario',
      agent: 'memoria.origen.agent',
    }[m && m.origen] || 'memoria.origen.mensaje';
  const texto = I18N.t(origen);
  return cuando ? I18N.t('memoria.origen.conFecha', { origen: texto, fecha: cuando }) : texto;
}

/** Los tres niveles de la vista sobre la importancia numérica del almacén. */
function nivelHecho(m) {
  const imp = Number(m && m.importance);
  if (!Number.isFinite(imp)) return 'normal';
  if (imp >= 0.8) return 'alta';
  if (imp <= 0.4) return 'baja';
  return 'normal';
}

/* Prefijo de las claves de nivel: se compone en un solo sitio (ver «imp.aria»). */
const IMP_CLAVE = 'memoria.imp.';

/* Los valores que viajan al almacén: importance sigue siendo 0..1 (no se toca el scoring). */
const MEM_IMPORTANCIAS = [
  [1, 'alta'],
  [0.6, 'normal'],
  [0.3, 'baja'],
];

/* ---------- 2. constructores puros ----------
   Puras a propósito: se prueban sin DOM y son la única pieza que sabe de HTML. */

/** Etiquetas de un hecho como píldoras. */
function memTags(etiquetas) {
  return (etiquetas || []).map((t) => `<span class="memtag">${esc(t)}</span>`).join('');
}

function htmlHecho(m) {
  const nivel = nivelHecho(m);
  const usos = Number(m.uses) || 0;
  /* Un hecho que nunca se ha usado no lleva fecha de uso: decir «usado hace 8 meses, 0
     veces» es una contradicción que el usuario lee como un fallo de la app. */
  const uso = usos
    ? I18N.t(usos === 1 ? 'memoria.uso.usadoUno' : 'memoria.uso.usadoVarios', { cuando: haceDe(m.lastUsed), n: usos })
    : I18N.t('memoria.uso.nunca');
  const niveles = MEM_IMPORTANCIAS.map(
    ([v, n]) =>
      `<button type="button" class="btn ghost sq${nivel === n ? ' on' : ''}" data-imp="${v}" role="radio" aria-checked="${nivel === n}" title="${esc(I18N.t(IMP_CLAVE + n))}">${esc(I18N.t(IMP_CLAVE + n))}</button>`,
  ).join('');
  return `<div class="memitem" data-id="${esc(m.id)}">
    <span class="mt"><span class="memtxt" data-texto>${esc(m.text)}</span><br>
      <small class="md">${esc(procedencia(m))} · ${esc(uso)}${memTags(m.etiquetas) ? ' ' + memTags(m.etiquetas) : ''}</small></span>
    <span class="memimp" role="radiogroup" aria-label="${esc(I18N.t('memoria.imp.aria'))}">${niveles}</span>
    <button type="button" class="btn ghost sq" data-edit title="${esc(I18N.t('memoria.ficha.editar'))}" aria-label="${esc(I18N.t('memoria.ficha.editar.aria'))}">${ic('code')}</button>
    <button type="button" class="btn ghost sq danger" data-del title="${esc(I18N.t('memoria.ficha.olvidar'))}" aria-label="${esc(I18N.t('memoria.ficha.olvidar.aria'))}">${ic('trash')}</button>
  </div>`;
}

/** Propuesta de «Recién aprendido»: lleva su frase literal y por qué se propuso. */
function htmlPropuesta(p) {
  /* Las piezas de la procedencia van separadas con «·», como el resto de la vista: sin
     separador se leían pegadas («parece tu ciudadLo dijiste así: …»). */
  const piezas = [
    p.motivo || '',
    p.origenTexto && p.origenTexto !== p.texto ? I18N.t('memoria.propuesta.dichoAsi', { texto: p.origenTexto }) : '',
    p.convTitulo ? I18N.t('memoria.propuesta.enConv', { titulo: p.convTitulo }) : '',
  ]
    .filter(Boolean)
    .map((t) => esc(t));
  const procedencia = piezas.length ? `<small class="md">${piezas.join(' · ')}</small>` : '';
  return `<div class="memitem" data-id="${esc(p.id)}">
    <span class="mt"><span class="memtxt" data-texto>${esc(p.texto)}</span><br>${procedencia}${memTags(p.etiquetas) ? '<br>' + memTags(p.etiquetas) : ''}</span>
    <button type="button" class="btn" data-acc="guardar">${esc(I18N.t('memoria.propuesta.guardar'))}</button>
    <button type="button" class="btn ghost" data-acc="editar">${esc(I18N.t('memoria.propuesta.editar'))}</button>
    <button type="button" class="btn ghost danger" data-acc="descartar">${esc(I18N.t('memoria.propuesta.descartar'))}</button>
  </div>`;
}

function htmlPapelera(m) {
  return `<div class="memitem" data-id="${esc(m.id)}">
    <span class="mt">${esc(m.text)}<br><small class="md">${esc(I18N.t('memoria.papelera.desde', { cuando: haceDe(m.papelera) }))}</small></span>
    <button type="button" class="btn ghost" data-acc="restaurar">${ic('restore')} ${esc(I18N.t('memoria.papelera.restaurar'))}</button>
  </div>`;
}

function htmlVacio(titulo, texto) {
  return vListEmpty('memory', titulo, texto);
}

/** Pinta una sección con su lista; un error de lectura NO se disfraza de lista vacía. */
function pintarLista(sel, html, error, vacio) {
  const box = $(sel);
  if (!box) return;
  if (error) {
    /* El canal de la lista avisa (lanza) cuando el almacén no se pudo leer o interpretar:
       aquí se explica en humano y se ofrece la salida, en vez de enseñar una memoria
       vacía que no es cierta. */
    box.innerHTML = `<div class="listempty memerror"><div class="le-mark">${ic('alert')}</div>
      <b>${esc(I18N.t('memoria.error.titulo'))}</b>
      <p>${esc(I18N.t('memoria.error.texto'))}</p>
      <div class="le-act"><button type="button" class="btn" data-copiar-restaurar>${esc(I18N.t('memoria.error.restaurar'))}</button>
      <button type="button" class="btn ghost" data-reintentar>${esc(I18N.t('memoria.error.reintentar'))}</button></div>
      <p class="memerror-det" data-motivo>${esc(error)}</p></div>`;
    const b = box.querySelector('[data-copiar-restaurar]');
    if (b) b.onclick = memRestaurarCopia;
    const r = box.querySelector('[data-reintentar]');
    if (r) r.onclick = () => pintarHechos();
    return;
  }
  box.innerHTML = html || vacio;
}

/* ---------- 3. estado de la vista (no se persiste) ---------- */
let memHechos = []; // última lectura, para filtrar sin volver a preguntar
let memFiltroQ = '';
let memFiltroTag = null;
let memUndo = null; // { hecho, timer }
let memVaciarArmado = false;

/* ---------- 4. «Lo que sé de ti» ---------- */

function memPintaUndo() {
  const box = $('#memUndoBox');
  if (!box) return;
  if (!memUndo) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = `<span>${esc(I18N.t('memoria.undo.texto', { texto: String(memUndo.hecho.text).slice(0, 90) }))}</span>
    <button type="button" class="btn ghost" data-deshacer>${esc(I18N.t('memoria.undo.deshacer'))}</button>`;
  box.querySelector('[data-deshacer]').onclick = memDeshacerBorrado;
}

function memPonUndo(m) {
  clearTimeout(memUndo && memUndo.timer); // solo puede haber un deshacer vivo: el nuevo manda
  memUndo = { hecho: m, timer: setTimeout(memCaducaUndo, 10000) };
}
function memCaducaUndo() {
  memUndo = null;
  memPintaUndo();
}

/** Deshacer un borrado: si el almacén lo movió a la papelera se recupera tal cual
    (conserva origen, etiquetas y usos); si se borró de verdad, se vuelve a escribir. */
async function memDeshacerBorrado() {
  if (!memUndo) return;
  const m = memUndo.hecho;
  clearTimeout(memUndo.timer);
  memUndo = null;
  const r = await window.sagitari.memoryTrashRestore(m.id);
  let ok = !!(r && r.ok);
  if (!ok) {
    const alta = await window.sagitari.memoryAdd(m.text, m.importance);
    ok = !(alta && alta.ok === false);
  }
  showToast(ok ? I18N.t('memoria.recuperado') : I18N.t('memoria.recuperar.fallo'));
  await pintarHechos();
}

/** Chips de etiqueta para filtrar la ficha (se construyen de lo que hay de verdad). */
function memPintaFiltro() {
  const box = $('#memFiltro');
  if (!box) return;
  const cuenta = new Map();
  for (const m of memHechos) for (const t of m.etiquetas || []) cuenta.set(t, (cuenta.get(t) || 0) + 1);
  if (!cuenta.size) {
    box.innerHTML = '';
    return;
  }
  const botones = [
    `<button type="button" class="memtag${memFiltroTag ? '' : ' on'}" data-tag="" aria-pressed="${!memFiltroTag}">${esc(I18N.t('memoria.filtro.todas'))}</button>`,
  ];
  for (const [tag, n] of [...cuenta].sort((a, b) => b[1] - a[1]))
    botones.push(
      `<button type="button" class="memtag${memFiltroTag === tag ? ' on' : ''}" data-tag="${esc(tag)}" aria-pressed="${memFiltroTag === tag}">${esc(tag)} <small>${n}</small></button>`,
    );
  box.innerHTML = botones.join('');
  box.querySelectorAll('[data-tag]').forEach((b) => {
    b.onclick = () => {
      memFiltroTag = b.dataset.tag || null;
      memPintaFiltro();
      memPintaHechosVisibles();
    };
  });
}

function memVisibles() {
  const q = memFiltroQ.trim().toLowerCase();
  return memHechos.filter((m) => {
    if (memFiltroTag && !(m.etiquetas || []).includes(memFiltroTag)) return false;
    if (q && !(String(m.text) + ' ' + (m.etiquetas || []).join(' ')).toLowerCase().includes(q)) return false;
    return true;
  });
}

function memPintaHechosVisibles() {
  const box = $('#memList');
  if (!box) return;
  const visibles = memVisibles();
  const cuenta = $('#memFichaCuenta');
  if (cuenta)
    cuenta.textContent = memHechos.length
      ? visibles.length === memHechos.length
        ? I18N.t(memHechos.length === 1 ? 'memoria.ficha.uno' : 'memoria.ficha.varios', { n: memHechos.length })
        : I18N.t('memoria.ficha.filtrados', { n: visibles.length, total: memHechos.length })
      : '';
  if (!memHechos.length) {
    box.innerHTML = htmlVacio(I18N.t('memoria.ficha.vacio.titulo'), I18N.t('memoria.ficha.vacio.texto'));
    return;
  }
  if (!visibles.length) {
    box.innerHTML = `<div class="subnote">${esc(I18N.t('memoria.ficha.sinCoincidencias'))}</div>`;
    return;
  }
  box.innerHTML = visibles.map(htmlHecho).join('');
  box.querySelectorAll('.memitem').forEach((it) => {
    const m = memHechos.find((x) => x.id === it.dataset.id);
    if (!m) return;
    it.querySelectorAll('[data-imp]').forEach((b) => {
      b.onclick = async () => {
        await window.sagitari.memoryUpdate(m.id, { importance: Number(b.dataset.imp) });
        await pintarHechos();
      };
    });
    const txt = it.querySelector('.memtxt');
    const botonEditar = it.querySelector('[data-edit]');
    const textoOriginal = txt.textContent;
    botonEditar.onclick = async () => {
      const editando = txt.getAttribute('contenteditable') === 'true';
      if (!editando) {
        txt.setAttribute('contenteditable', 'true');
        txt.setAttribute('role', 'textbox');
        txt.setAttribute('aria-label', I18N.t('memoria.ficha.editar.aria'));
        botonEditar.setAttribute('aria-label', I18N.t('memoria.ficha.guardar.aria'));
        txt.focus();
        const rango = document.createRange();
        rango.selectNodeContents(txt);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(rango);
        return;
      }
      const nuevo = txt.textContent.trim();
      // vaciar un recuerdo lo dejaría sin sentido: se avisa y se deja como estaba
      if (!nuevo) {
        txt.textContent = textoOriginal;
        showToast(I18N.t('memoria.ficha.vacia'));
      } else if (nuevo !== textoOriginal) {
        await window.sagitari.memoryUpdate(m.id, { text: nuevo });
        showToast(I18N.t('memoria.ficha.guardado'));
      }
      await pintarHechos();
    };
    txt.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        txt.textContent = textoOriginal;
        botonEditar.click();
      }
    };
    it.querySelector('[data-del]').onclick = async () => {
      await window.sagitari.memoryRemove(m.id);
      memPonUndo(m);
      await pintarHechos();
    };
  });
}

async function pintarHechos() {
  let list = [],
    err = null;
  try {
    list = (await window.sagitari.memoryList()) || [];
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  if (err) memHechos = [];
  else memHechos = list.filter((m) => m && m.id && !m.papelera);
  memPintaFiltro();
  memPintaUndo();
  if (err) {
    pintarLista('#memList', '', err, '');
    return;
  }
  memPintaHechosVisibles();
}

/* ---------- 5. «Recién aprendido» (bandeja de aprobación) ---------- */

async function pintarBandeja() {
  let props = [],
    err = null;
  try {
    props = (await window.sagitari.memoryTrayList()) || [];
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  const cuenta = $('#memBandejaCuenta');
  if (cuenta)
    cuenta.textContent = err || !props.length
      ? ''
      : I18N.t(props.length === 1 ? 'memoria.tray.una' : 'memoria.tray.varias', { n: props.length });
  pintarLista(
    '#memBandeja',
    props.map(htmlPropuesta).join(''),
    err,
    htmlVacio(I18N.t('memoria.tray.vacio.titulo'), I18N.t('memoria.tray.vacio.texto')),
  );
  const box = $('#memBandeja');
  if (!box) return;
  box.querySelectorAll('.memitem').forEach((it) => {
    const id = it.dataset.id;
    const txt = it.querySelector('.memtxt');
    const textoOriginal = txt.textContent;
    it.querySelector('[data-acc="guardar"]').onclick = async () => {
      const editando = txt.getAttribute('contenteditable') === 'true';
      const editado = editando ? txt.textContent.trim() : '';
      if (editando && !editado) {
        showToast(I18N.t('memoria.tray.vacia'));
        txt.focus();
        return;
      }
      /* Siempre se acepta la PROPUESTA (es la que lleva las etiquetas —«identidad» decide
         que el dato vaya siempre en el prompt— y la frase de la que salió). Si el usuario
         la ha corregido, el texto se ajusta después sobre el hecho ya guardado: crear uno
         nuevo por el camino de «añadir» perdía las etiquetas y el origen. */
      const r = await window.sagitari.memoryTrayAccept(id);
      if (r && r.ok === false) {
        showToast(I18N.t('memoria.tray.guardar.fallo', { motivo: r.error || I18N.t('chat.error.desconocido') }));
        return;
      }
      const m = r && r.memory;
      if (editado && editado !== textoOriginal && m && m.id) {
        const u = await window.sagitari.memoryUpdate(m.id, { text: editado });
        if (u && u.ok === false) {
          showToast(I18N.t('memoria.tray.corregido.fallo', { motivo: u.error || I18N.t('chat.error.desconocido') }));
          await Promise.all([pintarBandeja(), pintarHechos()]);
          return;
        }
      }
      showToast(I18N.t('memoria.tray.guardado'));
      await Promise.all([pintarBandeja(), pintarHechos()]);
    };
    it.querySelector('[data-acc="editar"]').onclick = () => {
      txt.setAttribute('contenteditable', 'true');
      txt.setAttribute('role', 'textbox');
      txt.setAttribute('aria-label', I18N.t('memoria.tray.editar.aria'));
      txt.focus();
      const rango = document.createRange();
      rango.selectNodeContents(txt);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(rango);
    };
    txt.onkeydown = (e) => {
      if (e.key === 'Escape') {
        txt.textContent = textoOriginal;
        it.querySelector('[data-acc="guardar"]').focus();
      }
    };
    it.querySelector('[data-acc="descartar"]').onclick = async () => {
      await window.sagitari.memoryTrayDiscard(id);
      showToast(I18N.t('memoria.tray.descartado'));
      await pintarBandeja();
    };
  });
}

/* ---------- 6. «Cómo trabajas conmigo» ---------- */

/* Cada grupo con su nombre humano (CLAVE del diccionario), su icono y la categoría con la
   que se olvida. La clave que viaja al proceso principal va en español (la traduce
   `habits.olvidar`) y cubre TODAS las categorías que el perfil observa de verdad: dejar
   una fuera sería un «olvidar» que miente. El orden es el de esta lista. */
const MEM_GRUPOS = [
  { cat: 'tools', titulo: 'memoria.cat.tools', icono: 'tools', olvidar: 'herramientas' },
  { cat: 'apps', titulo: 'memoria.cat.apps', icono: 'window', olvidar: 'aplicaciones' },
  { cat: 'commands', titulo: 'memoria.cat.commands', icono: 'terminal', olvidar: 'comandos' },
  { cat: 'folders', titulo: 'memoria.cat.folders', icono: 'folder', olvidar: 'carpetas' },
  { cat: 'sites', titulo: 'memoria.cat.sites', icono: 'globe', olvidar: 'webs' },
  { cat: 'modes', titulo: 'memoria.cat.modes', icono: 'zap', olvidar: 'modos' },
  { cat: 'confirms', titulo: 'memoria.cat.confirms', icono: 'check', olvidar: 'permisos' },
];

/** El nombre humano de una categoría de olvido ('webs' → «Webs»), para los avisos. */
function memTituloCategoria(clave) {
  if (clave === 'todo') return I18N.t('memoria.cat.todo');
  const g = MEM_GRUPOS.find((x) => x.olvidar === clave);
  /* En una frase el nombre de la categoría va en minúscula («en webs»); el rótulo del
     grupo (hgr-t) sí va capitalizado. */
  return g ? I18N.t(g.titulo).toLowerCase() : clave;
}

function memFilas(area, valor) {
  if (Array.isArray(valor)) return valor.map((x) => ({ name: String(x.name), count: Number(x.count) || 0 }));
  if (valor && typeof valor === 'object') {
    if (area === 'confirms') {
      const filas = [];
      if (valor.approved) filas.push({ name: 'aprobadas', count: Number(valor.approved) || 0 });
      if (valor.denied) filas.push({ name: 'denegadas', count: Number(valor.denied) || 0 });
      return filas;
    }
    return Object.entries(valor).map(([name, count]) => ({ name, count: Number(count) || 0 }));
  }
  return [];
}

async function pintarHabitos() {
  let s = null,
    err = null;
  try {
    s = await window.sagitari.habitsGet();
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  const box = $('#memHabitos');
  if (!box) return;
  if (err || !s) {
    box.innerHTML = err ? `<div class="subnote">${esc(I18N.t('memoria.habitos.fallo', { motivo: err }))}</div>` : '';
    return;
  }
  const bloques = [];
  for (const g of MEM_GRUPOS) {
    const filas = memFilas(g.cat, s[g.cat]).filter((f) => f.name && f.count > 0);
    if (!filas.length) continue;
    const total = filas.reduce((n, f) => n + f.count, 0);
    const titulo = I18N.t(g.titulo);
    const usos = I18N.t(total === 1 ? 'ajustes.habitos.usos.uno' : 'ajustes.habitos.usos.varios');
    const olvidar = I18N.t('ajustes.habitos.olvidar', { titulo: titulo.toLowerCase() });
    bloques.push(
      `<div class="hgrupo" data-cat="${esc(g.cat)}"><span class="hgr-t">${ic(g.icono)} ${esc(titulo)}</span>` +
        `<span class="hgr-n">${total} ${esc(usos)}</span>` +
        filas.map((f) => `<span class="hpill">${esc(f.name)} ×${f.count}</span>`).join('') +
        `<button type="button" class="btn ghost sq" data-olvidar="${esc(g.olvidar)}" title="${esc(olvidar)}" aria-label="${esc(olvidar)}">${ic('trash')}</button></div>`,
    );
  }
  box.innerHTML = bloques.length ? bloques.join('') : '<span class="hdim">' + esc(I18N.t('memoria.habitos.vacio')) + '</span>';
  box.querySelectorAll('[data-olvidar]').forEach((b) => {
    b.onclick = () => memOlvidarHabitos(b.dataset.olvidar, b);
  });
}

/** «Olvidar esta categoría»: borra solo lo observado en esa categoría (o todo el perfil). */
async function memOlvidarHabitos(categoria, ancla) {
  const que =
    categoria === 'todo'
      ? I18N.t('memoria.olvidar.todoQue')
      : I18N.t('memoria.olvidar.que', { titulo: memTituloCategoria(categoria) });
  if (
    !(await askConfirm(
      ancla || document.body,
      I18N.t('memoria.olvidar.confirmar', { que }),
      I18N.t('memoria.olvidar.detalle'),
    ))
  )
    return;
  if (ancla) ancla.disabled = true;
  const r = await window.sagitari.habitsForget(categoria);
  if (r && r.ok === false) {
    if (ancla) ancla.disabled = false;
    showToast(I18N.t('memoria.olvidar.fallo', { motivo: r.error || I18N.t('chat.error.desconocido') }));
    return;
  }
  showToast(I18N.t('memoria.olvidar.hecho', { que }));
  await pintarHabitos();
}

/* ---------- 7. «Buscar en lo que hemos hablado» ----------
   El índice de episodios es de la fase 3, así que en esta fase la caja se muestra
   DESACTIVADA y lo explica: un candado honesto es mejor que una búsqueda que devuelva
   vacío y haga creer que no habéis hablado de nada. Cuando esa fase traiga su puente, se
   activa aquí (quitar el `disabled` y llamar al canal de episodios). */
function memPreparaBuscador() {
  const caja = $('#memBuscar');
  const boton = $('#memBuscarBtn');
  const nota = $('#memBuscarNota');
  if (caja) caja.disabled = true;
  if (boton) boton.disabled = true;
  if (nota) {
    nota.hidden = false;
    nota.textContent = I18N.t('memoria.hablar.nota');
  }
}

/* ---------- 8. Papelera ---------- */

async function pintarPapelera() {
  let list = [],
    err = null;
  try {
    list = (await window.sagitari.memoryTrashList()) || [];
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  memVaciarArmado = false;
  const boton = $('#memPapeleraVaciar');
  if (boton) {
    boton.textContent = I18N.t('memoria.papelera.vaciar');
    boton.classList.remove('armado');
  }
  const barra = $('#memPapeleraBarra');
  if (barra) barra.hidden = !!err || !list.length;
  const cuenta = $('#memPapeleraCuenta');
  if (cuenta)
    cuenta.textContent = err || !list.length
      ? ''
      : I18N.t(list.length === 1 ? 'memoria.papelera.uno' : 'memoria.papelera.varios', { n: list.length });
  pintarLista(
    '#memPapelera',
    list.map(htmlPapelera).join(''),
    err,
    '<div class="subnote">' + esc(I18N.t('memoria.papelera.vacia')) + '</div>',
  );
  const box = $('#memPapelera');
  if (!box) return;
  box.querySelectorAll('.memitem').forEach((it) => {
    it.querySelector('[data-acc="restaurar"]').onclick = async () => {
      const r = await window.sagitari.memoryTrashRestore(it.dataset.id);
      if (r && r.ok === false) {
        showToast(I18N.t('memoria.papelera.restaurar.fallo', { motivo: r.error || I18N.t('chat.error.desconocido') }));
        await pintarPapelera();
        return;
      }
      showToast(I18N.t('memoria.papelera.restaurado'));
      await Promise.all([pintarPapelera(), pintarHechos()]);
    };
  });
}

/* ---------- 9. Pie: aprendizaje, exportar, olvidarlo todo ---------- */

/** Estado de los interruptores desde los ajustes. Por defecto: aprende SÍ (propone y
    espera aprobación), guardar sin preguntar NO. */
function pintarPie() {
  const ajustes = (typeof CFG !== 'undefined' && CFG && CFG.settings) || {};
  const aprender = ajustes.memoryLearn !== false;
  const auto = ajustes.memoryAutoSave === true;
  const swA = $('#swMemLearn');
  if (swA) {
    swA.classList.toggle('on', aprender);
    swA.setAttribute('aria-checked', aprender ? 'true' : 'false');
  }
  const swB = $('#swMemAuto');
  if (swB) {
    swB.classList.toggle('on', auto);
    swB.setAttribute('aria-checked', auto ? 'true' : 'false');
  }
}

async function memAlterna(sel, clave) {
  const sw = $(sel);
  if (!sw) return;
  const on = !sw.classList.contains('on');
  sw.classList.toggle('on', on);
  sw.setAttribute('aria-checked', on ? 'true' : 'false');
  const r = await window.sagitari.setSettings({ [clave]: on });
  /* El canal devuelve los ajustes PERSISTIDOS: con ellos se sincroniza CFG, que es de
     donde `pintarPie()` repinta los interruptores cada vez que se entra en la vista.
     Sin esto el interruptor volvía a su valor viejo al reabrirla y, como el siguiente
     clic se calculaba desde la clase, un ajuste apagado no se podía volver a encender. */
  const valor = r && typeof r === 'object' && typeof r[clave] === 'boolean' ? r[clave] : on;
  if (typeof CFG !== 'undefined' && CFG) CFG.settings = { ...(CFG.settings || {}), [clave]: valor };
  pintarPie(); // la pantalla enseña lo que de verdad ha quedado guardado
  if (clave === 'memoryLearn')
    showToast(
      valor
        ? I18N.t('memoria.aprender.si')
        : I18N.t('memoria.aprender.no'),
    );
  else showToast(valor ? I18N.t('memoria.auto.si') : I18N.t('memoria.auto.no'));
}

/** Exportar: el almacén devuelve el volcado y se copia al portapapeles como JSON legible.
    Un fallo del almacén no se copia: sería llevar al portapapeles un «no pude» con la
    apariencia de ser tu memoria. */
async function memExportar() {
  const b = $('#memExport');
  if (b) b.disabled = true;
  try {
    const datos = await window.sagitari.memoryExport();
    if (datos && datos.ok === false) {
      showToast(I18N.t('memoria.exportar.fallo', { motivo: datos.error || I18N.t('chat.error.desconocido') }));
      return;
    }
    const texto = typeof datos === 'string' ? datos : JSON.stringify(datos, null, 2);
    copyText(texto, I18N.t('memoria.exportar.hecho'));
  } catch (e) {
    showToast(I18N.t('memoria.exportar.fallo', { motivo: (e && e.message) || e }));
  } finally {
    if (b) b.disabled = false;
  }
}

const MEM_PALABRA = 'OLVIDAR';

function memSincronizaWipe() {
  const caja = $('#memWipeInput');
  const ir = $('#memWipeGo');
  if (caja && ir) ir.disabled = caja.value.trim() !== MEM_PALABRA;
}

/** «Olvídalo todo» pide la palabra escrita: es irreversible y un clic de más no basta. */
function memMostrarWipe(mostrar) {
  const caja = $('#memWipeBox');
  if (!caja) return;
  caja.hidden = !mostrar;
  if (mostrar) {
    const texto = $('#memWipeInput');
    if (texto) texto.value = '';
    memSincronizaWipe();
    if (texto) texto.focus();
  }
}

async function memOlvidarTodo() {
  const ir = $('#memWipeGo');
  if (ir) ir.disabled = true;
  try {
    const r = await window.sagitari.memoryWipe();
    if (r && r.ok === false) {
      showToast(I18N.t('memoria.olvidar.fallo', { motivo: r.error || I18N.t('chat.error.desconocido') }));
      if (ir) ir.disabled = false; // la confirmación sigue abierta para reintentar
      return;
    }
    memMostrarWipe(false);
    showToast(I18N.t('memoria.wipe.hecho'));
    await renderMemoria();
  } catch (e) {
    showToast(I18N.t('memoria.olvidar.fallo', { motivo: (e && e.message) || e }));
    if (ir) ir.disabled = false;
  }
}

/* ---------- 10. Restaurar la copia (almacén ilegible) ---------- */

/** Salida del almacén ilegible: el proceso principal repone la copia y aquí se dice
    exactamente qué pasó. Si no hay copia, se explica dónde vive el fichero; nunca un
    «hecho» falso. */
async function memRestaurarCopia() {
  const b = document.querySelector('[data-copiar-restaurar]');
  if (b) b.disabled = true;
  let r = null;
  try {
    r = await window.sagitari.memoryRestoreBackup();
  } catch (e) {
    if (b) b.disabled = false;
    memMotivo(I18N.t('memoria.restaurar.fallo', { motivo: (e && e.message) || e }));
    return;
  }
  if (r && r.ok) {
    showToast(r.origen ? I18N.t('memoria.restaurar.hechaDel', { origen: r.origen }) : I18N.t('memoria.restaurar.hecha'));
    await renderMemoria();
    return;
  }
  if (b) b.disabled = false;
  const error = (r && r.error) || I18N.t('chat.error.desconocido');
  /* «Sin copia» es un caso (habitual) y tiene su explicación; cualquier otro fallo se
     cuenta con su motivo real, sin disfrazarlo. */
  memMotivo(
    r && r.code === 'sin_copia'
      ? I18N.t('memoria.restaurar.sinCopia')
      : I18N.t('memoria.restaurar.copia.fallo', { motivo: error }),
  );
}

function memMotivo(texto) {
  const n = document.querySelector('#memList [data-motivo]');
  if (n) n.textContent = texto;
}

/* ---------- 11. Entrada de la vista ---------- */

/** Pinta la vista entera. La llama el router de vistas (10-chat.js) al abrir «Memoria». */
async function renderMemoria() {
  const box = $('#memList');
  if (box && !box.innerHTML)
    box.innerHTML = '<div class="subnote memcargando">' + esc(I18N.t('memoria.cargando')) + '</div>';
  pintarPie();
  memPreparaBuscador();
  await Promise.all([pintarHechos(), pintarBandeja(), pintarHabitos(), pintarPapelera()]);
}

/* ---------- 12. cableado (una sola vez) ---------- */

/** La búsqueda propia de la ficha filtra en local: no hay canal que gastar. */
if ($('#memSearch'))
  $('#memSearch').oninput = (e) => {
    memFiltroQ = e.target.value || '';
    memPintaHechosVisibles();
  };

if ($('#memAdd'))
  $('#memAdd').onclick = async () => {
    const texto = $('#memInput').value.trim();
    if (!texto) return;
    $('#memInput').value = '';
    $('#memAdd').disabled = true;
    try {
      const r = await window.sagitari.memoryAdd(texto, 0.6);
      if (r && r.ok === false) {
        showToast(I18N.t('memoria.anadir.fallo', { motivo: r.error || I18N.t('chat.error.desconocido') }));
        return;
      }
      showToast(I18N.t('memoria.anadido'));
      await pintarHechos();
    } catch (e) {
      showToast(I18N.t('memoria.anadir.fallo', { motivo: (e && e.message) || e }));
    } finally {
      $('#memAdd').disabled = false;
    }
  };
if ($('#memInput'))
  $('#memInput').onkeydown = (e) => {
    if (e.key === 'Enter') $('#memAdd').click();
  };

if ($('#swMemLearn')) $('#swMemLearn').onclick = () => memAlterna('#swMemLearn', 'memoryLearn');
if ($('#swMemAuto')) $('#swMemAuto').onclick = () => memAlterna('#swMemAuto', 'memoryAutoSave');
if ($('#memExport')) $('#memExport').onclick = memExportar;
if ($('#memOlvidarTodo')) $('#memOlvidarTodo').onclick = (e) => memOlvidarHabitos('todo', e.currentTarget);
if ($('#memWipe')) $('#memWipe').onclick = () => memMostrarWipe($('#memWipeBox').hidden);
if ($('#memWipeInput')) $('#memWipeInput').oninput = memSincronizaWipe;
if ($('#memWipeGo')) $('#memWipeGo').onclick = memOlvidarTodo;
if ($('#memWipeCancel'))
  $('#memWipeCancel').onclick = () => {
    memMostrarWipe(false);
    $('#memWipe').focus();
  };

/* Vaciar la papelera no tiene vuelta atrás: dos pulsaciones, y la segunda lo dice. */
if ($('#memPapeleraVaciar'))
  $('#memPapeleraVaciar').onclick = async () => {
    const b = $('#memPapeleraVaciar');
    if (!memVaciarArmado) {
      memVaciarArmado = true;
      b.textContent = I18N.t('memoria.papelera.armado');
      b.classList.add('armado');
      return;
    }
    memVaciarArmado = false;
    b.disabled = true;
    const r = await window.sagitari.memoryTrashEmpty();
    b.disabled = false;
    if (r && r.ok === false) {
      showToast(I18N.t('memoria.papelera.vaciar.fallo', { motivo: r.error || I18N.t('chat.error.desconocido') }));
      await pintarPapelera();
      return;
    }
    showToast(
      r && r.borradas !== undefined ? I18N.t('memoria.papelera.vaciada.n', { n: r.borradas }) : I18N.t('memoria.papelera.vaciada'),
    );
    await Promise.all([pintarPapelera(), pintarHechos()]);
  };

/* La búsqueda en conversaciones llegará con su índice (fase 3); su formulario no envía nada. */
if ($('#memBuscarForm'))
  $('#memBuscarForm').onsubmit = (e) => {
    e.preventDefault();
    showToast(I18N.t('memoria.hablar.inactiva'));
  };

/* Propuesta nueva del turno: la bandeja se refresca sola. */
if (window.sagitari && window.sagitari.onMemoriaNueva)
  window.sagitari.onMemoriaNueva(() => {
    if ($('#view-memory') && $('#view-memory').classList.contains('on')) pintarBandeja();
  });

if (typeof window !== 'undefined')
  window.MemoriaUI = {
    // entrada de la vista, por si una prueba o un atajo la necesita a mano
    renderMemoria,
    // constructores puros (los usan las pruebas de la vista)
    htmlHecho,
    htmlPropuesta,
    htmlPapelera,
    htmlVacio,
    haceDe,
    procedencia,
    nivelHecho,
    // pintores de sección, por si una prueba o una acción necesita refrescar solo una
    pintarLista,
    pintarHechos,
    pintarBandeja,
    pintarHabitos,
    pintarPapelera,
  };
