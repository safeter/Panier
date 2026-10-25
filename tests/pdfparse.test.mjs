import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReceiptText, findDate, findStore } from '../js/pdfparse.js';

test('dates : formats québécois, anglais et ISO', () => {
  assert.equal(findDate('Commande du 14 octobre 2026'), '2026-10-14');
  assert.equal(findDate('Livraison : 1er mars 2026'), '2026-03-01');
  assert.equal(findDate('Order date: Oct 7, 2026'), '2026-10-07');
  assert.equal(findDate('Date 05/09/2026 12:41'), '2026-09-05');
  assert.equal(findDate('2026-05-14'), '2026-05-14');
});

test('magasin reconnu', () => {
  assert.equal(findStore('Merci de soutenir les Fermes Lufa'), 'Fermes Lufa');
  assert.equal(findStore('SUPER C #8641'), 'Super C');
});

test('commande en colonnes (style Lufa) : quantité, prix unitaire, total', () => {
  const r = parseReceiptText([
    'Fermes Lufa — Récapitulatif de votre commande',
    'Livraison prévue le 22 octobre 2026',
    'Produit Qté Prix Total',
    'Laitue Boston de Lufa (1 tête) 1 4,25 $ 4,25 $',
    'Tomates cerises 300 g 2 5,50 $ 11,00 $',
    'Pain au levain, Boulangerie Guillaume 1 7,95 $ 7,95 $',
    'Sous-total 23,20 $',
    'Frais de livraison 0,00 $',
    'Total 23,20 $',
  ]);
  assert.equal(r.store, 'Fermes Lufa');
  assert.equal(r.date, '2026-10-22');
  assert.equal(r.total, 23.2);
  assert.equal(r.lines.length, 3);
  assert.deepEqual(r.lines.map((l) => [l.name, l.qty, l.amount]), [
    ['Laitue Boston de Lufa (1 tête)', 1, 4.25],
    ['Tomates cerises 300 g', 2, 11],
    ['Pain au levain, Boulangerie Guillaume', 1, 7.95],
  ]);
  assert.equal(r.lines[1].size, '300 g');
});

test('reçu de caisse : rabais, poids au kg, taxes ignorées', () => {
  const r = parseReceiptText([
    'SUPER C',
    '2026/10/24',
    'LAIT 3,25% 2L 6,49',
    'RABAIS -1,00',
    'BANANES BIO 1,040 kg @ 2,62 $/kg 2,72',
    '2 x YOGOURT OIKOS 4,98',
    'TPS 0,25',
    'TVQ 0,50',
    'TOTAL 14,94',
    'VISA 14,94',
  ]);
  assert.equal(r.date, '2026-10-24');
  assert.equal(r.lines.length, 3);
  assert.equal(r.lines[0].name, 'LAIT 3,25% 2L');
  assert.equal(r.lines[0].amount, 5.49);
  assert.equal(r.lines[0].regularPrice, 6.49);
  assert.equal(r.lines[1].name, 'BANANES BIO');
  assert.equal(r.lines[1].qty, 1.04);
  assert.equal(r.lines[1].unit, 'kg');
  assert.equal(r.lines[2].qty, 2);
  assert.equal(r.lines[2].name, 'YOGOURT OIKOS');
  assert.equal(r.total, 14.94);
});

test('facture réelle Fermes Lufa : prix révisés au poids réel, livraison et taxes exclues', async () => {
  const { readFileSync } = await import('node:fs');
  const { guessCategory } = await import('../js/pdfparse.js');
  const text = readFileSync(new URL('./fixtures/lufa-2026-10-24.txt', import.meta.url), 'utf8').split('\n');
  const r = parseReceiptText(text);
  assert.equal(r.store, 'Fermes Lufa');
  assert.equal(r.date, '2026-10-24');
  assert.equal(r.total, 63.19);
  assert.equal(r.lines.length, 14);
  assert.equal(Math.round(r.lines.reduce((a, l) => a + l.amount, 0) * 100) / 100, 56.04);
  const tomates = r.lines[0];
  assert.deepEqual([tomates.name, tomates.amount, tomates.size], ['Tomates cerises multicolores', 3.57, '383 g']);
  const porc = r.lines.find((l) => l.name.startsWith('Filet de porc'));
  assert.equal(porc.amount, 7.48);
  assert.equal(guessCategory(porc.name), 'viande');
  assert.equal(guessCategory('Cheddar râpé biologique'), 'laitiers');
  assert.equal(guessCategory('Poires Bartlett'), 'fruits');
  assert.equal(guessCategory('Bok choy Black Summer'), 'legumes');
  assert.equal(guessCategory('Nouilles ramen (sèches)'), 'boulangerie');
});

test('taxes : lignes TPS/TVQ jamais retenues, codes de taxe en fin de ligne tolérés', () => {
  const r = parseReceiptText([
    'MAXI 2026-10-20',
    'CHIPS DORITOS 4,99 FP',
    'BOISSON GAZEUSE 2,49 T',
    'POMMES GALA 3,99',
    'TPS 5% 0,37',
    'TVQ 9,975% 0,75',
    '** TAXES 1,12',
    'GST/HST 0,37',
    'TOTAL 12,59',
  ]);
  assert.deepEqual(r.lines.map((l) => [l.name, l.amount]), [['CHIPS DORITOS', 4.99], ['BOISSON GAZEUSE', 2.49], ['POMMES GALA', 3.99]]);
});
