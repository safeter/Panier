import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  joinLines, monthlyPanel, tornqvistLink, chainedIndex, headlineInflation, decompose,
  alertsFor, addMonths, monthsBetween, rebase, officialChange, spendByMonth,
} from '../js/calc.js';

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

function fixture() {
  const products = [
    { id: 'lait', name: 'Lait', unit: 'litre', category: 'laitiers' },
    { id: 'pain', name: 'Pain', unit: 'pain', category: 'boulangerie' },
    { id: 'savon', name: 'Savon', unit: 'unité', category: 'hors' },
  ];
  const receipts = [
    { id: 'r1', date: '2024-01-10', storeId: 's' },
    { id: 'r2', date: '2024-02-10', storeId: 's' },
    { id: 'r3', date: '2024-06-10', storeId: 's' },
  ];
  const lines = [
    { id: 'a', receiptId: 'r1', productId: 'lait', qty: 2, amount: 4 },   // 2,00 $
    { id: 'b', receiptId: 'r1', productId: 'pain', qty: 1, amount: 3 },   // 3,00 $
    { id: 'c', receiptId: 'r1', productId: 'savon', qty: 1, amount: 50 }, // hors
    { id: 'd', receiptId: 'r2', productId: 'lait', qty: 2, amount: 4.4 }, // 2,20 $ (+10 %)
    { id: 'e', receiptId: 'r2', productId: 'pain', qty: 1, amount: 3 },   // 3,00 $
    { id: 'f', receiptId: 'r3', productId: 'lait', qty: 1, amount: 2.2 }, // inchangé
    { id: 'g', receiptId: 'r3', productId: 'pain', qty: 2, amount: 6.6 }, // 3,30 $ (+10 %)
  ];
  return { products, receipts, lines };
}

test('arithmétique des mois', () => {
  assert.equal(addMonths('2024-11', 3), '2025-02');
  assert.equal(addMonths('2025-01', -12), '2024-01');
  assert.equal(monthsBetween('2023-12', '2024-08'), 8);
});

test('le hors-périmètre est exclu', () => {
  const j = joinLines(fixture());
  assert.equal(j.length, 6);
  assert.ok(j.every((l) => l.product.category !== 'hors'));
});

test('lien de Törnqvist : prix identiques = 1, hausse pondérée', () => {
  const panel = monthlyPanel(joinLines(fixture()));
  const [jan, feb] = [panel.get('2024-01'), panel.get('2024-02')];
  const { link, matched } = tornqvistLink(jan, feb);
  assert.equal(matched, 2);
  // parts : jan lait 4/7, fév lait 4,4/7,4 ; seul le lait monte de 10 %
  const w = (4 / 7 + 4.4 / 7.4) / 2;
  approx(link, Math.exp(w * Math.log(1.1)));
  assert.equal(tornqvistLink(jan, jan).link, 1);
});

test('indice chaîné : base 100, trou franchi et signalé', () => {
  const panel = monthlyPanel(joinLines(fixture()));
  const s = chainedIndex(panel);
  assert.deepEqual(s.map((p) => p.month), ['2024-01', '2024-02', '2024-06']);
  assert.equal(s[0].index, 100);
  assert.equal(s[2].gap, 3);
  assert.equal(s[2].reliable, false); // 2 produits communs < 5
  assert.ok(s[2].index > s[1].index && s[1].index > 100);
});

test('inflation affichée : depuis le début faute de point il y a 12 mois', () => {
  const s = chainedIndex(monthlyPanel(joinLines(fixture())));
  const h = headlineInflation(s);
  assert.equal(h.kind, 'depuisDebut');
  assert.equal(h.from, '2024-01');
  approx(h.pct, s[2].index - 100);
});

test('inflation affichée : 12 mois quand un point existe un an plus tôt (±2)', () => {
  const s = [
    { month: '2024-01', index: 100 }, { month: '2024-11', index: 104 }, { month: '2025-01', index: 106 },
  ];
  const h = headlineInflation(s);
  assert.equal(h.kind, '12mois');
  assert.equal(h.from, '2024-01');
  approx(h.pct, 6);
});

test('décomposition : le produit des effets redonne la variation des dépenses', () => {
  const f = fixture();
  const panel = monthlyPanel(joinLines(f));
  const s = chainedIndex(panel);
  const d = decompose(panel, s, '2024-02', '2024-06');
  const prod = (1 + d.pricePct / 100) * (1 + d.quantityPct / 100) * (1 + d.mixPct / 100);
  approx(prod, 1 + d.totalPct / 100, 1e-9);
  approx(d.spend0, 7.4, 1e-9);
  approx(d.spend1, 8.8, 1e-9);
});

test('écart aberrant (erreur d\'unité) écarté du lien', () => {
  const row = (p) => new Map([['a', { spend: 10, qty: 10 / p, price: p }], ['b', { spend: 10, qty: 5, price: 2 }]]);
  const { link, matched } = tornqvistLink(row(1), row(12));
  assert.equal(matched, 1);
  assert.equal(link, 1);
});

test('alertes : prix élevé, plancher, réduction de format', () => {
  const h = (ps) => ps.map((price, i) => ({ date: `2024-0${i + 1}-01`, price }));
  assert.equal(alertsFor(h([2, 2, 2, 2.5]))[0].kind, 'cher');
  assert.equal(alertsFor(h([2, 2.2, 2.1, 1.9]))[0].kind, 'plancher');
  assert.equal(alertsFor(h([2, 2.1, 2.05])).length, 0);
  const shrink = alertsFor([
    { date: '2024-01-01', price: 4, sizeQty: 500 },
    { date: '2024-02-01', price: 4, sizeQty: 450 },
  ]);
  assert.equal(shrink[0].kind, 'shrink');
  approx(shrink[0].pct, 10);
});

test('série officielle : rebasage et variation sur la même période', () => {
  const off = [{ month: '2024-01', value: 200 }, { month: '2024-06', value: 210 }];
  assert.deepEqual(rebase(off, '2024-01').map((p) => p.index), [100, 105]);
  approx(officialChange(off, '2024-01', '2024-06').pct, 5);
});

test('données migrées : totaux par mois identiques au Sheet', () => {
  const seed = JSON.parse(readFileSync(new URL('../data/seed.json', import.meta.url)));
  const all = joinLines(seed, { inScopeOnly: false });
  const sheetTotal = seed.lines.reduce((a, l) => a + l.amount, 0);
  // Total de la feuille Historique (5 676,18 $) moins les 16 dépenses hors épicerie retirées
  // du jeu de départ (assurances, CPE, téléphone, abonnement…) : 1 129,26 $.
  approx(sheetTotal, 5676.18 - 1129.26, 0.005);
  const total = all.reduce((a, l) => a + l.amount, 0);
  approx(total, 5682.29 - 1129.26, 0.005); // sans les 6 lignes de rabais/consignes négatives
  const months = spendByMonth(joinLines(seed)).map((m) => m.month);
  assert.deepEqual(months, ['2023-12', '2024-08', '2024-09', '2024-10', '2024-11', '2024-12', '2025-01', '2025-02', '2025-03', '2025-04', '2026-01']);
  const s = chainedIndex(monthlyPanel(joinLines(seed)));
  assert.equal(s[0].index, 100);
  assert.ok(s.every((p) => Number.isFinite(p.index)));
});

test('calcul : un produit nommé TPS ou TVQ n’entre jamais dans l’indice', () => {
  const f = fixture();
  f.products.push({ id: 'tvq', name: 'TVQ', unit: 'unité', category: 'autres' });
  f.lines.push({ id: 'x', receiptId: 'r1', productId: 'tvq', qty: 1, amount: 0.75 });
  assert.ok(joinLines(f).every((l) => l.productId !== 'tvq'));
});

test('contrôle de qualité : poids saisi comme quantité, quantité oubliée, écart, ligne validée', async () => {
  const { auditLines } = await import('../js/calc.js');
  const P = (id, unit) => ({ id, name: id, unit, category: 'fruits' });
  const mk = (id, p, qty, amount, extra = {}) => ({ id, productId: p.id, product: p, qty, amount, date: '2025-01-01', month: '2025-01', ...extra });
  const mangue = P('mangue', 'unité');
  const raisins = P('raisins', 'sac');
  const persil = P('persil', 'botte');
  const lines = [
    mk('m1', mangue, 1, 1.47), mk('m2', mangue, 1, 1.49), mk('m3', mangue, 1, 1.45), mk('m4', mangue, 1, 5.88),
    mk('r1', raisins, 0.98, 6.46),
    mk('p1', persil, 1, 1.99), mk('p2', persil, 1, 1.99), mk('p3', persil, 1, 5.49), mk('p4', persil, 1, 5.49, { review: 'ok' }),
  ];
  const f = auditLines(lines);
  assert.deepEqual(f.get('m4').fixes[0].patch, { qty: 4 });
  assert.deepEqual(f.get('r1').fixes[0].patch, { unit: 'kg' });
  assert.equal(f.get('p3').kind, 'ecart');
  assert.ok(!f.has('p4'));
  assert.ok(!f.has('m1'));
});

test('plus fortes hausses : un prix isolé ne fait pas la tendance', async () => {
  const { movers } = await import('../js/calc.js');
  const p = { id: 'b', name: 'Banane', unit: 'unité', category: 'fruits' };
  const ls = [['2024-01-05', 2.0], ['2024-02-05', 2.1], ['2025-01-05', 4.6], ['2025-02-05', 2.3]]
    .map(([date, amount], i) => ({ id: `l${i}`, productId: 'b', qty: 1, amount, date, product: p }));
  const [m] = movers(ls);
  approx(m.first, 2.05, 1e-9);
  approx(m.last, 3.45, 1e-9); // médiane de 4,60 et 2,30, et non 2,30 seul ni 4,60 seul
});

test('IPC officiel : publié avec un mois de retard, jamais avant le mois de départ', () => {
  const off = [{ month: '2025-01', value: 100 }, { month: '2025-12', value: 104 }];
  const c = officialChange(off, '2025-01', '2026-01');
  assert.equal(c.to, '2025-12');
  approx(c.pct, 4, 1e-9);
  assert.equal(officialChange(off, '2025-12', '2026-01'), null);
});

test('indice multilatéral : identique au lien direct entre deux mois, sans dérive sur un aller-retour de prix', async () => {
  const { multilateralIndex, rollingPanel } = await import('../js/calc.js');
  const row = (prices) => new Map(Object.entries(prices).map(([id, price]) => [id, { spend: price, qty: 1, price, category: 'fruits' }]));
  // Deux mois : même résultat que le lien de Törnqvist
  const two = new Map([['2025-01', row({ a: 1, b: 2, c: 3, d: 4, e: 5 })], ['2025-02', row({ a: 1.1, b: 2.2, c: 3.3, d: 4.4, e: 5.5 })]]);
  approx(multilateralIndex(two)[1].index, 110, 1e-9);
  // Soldes qui vont et viennent avec des quantités qui suivent : le chaînage dérive, pas le multilatéral
  const m = (pa, qa) => new Map([['a', { spend: pa * qa, qty: qa, price: pa, category: 'x' }], ['b', { spend: 2 * 1, qty: 1, price: 2, category: 'x' }]]);
  const bounce = new Map([['2025-01', m(1, 1)], ['2025-02', m(0.5, 6)], ['2025-03', m(0.8, 3)], ['2025-04', m(1, 1)]]);
  const geks = multilateralIndex(bounce);
  approx(geks.at(-1).index, 100, 1e-9); // mêmes prix qu'au départ : 100
  const chain = chainedIndex(bounce);
  assert.ok(Math.abs(chain.at(-1).index - 100) > 0.5, `le chaînage, lui, s’éloigne de 100 (${chain.at(-1).index})`);
  // Premier mois isolé : les autres mois restent comparables entre eux
  const iso = new Map([['2024-01', row({ z: 9 })], ...two]);
  const s = multilateralIndex(iso);
  assert.equal(s[0].reliable, false);
  approx(s[2].index / s[1].index, 1.1, 1e-9);
  // Fenêtres mobiles : 6 mois civils, nombre de mois observés
  const w = rollingPanel(new Map([['2025-01', row({ a: 1 })], ['2025-03', row({ a: 2 })], ['2025-08', row({ a: 4 })]]));
  assert.equal(w.get('2025-03').get('a').price, 1.5);
  assert.equal(w.get('2025-03').nMonths, 2);
  assert.equal(w.get('2025-08').nMonths, 2); // mars et août
});

test('fiabilité : reçu validé, prix cohérent, format différent, comparaison au gramme', async () => {
  const { assessLines } = await import('../js/calc.js');
  const P = { id: 'b', name: 'Banane bio', unit: 'unité', category: 'fruits' };
  const L = (id, amount, extra = {}) => ({ id, productId: 'b', qty: 1, amount, product: P, date: '2025-01-01', ...extra });
  const ls = [L('a', 2.0), L('b', 2.1), L('c', 1.9), L('d', 4.05), L('e', 4.05, { validated: true })];
  const t = assessLines(ls, new Map());
  assert.equal(t.get('a').tier, 'fiable');
  assert.equal(t.get('d').tier, 'aConfirmer'); // un régime saisi « à l'unité »
  assert.match(t.get('d').why, /format, poids ou unité/);
  assert.equal(t.get('e').tier, 'fiable'); // reçu validé : la parole de l'utilisateur
  assert.equal(t.get('e').why, 'Reçu validé');
  // Format connu : 2 × 500 g à 4 $ et 1 kg à 7,80 $ ont le même prix au gramme à 3 % près
  const Q = { id: 'f', name: 'Fraises', unit: 'contenant', category: 'fruits' };
  const S = (id, amount, sizeQty) => ({ id, productId: 'f', qty: 1, amount, sizeQty, sizeUnit: 'g', product: Q });
  const u = assessLines([S('x', 4, 500), S('y', 4.1, 500), S('z', 7.8, 1000)], new Map());
  assert.equal(u.get('z').tier, 'fiable');
  // Seul achat d'un produit : rien à comparer, il reste fiable
  assert.equal(assessLines([L('solo', 9)], new Map()).get('solo').tier, 'fiable');
});

test('fiabilité : deux achats du simple au double, les deux sont à confirmer', async () => {
  const { assessLines } = await import('../js/calc.js');
  const P = { id: 'b', name: 'Avocats', unit: 'unité', category: 'fruits' };
  const t = assessLines([2.98, 6.0].map((amount, i) => ({ id: `l${i}`, productId: 'b', qty: 1, amount, product: P })), new Map());
  assert.deepEqual([...t.values()].map((x) => x.tier), ['aConfirmer', 'aConfirmer']);
});
