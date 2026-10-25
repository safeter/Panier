import { test } from 'node:test';
import assert from 'node:assert/strict';
import { similarProducts, nameKey } from '../js/similar.js';

const P = (name, unit = 'unité', category = 'legumes') => ({ id: `${name}--${unit}`, name, unit, category });
const counts = (ps, n = 2) => new Map(ps.map((p) => [p.id, n]));

test('clé de nom : casse, accents, pluriel et format ignorés', () => {
  assert.equal(nameKey('Bleuets 170g'), nameKey('bleuet'));
  assert.equal(nameKey('Fromage'), nameKey('fromage'));
});

test('doublons repérés, variétés différentes jamais proposées', () => {
  const ps = [
    P('Fromage', 'paquet', 'laitiers'), P('fromage', 'paquet', 'laitiers'),
    P('Hummus', 'contenant', 'autres'), P('Hummus Humm!', 'contenant', 'autres'),
    P('Tomates cerises', 'contenant'), P('Tomates cerises multicolores', 'contenant'),
    P('Laitue'), P('Laitue romaine'),
    P('Tomates en dés', 'boîte'), P('Tomates brûlées', 'boîte'),
    P('Oranges', 'sac', 'fruits'), P('Oranges bio', 'sac', 'fruits'),
    P('Vinaigre', 'bouteille', 'autres'), P('Vinaigre balsamique', 'bouteille', 'autres'),
    P('Pommes Gala', 'kg', 'fruits'), P('Pommes Gala', 'sac', 'fruits'),
    P('Crème 35%', 'carton', 'laitiers'), P('Crème 15%', 'carton', 'laitiers'),
  ];
  const pairs = similarProducts(ps, counts(ps));
  const names = pairs.map((x) => [x.kind, x.drop.name]);
  assert.deepEqual(names.find((x) => x[1].toLowerCase() === 'fromage')?.[0], 'meme-nom');
  assert.ok(names.some(([k, n]) => k === 'variante' && n === 'Hummus Humm!'));
  assert.ok(names.some(([k, n]) => k === 'variante' && n === 'Tomates cerises multicolores'));
  for (const no of ['Crème 15%', 'Crème 35%', 'Laitue romaine', 'Tomates brûlées', 'Tomates en dés', 'Oranges bio', 'Vinaigre balsamique']) {
    assert.ok(!names.some(([, n]) => n === no), `${no} ne doit pas être proposé`);
  }
  assert.ok(!pairs.some((x) => x.keep.name === 'Pommes Gala'), 'unités différentes : séries distinctes');
});

test('paire déclarée différente : plus proposée', () => {
  const ps = [P('Hummus', 'contenant', 'autres'), P('Hummus Humm!', 'contenant', 'autres')];
  const key = [ps[0].id, ps[1].id].sort().join('|');
  assert.equal(similarProducts(ps, counts(ps), new Set([key])).length, 0);
});
