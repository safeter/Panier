import * as db from './db.js';
import * as calc from './calc.js';
import { CATEGORIES, CAT, IN_SCOPE, isTaxLabel } from './categories.js';
import { $, $$, esc, fmtMoney, fmtPct, fmtMonth, fmtDate, today, uid, slug, toast, num, parseSize, fmtSize } from './util.js';
import { indexChart, spendBars, effectBars, priceSpark } from './charts.js';
import { planImport } from './importer.js';
import { parseReceiptText, guessCategory } from './pdfparse.js';
import { similarProducts, nameKey } from './similar.js';
import { planCatalogue } from './catalogue.js';
import { pushPending, pushDelete, pendingLines, newToken } from './sync.js';
import { exportExcel, exportJSON } from './excel.js';

export const APP_VERSION = '2.8.0';
const UNITS = ['unité', 'kg', 'sac', 'paquet', 'boîte', 'contenant', 'bouteille', 'pot', 'litre', 'carton', 'botte', 'pain', 'douzaine', 'tablette'];

const state = {
  data: { stores: [], products: [], receipts: [], lines: [] },
  official: { points: [] },
  settings: { region: '', sheetUrl: '', sheetToken: '' },
  sync: { last: null, error: null, busy: false },
  view: null,
  draft: null,
  aliases: {},   // ancien libellé (slug) -> id du produit : noms corrigés, renommés ou fusionnés
  notSame: [],   // paires « idA|idB » déclarées différentes
};

// ---------- Données dérivées ----------
function derive() {
  const d = state.data;
  const joined = calc.joinLines(d);
  // Deux catégories d'achats. Fiables : reçu validé, achat confirmé ou prix cohérent avec les autres achats
  // du produit. À confirmer : achat douteux ou prix hors de ±50 % de l'habitude (format, poids, unité ?).
  // Seuls les achats fiables entrent dans l'indice ; les dépenses comptent tout.
  const flags = calc.auditLines(joined);
  const trust = calc.assessLines(joined, flags);
  const indexed = joined.filter((l) => trust.get(l.id)?.tier === 'fiable');
  const doubtful = joined.filter((l) => trust.get(l.id)?.tier !== 'fiable');
  // Indice : fenêtres mobiles de 6 mois comparées entre elles produit par produit (multilatéral, sans dérive).
  const monthly = calc.monthlyPanel(indexed);
  const panel = calc.rollingPanel(monthly);
  const series = calc.multilateralIndex(panel);
  // Le résumé s'arrête au dernier mois assez complet : un mois qui commence (1 ou 2 reçus)
  // a trop peu de produits déjà achetés dans les 12 mois précédents pour peser sur le chiffre.
  const months = [...monthly.keys()];
  const ownMatched = (mo) => {
    const before = new Set(months.filter((m) => m < mo && calc.monthsBetween(m, mo) <= 12).flatMap((m) => [...monthly.get(m).keys()]));
    return [...monthly.get(mo).keys()].filter((id) => before.has(id)).length;
  };
  let end = series.length - 1;
  while (end > 0 && ownMatched(series[end].month) < calc.MIN_MATCHED) end--;
  const head = calc.headlineInflation(series.slice(0, end + 1));
  const pending = series.slice(end + 1).map((p) => ({ month: p.month, matched: ownMatched(p.month) }));
  // Série officielle lissée sur les mêmes fenêtres de 6 mois
  const official = calc.smoothOfficial(state.official.points || []);
  const P = new Map(d.products.map((p) => [p.id, p]));
  const byProduct = new Map();
  for (const l of indexed) {
    if (!byProduct.has(l.productId)) byProduct.set(l.productId, []);
    byProduct.get(l.productId).push(l);
  }
  const alerts = [];
  // Alertes : seulement pour les produits achetés récemment (un prix de 2024 n'aide pas l'épicerie de cette semaine).
  const latest = indexed.reduce((a, l) => (l.date > a ? l.date : a), '');
  const recent = latest ? new Date(Date.parse(latest) - 120 * 864e5).toISOString().slice(0, 10) : '';
  for (const [id] of byProduct) {
    const h = calc.priceHistory(indexed, id);
    if (!h.length || h.at(-1).date < recent) continue;
    for (const a of calc.alertsFor(h)) alerts.push({ productId: id, name: P.get(id)?.name, ...a, last: h.at(-1) });
  }
  // Tous les achats valides, hors périmètre et douteux compris : liste des produits, nombre d'achats.
  const all = calc.joinLines(d, { inScopeOnly: false });
  const byProductAll = new Map();
  for (const l of all) {
    if (!byProductAll.has(l.productId)) byProductAll.set(l.productId, []);
    byProductAll.get(l.productId).push(l);
  }
  const counts = new Map();
  for (const l of d.lines) counts.set(l.productId, (counts.get(l.productId) || 0) + 1);
  const twins = similarProducts(d.products, counts, new Set(state.notSame || []));
  state.derived = { twins, joined, indexed, doubtful, trust, flags, panel, series, head, pending, official, byProduct, byProductAll, alerts, alertIds: new Set(alerts.map((a) => a.productId)) };
}

async function reload() {
  state.data = await db.loadAll();
  state.aliases = await db.getMeta('aliases', {});
  state.notSame = await db.getMeta('notSame', []);
  derive();
}

/** Met à jour l'état de l'envoi affiché dans Réglages, sans redessiner la page (ni perdre la saisie). */
function refreshSyncStatus() {
  const el = $('#sync-status');
  if (el) el.outerHTML = syncStatus();
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
      db.setMeta('sync', { last: state.sync.last, error: null });
      if (added > 0 || !quiet) toast(added > 0 ? `${added} ligne(s) ajoutée(s) au Google Sheet.` : 'Google Sheet à jour.', 'ok');
    }
    return added;
  } catch (err) {
    state.sync = { ...state.sync, error: err.message, busy: false };
    db.setMeta('sync', { last: state.sync.last, error: err.message });
    if (!quiet) toast(`Envoi au Google Sheet impossible : ${err.message}`, 'error');
    return null;
  } finally {
    state.sync.busy = false;
    refreshSyncStatus();
  }
}

function syncStatus() {
  const pending = pendingLines(state.data).length;
  const { last, error } = state.sync;
  const p = (cls, html) => `<p id="sync-status" class="status ${cls}" role="status">${html}</p>`;
  if (!state.settings.sheetUrl) return p('off', `Non relié · ${pending} ligne(s) à envoyer. Tes données restent seulement sur ce téléphone.`);
  if (error) return p('bad', `Erreur au dernier envoi : ${esc(error)} · ${pending} ligne(s) en attente.`);
  if (pending) return p('off', `${pending} ligne(s) en attente d'envoi${navigator.onLine ? '' : ' (hors ligne)'}.`);
  return p('good', `Relié et à jour${last ? ` · dernier envoi ${esc(new Date(last).toLocaleString('fr-CA', { dateStyle: 'medium', timeStyle: 'short' }))}` : ''}.`);
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
  [/^#\/verifier$/, viewReview],
];

function render() {
  const hash = location.hash || '#/';
  if (state.draft?.editing && hash !== '#/ajouter') state.draft = null; // correction abandonnée
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
  const { series, head, pending, panel, official, joined, indexed, doubtful, alerts } = state.derived;
  if (!joined.length) {
    return `<section class="empty"><h1>Commence ton suivi</h1><p>Ajoute un premier reçu : l'indice apparaît dès le deuxième mois.</p><a class="btn primary" href="#/ajouter">Ajouter un reçu</a></section>`;
  }
  const lastDate = joined.reduce((a, l) => (l.date > a ? l.date : a), '');
  const staleMonths = calc.monthsBetween(calc.monthOf(lastDate), calc.monthOf(today()));
  const offCh = head ? calc.officialChange(official, head.from, head.to) : null;
  const dec = head ? calc.decompose(panel, series, head.from, head.to) : null;
  const rebased = calc.rebase(official, series[0].month);
  const period = head ? `${fmtMonth(head.from)} → ${fmtMonth(head.to)}` : '';
  const win = (mo) => `${fmtMonth(calc.addMonths(mo, -(calc.WINDOW - 1)), { short: true })} – ${fmtMonth(mo, { short: true })}`;
  const kindNote = !head ? 'Pas encore deux mois comparables' : head.kind === '12mois' ? 'Sur 12 mois' : `Depuis le début (${head.months} mois)`;
  const offLag = offCh && head && offCh.to !== head.to
    ? `Dernier mois publié par Statistique Canada : ${fmtMonth(offCh.to)}.` : '';

  const gap = offCh && head ? head.pct - offCh.pct : null;
  const pts = (x) => Math.abs(x).toLocaleString('fr-CA', { maximumFractionDigits: 1 });
  const verdict = gap === null ? '' : Math.abs(gap) < 1
    ? 'Mes prix suivent l’inflation alimentaire du Québec.'
    : gap > 0 ? `Mes prix ont évolué ${pts(gap)} points au-dessus de l’IPC du Québec.`
      : `Mes prix ont évolué ${pts(gap)} points sous l’IPC du Québec.`;
  const monthSpend = (mo) => joined.filter((l) => l.month === mo);
  const pendingNote = pending.length
    ? `<div class="pending-box">${pending.map((p) => {
      const ls = monthSpend(p.month);
      return `<p><strong>${esc(fmtMonth(p.month))} : ${ls.length} articles, ${esc(fmtMoney(ls.reduce((a, l) => a + l.amount, 0)))}</strong> — pas encore dans « Mes prix » : ${p.matched} produit${p.matched > 1 ? 's' : ''} déjà acheté${p.matched > 1 ? 's' : ''} dans les 12 mois précédents, il en faut ${calc.MIN_MATCHED}. Les achats habituels (lait, œufs, fruits…) le compléteront vite.</p>`;
    }).join('')}</div>` : '';

  // Catégories : part des dépenses des 12 derniers mois, prix sur la même période que « Mes prix »
  const last12 = joined.filter((l) => calc.monthsBetween(l.month, calc.monthOf(lastDate)) < 12);
  const spend12 = last12.reduce((a, l) => a + l.amount, 0) || 1;
  const catRows = IN_SCOPE.map((c) => {
    const s = calc.multilateralIndex(panel, (v) => v.category === c.id).filter((p) => !head || p.month <= head.to);
    const h = calc.headlineInflation(s);
    const share = last12.filter((l) => l.product.category === c.id).reduce((a, l) => a + l.amount, 0) / spend12;
    // Chiffre affiché seulement si les deux bouts de la période reposent sur assez de produits communs.
    const at = (mo) => s.find((p) => p.month === mo);
    const weak = !h || !at(h.from)?.reliable || !at(h.to)?.reliable;
    return { c, h, share, weak };
  }).sort((a, b) => b.share - a.share);

  const mv = calc.movers(indexed);
  const ups = mv.filter((m) => m.pct > 0).slice(0, 5);
  const downs = mv.filter((m) => m.pct < 0).slice(-5).reverse();
  const moverList = (xs) => xs.map((m) => `<li><a href="#/produits/${encodeURIComponent(m.productId)}"><span>${esc(m.name)}</span><span class="${m.pct > 0 ? 'up' : 'down'}">${fmtPct(m.pct, 0)}</span></a><small>${esc(fmtMoney(m.first))} → ${esc(fmtMoney(m.last))}</small></li>`).join('');

  return `
  <header class="page-head">
    <h1>Mon panier</h1>
    <p class="muted">Dernier achat le ${esc(fmtDate(lastDate))}</p>
  </header>
  ${staleMonths >= 2 ? `<a class="notice" href="#/ajouter"><strong>Aucun achat depuis ${staleMonths} mois.</strong> Ajoute tes prochains reçus pour reprendre le suivi mensuel.</a>` : ''}
  ${doubtful.length || state.derived.twins.length ? `<a class="notice" href="#/verifier"><strong>À vérifier : ${[doubtful.length ? `${doubtful.length} achats à confirmer` : '', state.derived.twins.length ? `${state.derived.twins.length} produits en double` : ''].filter(Boolean).join(' et ')}.</strong> Les achats à confirmer (format, poids ou unité douteux) ne comptent pas dans l'indice.</a>` : ''}
  ${!state.settings.sheetUrl && pendingLines(state.data).length ? `<a class="notice" href="#/reglages"><strong>${pendingLines(state.data).length} lignes pas encore envoyées au Google Sheet.</strong> Ajoute l'adresse du script dans Réglages.</a>` : ''}

  <section class="receipt" aria-labelledby="t-sum">
    <h2 id="t-sum" class="receipt-title">${kindNote}<span>${esc(period)}</span></h2>
    ${leader('Mes prix', fmtPct(head?.pct), 'big', head ? `Prix moyens de ${esc(win(head.from))} comparés à ${esc(win(head.to))}, produit par produit.` : '')}
    ${leader('IPC Québec, aliments en magasin', offCh ? fmtPct(offCh.pct) : 'en attente', 'qc', offCh ? esc(offLag) : 'La série officielle se met à jour automatiquement chaque mois.')}
    ${verdict ? `<p class="verdict">${esc(verdict)}</p>` : ''}
    <p class="trust-line"><span class="tag ok">fiables</span> ${indexed.length} achats dans l’indice${doubtful.length ? ` · <a href="#/verifier"><span class="tag warn">à confirmer</span> ${doubtful.length} achats exclus</a>` : ''}</p>
    ${pendingNote}
  </section>

  ${dec ? `<section class="block"><h2>Pourquoi ma facture a changé</h2>
    <p class="muted">Dépense moyenne par mois d’achats : ${esc(win(dec.m0))} : ${esc(fmtMoney(dec.spend0))} · ${esc(win(dec.m1))} : ${esc(fmtMoney(dec.spend1))} (${fmtPct(dec.totalPct)}).</p>
    ${effectBars(dec)}</section>` : ''}

  <section class="block"><h2>Mon indice des prix</h2>
    <div class="legend"><span class="k me">Mon panier</span>${rebased.length ? '<span class="k qc">IPC Québec</span>' : ''}<span class="k dash">Mois manquants ou peu de produits communs</span></div>
    ${indexChart(series, rebased)}
    <p class="muted small">Base 100 = ${esc(fmtMonth(series[0].month))}. Chaque point compare les prix moyens des ${calc.WINDOW} mois qui le précèdent, produit par produit, à ceux de tous les autres points ; l’IPC du Québec est lissé de la même façon.</p>
  </section>

  <section class="block"><h2>Par catégorie</h2>
    <p class="muted small">Part des dépenses des 12 derniers mois ; variation des prix sur 12 mois, ou depuis le premier mois de la catégorie si son historique est plus court.</p>
    <ul class="cats">${catRows.map(({ c, h, share, weak }) => `<li>
      <div class="cat-line"><span>${esc(c.short)}</span>${weak ? '<span class="muted small">trop peu de produits comparables</span>' : `<span class="${h.pct > 0 ? 'up' : 'down'}">${fmtPct(h.pct)}</span>`}</div>
      <div class="share"><span style="width:${(share * 100).toFixed(1)}%"></span></div>
      <small>${Math.round(share * 100)} % des dépenses</small></li>`).join('')}</ul>
  </section>

  <section class="block two"><div><h2>Plus fortes hausses</h2><ul class="movers">${moverList(ups) || '<li class="muted">Pas assez d’achats répétés.</li>'}</ul></div>
    <div><h2>Plus fortes baisses</h2><ul class="movers">${moverList(downs) || '<li class="muted">Aucune.</li>'}</ul></div></section>

  <section class="block"><h2>Dépenses par mois</h2>${spendBars(calc.spendByMonth(joined))}
    <p class="muted small">Épicerie seulement, taxes (TPS, TVQ) exclues ; ${state.data.products.filter((p) => p.category === 'hors').length} produits hors périmètre exclus.</p></section>

  ${alerts.length ? `<a class="block link-block" href="#/produits?alertes"><h2>${alerts.length} alerte(s) de prix</h2><p class="muted">Prix élevés, prix planchers et formats réduits sur tes produits.</p></a>` : ''}
  `;
}

// ---------- Ajouter un reçu ----------
const emptyLine = () => ({ name: '', productId: null, qty: '1', amount: '', size: '', regularPrice: '', category: 'autres', unit: 'unité', confidence: null, raw: '' });

/**
 * Produit connu pour un libellé : même nom, ancien nom retenu (renommage, fusion, correction),
 * puis même nom aux accents, pluriels et formats près. `strict` : seulement dans cette unité.
 */
function findProduct(name, unit, { strict = false } = {}) {
  const n = slug(name);
  if (!n) return null;
  let cands = state.data.products.filter((p) => slug(p.name) === n);
  if (!cands.length && state.aliases[n]) cands = state.data.products.filter((p) => p.id === state.aliases[n]);
  if (!cands.length) {
    const k = nameKey(name);
    if (k) cands = state.data.products.filter((p) => nameKey(p.name) === k);
  }
  return cands.find((p) => !unit || p.unit === unit) || (strict ? null : cands[0]) || null;
}

/** « Tomates cerises multicolores » → « Tomates cerises » : produit connu dont le nom commence le libellé. */
function findByPrefix(label) {
  const l = slug(label);
  let best = null;
  for (const p of state.data.products) {
    if (p.category === 'hors') continue;
    const n = slug(p.name);
    if (n.length >= 5 && (l === n || l.startsWith(n + '-')) && (!best || n.length > slug(best.name).length)) best = p;
  }
  return best;
}

function viewAdd() {
  if (!state.draft) state.draft = { date: today(), store: '', lines: [emptyLine(), emptyLine(), emptyLine()] };
  const d = state.draft;
  const names = [...new Set(state.data.products.filter((p) => p.category !== 'hors').map((p) => p.name))].sort((a, b) => a.localeCompare(b, 'fr'));
  state.after = () => bindAdd();
  if (d.editing) {
    return `<a class="back" href="#/recus/${encodeURIComponent(d.editing)}" id="cancel-edit">Annuler</a>
  <header class="page-head"><h1>Modifier le reçu</h1><p class="muted">Corrige un produit, une quantité ou un montant ; les lignes modifiées sont renvoyées au Google Sheet.</p></header>
  ${receiptForm(d, names)}`;
  }
  return `
  <header class="page-head"><h1>Ajouter un reçu</h1></header>
  <section class="scan-box">
    <label class="btn primary file"><input type="file" id="pdf-file" accept="application/pdf,.pdf">Lire un PDF (Lufa, reçu en ligne…)</label>
    <label class="btn file"><input type="file" id="import-file" accept="application/json,.json">Importer un fichier de reçus préparé par Claude</label>
    <p class="muted small" id="import-status">Le PDF est lu sur ce téléphone ; tu vérifies les lignes avant d’enregistrer. Les noms que tu corriges sont retenus pour les prochaines fois.</p>
  </section>
  ${receiptForm(d, names)}`;
}

function receiptForm(d, names) {
  return `
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
    <div class="total-line"><span>Total des lignes, hors taxes</span><strong id="sum">${fmtMoney(sumDraft())}</strong></div>
    <button class="btn primary wide" type="submit">${d.editing ? 'Enregistrer les corrections' : 'Enregistrer le reçu'}</button>
  </form>`;
}

function lineRow(l, i) {
  const known = (l.productId && state.data.products.find((p) => p.id === l.productId)) || findProduct(l.name);
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
    if (t.dataset.f === 'category') l.catTouched = true;
    if (t.dataset.f === 'name') {
      const p = findProduct(t.value);
      l.productId = p?.id || null;
      // Nouveau produit : catégorie proposée d'après le nom, tant que l'utilisateur ne l'a pas choisie.
      if (!p && !l.catTouched) {
        l.category = guessCategory(t.value);
        const sel = $('select[data-f="category"]', fs);
        if (sel) sel.value = l.category;
      }
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
  $('#import-file')?.addEventListener('change', onImportFile);
  $('#pdf-file')?.addEventListener('change', onPdfFile);
  $('#cancel-edit')?.addEventListener('click', () => { state.draft = null; });
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
  if (state.draft.editing) return '';
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
    const aliases = state.aliases;
    const P = new Map(state.data.products.map((p) => [p.id, p]));
    const kg = (l) => (l.unit === 'kg' ? { unit: 'kg', strict: true } : {});
    const find = (name, l) => findProduct(name, kg(l).unit, kg(l));
    state.draft = {
      date: parsed.date || today(),
      store: parsed.store || '',
      lines: parsed.lines.map((l) => {
        const bare = l.name.replace(/\s*\d+(?:[,.]\d+)?\s?(?:kg|g|ml|l)\b/i, '').trim();
        // Un article pesé (kg) ne rejoint qu'un produit vendu au kg : un prix au kg n'est pas un prix au sac.
        const known = (aliases[slug(l.name)] && P.get(aliases[slug(l.name)]))
          || find(l.name, l) || (bare !== l.name && find(bare, l)) || null;
        const guess = !known && l.unit !== 'kg' && findByPrefix(bare);
        return {
          ...emptyLine(),
          name: (known || guess) ? (known || guess).name : l.name, productId: (known || guess)?.id || null, rawName: l.name,
          unit: (known || guess) ? (known || guess).unit : l.unit, category: (known || guess) ? (known || guess).category : guessCategory(l.name),
          qty: String(l.qty).replace('.', ','), amount: l.amount.toFixed(2).replace('.', ','),
          size: l.size || '', regularPrice: l.regularPrice ? String(l.regularPrice).replace('.', ',') : '',
          raw: l.raw, confidence: known ? 0.9 : guess ? 0.6 : 0.5,
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
    const plan = planImport(state.data, payload, uid, await db.getMeta('aliases', {}));
    if (!plan.receipts.length) {
      status.textContent = `Rien à importer : ${plan.skipped.length} reçu(s) déjà présents.`;
      return;
    }
    const total = plan.lines.reduce((a, l) => a + l.amount, 0);
    const msg = `Importer ${plan.receipts.length} reçu(s), ${plan.lines.length} articles, ${fmtMoney(total)} hors taxes`
      + `${plan.products.length ? `, dont ${plan.products.length} nouveaux produits` : ''}`
      + `${plan.skipped.length ? ` (${plan.skipped.length} déjà présents, ignorés)` : ''}`
      + `${plan.taxesIgnored ? ` ; ${plan.taxesIgnored} ligne(s) de taxe ignorée(s)` : ''} ?`;
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
  const filled = d.lines.filter((l) => l.name.trim() && num(l.amount));
  const taxLines = filled.filter((l) => isTaxLabel(l.name));
  const negative = filled.filter((l) => !isTaxLabel(l.name) && !(num(l.amount) > 0));
  const lines = filled.filter((l) => !isTaxLabel(l.name) && num(l.amount) > 0);
  if (taxLines.length) toast(`${taxLines.length} ligne(s) de taxe (TPS, TVQ) ignorée(s) : seuls les prix des produits comptent.`);
  if (negative.length) toast(`${negative.length} ligne(s) à montant négatif ignorée(s) : pour un rabais, inscris le prix payé sur la ligne du produit.`);
  if (!lines.length) throw new Error('Ajoute au moins une ligne avec un produit et un montant.');
  if (!d.store.trim()) throw new Error('Indique le magasin.');
  let store = state.data.stores.find((s) => slug(s.name) === slug(d.store));
  const newStores = [];
  if (!store) { store = { id: slug(d.store), name: d.store.trim() }; newStores.push(store); }
  const editing = d.editing ? state.data.receipts.find((r) => r.id === d.editing) : null;
  const receipt = editing
    ? { ...editing, date: d.date, storeId: store.id, updatedAt: new Date().toISOString() }
    : { id: uid('r'), date: d.date, storeId: store.id, source: d.lines.some((l) => l.rawName) ? 'pdf' : 'manuel', total: null, createdAt: new Date().toISOString() };
  const headerChanged = editing && (editing.date !== d.date || editing.storeId !== store.id);
  const newProducts = [];
  const outLines = lines.map((l, pos) => {
    let p = (l.productId && state.data.products.find((x) => x.id === l.productId)) || findProduct(l.name, l.unit);
    if (!p) {
      const id = `${slug(l.name)}--${slug(l.unit)}`;
      p = newProducts.find((x) => x.id === id) || state.data.products.find((x) => x.id === id);
      if (!p) {
        p = { id, name: l.name.trim(), unit: l.unit, category: l.category, type: slug(l.name) };
        newProducts.push(p);
      }
    }
    const size = parseSize(l.size);
    const q = num(l.qty);
    const o = l.orig;
    // pos : ordre des lignes du reçu. Une ligne corrigée garde son identifiant (et sa place).
    const fresh = {
      id: o?.id || uid('l'), receiptId: receipt.id, pos, productId: p.id, qty: q > 0 ? q : 1, amount: Math.round(num(l.amount) * 100) / 100,
      regularPrice: num(l.regularPrice), sizeQty: size?.qty ?? null, sizeUnit: size?.unit ?? null,
    };
    // Ligne inchangée d'un reçu modifié : on la garde telle quelle (déjà envoyée, déjà vérifiée).
    const same = o && !headerChanged && o.productId === fresh.productId && o.qty === fresh.qty && o.amount === fresh.amount
      && (o.regularPrice ?? null) === fresh.regularPrice && (o.sizeQty ?? null) === fresh.sizeQty;
    return same ? { ...o, pos } : fresh;
  });
  const total = outLines.reduce((a, l) => a + l.amount, 0);
  // Prix inhabituel par rapport aux achats précédents du produit : format, poids ou quantité mal saisis ?
  const P = new Map([...state.data.products, ...newProducts].map((p) => [p.id, p]));
  const fresh = outLines.map((l) => ({ ...l, product: P.get(l.productId), date: d.date }));
  const history = state.derived.joined.filter((l) => l.receiptId !== receipt.id && fresh.some((f) => f.productId === l.productId));
  const check = calc.assessLines([...history, ...fresh.filter((l) => l.product.category !== 'hors')]);
  const odd = fresh.filter((l) => check.get(l.id)?.tier === 'aConfirmer');
  if (odd.length && !confirm(`Prix inhabituel${odd.length > 1 ? 's' : ''} :\n${odd.map((l) => `• ${l.product.name} : ${check.get(l.id).why}`).join('\n')}\n\nVérifie le format, le poids ou la quantité. Enregistrer tel quel (ces achats seront considérés comme vérifiés) ?`)) return;
  receipt.validatedAt = new Date().toISOString(); // lignes revues par l'utilisateur avant d'enregistrer
  if (!editing) {
    const sumOf = (rid) => state.data.lines.filter((l) => l.receiptId === rid).reduce((a, l) => a + l.amount, 0);
    const dup = state.data.receipts.find((r) => r.date === d.date && r.storeId === store.id && Math.abs(sumOf(r.id) - total) < 0.01);
    if (dup && !confirm(`Un reçu ${store.name} du ${fmtDate(d.date)} de ${fmtMoney(total)} est déjà enregistré. L’enregistrer une deuxième fois ?`)) return;
  }
  // Retient « libellé du document → produit » pour reconnaître ce libellé automatiquement la prochaine fois.
  const learned = lines.filter((l) => l.rawName);
  if (learned.length) {
    const aliases = await db.getMeta('aliases', {});
    for (const l of learned) {
      const outLine = outLines[lines.indexOf(l)];
      if (outLine) aliases[slug(l.rawName)] = outLine.productId;
    }
    await db.setMeta('aliases', aliases);
  }
  if (editing) {
    // Lignes retirées ou modifiées : supprimées ici et dans le Google Sheet (les nouvelles versions y repartent).
    const out = new Map(outLines.map((l) => [l.id, l]));
    const old = state.data.lines.filter((l) => l.receiptId === editing.id);
    const removed = old.filter((l) => !out.has(l.id));
    const changed = old.filter((l) => out.has(l.id) && !out.get(l.id).syncedAt);
    try { await pushDelete([...removed, ...changed], state.settings); } catch (err) { toast(`Corrigé ici, mais l’ancienne version reste dans le Google Sheet : ${err.message}`, 'error'); }
    if (removed.length) await db.del('lines', removed.map((l) => l.id));
  }
  if (newStores.length) await db.put('stores', newStores);
  if (newProducts.length) await db.put('products', newProducts);
  await db.put('receipts', receipt);
  await db.put('lines', outLines);
  state.draft = null;
  await reload();
  toast(editing ? 'Reçu corrigé.' : `Reçu enregistré : ${outLines.length} articles, ${fmtMoney(total)}.`, 'ok');
  trySync();
  location.hash = editing ? `#/recus/${encodeURIComponent(receipt.id)}` : '#/';
}

/** Articles d'un reçu, dans l'ordre du reçu. */
function receiptLines(id) {
  return state.data.lines.filter((l) => l.receiptId === id)
    .sort((a, b) => (a.pos ?? 1e6) - (b.pos ?? 1e6) || a.id.localeCompare(b.id));
}

/** Charge un reçu enregistré dans le formulaire pour le corriger. */
function editReceipt(id) {
  const r = state.data.receipts.find((x) => x.id === id);
  const P = new Map(state.data.products.map((p) => [p.id, p]));
  const fmt = (x) => String(x).replace('.', ',');
  state.draft = {
    editing: id, date: r.date, store: storeName(r.storeId),
    lines: receiptLines(id).map((l) => {
      const p = P.get(l.productId) || {};
      return {
        ...emptyLine(), orig: l, productId: l.productId, name: p.name || '', unit: p.unit || 'unité', category: p.category || 'autres',
        qty: fmt(l.qty), amount: l.amount.toFixed(2).replace('.', ','),
        size: l.sizeQty ? `${fmt(l.sizeQty)} ${l.sizeUnit === 'un' ? '' : l.sizeUnit}`.trim() : '',
        regularPrice: l.regularPrice ? fmt(l.regularPrice) : '',
      };
    }),
  };
  location.hash = '#/ajouter';
}

// ---------- Produits ----------
function viewProducts() {
  const onlyAlerts = location.hash.includes('alertes') || location.search.includes('alertes');
  const { byProductAll, alerts } = state.derived;
  const A = new Map();
  alerts.forEach((a) => { if (!A.has(a.productId)) A.set(a.productId, []); A.get(a.productId).push(a); });
  const rows = state.data.products.map((p) => {
    const ls = (byProductAll.get(p.id) || []).slice().sort((a, b) => a.date.localeCompare(b.date));
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
      const name = f.get('name').trim() || p.name;
      await db.put('products', { ...p, name, category: f.get('category') });
      if (slug(name) !== slug(p.name)) {
        // L'ancien nom reste reconnu aux prochains reçus et PDF.
        const aliases = await db.getMeta('aliases', {});
        aliases[slug(p.name)] = p.id;
        await db.setMeta('aliases', aliases);
      }
      await reload();
      toast('Produit mis à jour.', 'ok');
      render();
    });
    $('#mform').addEventListener('submit', async (e) => {
      e.preventDefault();
      const target = state.data.products.find((x) => `${x.name} · ${x.unit}` === new FormData(e.target).get('target'));
      if (!target || target.id === p.id) { toast('Choisis un autre produit dans la liste.', 'error'); return; }
      const moved = state.data.lines.filter((l) => l.productId === p.id);
      const units = target.unit !== p.unit ? `\n\nAttention : unités différentes (${p.unit} → ${target.unit}). Un prix ${p.unit === 'kg' ? 'au kg' : `par ${p.unit}`} n'est pas comparable à un prix ${target.unit === 'kg' ? 'au kg' : `par ${target.unit}`}.` : '';
      if (!confirm(`Rattacher les ${moved.length} achats de « ${p.name} » à « ${target.name} » et supprimer « ${p.name} » ?${units}`)) return;
      await mergeProducts(p, target);
      await reload();
      toast(`Fusionné dans « ${target.name} ».`, 'ok');
      location.hash = `#/produits/${encodeURIComponent(target.id)}`;
    });
  };
  const others = state.data.products.filter((x) => x.id !== p.id && x.category !== 'hors')
    .map((x) => `${x.name} · ${x.unit}`).sort((a, b) => a.localeCompare(b, 'fr'));
  return `
  <a class="back" href="#/produits">Produits</a>
  <header class="page-head"><h1>${esc(p.name)}</h1><p class="muted">${esc(CAT[p.category]?.name || '')} · unité : ${esc(p.unit)}</p></header>
  ${alerts.map((a) => `<p class="notice ${a.kind === 'plancher' ? 'good' : ''}">${a.kind === 'cher' ? `Dernier prix ${fmtPct(a.pct, 0)} au-dessus de la médiane.` : a.kind === 'plancher' ? 'Dernier prix au plus bas observé.' : `Même prix, format réduit de ${Math.round(a.pct)} %.`}</p>`).join('')}
  <section class="block"><h2>Prix payé</h2>${priceSpark(h, med) || '<p class="muted">Un seul achat pour l’instant.</p>'}
    <div class="stats3"><div><small>Médiane</small><strong>${med ? fmtMoney(med) : '—'}</strong></div><div><small>Plus bas</small><strong>${h.length ? fmtMoney(Math.min(...h.map((x) => x.price))) : '—'}</strong></div><div><small>Plus haut</small><strong>${h.length ? fmtMoney(Math.max(...h.map((x) => x.price))) : '—'}</strong></div></div>
  </section>
  <section class="block"><h2>Achats</h2><table class="tbl"><thead><tr><th>Date</th><th>Magasin</th><th class="num">Prix</th></tr></thead>
    <tbody>${h.slice().reverse().map((x) => `<tr><td>${esc(x.date)}${state.derived.trust.get(x.id)?.tier === 'aConfirmer' ? ' <span class="tag warn">à confirmer</span>' : ''}</td><td>${esc(storeName(x.storeId))}</td><td class="num">${esc(fmtMoney(x.price))}${x.sizeQty ? `<small> ${esc(fmtSize(x.sizeQty, x.sizeUnit))}</small>` : ''}</td></tr>`).join('')}</tbody></table></section>
  <form id="pform" class="block"><h2>Modifier</h2>
    <label>Nom<input name="name" value="${esc(p.name)}"></label>
    <label>Catégorie IPC<select name="category">${CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === p.category ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
    <button class="btn" type="submit">Enregistrer les modifications</button>
  </form>
  <form id="mform" class="block"><h2>Fusionner avec un autre produit</h2>
    <p class="hint">Pour un doublon (« Tomates cerises multicolores » et « Tomates cerises ») : les achats sont rattachés à l'autre produit, et ce nom sera reconnu automatiquement ensuite.</p>
    <label>Produit à garder<input name="target" list="merge-list" placeholder="Rechercher un produit"></label>
    <datalist id="merge-list">${others.map((o) => `<option value="${esc(o)}">`).join('')}</datalist>
    <button class="btn" type="submit">Fusionner</button>
  </form>`;
}

// ---------- Achats à vérifier ----------
function viewReview() {
  const { flags, trust, doubtful } = state.derived;
  const byId = new Map(doubtful.map((l) => [l.id, l]));
  const safe = doubtful.filter((l) => flags.get(l.id)?.fixes?.length === 1);
  // Achats à confirmer, regroupés par reçu (du plus récent au plus ancien)
  const groups = new Map();
  for (const l of doubtful.slice().sort((a, b) => b.date.localeCompare(a.date) || (a.pos ?? 0) - (b.pos ?? 0))) {
    if (!groups.has(l.receiptId)) groups.set(l.receiptId, []);
    groups.get(l.receiptId).push(l);
  }
  state.after = () => {
    $$('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      const l = byId.get(b.dataset.id);
      const act = b.dataset.act;
      if (act === 'fix') await applyFix(l, flags.get(l.id).fixes[Number(b.dataset.n)].patch);
      else if (act === 'format') { if (!(await otherFormat(l))) return; }
      else await reviewLine(l, act);
      await reload();
      render();
    }));
    $$('[data-validate]').forEach((b) => b.addEventListener('click', async () => {
      await validateReceipt(b.dataset.validate, true);
      await reload();
      toast('Reçu validé : tous ses achats comptent dans l’indice.', 'ok');
      render();
    }));
    $$('[data-twin]').forEach((b) => b.addEventListener('click', async () => {
      const t = state.derived.twins[Number(b.dataset.n)];
      if (b.dataset.twin === 'merge') await mergeProducts(t.drop, t.keep);
      else if (b.dataset.twin === 'swap') await mergeProducts(t.keep, t.drop);
      else {
        state.notSame = [...(state.notSame || []), t.key];
        await db.setMeta('notSame', state.notSame);
      }
      await reload();
      render();
    }));
    $('#merge-all')?.addEventListener('click', async () => {
      const sure = state.derived.twins.filter((t) => t.kind === 'meme-nom');
      if (!confirm(`Fusionner ${sure.length} doublons évidents ?`)) return;
      for (const t of sure) await mergeProducts(t.drop, t.keep);
      await reload();
      toast(`${sure.length} produits fusionnés.`, 'ok');
      render();
    });
    $('#fix-all')?.addEventListener('click', async () => {
      if (!confirm(`Appliquer les ${safe.length} corrections sans ambiguïté ?`)) return;
      for (const l of safe) await applyFix(l, flags.get(l.id).fixes[0].patch);
      await reload();
      toast(`${safe.length} corrections appliquées.`, 'ok');
      render();
    });
  };
  const twins = state.derived.twins;
  const sure = twins.filter((t) => t.kind === 'meme-nom');
  const twinsHtml = twins.length ? `<section class="block"><h2>Produits en double ?</h2>
    <p class="hint">Même produit sous deux noms : fusionner rattache tous les achats au produit gardé, et l'autre nom sera reconnu automatiquement ensuite.</p>
    ${sure.length ? `<button class="btn primary wide" id="merge-all">Fusionner les ${sure.length} doublons évidents</button>` : ''}
    <ul class="review twins">${twins.map((t, n) => `<li>
      <div class="rv-head"><span class="tag ${t.kind}">${t.kind === 'meme-nom' ? 'Même nom' : 'Variante probable'}</span></div>
      <p class="rv-line">« ${esc(t.drop.name)} » (${t.dropCount}) → « ${esc(t.keep.name)} » (${t.keepCount})</p>
      <p class="hint">${esc(CAT[t.keep.category]?.short || '')} · ${esc(t.keep.unit)}</p>
      <div class="btns"><button class="btn primary" data-twin="merge" data-n="${n}">Fusionner</button>
        <button class="btn" data-twin="swap" data-n="${n}">Garder l’autre nom</button>
        <button class="btn" data-twin="different" data-n="${n}">Produits différents</button></div>
    </li>`).join('')}</ul></section>` : '';
  if (!doubtful.length && !twins.length) return `<a class="back" href="#/">Tableau</a><header class="page-head"><h1>À vérifier</h1></header><p class="muted">Rien à vérifier : tous les achats sont fiables et aucun produit n'est en double.</p>`;
  const lineHtml = (l) => {
    const f = flags.get(l.id);
    return `<li>
    <div class="rv-head"><a href="#/produits/${encodeURIComponent(l.productId)}">${esc(l.product.name)}</a><span>${String(l.qty).replace('.', ',')} × ${esc(l.product.unit)} · ${esc(fmtMoney(l.amount))}</span></div>
    <p class="hint">${esc(trust.get(l.id).why)}</p>
    <div class="btns">${(f?.fixes || []).map((x, n) => `<button class="btn primary" data-act="fix" data-n="${n}" data-id="${esc(l.id)}">${esc(x.label)}</button>`).join('')}
      <button class="btn" data-act="ok" data-id="${esc(l.id)}">C'est correct</button>
      <button class="btn" data-act="format" data-id="${esc(l.id)}">Autre format</button>
      <button class="btn danger" data-act="excluded" data-id="${esc(l.id)}">Exclure</button></div>
  </li>`;
  };
  return `<a class="back" href="#/">Tableau</a>
  <header class="page-head"><h1>À vérifier</h1><p class="muted">${doubtful.length ? `${doubtful.length} achats à confirmer dans ${groups.size} reçus. Ils ne comptent pas dans l'indice tant que tu ne les as pas confirmés ; les dépenses, elles, les comptent. Tu n’es pas obligé de tout traiter.` : 'Tous les achats sont fiables.'}</p></header>
  ${twinsHtml}
  ${doubtful.length ? `<h2 class="mt">Achats à confirmer</h2>
  <p class="hint">« Autre format » : le produit a été acheté dans un autre format (régime plutôt qu'une banane, sac plutôt qu'un avocat) ; l'achat rejoint une série de prix à part et compte à nouveau.</p>` : ''}
  ${safe.length ? `<button class="btn primary wide" id="fix-all">Appliquer les ${safe.length} corrections sans ambiguïté</button>` : ''}
  ${[...groups.entries()].map(([rid, ls]) => `<section class="rv-group">
    <div class="rv-receipt"><a href="#/recus/${encodeURIComponent(rid)}"><strong>${esc(storeName(ls[0].storeId))}</strong> · ${esc(fmtDate(ls[0].date))}</a>
      <button class="btn" data-validate="${esc(rid)}">Tout est correct dans ce reçu</button></div>
    <ul class="review">${ls.map(lineHtml).join('')}</ul></section>`).join('')}`;
}

/** Valide (ou dévalide) un reçu : l'utilisateur garantit ses achats, qui comptent tous dans l'indice. */
async function validateReceipt(id, on) {
  const r = state.data.receipts.find((x) => x.id === id);
  const next = { ...r };
  if (on) next.validatedAt = new Date().toISOString(); else delete next.validatedAt;
  await db.put('receipts', next);
}

/**
 * Achat d'un autre format que d'habitude (régime de bananes, sac d'avocats) : rattaché à une variante
 * du produit, qui a sa propre série de prix. Retourne false si l'utilisateur annule.
 */
async function otherFormat(l) {
  const p = state.data.products.find((x) => x.id === l.productId);
  const name = prompt('Nom de ce format (il formera sa propre série de prix) :', `${p.name} (autre format)`);
  if (!name || !name.trim() || slug(name) === slug(p.name)) return false;
  const existing = state.data.products.find((x) => slug(x.name) === slug(name) && x.unit === p.unit);
  const target = existing || { ...p, id: `${slug(name)}--${slug(p.unit)}`, name: name.trim(), type: slug(name) };
  if (!existing) await db.put('products', target);
  const line = state.data.lines.find((x) => x.id === l.id);
  const next = { ...line, productId: target.id, review: 'ok' };
  if (line.syncedAt) {
    try { await pushDelete([line], state.settings); next.syncedAt = null; } catch { /* renvoyé au prochain envoi */ }
  }
  await db.put('lines', next);
  toast(`Achat rattaché à « ${target.name} ».`, 'ok');
  return true;
}

/** Rattache tous les achats de `from` à `to`, supprime `from`, et retient son nom pour les prochains imports. */
async function mergeProducts(from, to) {
  const moved = state.data.lines.filter((l) => l.productId === from.id);
  // Lignes déjà dans le Google Sheet : retirées puis renvoyées sous le nom gardé.
  let resend = false;
  try { resend = (await pushDelete(moved, state.settings)) !== null; } catch { /* le Sheet garde l'ancien nom */ }
  await db.put('lines', moved.map((l) => ({ ...l, productId: to.id, ...(resend && l.syncedAt ? { syncedAt: null } : {}) })));
  await db.del('products', from.id);
  const aliases = await db.getMeta('aliases', {});
  aliases[slug(from.name)] = to.id;
  for (const [k, v] of Object.entries(aliases)) if (v === from.id) aliases[k] = to.id;
  await db.setMeta('aliases', aliases);
}

async function reviewLine(l, review) {
  const line = state.data.lines.find((x) => x.id === l.id);
  await db.put('lines', { ...line, review });
}

async function applyFix(l, patch) {
  const line = state.data.lines.find((x) => x.id === l.id);
  const next = { ...line, review: 'ok' };
  if (patch.qty) next.qty = patch.qty;
  if (patch.amount) next.amount = patch.amount;
  if (patch.unit) {
    // Même produit vendu au kg : série de prix distincte (créée au besoin)
    const p = state.data.products.find((x) => x.id === line.productId);
    const id = `${slug(p.name)}--${slug(patch.unit)}`;
    if (!state.data.products.some((x) => x.id === id)) await db.put('products', { ...p, id, unit: patch.unit });
    next.productId = id;
  }
  if (line.syncedAt) {
    try { await pushDelete([line], state.settings); next.syncedAt = null; } catch { /* renvoyé au prochain envoi */ }
  }
  await db.put('lines', next);
}

// ---------- Reçus ----------
const SOURCES = { migration: 'historique', 'ancienne-app': 'ancienne app', pdf: 'PDF', manuel: 'saisi', import: 'importé' };
/** Étiquette de fiabilité d'un reçu : validé par l'utilisateur, fiable (prix cohérents) ou à confirmer. */
const trustTag = (r, todo) => (r.validatedAt ? '<span class="tag ok">validé</span>'
  : todo ? `<span class="tag warn">${todo} à confirmer</span>` : '<span class="tag ok">fiable</span>');
function viewReceipts() {
  const { receipts, lines } = state.data;
  const byR = new Map();
  lines.forEach((l) => byR.set(l.receiptId, (byR.get(l.receiptId) || 0) + l.amount));
  const sorted = receipts.slice().sort((a, b) => b.date.localeCompare(a.date));
  const todo = new Map();
  for (const l of state.derived.doubtful) todo.set(l.receiptId, (todo.get(l.receiptId) || 0) + 1);
  let cur = '';
  const items = sorted.map((r) => {
    const mo = calc.monthOf(r.date);
    const head = mo !== cur ? `<li class="month">${esc(fmtMonth(mo))}</li>` : '';
    cur = mo;
    return `${head}<li><a href="#/recus/${encodeURIComponent(r.id)}"><span>${esc(storeName(r.storeId))}<small>${esc(fmtDate(r.date))} · ${esc(SOURCES[r.source] || r.source || '')} ${trustTag(r, todo.get(r.id))}</small></span><strong>${esc(fmtMoney(byR.get(r.id) || 0))}</strong></a></li>`;
  }).join('');
  const nTodo = sorted.filter((r) => todo.get(r.id)).length;
  return `<header class="page-head"><h1>Reçus</h1><p class="muted">${receipts.length} reçus · <span class="tag ok">fiable</span> ${receipts.length - nTodo} · <span class="tag warn">à confirmer</span> ${nTodo}</p></header><ul class="rlist">${items}</ul>`;
}

function viewReceipt(id) {
  const r = state.data.receipts.find((x) => x.id === id);
  if (!r) return '<p>Reçu introuvable.</p>';
  const P = new Map(state.data.products.map((p) => [p.id, p]));
  const ls = receiptLines(id);
  const { trust } = state.derived;
  const todo = ls.filter((l) => trust.get(l.id)?.tier === 'aConfirmer');
  state.after = () => {
    $('#edit-r').addEventListener('click', () => editReceipt(id));
    $('#val-r').addEventListener('click', async () => {
      const on = !r.validatedAt;
      if (on && todo.length && !confirm(`Tu confirmes que ${todo.length > 1 ? `les ${todo.length} achats à confirmer de ce reçu sont corrects` : 'l’achat à confirmer de ce reçu est correct'} (format, poids, quantité) ?`)) return;
      await validateReceipt(id, on);
      await reload();
      toast(on ? 'Reçu validé : tous ses achats comptent dans l’indice.' : 'Validation retirée.', 'ok');
      render();
    });
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
  <header class="page-head"><h1>${esc(storeName(r.storeId))}</h1><p class="muted">${esc(fmtDate(r.date))} · ${trustTag(r, todo.length)}</p></header>
  <section class="receipt"><table class="tbl plain"><tbody>${ls.map((l) => {
    const p = P.get(l.productId) || {};
    const t = trust.get(l.id);
    return `<tr class="${p.category === 'hors' ? 'dim' : ''}"><td><a href="#/produits/${encodeURIComponent(l.productId)}">${esc(p.name)}</a><small>${l.qty !== 1 ? `${String(l.qty).replace('.', ',')} × ${esc(fmtMoney(calc.unitPrice(l)))}` : ''}</small>${t?.tier === 'aConfirmer' ? `<small class="why">À confirmer : ${esc(t.why)}</small>` : ''}</td><td class="num">${esc(fmtMoney(l.amount))}</td></tr>`;
  }).join('')}</tbody></table>
  ${leader('Total', fmtMoney(ls.reduce((a, l) => a + l.amount, 0)))}</section>
  <p class="hint">${r.validatedAt ? `Validé le ${esc(fmtDate(r.validatedAt.slice(0, 10)))} : tous ses achats comptent dans l’indice.` : todo.length ? 'Les achats à confirmer ne comptent pas dans l’indice. Valide le reçu si tout est juste, ou corrige-le.' : 'Prix cohérents avec tes autres achats : ce reçu compte dans l’indice.'}</p>
  <div class="btns"><button class="btn ${r.validatedAt ? '' : 'primary'}" id="val-r">${r.validatedAt ? 'Retirer la validation' : 'Valider ce reçu'}</button>
  <button class="btn" id="edit-r">Modifier ce reçu</button>
  <button class="btn danger" id="del-r">Supprimer ce reçu</button></div>`;
}

// ---------- Réglages ----------
function viewSettings() {
  const d = state.data;
  state.after = () => {
    $('#gform').addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = new FormData(e.target).get('sheetUrl').trim();
      if (url && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec\/?$/.test(url)) {
        toast('Adresse invalide : elle doit commencer par https://script.google.com/macros/s/ et finir par /exec.', 'error');
        return;
      }
      state.settings = { ...state.settings, sheetUrl: url };
      await db.setMeta('settings', state.settings);
      if (url) await trySync({ quiet: false });
      render();
    });
    $('#x-json').addEventListener('click', () => exportJSON({ ...state.data, aliases: state.aliases, notSame: state.notSame }));
    $('#x-xlsx').addEventListener('click', async () => {
      try {
        await exportExcel(state.data, { series: state.derived.series, trust: state.derived.trust, alerts: state.derived.alerts.map((a) => ({ Produit: a.name, Alerte: a.kind, 'Écart %': a.pct ? Math.round(a.pct) : '' })) });
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
        if (data.aliases) await db.setMeta('aliases', data.aliases);
        if (Array.isArray(data.notSame)) await db.setMeta('notSame', data.notSame);
        await reload();
        toast('Sauvegarde restaurée.', 'ok');
        render();
      } catch (err) { toast(err.message, 'error'); }
    });
    $('#reset').addEventListener('click', async () => {
      const sent = state.data.lines.filter((l) => l.syncedAt);
      if (!confirm(`Effacer tous les reçus ajoutés et revenir aux seules données historiques ?${sent.length ? ` Les ${sent.length} lignes envoyées au Google Sheet y seront aussi retirées.` : ''}`)) return;
      try { await pushDelete(sent, state.settings); } catch (err) { toast(`Le Google Sheet garde les lignes envoyées : ${err.message}`, 'error'); }
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
  <form id="gform" class="block" autocomplete="off">
    <h2>Google Sheet</h2>
    ${syncStatus()}
    <p class="hint">Chaque reçu enregistré est ajouté à la feuille « Historique » de Suivi_depenses_V2.</p>
    <label>Adresse du script (se termine par /exec)<input name="sheetUrl" type="url" inputmode="url" value="${esc(state.settings.sheetUrl)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
    <button class="btn primary wide" type="submit">${state.settings.sheetUrl ? 'Envoyer maintenant' : 'Relier le Google Sheet'}</button>
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
  <p class="muted small center">Panier v${APP_VERSION} · données historiques : Suivi_depenses_V2</p>`;
}

// ---------- Données récupérées, ajoutées une seule fois ----------
const PATCHES = ['recus-mai-2026', 'catalogue-2026-10'];
async function applyPatches() {
  const done = await db.getMeta('patches', []);
  for (const name of PATCHES.filter((p) => !done.includes(p))) {
    try {
      const payload = await fetch(`./data/patches/${name}.json`).then((r) => r.json());
      const data = await db.loadAll();
      if (payload.type === 'catalogue') {
        // Harmonisation des noms, fusions et suppressions : les anciens noms restent reconnus aux imports.
        const plan = planCatalogue(data, payload);
        const synced = plan.delLines.filter((l) => l.syncedAt);
        if (synced.length && state.settings.sheetUrl) { try { await pushDelete(synced, state.settings); } catch { /* sans effet sur l'app */ } }
        if (plan.putProducts.length) await db.put('products', plan.putProducts);
        if (plan.putLines.length) await db.put('lines', plan.putLines);
        if (plan.delLines.length) await db.del('lines', plan.delLines.map((l) => l.id));
        if (plan.delProducts.length) await db.del('products', plan.delProducts);
        if (plan.delReceipts.length) await db.del('receipts', plan.delReceipts);
        const aliases = await db.getMeta('aliases', {});
        await db.setMeta('aliases', { ...plan.aliases, ...aliases });
        if (plan.notSame.length) await db.setMeta('notSame', [...new Set([...(await db.getMeta('notSame', [])), ...plan.notSame])]);
        const sm = plan.summary;
        const pl = (k, one, many) => `${k} ${k > 1 ? many : one}`;
        if (sm.renamed + sm.merged + sm.deleted) toast(`Catalogue harmonisé : ${pl(sm.renamed, 'nom revu', 'noms revus')}, ${pl(sm.merged, 'doublon fusionné', 'doublons fusionnés')}, ${pl(sm.deleted, 'produit retiré', 'produits retirés')} (non identifiables ou hors épicerie).`, 'ok');
      } else {
        const plan = planImport(data, payload, uid, await db.getMeta('aliases', {}));
        if (plan.stores.length) await db.put('stores', plan.stores);
        if (plan.products.length) await db.put('products', plan.products);
        if (plan.receipts.length) await db.put('receipts', plan.receipts);
        if (plan.lines.length) await db.put('lines', plan.lines);
        if (plan.receipts.length) toast(`${plan.receipts.length} reçus récupérés de l’ancienne app (${plan.lines.length} articles).`, 'ok');
      }
      done.push(name);
      await db.setMeta('patches', done);
    } catch (err) {
      console.warn('Patch non appliqué', name, err);
    }
  }
}

// ---------- Démarrage ----------
async function start() {
  try {
    // Réglages d'abord : une mise à jour du catalogue peut devoir retirer des lignes du Google Sheet.
    state.settings = { ...state.settings, ...(await db.getMeta('settings', {})) };
    state.sync = { ...state.sync, ...(await db.getMeta('sync', {})) };
    const seeded = await db.ensureSeeded();
    await applyPatches();
    await db.persist();
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
