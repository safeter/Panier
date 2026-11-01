import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanOcrLines, cleanName, rowsFromFragments } from '../js/ocrclean.js';
import { parseReceiptText, guessCategory } from '../js/pdfparse.js';

test('répare les prix mal lus', () => {
  const l = cleanOcrLines('LAIT 2% 4, 99 S\nPAIN | 3 ,49\nBEURRE 5,O9\n\n_\n');
  assert.deepEqual(l, ['LAIT 2% 4,99 $', 'PAIN 3,49', 'BEURRE 5,09']);
});

test('le texte nettoyé passe dans le parseur de reçus', () => {
  const lines = cleanOcrLines('SUPER C\n2024-05-03\nBANANES 2,19 FP\nFROMAGE CHEDDAR 6, 49\nTOTAL 8,68');
  const r = parseReceiptText(lines);
  assert.equal(r.store, 'Super C');
  assert.equal(r.date, '2024-05-03');
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[1].amount, 6.49);
});

test('codes-barres, PLU et codes de taxe retirés du nom', () => {
  assert.equal(cleanName('06038301714 MANDARIN FM MRJ'), 'MANDARIN FM');
  assert.equal(cleanName('sc 065633134665 GENM CEREALES MRy'), 'GENM CEREALES');
  assert.equal(cleanName('(2)03338370278 COURONNE BROCOLI MRI'), 'COURONNE BROCOLI');
  assert.equal(cleanName('4011 BANANES'), 'BANANES');
});

// Texte tel que lu sur une vraie photo de reçu Provigo (erreurs de l'OCR comprises).
const PROVIGO = `Provigo
PGO ST-LAURENT (#5290)
21-EPICERIE
06563313465 GENM CEREALES MRJ 7.00
Prix des membres MRJ -1,00
CHEERIOS 100 Pts
22-PRODUITS LAITIERS
05680052108 OIKO NAT XTR CRE MRJ 7.50
06038315209 SN CHED MRBRE LG MRJ
$5.99 ch ou 2/811.00 KB
2 @ 2/$11.00
27-FRUITS ET LEGUMES
(2)03338370278 COURONNE BROCOLI MRI
2 & $2.00 » 4.00
3488 MANGUE ROUGE MRJ
$1.80 ch ou 3/$4.98 KB
3 6 3/84.98 4,38
4011 BANANES MRJ
1.475 ka 6 s1.96/k10 22.60,
35-CHARCUTERIE
77033302401 FSAN HUMM NX PIN MRJ 4.00
SOUS-TOTAL 40.37
TOTAL 40.37`;

test('reçu Provigo : quantités et poids sur la ligne suivante, offres, rabais membre', () => {
  const r = parseReceiptText(cleanOcrLines(PROVIGO));
  assert.equal(r.store, 'Provigo');
  assert.deepEqual(r.lines.map((l) => [l.name, l.qty, l.amount]), [
    ['GENM CEREALES', 1, 6],
    ['OIKO NAT XTR CRE', 1, 7.5],
    ['SN CHED MRBRE LG', 2, 11],      // 2 @ 2/11,00 : montant recalculé, le montant imprimé manquait
    ['COURONNE BROCOLI', 2, 4],
    ['MANGUE ROUGE', 3, 4.98],        // « 3/84.98 » et « 4,38 » mal lus : 3 @ 3/4,98 donne 4,98
    ['BANANES', 1.475, 2.89],         // 1,475 kg × 1,96 = 2,89 (montant lu « 22.60 »)
    ['FSAN HUMM NX PIN', 1, 4],
  ]);
  assert.equal(r.subtotal, 40.37);
  assert.equal(r.lines.reduce((a, l) => a + l.amount, 0).toFixed(2), '40.37');
  assert.equal(r.lines[0].regularPrice, 7);
  assert.equal(guessCategory(r.lines[1].name, r.lines[1].section), 'laitiers');
  assert.equal(guessCategory(r.lines[6].name, r.lines[6].section), 'viande');
});

test('un rabais plus grand que le prix (mauvaise lecture) n’est pas appliqué', () => {
  const r = parseReceiptText(['CEREALES 1.00', 'Prix des membres -1,00']);
  assert.equal(r.lines[0].amount, 1);
});

test('lignes courbes : le prix à droite rejoint son produit', () => {
  // Reçu froissé : la ligne descend de 0,05 px par px ; les prix sont 30 px plus bas que le début du nom.
  const frag = (text, x0, y0, w) => ({ text, x0, y0, x1: x0 + w, y1: y0 + 30, slope: 0.05 });
  const rows = rowsFromFragments([
    frag('LAIT 2% 2L', 100, 100, 400), frag('5,49', 700, 130, 80),
    frag('PAIN BLANC', 100, 150, 400), frag('3,29', 700, 180, 80),
    frag('OEUFS', 100, 200, 200), frag('4,79', 700, 230, 80),
  ]);
  assert.deepEqual(rows, ['LAIT 2% 2L 5,49', 'PAIN BLANC 3,29', 'OEUFS 4,79']);
});

test('texte vide', () => assert.deepEqual(cleanOcrLines(''), []));
