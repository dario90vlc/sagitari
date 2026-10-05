'use strict';

/* Funciones puras de utilidad para ejecución de comandos.
   Se extraen de executors.js para que sean testeables y reutilizables.
   No dependen de nada externo: solo reciben datos y devuelven datos. */

/* cmd.exe y otras herramientas nativas emiten en la página de códigos OEM (CP850 en
   Windows en español), no en UTF-8: si los bytes no forman UTF-8 válido los decodificamos
   como CP850 para que los acentos no lleguen corruptos. (Los acentos españoles coinciden
   en CP850 y CP437, así que la tabla sirve también en equipos con OEM 437.) */
const CP850 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ';
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });

/**
 * Tipo MIME real de una imagen por sus primeros bytes (no por la extensión: renombrar
 * un .txt a .png no lo convierte en imagen, y los modelos solo aceptan formatos de
 * verdad). Devuelve null si no es de un formato que se pueda enviar.
 */
function tipoDeImagen(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Decodifica la salida de un comando: intenta UTF-8 estricto, y si falla usa CP850
 * (la página de códigos OEM de Windows en español).
 */
function decodeOut(buf) {
  buf = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'utf8');
  try {
    return UTF8_STRICT.decode(buf);
  } catch {}
  const s = buf.toString('latin1');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c < 0x80 ? s[i] : CP850[c - 0x80];
  }
  return out;
}

/* open_url acaba en shell.openExternal, que en Windows invoca el handler del
   SISTEMA, no el navegador: file://, ms-msdt:, search-ms: o cualquier otro
   protocolo registrado se abrirían sin que el usuario lo vea. Solo http(s) es
   una dirección de navegador, así que es lo único que se acepta. */
function openUrlAllowed(url) {
  try {
    const p = new URL(String(url || '').trim()).protocol.toLowerCase();
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

module.exports = {
  CP850,
  UTF8_STRICT,
  tipoDeImagen,
  decodeOut,
  openUrlAllowed,
};
