// components/osm-cache.js
// Cache IndexedDB pour le cache spatial OSM
//
// stores:
// - ways:   { id, nodes: number[], tags: object, fetchedAt: number }
// - nodes:  { id, lat, lon }
// - bboxes: { key, wayIds: number[], contentTiles: string[], fetchedAt: number }

const DB_NAME = 'osm-spatial-cache'
const DB_VERSION = 3
let _dbPromise = null

function openDB() {
	if (_dbPromise) return _dbPromise

	_dbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION)

		req.onupgradeneeded = () => {
			const db = req.result

			if (!db.objectStoreNames.contains('ways')) {
				db.createObjectStore('ways', { keyPath: 'id' })
			}

			if (!db.objectStoreNames.contains('nodes')) {
				db.createObjectStore('nodes', { keyPath: 'id' })
			}

			if (!db.objectStoreNames.contains('bboxes')) {
				db.createObjectStore('bboxes', { keyPath: 'key' })
			}
		}

		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error)
	})

	return _dbPromise
}

function txDone(tx) {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve()
		tx.onerror = () => reject(tx.error)
		tx.onabort = () => reject(tx.error)
	})
}

function getOne(store, key) {
	return new Promise((resolve) => {
		const r = store.get(key)
		r.onsuccess = () => resolve(r.result || null)
		r.onerror = () => resolve(null)
	})
}

function getMany(store, keys) {
	return Promise.all(keys.map((k) => getOne(store, k)))
}

function putOne(store, value) {
	return new Promise((resolve, reject) => {
		const r = store.put(value)
		r.onsuccess = () => resolve()
		r.onerror = () => reject(r.error)
	})
}

function deleteOne(store, key) {
	return new Promise((resolve) => {
		const r = store.delete(key)
		r.onsuccess = () => resolve()
		r.onerror = () => resolve()
	})
}

function clearStore(store) {
	return new Promise((resolve, reject) => {
		const r = store.clear()
		r.onsuccess = () => resolve()
		r.onerror = () => reject(r.error)
	})
}

function normalizeIds(ids) {
	return [...new Set((ids || []).map(Number))].filter(
		(n) => Number.isInteger(n) && n > 0
	)
}

function normalizeStringArray(values) {
	return [
		...new Set((values || []).map((v) => String(v).trim()).filter(Boolean)),
	]
}

function normalizeBBoxRow(row) {
	if (!row || !row.key) return null

	return {
		key: String(row.key),
		wayIds: normalizeIds(row.wayIds),
		contentTiles: normalizeStringArray(row.contentTiles),
		fetchedAt: Number(row.fetchedAt) || 0,
	}
}

export function resetDBPromiseForDev() {
	_dbPromise = null
}

export async function getWays(wayIds, { maxAgeMs = null } = {}) {
	const ids = normalizeIds(wayIds)
	if (!ids.length) return { found: [], missing: [] }

	const db = await openDB()
	const tx = db.transaction(['ways'], 'readonly')
	const store = tx.objectStore('ways')

	const rows = await getMany(store, ids)
	await txDone(tx)

	const found = []
	const missing = []
	const now = Date.now()

	for (let i = 0; i < ids.length; i++) {
		const row = rows[i]
		if (!row) {
			missing.push(ids[i])
			continue
		}

		if (maxAgeMs != null) {
			const age = now - (row.fetchedAt || 0)
			if (!row.fetchedAt || age > maxAgeMs) {
				missing.push(ids[i])
				continue
			}
		}

		found.push(row)
	}

	return { found, missing }
}

export async function putWays(ways) {
	const arr = Array.isArray(ways) ? ways : []
	if (!arr.length) return

	const db = await openDB()
	const tx = db.transaction(['ways'], 'readwrite')
	const store = tx.objectStore('ways')

	for (const w of arr) {
		if (!w || !Number.isInteger(Number(w.id))) continue

		const row = {
			id: Number(w.id),
			nodes: normalizeIds(w.nodes),
			tags: w.tags && typeof w.tags === 'object' ? w.tags : {},
			fetchedAt: Number(w.fetchedAt) || Date.now(),
		}

		if (row.nodes.length < 2) continue
		await putOne(store, row)
	}

	await txDone(tx)
}

export async function getNodes(nodeIds) {
	const ids = normalizeIds(nodeIds)
	if (!ids.length) return []

	const db = await openDB()
	const tx = db.transaction(['nodes'], 'readonly')
	const store = tx.objectStore('nodes')

	const rows = await getMany(store, ids)
	await txDone(tx)

	return rows.filter(Boolean)
}

export async function putNodes(nodes) {
	const arr = Array.isArray(nodes) ? nodes : []
	if (!arr.length) return

	const db = await openDB()
	const tx = db.transaction(['nodes'], 'readwrite')
	const store = tx.objectStore('nodes')

	for (const n of arr) {
		if (!n || !Number.isInteger(Number(n.id))) continue
		if (!isFinite(Number(n.lat)) || !isFinite(Number(n.lon))) continue

		await putOne(store, {
			id: Number(n.id),
			lat: Number(n.lat),
			lon: Number(n.lon),
		})
	}

	await txDone(tx)
}

export async function getBBox(key, { maxAgeMs = null } = {}) {
	if (!key) return null

	const db = await openDB()
	const tx = db.transaction(['bboxes'], 'readonly')
	const store = tx.objectStore('bboxes')

	const raw = await getOne(store, key)
	await txDone(tx)

	const row = normalizeBBoxRow(raw)
	if (!row) return null

	if (!row.wayIds.length) return null

	if (maxAgeMs != null) {
		const age = Date.now() - (row.fetchedAt || 0)
		if (!row.fetchedAt || age > maxAgeMs) return null
	}

	return row
}

export async function putBBox({
	key,
	wayIds,
	contentTiles = [],
	fetchedAt = Date.now(),
}) {
	if (!key) return

	const row = normalizeBBoxRow({
		key,
		wayIds,
		contentTiles,
		fetchedAt,
	})

	if (!row) return

	const db = await openDB()
	const tx = db.transaction(['bboxes'], 'readwrite')
	const store = tx.objectStore('bboxes')

	await putOne(store, row)
	await txDone(tx)
}

export async function deleteBBox(key) {
	if (!key) return

	const db = await openDB()
	const tx = db.transaction(['bboxes'], 'readwrite')
	const store = tx.objectStore('bboxes')

	await deleteOne(store, key)
	await txDone(tx)
}

export async function clearAll() {
	const db = await openDB()
	const tx = db.transaction(['ways', 'nodes', 'bboxes'], 'readwrite')

	await Promise.all([
		clearStore(tx.objectStore('ways')),
		clearStore(tx.objectStore('nodes')),
		clearStore(tx.objectStore('bboxes')),
	])

	await txDone(tx)
}

/**
 * Purge des bboxes les plus anciennes.
 * @param {number} maxEntries ex: 5000
 */
export async function pruneBBoxes(maxEntries = 5000) {
	const limit = Number(maxEntries)
	if (!Number.isInteger(limit) || limit <= 0) return

	const db = await openDB()
	const tx = db.transaction(['bboxes'], 'readwrite')
	const store = tx.objectStore('bboxes')

	const all = await new Promise((resolve) => {
		const res = []
		const c = store.openCursor()

		c.onsuccess = () => {
			const cur = c.result
			if (!cur) return resolve(res)

			const row = normalizeBBoxRow(cur.value)
			if (row) res.push(row)

			cur.continue()
		}

		c.onerror = () => resolve(res)
	})

	const rows = all.filter(Boolean)

	if (rows.length <= limit) {
		await txDone(tx)
		return
	}

	rows.sort((a, b) => (a.fetchedAt || 0) - (b.fetchedAt || 0))
	const toDelete = rows.slice(0, rows.length - limit)

	for (const row of toDelete) {
		await deleteOne(store, row.key)
	}

	await txDone(tx)
}
