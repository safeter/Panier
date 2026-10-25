import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planCatalogue } from '../js/catalogue.js';
import { planImport } from '../js/importer.js';
import { joinLines, chainedIndex, monthlyPanel } from '../js/calc.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));

function migrated() {
  const s = read('../data/seed.json');
  let k = 0;
  const pl = planImport(s, read('../data/patches/recus-mai-2026.json'), (x) => `${x}${++k}`);
  for (const t of ['stores', 'products', 'receipts', 'lines']) s[t] = [...s[t], ...pl[t]];
  return s;
}

function apply(data, plan) {
  const del = new Set(plan.delProducts);
  const delL = new Set(plan.delLines.map((l) => l.id));
  const putP = new Map(plan.putProducts.map((p) => [p.id, p]));
  const putL = new Map(plan.putLines.map((l) => [l.id, l]));
  return {
    ...data,
    products: data.products.filter((p) => !del.has(p.id)).map((p) => putP.get(p.id) || p),
    lines: data.lines.filter((l) => !delL.has(l.id)).map((l) => putL.get(l.id) || l),
  };
}

test('catalogue d’octobre : renommages, fusions, suppressions, puis plus rien à rejouer', () => {
  const data = migrated();
  const patch = read('../data/patches/catalogue-2026-10.json');
  const plan = planCatalogue(data, patch);
  assert.equal(plan.summary.renamed, Object.keys(patch.rename).length);
  assert.equal(plan.summary.merged, patch.merge.length);
  // Les dépenses hors épicerie ne sont plus dans le jeu de départ : seuls les 22 produits non identifiables restent à retirer.
  assert.equal(plan.summary.deleted, 22);
  assert.deepEqual(plan.delReceipts, [], 'aucun reçu d’épicerie vidé');
  assert.ok(plan.notSame.includes('citrons--sac|citrons-meyer--sac'));
  const after = apply(data, plan);
  const ids = new Set(after.products.map((p) => p.id));
  for (const id of patch.delete) assert.ok(!ids.has(id), `${id} supprimé`);
  assert.ok(after.lines.every((l) => ids.has(l.productId)), 'aucun achat orphelin');
  const yog = after.products.find((p) => p.id === 'yogourt-oikos-grec--pot');
  assert.equal(yog.name, 'Yogourt grec (Oikos)');
  const creme = after.lines.filter((l) => l.productId === 'creme-15--carton').length;
  assert.equal(creme, 3, 'les 2 achats « creme 15% » rattachés à Crème 15%');
  assert.equal(plan.aliases['yogourt-oikos-grec'], 'yogourt-oikos-grec--pot');
  // rejouer : aucun changement
  const again = planCatalogue(after, patch);
  assert.deepEqual(again.summary, { renamed: 0, merged: 0, deleted: 0, linesMoved: 0, linesDeleted: 0 });
  // les fusions de noms génériques avec leur marque : plus de « Hummus (Humm!) » ni de « Bagels » seuls
  assert.ok(!ids.has('hummus-humm--contenant') && !ids.has('bagels--sac'));
  // l'indice se calcule toujours
  const s = chainedIndex(monthlyPanel(joinLines(after)));
  assert.ok(s.length > 5 && s.every((p) => Number.isFinite(p.index)));
});

test('catalogue : une installation antérieure perd aussi les dépenses hors épicerie et leurs reçus vides', () => {
  const data = migrated();
  data.products.push({ id: 'telephone-fizz--mois', name: 'Téléphone Fizz', unit: 'mois', category: 'hors' });
  data.receipts.push({ id: 'mig-2026-01-02-fizz', date: '2026-01-02', storeId: 'fizz', source: 'migration' });
  data.lines.push({ id: 'mig-l9999', receiptId: 'mig-2026-01-02-fizz', productId: 'telephone-fizz--mois', qty: 1, amount: 40 });
  const plan = planCatalogue(data, read('../data/patches/catalogue-2026-10.json'));
  assert.equal(plan.summary.deleted, 23);
  assert.deepEqual(plan.delReceipts, ['mig-2026-01-02-fizz']);
});

test('noms du catalogue : plus de minuscules initiales ni de noms tout en majuscules', () => {
  const data = migrated();
  const after = apply(data, planCatalogue(data, read('../data/patches/catalogue-2026-10.json')));
  const bad = after.products.filter((p) => /^[a-zà-ÿ]/.test(p.name) || /^[A-ZÀ-Ý\s.]{6,}$/.test(p.name));
  assert.deepEqual(bad.map((p) => p.name), []);
});
