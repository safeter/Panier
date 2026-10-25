import * as db from './db.js';
import * as calc from './calc.js';
import { CATEGORIES, CAT, IN_SCOPE } from './categories.js';
import { $, $$, esc, fmtMoney, fmtPct, fmtMonth, fmtDate, today, uid, slug, toast, num, parseSize, fmtSize } from './util.js';
import { indexChart, spendBars, effectBars, priceSpark } from './charts.js';
import { planImport } from './importer.js';
import { parseReceiptText, guessCategory } from './pdfparse.js';
import { pushPending, pushDelete, pendingLines, newToken } from './sync.js';
import { exportExcel, exportJSON } from './excel.js';

const UNITS = ['unité', 'kg', 'sac', 'paquet', 'boîte', 'contenant', 'bouteille', 'pot', 'litre', 'carton', 'botte', 'pain', 'douzaine', 'tablette'];

const state = {
  data: { stores: [], products: [], receipts: [], lines: [] },
  official: { points: [] },
  settings: { region: '', sheetUrl: '', sheetToken: '' },
  sync: { last: null, error: null, busy: false },
  view: null,
  draft: null,
};

// ---------- Données dérivées ----------
function derive() {
  const d = state.data;
  const joined = calc.joinLines(d);
  const panel = calc.monthlyPanel(joined);
  const series = calc.chainedIndex(panel);
  // Le résumé s'arrête au dernier mois assez complet : un mois qui commence (1 ou 2 reçus)
  // compte trop peu de produits comparables pour un chiffre fiable.
  let end = series.length - 1;
  while (end > 0 && !series[end].reliable) end--;
  const head = calc.headlineInflation(series.slice(0, end + 1));
  const pending = end < series.length - 1 ? series.slice(end + 1) : [];
  const official = state.official.points || [];
  const P = new Map(d.products.map((p) => [p.id, p]));
  const byProduct = new Map();
  for (const l of joined) {
    if (!byProduct.has(l.productId)) byProduct.set(l.productId, []);
    byProduct.get(l.productId).push(l);
  }
  const alerts = [];
  for (const [id] of byProduct) {
    const h = calc.priceHistory(joined, id);
    for (const a of calc.alertsFor(h)) alerts.push({ productId: id, name: P.get(id)?.name, ...a, last: h.at(-1) });
  }
  state.derived = { joined, panel, series, head, pending, official, byProduct, alerts, alertIds: new Set(alerts.map((a) => a.productId)) };
}

async function reload() {
  state.data = await db.loadAll();
  derive();
}

async function trySync({ quiet = true } = {}) {
  if (!state.settings.sheetUrl || state.sync.busy || !navigator.onLine) return null;
  state.sync.busy = true;
  try {
    const added = await pushPending(state.data, state.settings);
    if (added !== null) {
      state.data = await db.loadAll();
      derive();
      state.sync = { last: new Date().toISOString(), error: null, busy: false };
      if (added > 0 || !quiet) toast(added > 0 ? `${added} ligne(s) ajoutée(s) au Google Sheet.` : 'Google Sheet à jour.', 'ok');
    }
    return added;
  } catch (err) {
    state.sync = { ...state.sync, error: err.message, busy: false };
    if (!quiet) toast(`Envoi au Google Sheet impossible : ${err.message}`, 'error');
    return null;
  } finally {
    state.sync.busy = false;
  }
}

const storeName = (id) => state.data.stores.find((s) => s.id === id)?.name || id;

// ---------- Routeur ----------
const routes = [
  [/^#?\/?$/, viewDashboard],
  [/^#\/ajouter$/, viewAdd],
  [/^#\/produits(?:\?.*)?$/, viewProducts],
  [/^#\/produits\/(.+)$/, viewProduct],
  [/^#\/recus$/, viewReceipts],
  [/^#\/recus\/(.+)$/, viewReceipt],
  [/^#\/reglages$/, viewSettings],
];

function render() {
  const hash = location.hash || '#/';
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      const main = $('#view');
      main.innerHTML = fn(...m.slice(1).map(decodeURIComponent));
      main.focus({ preventScroll: true });
      window.scrollTo(0, 0);
      $$('.tabbar a').forEach((a) => a.setAttribute('aria-current', hash.startsWith(a.getAttribute('href')) && (a.getAttribute('href') !== '#/' || hash === '#/') ? 'page' : 'false'));
      state.after?.();
      state.after = null;
      return;
    }
  }
  location.hash = '#/';
}

// ---------- Tableau de bord ----------
function leader(label, value, cls = '', note = '') {
  return `<div class="leader ${cls}"><span class="l-label">${label}</span><span class="l-dots" aria-hidden="true"></span><span class="l-value">${value}</span></div>${note ? `<p class="l-note">${note}</p>` : ''}`;
}

function viewDashboard() {
  const { series, head, pending, panel, official, joined, alerts } = state.derived;
  if (!joined.length) {
    return `<section class="empty"><h1>Commence ton suivi</h1><p>Ajoute un premier reçu : l'indice apparaît dès le deuxième mois.</p><a class="btn primary" href="#/ajouter">Ajouter un reçu</a></section>`;
  }
  const lastDate = joined.reduce((a, l) => (l.date > a ? l.date : a), '');
  const staleMonths = calc.monthsBetween(calc.monthOf(lastDate), calc.monthOf(today()));
  const offCh = head ? calc.officialChange(official, head.from, head.to) : null;
  const dec = head ? calc.decompose(panel, series, head.from, head.to) : null;
  const rebased = calc.rebase(official, series[0].month);
  const period = head ? `${fmtMonth(head.from)} → ${fmtMonth(head.to)}` : '';
  const kindNote = head?.kind === '12mois' ? 'Sur 12 mois' : `Depuis le début (${head?.months} mois)`;

  const gap = offCh && head ? head.pct - offCh.pct : null;
  const pts = (x) => Math.abs(x).toLocaleString('fr-CA', { maximumFractionDigits: 1 });
  const verdict = gap === null ? '' : Math.abs(gap) < 1
    ? 'Mes prix suivent l’inflation alimentaire du Québec.'
    : gap > 0 ? `Mes prix ont évolué ${pts(gap)} points au-dessus de l’IPC du Québec.`
      : `Mes prix ont évolué ${pts(gap)} points sous l’IPC du Québec.`;
  const pendingNote = pending.length
    ? `<p class="l-note pending">${pending.map((p) => `${fmtMonth(p.month)} : ${p.matched || 0} produit${(p.matched || 0) > 1 ? 's' : ''} comparable${(p.matched || 0) > 1 ? 's' : ''}`).join(' · ')}. Le chiffre inclura ce mois dès ${calc.MIN_MATCHED} produits déjà achetés auparavant.</p>` : '';

  // Catégories
  const last12 = joined.filter((l) => calc.monthsBetween(l.month, head?.to || calc.monthOf(lastDate)) < 12);
  const spend12 = last12.reduce((a, l) => a + l.amount, 0) || 1;
  const catRows = IN_SCOPE.map((c) => {
    const s = calc.chainedIndex(panel, (v) => v.category === c.id);
    const h = calc.headlineInflation(s);
    const share = last12.filter((l) => l.product.category === c.id).reduce((a, l) => a + l.amount, 0) / spend12;
    const weak = s.slice(1).filter((p) => !p.reliable).length > s.length / 2;
    return { c, h, share, weak };
  }).sort((a, b) => b.share - a.share);

  const mv = calc.movers(joined);
  const ups = mv.filter((m) => m.pct > 0).slice(0, 5);
  const downs = mv.filter((m) => m.pct < 0).slice(-5).reverse();
  const moverList = (xs) => xs.map((m) => `<li><a href="#/produits/${encodeURIComponent(m.productId)}"><span>${esc(m.name)}</span><span class="${m.pct > 0 ? 'up' : 'down'}">${fmtPct(m.pct, 0)}</span></a><small>${esc(fmtMoney(m.first))} → ${esc(fmtMoney(m.last))}</small></li>`).join('');

  return `
  <header class="page-head">
    <h1>Mon panier</h1>
    <p class="muted">Dernier achat le ${esc(fmtDate(lastDate))}</p>
  </header>
  ${staleMonths >= 2 ? `<a class="notice" href="#/ajouter"><strong>Aucun achat depuis ${staleMonths} mois.</strong> Ajoute tes prochains reçus pour reprendre le suivi mensuel.</a>` : ''}

  <section class="receipt" aria-labelledby="t-sum">
    <h2 id="t-sum" class="receipt-title">${kindNote}<span>${esc(period)}</span></h2>
    ${leader('Mes prix', fmtPct(head?.pct), 'big')}
    ${leader('IPC Québec, aliments en magasin', offCh ? fmtPct(offCh.pct) : 'en attente', 'qc', offCh ? '' : 'La série officielle se met à jour automatiquement chaque mois.')}
    ${dec ? leader('Mes dépenses d’épicerie', fmtPct(dec.totalPct)) : ''}
    ${verdict ? `<p class="verdict">${esc(verdict)}</p>` : ''}
    ${pendingNote}
  </section>

  ${dec ? `<section class="block"><h2>Pourquoi ma facture a changé</h2>
    <p class="muted">${esc(fmtMonth(dec.m0))} : ${esc(fmtMoney(dec.spend0))} · ${esc(fmtMonth(dec.m1))} : ${esc(fmtMoney(dec.spend1))}</p>
    ${effectBars(dec)}</section>` : ''}

  <section class="block"><h2>Mon indice des prix</h2>
    <div class="legend"><span class="k me">Mon panier</span>${rebased.length ? '<span class="k qc">IPC Québec</span>' : ''}<span class="k dash">Lien incertain ou mois manquants</span></div>
    ${indexChart(series, rebased)}
    <p class="muted small">Base 100 = ${esc(fmtMonth(series[0].month))}. ${series.filter((p) => !p.reliable).length} lien(s) sur ${series.length - 1} reposent sur moins de ${calc.MIN_MATCHED} produits communs.</p>
  </section>

  <section class="block"><h2>Par catégorie</h2>
    <p class="muted small">Part des dépenses sur 12 mois et variation des prix depuis le premier mois de la catégorie.</p>
    <ul class="cats">${catRows.map(({ c, h, share, weak }) => `<li>
      <div class="cat-line"><span>${esc(c.short)}</span><span class="${h && h.pct > 0 ? 'up' : 'down'}">${h ? fmtPct(h.pct) : '—'}${weak ? '<abbr title="Peu de produits comparables">*</abbr>' : ''}</span></div>
      <div class="share"><span style="width:${(share * 100).toFixed(1)}%"></span></div>
      <small>${Math.round(share * 100)} % des dépenses</small></li>`).join('')}</ul>
  </section>

  <section class="block two"><div><h2>Plus fortes hausses</h2><ul class="movers">${moverList(ups) || '<li class="muted">Pas assez d’achats répétés.</li>'}</ul></div>
    <div><h2>Plus fortes baisses</h2><ul class="movers">${moverList(downs) || '<li class="muted">Aucune.</li>'}</ul></div></section>

  <section class="block"><h2>Dépenses par mois</h2>${spendBars(calc.spendByMonth(joined))}
    <p class="muted small">Épicerie seulement ; ${state.data.products.filter((p) => p.category === 'hors').length} produits hors périmètre exclus.</p></section>

  ${alerts.length ? `<a class="block link-block" href="#/produits?alertes"><h2>${alerts.length} alerte(s) de prix</h2><p class="muted">Prix élevés, prix planchers et formats réduits sur tes produits.</p></a>` : ''}
  `;
}

// ---------- Ajouter un reçu ----------
const emptyLine = () => ({ name: '', productId: null, qty: '1', amount: '', size: '', regularPrice: '', category: 'autres', unit: 'unité', confidence: null, raw: '' });

function findProduct(name, unit) {
  const n = slug(name);
  const cands = state.data.products.filter((p) => slug(p.name) === n);
  return cands.find((p) => !unit || p.unit === unit) || cands[0] || null;
}

function viewAdd() {
  if (!state.draft) state.draft = { date: today(), store: '', lines: [emptyLine(), emptyLine(), emptyLine()] };
  const d = state.draft;
  const names = [...new Set(state.data.products.filter((p) => p.category !== 'hors').map((p) => p.name))].sort((a, b) => a.localeCompare(b, 'fr'));
  state.after = () => bindAdd();
  return `
  <header class="page-head"><h1>Ajouter un reçu</h1></header>
  <section class="scan-box">
    <label class="btn primary file"><input type="file" id="pdf-file" accept="application/pdf,.pdf">Lire un PDF (Lufa, reçu en ligne…)</label>
    <label class="btn file"><input type="file" id="import-file" accept="application/json,.json">Importer un fichier de reçus préparé par Claude</label>
    <p class="muted small" id="import-status">Le PDF est lu sur ce téléphone ; tu vérifies les lignes avant d’enregistrer. Les noms que tu corriges sont retenus pour les prochaines fois.</p>
  </section>
  <form id="receipt-form" class="block" autocomplete="off">
    <div class="row2">
      <label>Date<input type="date" name="date" value="${esc(d.date)}" required></label>
      <label>Magasin<input name="store" list="stores" value="${esc(d.store)}" placeholder="Super C" required></label>
    </div>
    <datalist id="stores">${state.data.stores.map((s) => `<option value="${esc(s.name)}">`).join('')}</datalist>
    <datalist id="products">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    ${frequentChips()}
    <div id="lines">${d.lines.map(lineRow).join('')}</div>
    <button type="button" class="btn ghost" id="add-line">Ajouter une ligne</button>
    <div class="total-line"><span>Total des lignes</span><strong id="sum">${fmtMoney(sumDraft())}</strong></div>
    <button class="btn primary wide" type="submit">Enregistrer le reçu</button>
  </form>`;
}

function lineRow(l, i) {
  const known = l.productId || findProduct(l.name);
  const low = l.confidence !== null && l.confidence < 0.7;
  return `<fieldset class="line${low ? ' low' : ''}" data-i="${i}">
    <legend class="sr-only">Ligne ${i + 1}</legend>
    ${l.raw ? `<p class="raw">${esc(l.raw)}${low ? ' · à vérifier' : ''}</p>` : ''}
    <input class="f-name" data-f="name" list="products" value="${esc(l.name)}" placeholder="Produit" aria-label="Produit">
    <div class="line-nums">
      <label>Qté<input data-f="qty" inputmode="decimal" value="${esc(l.qty)}"></label>
      <label>Montant $<input data-f="amount" inputmode="decimal" value="${esc(l.amount)}" placeholder="0,00"></label>
      <label>Format<input data-f="size" value="${esc(l.size)}" placeholder="500 g"></label>
      <button type="button" class="icon-btn" data-del="${i}" aria-label="Supprimer la ligne">×</button>
    </div>
    <div class="line-extra">
      <label class="nw" ${known || !l.name ? 'hidden' : ''}>Catégorie<select data-f="category">${CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === l.category ? 'selected' : ''}>${esc(c.short)}</option>`).join('')}</select></label>
      <label class="nw" ${known || !l.name ? 'hidden' : ''}>Unité<select data-f="unit">${UNITS.map((u) => `<option ${u === l.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
      <label>Prix régulier<input data-f="regularPrice" inputmode="decimal" value="${esc(l.regularPrice)}" placeholder="si en rabais"></label>
    </div>
    <p class="hint line-hint">${known ? `${esc(known.name)} · ${esc(CAT[known.category]?.short || '')} · ${esc(known.unit)}` : (l.name ? 'Nouveau produit : choisis sa catégorie.' : '')}</p>
  </fieldset>`;
}

const sumDraft = () => state.draft.lines.reduce((a, l) => a + (num(l.amount) || 0), 0);

function bindAdd() {
  const form = $('#receipt-form');
  form.addEventListener('input', (e) => {
    const t = e.target;
    if (t.name === 'date' || t.name === 'store') { state.draft[t.name] = t.value; return; }
    const fs = t.closest('fieldset.line');
    if (!fs) return;
    const l = state.draft.lines[Number(fs.dataset.i)];
    l[t.dataset.f] = t.value;
    if (t.dataset.f === 'name') {
      const p = findProduct(t.value);
      l.productId = p?.id || null;
      $$('.nw', fs).forEach((el) => { el.hidden = !!p || !t.value; });
      $('.line-hint', fs).textContent = p ? `${p.name} · ${CAT[p.category]?.short || ''} · ${p.unit}` : (t.value ? 'Nouveau produit : choisis sa catégorie.' : '');
    }
    $('#sum').textContent = fmtMoney(sumDraft());
  });
  form.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { state.draft.lines.splice(Number(del.dataset.del), 1); render(); }
  });
  $('#add-line').addEventListener('click', () => {
    state.draft.lines.push(emptyLine());
    render();
    state.after = null;
    const inputs = $$('.f-name');
    inputs.at(-1)?.focus();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await saveDraft(); } catch (err) { toast(err.message, 'error'); }
  });
  $('#import-file').addEventListener('change', onImportFile);
  $('#pdf-file').addEventListener('change', onPdfFile);
  $$('.chip[data-pid]').forEach((c) => c.addEventListener('click', () => addFrequent(c.dataset.pid)));
}

// Achats fréquents : un toucher ajoute la ligne avec la dernière quantité et le dernier prix payés.
function frequentProducts(limit = 16) {
  const { byProduct } = state.derived;
  return [...byProduct.entries()]
    .map(([id, ls]) => ({ id, n: ls.length, last: ls.reduce((a, l) => (l.date > a.date ? l : a)) }))
    .sort((a, b) => b.n - a.n)
    .slice(0, limit);
}

function frequentChips() {
  const used = new Set(state.draft.lines.map((l) => l.productId).filter(Boolean));
  const items = frequentProducts().filter((f) => !used.has(f.id));
  if (!items.length) return '';
  return `<div class="chips" aria-label="Achats fréquents"><p class="hint">Achats fréquents : touche pour ajouter avec le dernier prix payé.</p>
    ${items.map((f) => `<button type="button" class="chip" data-pid="${esc(f.id)}">${esc(f.last.product.name)}</button>`).join('')}</div>`;
}

function addFrequent(pid) {
  const f = frequentProducts(100).find((x) => x.id === pid);
  if (!f) return;
  const l = f.last;
  const line = { ...emptyLine(), name: l.product.name, productId: pid, unit: l.product.unit, category: l.product.category,
    qty: String(l.qty).replace('.', ','), amount: l.amount.toFixed(2).replace('.', ',') };
  const empty = state.draft.lines.findIndex((x) => !x.name.trim());
  if (empty >= 0) state.draft.lines[empty] = line; else state.draft.lines.push(line);
  render();
}

// Lecture d'un PDF : texte extrait sur l'appareil, lignes proposées, libellés appris au fil des corrections.
async function onPdfFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const status = $('#import-status');
  status.textContent = 'Lecture du PDF…';
  status.classList.remove('error');
  try {
    const { pdfToLines } = await import('./pdfimport.js');
    const text = await pdfToLines(file);
    const parsed = parseReceiptText(text);
    if (!parsed.lines.length) {
      status.textContent = text.length
        ? 'Aucune ligne de produit reconnue dans ce PDF. Envoie-le à Claude dans le projet Panier, ou saisis-le ci-dessous.'
        : 'Ce PDF ne contient pas de texte (c’est une image numérisée). Envoie-le à Claude dans le projet Panier.';
      status.classList.add('error');
      return;
    }
    const aliases = await db.getMeta('aliases', {});
    const P = new Map(state.data.products.map((p) => [p.id, p]));
    state.draft = {
      date: parsed.date || today(),
      store: parsed.store || '',
      lines: parsed.lines.map((l) => {
        const bare = l.name.replace(/\s*\d+(?:[,.]\d+)?\s?(?:kg|g|ml|l)\b/i, '').trim();
        const known = (aliases[slug(l.name)] && P.get(aliases[slug(l.name)]))
          || findProduct(l.name, l.unit === 'kg' ? 'kg' : undefined) || (bare !== l.name && findProduct(bare));
        return {
          ...emptyLine(),
          name: known ? known.name : l.name, productId: known?.id || null, rawName: l.name,
          unit: known ? known.unit : l.unit, category: known ? known.category : guessCategory(l.name),
          qty: String(l.qty).replace('.', ','), amount: l.amount.toFixed(2).replace('.', ','),
          size: l.size || '', regularPrice: l.regularPrice ? String(l.regularPrice).replace('.', ',') : '',
          raw: l.raw, confidence: known ? 0.9 : 0.5,
        };
      }),
    };
    const sum = parsed.lines.reduce((a, l) => a + l.amount, 0);
    render();
    const todo = state.draft.lines.filter((l) => !l.productId).length;
    toast(`${parsed.lines.length} lignes lues${todo ? `, ${todo} nouveaux produits à vérifier` : ''}${parsed.total ? ` · articles ${fmtMoney(sum)} (total du document avec taxes et frais : ${fmtMoney(parsed.total)})` : ''}.`);
  } catch (err) {
    status.textContent = `Lecture du PDF impossible : ${err.message}`;
    status.classList.add('error');
  } finally {
    e.target.value = '';
  }
}

async function onImportFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const status = $('#import-status');
  try {
    const payload = JSON.parse(await file.text());
    const plan = planImport(state.data, payload, uid);
    if (!plan.receipts.length) {
      status.textContent = `Rien à importer : ${plan.skipped.length} reçu(s) déjà présents.`;
      return;
    }
    const total = plan.lines.reduce((a, l) => a + l.amount, 0);
    const msg = `Importer ${plan.receipts.length} reçu(s), ${plan.lines.length} articles, ${fmtMoney(total)}`
      + `${plan.products.length ? `, dont ${plan.products.length} nouveaux produits` : ''}`
      + `${plan.skipped.length ? ` (${plan.skipped.length} déjà présents, ignorés)` : ''} ?`;
    if (!confirm(msg)) return;
    if (plan.stores.length) await db.put('stores', plan.stores);
    if (plan.products.length) await db.put('products', plan.products);
    await db.put('receipts', plan.receipts);
    await db.put('lines', plan.lines);
    await reload();
    toast(`${plan.receipts.length} reçu(s) importé(s).`, 'ok');
    trySync();
    location.hash = '#/';
  } catch (err) {
    status.textContent = err instanceof SyntaxError ? 'Ce fichier n’est pas un fichier de reçus valide.' : err.message;
    status.classList.add('error');
  } finally {
    e.target.value = '';
  }
}

async function saveDraft() {
  const d = state.draft;
  const lines = d.lines.filter((l) => l.name.trim() && num(l.amount));
  if (!lines.length) throw new Error('Ajoute au moins une ligne avec un produit et un montant.');
  if (!d.store.trim()) throw new Error('Indique le magasin.');
  let store = state.data.stores.find((s) => slug(s.name) === slug(d.store));
  const newStores = [];
  if (!store) { store = { id: slug(d.store), name: d.store.trim() }; newStores.push(store); }
  const receipt = { id: uid('r'), date: d.date, storeId: store.id, source: d.lines.some((l) => l.rawName) ? 'pdf' : 'manuel', total: null, createdAt: new Date().toISOString() };
  const newProducts = [];
  const outLines = lines.map((l) => {
    let p = (l.productId && state.data.products.find((x) => x.id === l.productId)) || findProduct(l.name, l.unit);
    if (!p) {
      const id = `${slug(l.name)}--${slug(l.unit)}`;
      p = newProducts.find((x) => x.id === id) || { id, name: l.name.trim(), unit: l.unit, category: l.category, type: slug(l.name) };
      if (!newProducts.includes(p)) newProducts.push(p);
    }
    const size = parseSize(l.size);
    return {
      id: uid('l'), receiptId: receipt.id, productId: p.id, qty: num(l.qty) || 1, amount: Math.round(num(l.amount) * 100) / 100,
      regularPrice: num(l.regularPrice), sizeQty: size?.qty ?? null, sizeUnit: size?.unit ?? null,
    };
  });
  // Retient « libellé du document → produit » pour reconnaître ce libellé automatiquement la prochaine fois.
  const learned = lines.filter((l) => l.rawName);
  if (learned.length) {
    const aliases = await db.getMeta('aliases', {});
    learned.forEach((l, i) => {
      const outLine = outLines[lines.indexOf(l)];
      if (outLine) aliases[slug(l.rawName)] = outLine.productId;
    });
    await db.setMeta('aliases', aliases);
  }
  if (newStores.length) await db.put('stores', newStores);
  if (newProducts.length) await db.put('products', newProducts);
  await db.put('receipts', receipt);
  await db.put('lines', outLines);
  state.draft = null;
  await reload();
  toast(`Reçu enregistré : ${outLines.length} articles, ${fmtMoney(outLines.reduce((a, l) => a + l.amount, 0))}.`, 'ok');
  trySync();
  location.hash = '#/';
}

// ---------- Produits ----------
function viewProducts() {
  const onlyAlerts = location.hash.includes('alertes') || location.search.includes('alertes');
  const { byProduct, alerts } = state.derived;
  const A = new Map();
  alerts.forEach((a) => { if (!A.has(a.productId)) A.set(a.productId, []); A.get(a.productId).push(a); });
  const rows = state.data.products.map((p) => {
    const ls = (byProduct.get(p.id) || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const last = ls.at(-1);
    return { p, n: ls.length, last, alerts: A.get(p.id) || [] };
  }).sort((a, b) => b.n - a.n || a.p.name.localeCompare(b.p.name, 'fr'));
  state.after = () => {
    const input = $('#q');
    const filter = () => {
      const q = slug(input.value);
      const cat = $('#cat').value;
      $$('#plist li').forEach((li) => {
        const ok = (!q || li.dataset.s.includes(q)) && (!cat || li.dataset.c === cat) && (!$('#al').checked || li.dataset.a === '1');
        li.hidden = !ok;
      });
    };
    input.addEventListener('input', filter);
    $('#cat').addEventListener('change', filter);
    $('#al').addEventListener('change', filter);
    filter();
  };
  const badge = (a) => a.kind === 'cher' ? `<span class="badge up">${fmtPct(a.pct, 0)} vs médiane</span>`
    : a.kind === 'plancher' ? '<span class="badge down">Prix plancher</span>'
      : `<span class="badge warn">Format −${Math.round(a.pct)} %</span>`;
  return `
  <header class="page-head"><h1>Produits</h1><p class="muted">${state.data.products.length} produits suivis</p></header>
  <div class="filters">
    <input id="q" type="search" placeholder="Rechercher un produit" aria-label="Rechercher un produit">
    <div class="row2">
      <select id="cat" aria-label="Catégorie"><option value="">Toutes les catégories</option>${CATEGORIES.map((c) => `<option value="${c.id}">${esc(c.short)}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" id="al" ${onlyAlerts ? 'checked' : ''}> Avec alerte</label>
    </div>
  </div>
  <ul id="plist" class="plist">${rows.map((r) => `<li data-s="${esc(slug(r.p.name))}" data-c="${r.p.category}" data-a="${r.alerts.length ? 1 : 0}">
    <a href="#/produits/${encodeURIComponent(r.p.id)}">
      <span class="p-name">${esc(r.p.name)}<small>${esc(CAT[r.p.category]?.short || '')} · ${esc(r.p.unit)} · ${r.n} achat${r.n > 1 ? 's' : ''}</small></span>
      <span class="p-price">${r.last ? esc(fmtMoney(calc.unitPrice(r.last))) : '—'}${r.alerts.map(badge).join('')}</span>
    </a></li>`).join('')}</ul>`;
}

function viewProduct(id) {
  const p = state.data.products.find((x) => x.id === id);
  if (!p) return '<p>Produit introuvable.</p>';
  const h = calc.priceHistory(calc.joinLines(state.data, { inScopeOnly: false }), id);
  const med = calc.median(h.map((x) => x.price));
  const alerts = calc.alertsFor(h);
  state.after = () => {
    $('#pform').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      await db.put('products', { ...p, name: f.get('name').trim() || p.name, category: f.get('category') });
      await reload();
      toast('Produit mis à jour.', 'ok');
      render();
    });
  };
  return `
  <a class="back" href="#/produits">Produits</a>
  <header class="page-head"><h1>${esc(p.name)}</h1><p class="muted">${esc(CAT[p.category]?.name || '')} · unité : ${esc(p.unit)}</p></header>
  ${alerts.map((a) => `<p class="notice ${a.kind === 'plancher' ? 'good' : ''}">${a.kind === 'cher' ? `Dernier prix ${fmtPct(a.pct, 0)} au-dessus de la médiane.` : a.kind === 'plancher' ? 'Dernier prix au plus bas observé.' : `Même prix, format réduit de ${Math.round(a.pct)} %.`}</p>`).join('')}
  <section class="block"><h2>Prix payé</h2>${priceSpark(h, med) || '<p class="muted">Un seul achat pour l’instant.</p>'}
    <div class="stats3"><div><small>Médiane</small><strong>${med ? fmtMoney(med) : '—'}</strong></div><div><small>Plus bas</small><strong>${h.length ? fmtMoney(Math.min(...h.map((x) => x.price))) : '—'}</strong></div><div><small>Plus haut</small><strong>${h.length ? fmtMoney(Math.max(...h.map((x) => x.price))) : '—'}</strong></div></div>
  </section>
  <section class="block"><h2>Achats</h2><table class="tbl"><thead><tr><th>Date</th><th>Magasin</th><th class="num">Prix</th></tr></thead>
    <tbody>${h.slice().reverse().map((x) => `<tr><td>${esc(x.date)}</td><td>${esc(storeName(x.storeId))}</td><td class="num">${esc(fmtMoney(x.price))}${x.sizeQty ? `<small> ${esc(fmtSize(x.sizeQty, x.sizeUnit))}</small>` : ''}</td></tr>`).join('')}</tbody></table></section>
  <form id="pform" class="block"><h2>Modifier</h2>
    <label>Nom<input name="name" value="${esc(p.name)}"></label>
    <label>Catégorie IPC<select name="category">${CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === p.category ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
    <button class="btn" type="submit">Enregistrer les modifications</button>
  </form>`;
}

// ---------- Reçus ----------
function viewReceipts() {
  const { receipts, lines } = state.data;
  const byR = new Map();
  lines.forEach((l) => byR.set(l.receiptId, (byR.get(l.receiptId) || 0) + l.amount));
  const sorted = receipts.slice().sort((a, b) => b.date.localeCompare(a.date));
  let cur = '';
  const items = sorted.map((r) => {
    const mo = calc.monthOf(r.date);
    const head = mo !== cur ? `<li class="month">${esc(fmtMonth(mo))}</li>` : '';
    cur = mo;
    return `${head}<li><a href="#/recus/${encodeURIComponent(r.id)}"><span>${esc(storeName(r.storeId))}<small>${esc(fmtDate(r.date))} · ${r.source === 'migration' ? 'historique' : r.source}</small></span><strong>${esc(fmtMoney(byR.get(r.id) || 0))}</strong></a></li>`;
  }).join('');
  return `<header class="page-head"><h1>Reçus</h1><p class="muted">${receipts.length} reçus</p></header><ul class="rlist">${items}</ul>`;
}

function viewReceipt(id) {
  const r = state.data.receipts.find((x) => x.id === id);
  if (!r) return '<p>Reçu introuvable.</p>';
  const P = new Map(state.data.products.map((p) => [p.id, p]));
  const ls = state.data.lines.filter((l) => l.receiptId === id);
  state.after = () => {
    $('#del-r').addEventListener('click', async () => {
      if (!confirm('Supprimer ce reçu et ses articles ?')) return;
      try { await pushDelete(ls, state.settings); } catch (err) { toast(`Reçu supprimé ici, mais pas dans le Google Sheet : ${err.message}`, 'error'); }
      await db.del('lines', ls.map((l) => l.id));
      await db.del('receipts', id);
      await reload();
      toast('Reçu supprimé.');
      location.hash = '#/recus';
    });
  };
  return `<a class="back" href="#/recus">Reçus</a>
  <header class="page-head"><h1>${esc(storeName(r.storeId))}</h1><p class="muted">${esc(fmtDate(r.date))}</p></header>
  <section class="receipt"><table class="tbl plain"><tbody>${ls.map((l) => {
    const p = P.get(l.productId) || {};
    return `<tr class="${p.category === 'hors' ? 'dim' : ''}"><td><a href="#/produits/${encodeURIComponent(l.productId)}">${esc(p.name)}</a><small>${l.qty !== 1 ? `${String(l.qty).replace('.', ',')} × ${esc(fmtMoney(calc.unitPrice(l)))}` : ''}</small></td><td class="num">${esc(fmtMoney(l.amount))}</td></tr>`;
  }).join('')}</tbody></table>
  ${leader('Total', fmtMoney(ls.reduce((a, l) => a + l.amount, 0)))}</section>
  <button class="btn danger" id="del-r">Supprimer ce reçu</button>`;
}

// ---------- Réglages ----------
function viewSettings() {
  const d = state.data;
  state.after = () => {
    $('#sform').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      state.settings = { ...state.settings, region: f.get('region').trim().toUpperCase().slice(0, 3), sheetUrl: f.get('sheetUrl').trim() };
      await db.setMeta('settings', state.settings);
      toast('Réglages enregistrés.', 'ok');
      if (state.settings.sheetUrl) { await trySync({ quiet: false }); render(); }
    });
    $('#sync-now')?.addEventListener('click', async () => { await trySync({ quiet: false }); render(); });
    $('#x-json').addEventListener('click', () => exportJSON(state.data));
    $('#x-xlsx').addEventListener('click', async () => {
      try {
        await exportExcel(state.data, { series: state.derived.series, alerts: state.derived.alerts.map((a) => ({ Produit: a.name, Alerte: a.kind, 'Écart %': a.pct ? Math.round(a.pct) : '' })) });
      } catch (err) { toast(err.message, 'error'); }
    });
    $('#i-json').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!Array.isArray(data.lines) || !Array.isArray(data.products)) throw new Error('Ce fichier n’est pas une sauvegarde Panier.');
        if (!confirm(`Remplacer les données actuelles par cette sauvegarde (${data.lines.length} articles) ?`)) return;
        await db.replaceAll(data);
        await reload();
        toast('Sauvegarde restaurée.', 'ok');
        render();
      } catch (err) { toast(err.message, 'error'); }
    });
    $('#reset').addEventListener('click', async () => {
      if (!confirm('Effacer tous les reçus ajoutés et revenir aux seules données historiques ?')) return;
      await db.setMeta('seeded', null);
      await db.setMeta('patches', []);
      await db.ensureSeeded();
      await applyPatches();
      await reload();
      toast('Données historiques rechargées.');
      location.hash = '#/';
    });
  };
  const added = d.receipts.filter((r) => r.source !== 'migration').length;
  return `<header class="page-head"><h1>Réglages</h1></header>
  <form id="sform" class="block" autocomplete="off">
    <h2>Google Sheet</h2>
    <p class="hint">Chaque reçu enregistré est ajouté à la feuille « Historique » de Suivi_depenses_V2. Installation : voir le guide dans le dépôt (apps-script/INSTALLATION.md).</p>
    <label>Adresse du script (se termine par /exec)<input name="sheetUrl" type="url" value="${esc(state.settings.sheetUrl)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
    <p class="hint">${state.settings.sheetUrl ? `${pendingLines(state.data).length} ligne(s) en attente d’envoi${state.sync.last ? ` · dernier envoi ${new Date(state.sync.last).toLocaleString('fr-CA')}` : ''}${state.sync.error ? ` · erreur : ${esc(state.sync.error)}` : ''}.` : 'Pas encore configuré : les données restent seulement sur ce téléphone.'}</p>
    ${state.settings.sheetUrl ? '<button type="button" class="btn" id="sync-now">Envoyer maintenant</button>' : ''}
    <h2 class="mt">Profil</h2>
    <label>Code régional (3 premiers caractères du code postal)<input name="region" value="${esc(state.settings.region)}" maxlength="3" placeholder="H4L"></label>
    <button class="btn primary" type="submit">Enregistrer les réglages</button>
  </form>
  <section class="block"><h2>Mes données</h2>
    <p class="muted">${d.receipts.length} reçus, dont ${added} ajoutés dans l'app · ${d.lines.length} articles · ${d.products.length} produits. Tout est stocké sur ce téléphone.</p>
    <div class="btns">
      <button class="btn" id="x-json">Télécharger une sauvegarde</button>
      <label class="btn file"><input type="file" id="i-json" accept="application/json,.json">Restaurer une sauvegarde</label>
      <button class="btn" id="x-xlsx">Exporter en Excel</button>
    </div>
    <p class="hint">Télécharge une sauvegarde après chaque série de reçus : effacer les données du navigateur efface aussi Panier.</p>
  </section>
  <section class="block"><h2>Données officielles</h2>
    <p class="muted">${state.official.points?.length ? `IPC du Québec, aliments achetés en magasin : ${state.official.points.length} mois, jusqu'en ${esc(fmtMonth(state.official.points.at(-1).month))}. Mis à jour le ${esc(state.official.updated)}.` : 'IPC du Québec : en attente de la première mise à jour automatique.'}</p>
  </section>
  <section class="block"><h2>Recommencer</h2><button class="btn danger" id="reset">Revenir aux données historiques</button></section>
  <p class="muted small center">Panier v2 · données historiques : Suivi_depenses_V2</p>`;
}

// ---------- Données récupérées, ajoutées une seule fois ----------
const PATCHES = ['recus-mai-2026'];
async function applyPatches() {
  const done = await db.getMeta('patches', []);
  for (const name of PATCHES.filter((p) => !done.includes(p))) {
    try {
      const payload = await fetch(`./data/patches/${name}.json`).then((r) => r.json());
      const data = await db.loadAll();
      const plan = planImport(data, payload, uid);
      if (plan.stores.length) await db.put('stores', plan.stores);
      if (plan.products.length) await db.put('products', plan.products);
      if (plan.receipts.length) await db.put('receipts', plan.receipts);
      if (plan.lines.length) await db.put('lines', plan.lines);
      done.push(name);
      await db.setMeta('patches', done);
      if (plan.receipts.length) toast(`${plan.receipts.length} reçus récupérés de l’ancienne app (${plan.lines.length} articles).`, 'ok');
    } catch (err) {
      console.warn('Patch non appliqué', name, err);
    }
  }
}

// ---------- Démarrage ----------
async function start() {
  try {
    const seeded = await db.ensureSeeded();
    await applyPatches();
    await db.persist();
    state.settings = { ...state.settings, ...(await db.getMeta('settings', {})) };
    if (!state.settings.sheetToken) {
      state.settings.sheetToken = newToken();
      await db.setMeta('settings', state.settings);
    }
    state.official = await fetch('./data/ipc-quebec.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => ({ points: [] }));
    await reload();
    if (seeded) toast(`Historique importé : ${state.data.lines.filter((l) => l.id.startsWith('mig-')).length} articles depuis ${fmtMonth(state.derived.series[0]?.month || '2023-12')}.`, 'ok');
  } catch (err) {
    $('#view').innerHTML = `<p class="notice">Impossible de charger les données : ${esc(err.message)}</p>`;
    return;
  }
  window.addEventListener('hashchange', render);
  render();
  window.addEventListener('online', () => trySync());
  trySync();
  if ('serviceWorker' in navigator) {
    // Une mise à jour de l'app prend le relais : on recharge une fois pour l'afficher tout de suite.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register('./sw.js').then((reg) => reg.update()).catch(() => {});
  }
}

start();
