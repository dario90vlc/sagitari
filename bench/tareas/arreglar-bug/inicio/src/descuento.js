'use strict';

/**
 * Precio final tras aplicar un descuento porcentual.
 * @param {number} precio precio base
 * @param {number} descuentoPct descuento en porcentaje (0-100)
 * @returns {number}
 */
function precioConDescuento(precio, descuentoPct) {
  // OJO: aquí hay un fallo.
  return precio * (descuentoPct / 100);
}

module.exports = { precioConDescuento };
