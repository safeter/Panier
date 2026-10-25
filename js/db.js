// Stockage local (IndexedDB). Toutes les données restent sur l'appareil pendant la phase de test.
const DB_NAME = 'panier';
const VERSION = 1;
export const STORES = ['stores', 'products', 'receipts', 'lines', 'meta'];

let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) {
          const os = db.createObjectStore(s, { keyPath: s === 'meta' ? 'key' : 'id' });
          if (s === 'lines') os.createIndex('receiptId', 'receiptId');
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(stores, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const out = fn(t);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export function getAll(store) {
  return open().then((db) => new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export function put(store, items) {
  const arr = Array.isArray(items) ? items : [items];
  return tx([store], 'readwrite', (t) => { const os = t.objectStore(store); arr.forEach((x) => os.put(x)); });
}

export function del(store, ids) {
  const arr = Array.isArray(ids) ? ids : [ids];
  return tx([store], 'readwrite', (t) => { const os = t.objectStore(store); arr.forEach((id) => os.delete(id)); });
}

export function clearAll() {
  return tx(STORES, 'readwrite', (t) => STORES.forEach((s) => t.objectStore(s).clear()));
}

export async function getMeta(key, fallback = null) {
  const all = await getAll('meta');
  const m = all.find((x) => x.key === key);
  return m ? m.value : fallback;
}
export const setMeta = (key, value) => put('meta', { key, value });

/** Charge tout en mémoire (quelques milliers de lignes au plus). */
export async function loadAll() {
  const [stores, products, receipts, lines] = await Promise.all(['stores', 'products', 'receipts', 'lines'].map(getAll));
  return { stores, products, receipts, lines };
}

/** Remplace tout le contenu par un jeu de données (restauration ou données migrées). */
export async function replaceAll(data) {
  await tx(['stores', 'products', 'receipts', 'lines'], 'readwrite', (t) => {
    for (const s of ['stores', 'products', 'receipts', 'lines']) {
      const os = t.objectStore(s);
      os.clear();
      (data[s] || []).forEach((x) => os.put(x));
    }
  });
}

/** Premier lancement : intègre les données migrées du Sheet. */
export async function ensureSeeded() {
  if (await getMeta('seeded')) return false;
  const seed = await fetch('./data/seed.json').then((r) => r.json());
  await replaceAll(seed);
  await setMeta('seeded', { at: new Date().toISOString(), source: seed.source });
  return true;
}

/** Demande au navigateur de ne pas effacer les données (important sur mobile). */
export async function persist() {
  if (navigator.storage?.persist) {
    try { return await navigator.storage.persist(); } catch { return false; }
  }
  return false;
}
