import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanOcrLines } from '../js/ocrclean.js';
import { parseReceiptText } from '../js/pdfparse.js';

test('répare les prix mal lus', () => {
  const l = cleanOcrLines('LAIT 2% 4, 99 S\nPAIN | 3 ,49\nBEURRE 5,O9\n\n_\n');
  assert.deepEqual(l, ['LAIT 2% 4,99 $', 'PAIN 3,49', 'BEURRE 5,09']);
});

test('le texte nettoyé passe dans le parseur de reçus', () => {
  const lines = cleanOcrLines('SUPER C\n2024-05-03\nBANANES 2,19 FP\nFROMAGE CHEDDAR 6, 49\nTOTAL 8,68');
  const r = parseReceiptText(lines);
  assert.equal(r.store, 'Super C');
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[1].amount, 6.49);
});

test('texte vide', () => assert.deepEqual(cleanOcrLines(''), []));
