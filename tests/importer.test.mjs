import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planImport } from '../js/importer.js';

let k = 0;
const id = (p) => `${p}${++k}`;
const base = () => ({
  stores: [{ id: 'super-c', name: 'Super C' }],
  products: [{ id: 'banane-bio--kg', name: 'Banane bio', unit: 'kg', category: 'fruits' }],
  receipts: [{ id: 'r0', date: '2026-01-17', storeId: 'super-c' }],
  lines: [{ id: 'l0', receiptId: 'r0', productId: 'banane-bio--kg', qty: 1, amount: 2.39 }],
});

test('reçu importé : produit existant retrouvé, nouveau produit créé', () => {
  const out = planImport(base(), { receipts: [{ date: '2026-10-24', store: 'super c', lines: [
    { name: 'banane bio', unit: 'kg', qty: '1,2', amount: '2,87' },
    { name: 'Kombucha', unit: 'bouteille', amount: 4.29, size: '414 ml', category: 'autres' },
  ] }] }, id);
  assert.equal(out.stores.length, 0);
  assert.equal(out.receipts.length, 1);
  assert.equal(out.lines[0].productId, 'banane-bio--kg');
  assert.equal(out.lines[0].qty, 1.2);
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].category, 'autres');
  assert.equal(out.lines[1].sizeQty, 414);
});

test('un reçu déjà présent est ignoré', () => {
  const out = planImport(base(), [{ date: '2026-01-17', store: 'Super C', lines: [{ name: 'Banane bio', unit: 'kg', amount: 2.39 }] }], id);
  assert.equal(out.receipts.length, 0);
  assert.equal(out.skipped.length, 1);
});

test('date invalide refusée', () => {
  assert.throws(() => planImport(base(), [{ date: '17/01/2026', store: 'Maxi', lines: [] }], id), /AAAA-MM-JJ/);
});

test('même nom, unité différente : nouvelle série de prix', () => {
  const out = planImport(base(), [{ date: '2026-05-03', store: 'Super C', lines: [{ name: 'Banane bio', unit: 'sac', amount: 3.49 }] }], id);
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].id, 'banane-bio--sac');
  assert.equal(out.products[0].category, 'fruits');
});

test('reçus de mai 2026 (ancienne app) : tous importables', async () => {
  const { readFileSync } = await import('node:fs');
  const seed = JSON.parse(readFileSync(new URL('../data/seed.json', import.meta.url)));
  const payload = JSON.parse(readFileSync(new URL('./fixtures/recus-mai-2026.json', import.meta.url)));
  const out = planImport(seed, payload, id);
  assert.equal(out.receipts.length, 5);
  assert.equal(out.lines.length, 71);
  assert.equal(out.skipped.length, 0);
});
