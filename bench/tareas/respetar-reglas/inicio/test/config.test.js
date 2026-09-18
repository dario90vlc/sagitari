'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

test('las dos configuraciones tienen las mismas claves', () => {
  const prod = require(path.join(__dirname, '..', 'config', 'produccion.json'));
  const dev = require(path.join(__dirname, '..', 'config', 'desarrollo.json'));
  assert.deepStrictEqual(Object.keys(prod).sort(), Object.keys(dev).sort());
});
