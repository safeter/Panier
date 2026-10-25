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
  approx(sheetTotal, 5676.18, 0.005); // total de la feuille Historique
  const total = all.reduce((a, l) => a + l.amount, 0);
  approx(total, 5682.29, 0.005); // sans les 6 lignes de rabais/consignes négatives
  const months = spendByMonth(joinLines(seed)).map((m) => m.month);
  assert.deepEqual(months, ['2023-12', '2024-08', '2024-09', '2024-10', '2024-11', '2024-12', '2025-01', '2025-02', '2025-03', '2025-04', '2026-01']);
  const s = chainedIndex(monthlyPanel(joinLines(seed)));
  assert.equal(s[0].index, 100);
  assert.ok(s.every((p) => Number.isFinite(p.index)));
});
