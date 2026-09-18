'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { precioConDescuento } = require('../src/descuento');

test('aplica el descuento al precio base', () => {
  assert.strictEqual(precioConDescuento(100, 25), 75);
  assert.strictEqual(precioConDescuento(200, 10), 180);
});

test('sin descuento el precio no cambia', () => {
  assert.strictEqual(precioConDescuento(50, 0), 50);
});

test('un descuento del 100% deja el precio a cero', () => {
  assert.strictEqual(precioConDescuento(30, 100), 0);
});
