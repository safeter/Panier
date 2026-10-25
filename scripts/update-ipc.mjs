// Met à jour data/ipc-quebec.json depuis l'API WDS de Statistique Canada.
// Tableau 18-10-0004-01 (IPC mensuel, non désaisonnalisé, 2002=100),
// géographie « Québec », produit « Aliments achetés en magasin ».
// Exécuté chaque mois par .github/workflows/ipc.yml (et à la demande).
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const WDS = 'https://www150.statcan.gc.ca/t1/wds/rest';
const PID = 18100004;
const OUT = new URL('../data/ipc-quebec.json', import.meta.url);

async function post(endpoint, body) {
  const res = await fetch(`${WDS}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${endpoint} : HTTP ${res.status}`);
  const [first] = await res.json();
  if (first.status !== 'SUCCESS') throw new Error(`${endpoint} : ${JSON.stringify(first).slice(0, 300)}`);
  return first.object;
}

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function findMember(dimension, ...names) {
  const wanted = names.map(norm);
  const m = dimension.member.find((x) => wanted.includes(norm(x.memberNameEn)) || wanted.includes(norm(x.memberNameFr || '')));
  if (!m) throw new Error(`membre introuvable : ${names.join(' / ')} dans ${dimension.dimensionNameEn}`);
  return m.memberId;
}

// Méthode 1 : API WDS (rapide, quelques Ko).
async function viaWds() {
  const meta = await post('getCubeMetadata', [{ productId: PID }]);
  const dims = meta.dimension;
  const geo = dims.find((d) => /geograph/i.test(d.dimensionNameEn));
  const prod = dims.find((d) => /product/i.test(d.dimensionNameEn));
  const coord = new Array(10).fill(0);
  coord[geo.dimensionPositionId - 1] = findMember(geo, 'Quebec', 'Québec');
  coord[prod.dimensionPositionId - 1] = findMember(prod, 'Food purchased from stores', 'Aliments achetés en magasin');
  const data = await post('getDataFromCubePidCoordAndLatestN', [{ productId: PID, coordinate: coord.join('.'), latestN: 120 }]);
  return {
    vector: `v${data.vectorId}`,
    points: data.vectorDataPoint.filter((p) => p.value !== null).map((p) => ({ month: p.refPer.slice(0, 7), value: Number(p.value) })),
  };
}

// Méthode 2 : fichier CSV complet du tableau (plus lourd, format très stable).
function splitCsv(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function viaCsv() {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync: wf } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const res = await fetch(`https://www150.statcan.gc.ca/n1/tbl/csv/${PID}-eng.zip`);
  if (!res.ok) throw new Error(`CSV : HTTP ${res.status}`);
  const dir = mkdtempSync(join(tmpdir(), 'ipc-'));
  const zip = join(dir, 't.zip');
  wf(zip, Buffer.from(await res.arrayBuffer()));
  const csv = execFileSync('unzip', ['-p', zip, `${PID}.csv`], { maxBuffer: 1 << 30 }).toString('utf8');
  const lines = csv.split(/\r?\n/);
  const head = splitCsv(lines[0].replace(/^﻿/, ''));
  const col = (name) => head.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iDate = col('REF_DATE'), iGeo = col('GEO'), iProd = col('Products and product groups'), iVal = col('VALUE'), iVec = col('VECTOR');
  const points = [];
  let vector = null;
  for (const line of lines.slice(1)) {
    if (!line.includes('Quebec') || !line.includes('Food purchased from stores')) continue;
    const f = splitCsv(line);
    if (f[iGeo] !== 'Quebec' || f[iProd] !== 'Food purchased from stores' || f[iVal] === '') continue;
    points.push({ month: f[iDate].slice(0, 7), value: Number(f[iVal]) });
    vector = f[iVec];
  }
  return { vector, points: points.filter((p) => p.month >= '2015-01') };
}

let result;
try {
  result = await viaWds();
  console.log('Source : API WDS');
} catch (err) {
  console.log(`API WDS indisponible (${err.message}) ; essai du fichier CSV.`);
  result = await viaCsv();
  console.log('Source : fichier CSV');
}
const points = result.points.sort((a, b) => a.month.localeCompare(b.month));
if (points.length < 12) throw new Error(`série trop courte : ${points.length} points`);

const out = {
  source: 'Statistique Canada, tableau 18-10-0004-01 — Québec, aliments achetés en magasin (2002=100)',
  vector: result.vector,
  updated: new Date().toISOString().slice(0, 10),
  points,
};
const before = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
const prevPoints = before ? JSON.stringify(JSON.parse(before).points) : '';
if (prevPoints === JSON.stringify(points)) {
  console.log('Aucune nouvelle donnée.');
} else {
  writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(`${points.length} points, dernier : ${points.at(-1).month} = ${points.at(-1).value}`);
}
