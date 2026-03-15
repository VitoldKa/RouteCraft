// components/osm-cache.js
// Cache IndexedDB pour OSM/Overpass : ways, nodes, bboxes
// - ways: { id, nodes: number[], tags: object, fetchedAt: number }
// - nodes: { id, lat, lon }
// - bboxes: { key, wayIds: number[], fetchedAt: number }

const DB_NAME = "osm-overpass-cache";
const DB_VERSION = 2; // IMPORTANT: bump pour créer bboxes si tu avais déjà v1
let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains("ways")) {
        db.createObjectStore("ways", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("nodes")) {
        db.createObjectStore("nodes", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("bboxes")) {
        db.createObjectStore("bboxes", { keyPath: "key" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return _dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function getOne(store, key) {
  return new Promise((resolve) => {
    const r = store.get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => resolve(null);
  });
}

function getMany(store, keys) {
  return Promise.all(keys.map((k) => getOne(store, k)));
}

function putOne(store, value) {
  return new Promise((resolve, reject) => {
    const r = store.put(value);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

function deleteOne(store, key) {
  return new Promise((resolve) => {
    const r = store.delete(key);
    r.onsuccess = () => resolve();
    r.onerror = () => resolve();
  });
}

function normalizeIds(ids) {
  return [...new Set((ids || []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
}

export function resetDBPromiseForDev() {
  // utile uniquement si tu changes DB_VERSION et que tu veux reset sans reload.
  _dbPromise = null;
}

export async function getWays(wayIds, { maxAgeMs = null } = {}) {
  const ids = normalizeIds(wayIds);
  if (!ids.length) return { found: [], missing: [] };

  const db = await openDB();
  const tx = db.transaction(["ways"], "readonly");
  const store = tx.objectStore("ways");

  const rows = await getMany(store, ids);
  await txDone(tx);

  const found = [];
  const missing = [];

  const now = Date.now();
  for (let i = 0; i < ids.length; i++) {
    const row = rows[i];
    if (!row) {
      missing.push(ids[i]);
      continue;
    }
    if (maxAgeMs != null) {
      const age = now - (row.fetchedAt || 0);
      if (!row.fetchedAt || age > maxAgeMs) {
        missing.push(ids[i]);
        continue;
      }
    }
    found.push(row);
  }

  return { found, missing };
}

export async function putWays(ways) {
  const arr = Array.isArray(ways) ? ways : [];
  if (!arr.length) return;

  const db = await openDB();
  const tx = db.transaction(["ways"], "readwrite");
  const store = tx.objectStore("ways");

  for (const w of arr) {
    if (!w || !Number.isInteger(Number(w.id))) continue;
    await putOne(store, w);
  }

  await txDone(tx);
}

export async function getNodes(nodeIds) {
  const ids = normalizeIds(nodeIds);
  if (!ids.length) return [];

  const db = await openDB();
  const tx = db.transaction(["nodes"], "readonly");
  const store = tx.objectStore("nodes");

  const rows = await getMany(store, ids);
  await txDone(tx);

  return rows.filter(Boolean);
}

export async function putNodes(nodes) {
  const arr = Array.isArray(nodes) ? nodes : [];
  if (!arr.length) return;

  const db = await openDB();
  const tx = db.transaction(["nodes"], "readwrite");
  const store = tx.objectStore("nodes");

  for (const n of arr) {
    if (!n || !Number.isInteger(Number(n.id))) continue;
    if (!isFinite(n.lat) || !isFinite(n.lon)) continue;
    await putOne(store, { id: Number(n.id), lat: Number(n.lat), lon: Number(n.lon) });
  }

  await txDone(tx);
}

export async function getBBox(key, { maxAgeMs = null } = {}) {
  if (!key) return null;

  const db = await openDB();
  const tx = db.transaction(["bboxes"], "readonly");
  const store = tx.objectStore("bboxes");

  const row = await getOne(store, key);
  await txDone(tx);

  if (!row) return null;
  if (!Array.isArray(row.wayIds) || !row.wayIds.length) return null;

  if (maxAgeMs != null) {
    const age = Date.now() - (row.fetchedAt || 0);
    if (!row.fetchedAt || age > maxAgeMs) return null;
  }

  return row;
}

export async function putBBox({ key, wayIds, fetchedAt = Date.now() }) {
  if (!key) return;

  const ids = normalizeIds(wayIds);
  const db = await openDB();
  const tx = db.transaction(["bboxes"], "readwrite");
  const store = tx.objectStore("bboxes");

  await putOne(store, { key, wayIds: ids, fetchedAt });
  await txDone(tx);
}

export async function deleteBBox(key) {
  if (!key) return;

  const db = await openDB();
  const tx = db.transaction(["bboxes"], "readwrite");
  const store = tx.objectStore("bboxes");

  await deleteOne(store, key);
  await txDone(tx);
}

export async function clearAll() {
  const db = await openDB();
  const tx = db.transaction(["ways", "nodes", "bboxes"], "readwrite");

  tx.objectStore("ways").clear();
  tx.objectStore("nodes").clear();
  tx.objectStore("bboxes").clear();

  await txDone(tx);
}

/**
 * Optionnel: purge des bboxes les plus anciennes si tu veux éviter la croissance.
 * @param {number} maxEntries ex: 200
 */
export async function pruneBBoxes(maxEntries = 200) {
  const db = await openDB();
  const tx = db.transaction(["bboxes"], "readwrite");
  const store = tx.objectStore("bboxes");

  // Scan via cursor
  const all = await new Promise((resolve) => {
    const res = [];
    const c = store.openCursor();
    c.onsuccess = () => {
      const cur = c.result;
      if (!cur) return resolve(res);
      res.push(cur.value);
      cur.continue();
    };
    c.onerror = () => resolve(res);
  });

  // rien à faire
  if (all.length <= maxEntries) {
    await txDone(tx);
    return;
  }

  // sort oldest first
  all.sort((a, b) => (a.fetchedAt || 0) - (b.fetchedAt || 0));
  const toDelete = all.slice(0, all.length - maxEntries);

  for (const row of toDelete) {
    await deleteOne(store, row.key);
  }

  await txDone(tx);
}
