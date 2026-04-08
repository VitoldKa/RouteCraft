import './map-toolbox.js'
import './map-annotation-editor.js'
import { MapAnnotationLayer } from './map-annotation-layer.js'
import {
	getWays,
	putWays,
	getNodes,
	putNodes,
	getBBox,
	putBBox,
	pruneBBoxes,
} from './osm-cache.js'

class OSMMap extends HTMLElement {
	constructor() {
		super()
		this.attachShadow({ mode: 'open' })

		this.route = []
		this.options = {
			strict: true,
			autoLoad: true,
			readOnly: false,
			interactionMode: 'create',
			currentDrawingColor: '#0060DD',
			annotationDraft: { text: '', color: '#1B2A41', fontSize: 12 },
			selectedAnnotationId: null,
			editingAnnotationId: null,
		}

		this.annotations = []
		this.selectedIndex = -1
		this.invalidSeg = new Map()
		this.invalidWayIds = new Set()

		// cache mémoire
		this.nodesById = new Map()
		this.wayNodeIds = new Map()
		this.wayTags = new Map()
		this.wayBBox = new Map()

		// optionnel: aide pour route-validation hors viewport courant
		this.wayToContentTiles = new Map() // wayId -> Set(tileKey)

		// hover / pick
		this.pick = null
		this.hoveredWayId = null
		this.hoverMatch = null

		// Leaflet
		this.map = null
		this.hoverLayer = null
		this.selectedLayer = null
		this.editLayer = null
		this.pickLayer = null
		this.annotationLayer = null

		this.editMarkers = new Map()
		this.editLines = new Map()

		// cache spatial statique
		this.CACHE_BASE_URL = '/spatial_cache'
		this.BBOX_INDEX_SIZE = 0.01 // doit matcher la phase C++
		this.CONTENT_TILE_SIZE = 0.05 // doit matcher la phase C++
		this.MIN_ZOOM = 14
		this.MAX_SPAN_DEG = 0.03

		// TTL IndexedDB
		this.BBOX_MAX_AGE_MS = 30 * 24 * 3600 * 1000 // 30 jours
		this.WAY_MAX_AGE_MS = 30 * 24 * 3600 * 1000 // 30 jours

		this.loading = false
		this.lastLoadKey = ''

		// Spatial index (grid in pixels)
		this.spatial = {
			enabled: true,
			cellSize: 80,
			zoom: null,
			grid: new Map(), // "cx,cy" -> Set(wayId)
			wayPixelBBox: new Map(),
		}
	}

	connectedCallback() {
		this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; height:100%; width:100%; }
        .shell { position:relative; height:100%; width:100%; }
        #map { height:100%; width:100%; }
        .leaflet-container img { max-width:none !important; }
        map-toolbox {
          position:absolute;
          top:16px;
          left:16px;
          z-index:1000;
        }
        map-annotation-editor {
          position:absolute;
          inset:0;
        }
      </style>

      <link rel="stylesheet"
            href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">

      <div class="shell">
        <map-toolbox></map-toolbox>
        <map-annotation-editor></map-annotation-editor>
        <div id="map"></div>
      </div>
    `

		this.map = L.map(this.shadowRoot.querySelector('#map')).setView(
			[46.2044, 6.1432],
			14
		)

		L.Icon.Default.imagePath = 'https://unpkg.com/leaflet@1.9.4/dist/images/'

		L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
			maxZoom: 19,
			attribution: '&copy; OpenStreetMap contributors',
		}).addTo(this.map)

		requestAnimationFrame(() => this.map.invalidateSize())
		setTimeout(() => this.map.invalidateSize(), 0)

		this._ro = new ResizeObserver(() => {
			if (this.map) this.map.invalidateSize()
		})
		this._ro.observe(this)

		this.hoverLayer = L.layerGroup().addTo(this.map)
		this.selectedLayer = L.layerGroup().addTo(this.map)
		this.editLayer = L.layerGroup().addTo(this.map)
		this.pickLayer = L.layerGroup().addTo(this.map)
		this.annotationLayer = new MapAnnotationLayer(this.map, {
			onSelect: (annotation) => {
				this.dispatchEvent(
					new CustomEvent('annotation-select', {
						detail: { annotation },
						bubbles: true,
						composed: true,
					})
				)
			},
			onEdit: (annotation) => {
				this.dispatchEvent(
					new CustomEvent('annotation-edit', {
						detail: { annotation },
						bubbles: true,
						composed: true,
					})
				)
			},
			onUpdate: (annotation) => {
				this.dispatchEvent(
					new CustomEvent('annotation-update', {
						detail: { annotation },
						bubbles: true,
						composed: true,
					})
				)
			},
			onEditCancel: (annotation) => {
				this.dispatchEvent(
					new CustomEvent('annotation-edit-cancel', {
						detail: { annotation },
						bubbles: true,
						composed: true,
					})
				)
			},
		})
		this.$toolbox = this.shadowRoot.querySelector('map-toolbox')
		this.$annotationEditor = this.shadowRoot.querySelector(
			'map-annotation-editor'
		)

		this.map.on('mousemove', (e) => this.onMouseMove(e))
		this.map.on('click', (e) => this.onMapClick(e))
		this.map.on('move', () => this.updateAnnotationEditor())
		this.map.on(
			'moveend',
			this.debounce(() => {
				if (this.options.autoLoad) this.loadWaysInView()
			}, 250)
		)

		this.map.on('zoomend', () => {
			this.buildSpatialIndex()
			this.updateAnnotationEditor()
		})
		this.$toolbox?.addEventListener('toggle', (e) => {
			this.dispatchEvent(
				new CustomEvent('toggle', {
					detail: e.detail,
					bubbles: true,
					composed: true,
				})
			)
		})
		this.$toolbox?.addEventListener('drawing-color-change', (e) => {
			this.dispatchEvent(
				new CustomEvent('drawing-color-change', {
					detail: e.detail,
					bubbles: true,
					composed: true,
				})
			)
		})
		this.$toolbox?.addEventListener('annotation-draft-change', (e) => {
			this.dispatchEvent(
				new CustomEvent('annotation-draft-change', {
					detail: e.detail,
					bubbles: true,
					composed: true,
				})
			)
		})
		this.$toolbox?.addEventListener('annotation-delete', () => {
			this.dispatchEvent(
				new CustomEvent('annotation-delete', {
					bubbles: true,
					composed: true,
				})
			)
		})
		this.$toolbox?.addEventListener('annotation-clear-selection', () => {
			this.dispatchEvent(
				new CustomEvent('annotation-clear-selection', {
					bubbles: true,
					composed: true,
				})
			)
		})
		this.$annotationEditor?.addEventListener('annotation-editor-save', (e) => {
			this.dispatchEvent(
				new CustomEvent('annotation-text-save', {
					detail: e.detail,
					bubbles: true,
					composed: true,
				})
			)
		})
		this.$annotationEditor?.addEventListener('annotation-editor-cancel', () => {
			this.dispatchEvent(
				new CustomEvent('annotation-edit-cancel', {
					bubbles: true,
					composed: true,
				})
			)
		})
		this.updateToolbox()

		this.emitStatus({ pickStatus: 'Aucun point', error: null })
	}

	disconnectedCallback() {
		if (this._ro) this._ro.disconnect()
		if (this.map) this.map.remove()
	}

	// ---------- Public API ----------

	setOptions(opts) {
		const next = { ...this.options, ...(opts || {}) }
		const modeChanged = next.interactionMode !== this.options.interactionMode
		this.options = next
		if (modeChanged && this.options.interactionMode === 'select') {
			this.clearSelection()
			this.clearHover()
		}
		this.syncMapEditingState()
		this.updateToolbox()
	}

	setRoute(route) {
		this.route = Array.isArray(route) ? route : []
		this.redrawSelected()
		this.validateAndMarkRoute({ autoFetch: true }).catch(() => {})
	}

	setAnnotations(annotations) {
		this.annotations = Array.isArray(annotations) ? annotations : []
		this.annotationLayer?.setAnnotations(this.annotations)
		this.annotationLayer?.setState({
			selectedAnnotationId: this.options.selectedAnnotationId,
			editingAnnotationId: this.options.editingAnnotationId,
		})
		this.updateAnnotationEditor()
	}

	setSelectedIndex(i) {
		this.selectedIndex = Number(i ?? -1)
		this.redrawSelected()
	}

	clearSelection() {
		this.pick = null
		this.pickLayer.clearLayers()
		this.emitStatus({ pickStatus: 'Aucun point' })
	}

	setCache(cache) {
		if (!cache) return
		this.nodesById = cache.nodesById || this.nodesById
		this.wayNodeIds = cache.wayNodeIds || this.wayNodeIds
		this.wayTags = cache.wayTags || this.wayTags
		this.wayBBox = cache.wayBBox || this.wayBBox
		this.afterDataChanged()
	}

	getCache() {
		return {
			nodesById: this.nodesById,
			wayNodeIds: this.wayNodeIds,
			wayTags: this.wayTags,
			wayBBox: this.wayBBox,
		}
	}

	clearOSMCache() {
		this.nodesById = new Map()
		this.wayNodeIds = new Map()
		this.wayTags = new Map()
		this.wayBBox = new Map()
		this.wayToContentTiles = new Map()
		this.clearHover()
		this.buildSpatialIndex()
		this.redrawSelected()
	}

	invalidate() {
		if (!this.map) return
		requestAnimationFrame(() => this.map.invalidateSize())
		setTimeout(() => this.map.invalidateSize(), 0)
	}

	fitRoute(route) {
		const pts = []
		for (const seg of route || []) {
			const a = this.nodesById.get(seg.fromNode)
			const b = this.nodesById.get(seg.toNode)
			if (a) pts.push([a.lat, a.lon])
			if (b) pts.push([b.lat, b.lon])
		}
		if (pts.length >= 2) {
			this.map.fitBounds(L.latLngBounds(pts).pad(0.3))
		}
	}

	// ---------- Validation ----------

	async validateAndMarkRoute({
		strict = this.options.strict,
		autoFetch = true,
	} = {}) {
		this.invalidSeg.clear()
		this.invalidWayIds.clear()

		const wayIds = this.uniqueWayIdsFromSegments(this.route)
		if (autoFetch && wayIds.length) {
			await this.loadWaysByIds(wayIds)
		}

		for (let i = 0; i < (this.route || []).length; i++) {
			const seg = this.route[i]
			const r = this.validateSegment(seg)

			if (strict && i > 0) {
				const prev = this.route[i - 1]
				if (Number(prev.toNode) !== Number(seg.fromNode)) {
					r.ok = false
					r.errors = r.errors || []
					r.errors.push({
						code: 'STRICT_CONTINUITY',
						message: `Continuité stricte: doit démarrer au node ${prev.toNode}`,
					})
				}
			}

			if (!r.ok) {
				const msg = r.errors?.[0]?.message || 'Segment invalide'
				this.invalidSeg.set(i, {
					codes: (r.errors || []).map((e) => e.code),
					message: msg,
				})
				this.invalidWayIds.add(Number(seg.wayId))
			}
		}

		this.dispatchEvent(
			new CustomEvent('route-validation', {
				detail: {
					ok: this.invalidSeg.size === 0,
					invalidIndexes: [...this.invalidSeg.keys()],
					invalidByIndex: Object.fromEntries(
						[...this.invalidSeg.entries()].map(([k, v]) => [k, v])
					),
				},
				bubbles: true,
				composed: true,
			})
		)

		this.redrawSelected?.()
	}

	async validateRoute(
		route = this.route,
		{ strict = this.options.strict, autoFetch = true } = {}
	) {
		const segments = Array.isArray(route) ? route : []
		const report = {
			ok: true,
			errors: [],
			warnings: [],
			fixed: [],
		}

		if (segments.length === 0) return report

		const wayIds = this.uniqueWayIdsFromSegments(segments)
		if (autoFetch && wayIds.length) {
			await this.loadWaysByIds(wayIds)
		}

		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i]
			const r = this.validateSegment(seg)

			if (!r.ok) {
				report.ok = false
				report.errors.push(
					...r.errors.map((e) => ({ index: i, segment: seg, ...e }))
				)
			}
			report.warnings.push(
				...r.warnings.map((w) => ({ index: i, segment: seg, ...w }))
			)

			if (strict && i > 0) {
				const prev = segments[i - 1]
				if (Number(prev.toNode) !== Number(seg.fromNode)) {
					if (Number(prev.toNode) === Number(seg.toNode)) {
						const before = { ...seg }
						const after = { ...seg, fromNode: seg.toNode, toNode: seg.fromNode }
						const r2 = this.validateSegment(after)

						if (r2.ok) {
							segments[i] = after
							report.fixed.push({
								index: i,
								before,
								after,
								note: 'Inversé pour respecter la continuité stricte.',
							})
						} else {
							report.ok = false
							report.errors.push({
								index: i,
								segment: seg,
								code: 'STRICT_CONTINUITY',
								message: `Continuité stricte cassée: le segment ${i} doit démarrer au node ${prev.toNode}.`,
							})
						}
					} else {
						report.ok = false
						report.errors.push({
							index: i,
							segment: seg,
							code: 'STRICT_CONTINUITY',
							message: `Continuité stricte cassée: le segment ${i} doit démarrer au node ${prev.toNode}.`,
						})
					}
				}
			}
		}

		return report
	}

	validateSegment(seg) {
		const errors = []
		const warnings = []

		const wayId = Number(seg?.wayId)
		const fromNode = Number(seg?.fromNode)
		const toNode = Number(seg?.toNode)

		if (!Number.isInteger(wayId) || wayId <= 0) {
			errors.push({ code: 'BAD_WAY_ID', message: 'wayId invalide.' })
			return { ok: false, errors, warnings }
		}

		const nodeIds = this.wayNodeIds.get(wayId)
		if (!nodeIds || nodeIds.length < 2) {
			errors.push({
				code: 'WAY_NOT_LOADED',
				message: `Way ${wayId} absente du cache mémoire (ou trop courte).`,
			})
			return { ok: false, errors, warnings }
		}

		if (
			!Number.isInteger(fromNode) ||
			!Number.isInteger(toNode) ||
			fromNode <= 0 ||
			toNode <= 0
		) {
			errors.push({
				code: 'BAD_NODE_ID',
				message: 'fromNode/toNode invalide(s).',
			})
			return { ok: false, errors, warnings }
		}

		if (fromNode === toNode) {
			errors.push({
				code: 'SAME_NODE',
				message: 'fromNode et toNode ne peuvent pas être identiques.',
			})
		}

		const a = nodeIds.indexOf(fromNode)
		const b = nodeIds.indexOf(toNode)

		if (a < 0) {
			errors.push({
				code: 'FROM_NOT_IN_WAY',
				message: `fromNode ${fromNode} n'appartient pas à way ${wayId}.`,
			})
		}

		if (b < 0) {
			errors.push({
				code: 'TO_NOT_IN_WAY',
				message: `toNode ${toNode} n'appartient pas à way ${wayId}.`,
			})
		}

		if (!this.nodesById.get(fromNode)) {
			warnings.push({
				code: 'FROM_NODE_NO_COORD',
				message: `Coordonnées manquantes pour node ${fromNode}.`,
			})
		}

		if (!this.nodesById.get(toNode)) {
			warnings.push({
				code: 'TO_NODE_NO_COORD',
				message: `Coordonnées manquantes pour node ${toNode}.`,
			})
		}

		return { ok: errors.length === 0, errors, warnings }
	}

	// ---------- Chargement depuis cache spatial statique ----------

	async loadWaysInView() {
		if (this.loading) return

		if (this.map.getZoom() < this.MIN_ZOOM) {
			this.emitStatus({
				error: `Zoome à ${this.MIN_ZOOM}+ pour charger.`,
			})
			return
		}

		const bounds = this.clampBounds(this.map.getBounds())
		const bboxKeys = this.bboxKeysCoveringBounds(bounds, this.BBOX_INDEX_SIZE)
		const stableKey = bboxKeys.slice().sort().join('|')

		if (stableKey === this.lastLoadKey) return
		this.lastLoadKey = stableKey

		this.loading = true

		try {
			const allWayIds = new Set()
			const contentTilesToFetch = new Set()

			// 1) Lire les bbox visibles depuis IndexedDB, sinon depuis fichiers statiques
			for (const key of bboxKeys) {
				let row = null

				try {
					row = await getBBox(key, { maxAgeMs: this.BBOX_MAX_AGE_MS })
				} catch {
					row = null
				}

				if (!row) {
					row = await this.fetchAndPersistBBoxIndex(key)
				}

				if (!row) continue

				for (const wayId of row.wayIds || []) {
					allWayIds.add(wayId)
				}

				for (const tileKey of row.contentTiles || []) {
					contentTilesToFetch.add(tileKey)
				}
			}

			// 2) Injecter ce qui existe déjà en IndexedDB
			const wayIds = [...allWayIds]
			let missingWayIds = []

			if (wayIds.length) {
				try {
					const res = await getWays(wayIds, { maxAgeMs: this.WAY_MAX_AGE_MS })
					this.ingestWaysIntoMemory(res.found || [])

					const foundNodeIds = this.collectNodeIdsFromWays(res.found || [])
					try {
						const nodeRows = await getNodes(foundNodeIds)
						this.ingestNodesIntoMemory(nodeRows)
					} catch {
						// ignore
					}

					missingWayIds = res.missing || []
				} catch {
					missingWayIds = wayIds
				}
			}

			// 3) Si des ways manquent, charger les content tiles associées
			if (missingWayIds.length && contentTilesToFetch.size) {
				for (const tileKey of contentTilesToFetch) {
					await this.fetchAndPersistContentTile(tileKey)
				}
			}

			this.afterDataChanged()
			this.emitStatus({ error: null })
		} catch (e) {
			this.emitStatus({ error: e?.message || String(e) })
			throw e
		} finally {
			this.loading = false
		}
	}

	async loadWaysByIds(wayIds) {
		const ids = this.normalizePositiveIntegers(wayIds)
		if (!ids.length) return

		// 1) d'abord lire depuis IndexedDB
		let foundWays = []
		let missingWayIds = ids

		try {
			const result = await getWays(ids, { maxAgeMs: this.WAY_MAX_AGE_MS })
			foundWays = result.found || []
			missingWayIds = result.missing || []
		} catch {
			foundWays = []
			missingWayIds = ids
		}

		this.ingestWaysIntoMemory(foundWays)

		if (foundWays.length) {
			const neededNodeIds = this.collectNodeIdsFromWays(foundWays)
			try {
				const nodeRows = await getNodes(neededNodeIds)
				this.ingestNodesIntoMemory(nodeRows)
			} catch {
				// ignore
			}
		}

		// 2) si des ways manquent, tenter via index local wayId -> contentTiles
		if (missingWayIds.length) {
			const tileKeys = new Set()

			for (const wayId of missingWayIds) {
				const set = this.wayToContentTiles.get(wayId)
				if (!set) continue
				for (const tileKey of set) tileKeys.add(tileKey)
			}

			for (const tileKey of tileKeys) {
				await this.fetchAndPersistContentTile(tileKey)
			}

			// 3) relire après hydratation
			try {
				const retry = await getWays(ids, { maxAgeMs: this.WAY_MAX_AGE_MS })
				this.ingestWaysIntoMemory(retry.found || [])

				const neededNodeIds = this.collectNodeIdsFromWays(retry.found || [])
				try {
					const nodeRows = await getNodes(neededNodeIds)
					this.ingestNodesIntoMemory(nodeRows)
				} catch {
					// ignore
				}
			} catch {
				// ignore
			}
		}

		this.afterDataChanged()
	}

	async fetchAndPersistBBoxIndex(key) {
		try {
			const data = await this.fetchBBoxIndex(key)
			const row = {
				key,
				wayIds: Array.isArray(data.wayIds) ? data.wayIds : [],
				contentTiles: Array.isArray(data.contentTiles) ? data.contentTiles : [],
				fetchedAt: data.fetchedAt || Date.now(),
				missing: false,
			}

			try {
				await putBBox(row)
				pruneBBoxes(5000).catch(() => {})
			} catch {
				// ignore
			}

			for (const wayId of row.wayIds) {
				let set = this.wayToContentTiles.get(wayId)
				if (!set) {
					set = new Set()
					this.wayToContentTiles.set(wayId, set)
				}
				for (const tileKey of row.contentTiles) {
					set.add(tileKey)
				}
			}

			return row
		} catch (e) {
			// Si le fichier bbox n'existe pas (404), on cache un résultat vide
			const is404 = e?.message?.includes('HTTP 404') || e?.status === 404

			if (is404) {
				const row = {
					key,
					wayIds: [],
					contentTiles: [],
					fetchedAt: Date.now(),
					missing: true,
				}

				try {
					await putBBox(row)
					pruneBBoxes(5000).catch(() => {})
				} catch {
					// ignore
				}

				return row
			}

			return null
		}
	}

	async fetchAndPersistContentTile(tileKey) {
		const tile = await this.fetchContentTile(tileKey)

		const ways = Array.isArray(tile.ways) ? tile.ways : []
		const nodes = Array.isArray(tile.nodes) ? tile.nodes : []

		this.ingestWaysIntoMemory(ways)
		this.ingestNodesIntoMemory(nodes)

		for (const w of ways) {
			let set = this.wayToContentTiles.get(Number(w.id))
			if (!set) {
				set = new Set()
				this.wayToContentTiles.set(Number(w.id), set)
			}
			set.add(tileKey)
		}

		try {
			await putWays(
				ways.map((w) => ({
					...w,
					fetchedAt: tile.fetchedAt || Date.now(),
				}))
			)
			await putNodes(nodes)
		} catch {
			// ignore
		}
	}

	// ---------- Fetch fichiers statiques ----------

	async fetchStaticJSON(path) {
		const res = await fetch(path, {
			method: 'GET',
			credentials: 'same-origin',
		})

		if (!res.ok) {
			const err = new Error(`${path} -> HTTP ${res.status}`)
			err.status = res.status
			throw err
		}

		return await res.json()
	}

	async fetchBBoxIndex(key) {
		const file = this.spatialFilenameFromKey(key)
		return this.fetchStaticJSON(`${this.CACHE_BASE_URL}/bbox-index/${file}`)
	}

	async fetchContentTile(key) {
		const file = this.spatialFilenameFromKey(key)
		return this.fetchStaticJSON(`${this.CACHE_BASE_URL}/content-tiles/${file}`)
	}

	// ---------- Cache ingest ----------

	ingestOverpassReplace(json) {
		// conservé pour compat si tu as encore de vieux appels externes
		this.nodesById = new Map()
		this.wayNodeIds = new Map()
		this.wayTags = new Map()
		this.wayBBox = new Map()

		for (const el of json.elements || []) {
			if (el.type === 'node') {
				this.nodesById.set(el.id, { lat: el.lat, lon: el.lon })
			} else if (el.type === 'way') {
				if (Array.isArray(el.nodes) && el.nodes.length >= 2) {
					this.wayNodeIds.set(el.id, el.nodes)
					this.wayTags.set(el.id, el.tags || {})
				}
			}
		}

		this.recomputeWayBBox()
	}

	ingestWaysIntoMemory(ways) {
		for (const w of ways || []) {
			if (Array.isArray(w.nodes) && w.nodes.length >= 2) {
				this.wayNodeIds.set(Number(w.id), w.nodes.map(Number))
				this.wayTags.set(Number(w.id), w.tags || {})
			}
		}
	}

	ingestNodesIntoMemory(nodes) {
		for (const row of nodes || []) {
			if (!row) continue
			if (
				!Number.isFinite(Number(row.lat)) ||
				!Number.isFinite(Number(row.lon))
			)
				continue
			this.nodesById.set(Number(row.id), {
				lat: Number(row.lat),
				lon: Number(row.lon),
			})
		}
	}

	recomputeWayBBox() {
		this.wayBBox = new Map()

		for (const [wayId, nodeIds] of this.wayNodeIds.entries()) {
			let minLat = Infinity
			let minLon = Infinity
			let maxLat = -Infinity
			let maxLon = -Infinity

			for (const nid of nodeIds) {
				const n = this.nodesById.get(nid)
				if (!n) continue

				minLat = Math.min(minLat, n.lat)
				maxLat = Math.max(maxLat, n.lat)
				minLon = Math.min(minLon, n.lon)
				maxLon = Math.max(maxLon, n.lon)
			}

			if (
				isFinite(minLat) &&
				isFinite(minLon) &&
				isFinite(maxLat) &&
				isFinite(maxLon)
			) {
				this.wayBBox.set(wayId, { minLat, minLon, maxLat, maxLon })
			}
		}
	}

	afterDataChanged() {
		this.recomputeWayBBox?.()
		this.recomputeIntersections?.()
		this.spatial.zoom = null
		this.buildSpatialIndex?.()
		this.clearHover?.()
		this.redrawSelected?.()
	}

	// ---------- Clés spatiales ----------

	formatCoord(v, precision = 5) {
		return Number(v).toFixed(precision)
	}

	spatialKey(s, w, n, e, precision = 5) {
		return [
			this.formatCoord(s, precision),
			this.formatCoord(w, precision),
			this.formatCoord(n, precision),
			this.formatCoord(e, precision),
		].join(',')
	}

	spatialFilenameFromKey(key) {
		return key.replaceAll(',', '__') + '.json'
	}

	bboxKeysCoveringBounds(bounds, size, precision = 5) {
		const s = bounds.getSouth()
		const w = bounds.getWest()
		const n = bounds.getNorth()
		const e = bounds.getEast()

		const y0 = Math.floor(s / size)
		const y1 = Math.floor(n / size)
		const x0 = Math.floor(w / size)
		const x1 = Math.floor(e / size)

		const keys = []
		for (let yi = y0; yi <= y1; yi++) {
			const south = yi * size
			const north = south + size
			for (let xi = x0; xi <= x1; xi++) {
				const west = xi * size
				const east = west + size
				keys.push(this.spatialKey(south, west, north, east, precision))
			}
		}
		return keys
	}

	// ---------- XYZ helpers (encore utiles si tu les utilises ailleurs) ----------

	tileXY(lat, lon, z) {
		const n = 2 ** z
		const x = Math.floor(((lon + 180) / 360) * n)
		const latRad = (lat * Math.PI) / 180
		const y = Math.floor(
			((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
				n
		)
		return {
			x: Math.max(0, Math.min(n - 1, x)),
			y: Math.max(0, Math.min(n - 1, y)),
		}
	}

	tileBounds(x, y, z) {
		const n = 2 ** z
		const w = (x / n) * 360 - 180
		const e = ((x + 1) / n) * 360 - 180
		const nLat =
			(180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)))
		const sLat =
			(180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)))
		return { s: sLat, w, n: nLat, e }
	}

	tilesCoveringBounds(bounds, z) {
		const s = bounds.getSouth()
		const w = bounds.getWest()
		const n = bounds.getNorth()
		const e = bounds.getEast()
		const tl = this.tileXY(n, w, z)
		const br = this.tileXY(s, e, z)

		const tiles = []
		for (let x = tl.x; x <= br.x; x++) {
			for (let y = tl.y; y <= br.y; y++) {
				tiles.push({ x, y, z })
			}
		}
		return tiles
	}

	tileKey(t) {
		return `t${t.z}/${t.x}/${t.y}`
	}

	// ---------- Spatial index (grid in pixels) ----------

	buildSpatialIndex() {
		if (!this.spatial.enabled || !this.map) return

		const zoom = this.map.getZoom()
		if (this.spatial.zoom === zoom && this.spatial.grid.size > 0) return

		this.spatial.zoom = zoom
		this.spatial.grid = new Map()
		this.spatial.wayPixelBBox = new Map()

		const cell = this.spatial.cellSize

		for (const [wayId, nodeIds] of this.wayNodeIds.entries()) {
			let minx = Infinity
			let miny = Infinity
			let maxx = -Infinity
			let maxy = -Infinity

			for (const nid of nodeIds) {
				const n = this.nodesById.get(nid)
				if (!n) continue
				const p = this.map.latLngToLayerPoint([n.lat, n.lon])
				minx = Math.min(minx, p.x)
				miny = Math.min(miny, p.y)
				maxx = Math.max(maxx, p.x)
				maxy = Math.max(maxy, p.y)
			}

			if (!isFinite(minx)) continue
			this.spatial.wayPixelBBox.set(wayId, { minx, miny, maxx, maxy })

			const cx0 = Math.floor(minx / cell)
			const cy0 = Math.floor(miny / cell)
			const cx1 = Math.floor(maxx / cell)
			const cy1 = Math.floor(maxy / cell)

			for (let cx = cx0; cx <= cx1; cx++) {
				for (let cy = cy0; cy <= cy1; cy++) {
					const key = `${cx},${cy}`
					let set = this.spatial.grid.get(key)
					if (!set) {
						set = new Set()
						this.spatial.grid.set(key, set)
					}
					set.add(wayId)
				}
			}
		}
	}

	candidatesNear(latlng) {
		this.buildSpatialIndex()

		const p = this.map.latLngToLayerPoint(latlng)
		const cell = this.spatial.cellSize
		const cx = Math.floor(p.x / cell)
		const cy = Math.floor(p.y / cell)

		const out = new Set()
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				const key = `${cx + dx},${cy + dy}`
				const set = this.spatial.grid.get(key)
				if (!set) continue
				for (const id of set) out.add(id)
			}
		}
		return out
	}

	// ---------- Hover ----------

	clearHover() {
		this.hoverLayer.clearLayers()
		this.hoveredWayId = null
		this.hoverMatch = null
	}

	updateToolbox() {
		this.$toolbox?.setState({
			interactionMode: this.options.interactionMode,
			currentDrawingColor:
				this.normalizeColor(this.options.currentDrawingColor) || '#0060DD',
			selectedAnnotationId: this.options.selectedAnnotationId,
			editingAnnotationId: this.options.editingAnnotationId,
			annotationDraft: this.options.annotationDraft,
		})
		this.annotationLayer?.setState({
			selectedAnnotationId: this.options.selectedAnnotationId,
			editingAnnotationId: this.options.editingAnnotationId,
		})
		this.updateAnnotationEditor()
	}

	syncMapEditingState() {
		if (!this.map) return
		if (this.options.editingAnnotationId) {
			if (this.map.dragging?.enabled()) this.map.dragging.disable()
			if (this.map.doubleClickZoom?.enabled())
				this.map.doubleClickZoom.disable()
			return
		}
		if (this.map.dragging && !this.map.dragging.enabled())
			this.map.dragging.enable()
		if (this.map.doubleClickZoom && !this.map.doubleClickZoom.enabled())
			this.map.doubleClickZoom.enable()
	}

	updateAnnotationEditor() {
		if (!this.$annotationEditor || !this.map) return
		const annotation = this.annotations.find(
			(item) => item?.id === this.options.editingAnnotationId
		)
		if (!annotation) {
			this.$annotationEditor.setState({ open: false, annotation: null })
			return
		}
		const point = this.map.latLngToContainerPoint([
			annotation.lat,
			annotation.lon,
		])
		this.$annotationEditor.setState({
			open: true,
			annotation,
			position: {
				x: point.x + 18,
				y: point.y - 18,
			},
		})
	}

	renderHoverWay(wayId, match = null) {
		this.hoverLayer.clearLayers()
		this.hoveredWayId = wayId
		this.hoverMatch = match

		const latlngs = this.wayToLatLngs(wayId)
		if (latlngs.length < 2) return

		const poly = L.polyline(latlngs, { weight: 7, opacity: 0.9 }).addTo(
			this.hoverLayer
		)
		const tags = this.wayTags.get(wayId) || {}
		const name = tags.name ? ` (${tags.name})` : ''
		const kind = this.describeWayKind(tags)

		const hint =
			window.event?.ctrlKey || window.event?.metaKey
				? 'Ctrl + clic : ajouter la way entière'
				: 'Clic : tronçon / intersections'

		const reasons =
			match?.reasons?.length > 0
				? `<br><small>Best match: ${match.reasons.join(' + ')}</small>`
				: ''
		const alternate =
			match?.alternate?.wayId != null
				? `<br><small>Alt: way ${match.alternate.wayId}</small>`
				: ''

		poly.bindTooltip(
			`way ${wayId}${name}${kind ? ` · ${kind}` : ''}<br><small>${hint}</small>${reasons}${alternate}`,
			{
				sticky: true,
				direction: 'top',
				opacity: 0.9,
			}
		)
	}

	onMouseMove(e) {
		if (this.options.readOnly) return
		if (
			this.options.interactionMode === 'select' ||
			this.options.interactionMode === 'annotate'
		) {
			this.clearHover()
			return
		}
		if (this.wayNodeIds.size === 0) return
		if (this._moveTicking) return
		this._moveTicking = true

		requestAnimationFrame(() => {
			this._moveTicking = false

			const candidates = this.candidatesNear(e.latlng)
			if (candidates.size === 0) {
				this.clearHover()
				return
			}
			const ranked = this.rankWayCandidates(e.latlng, [...candidates])
			const best = ranked[0] || null

			const THRESHOLD = 15
			if (!best || best.distance > THRESHOLD) {
				this.clearHover()
				return
			}

			const sameWay = best.wayId === this.hoveredWayId
			const sameReason =
				JSON.stringify(best.reasons || []) ===
				JSON.stringify(this.hoverMatch?.reasons || [])
			if (!sameWay || !sameReason) {
				this.renderHoverWay(best.wayId, best)
			}
		})
	}

	// ---------- Click pick segment ----------

	onMapClick(e) {
		if (this.options.readOnly) return
		const clickTarget = e?.originalEvent?.target
		if (
			clickTarget instanceof Element &&
			clickTarget.closest('.map-annotation-icon')
		) {
			return
		}
		if (this.options.interactionMode === 'annotate') {
			if (this.options.editingAnnotationId) return
			this.addTextAnnotationAt(e.latlng)
			return
		}
		if (this.options.interactionMode === 'select') return

		if (
			e.originalEvent &&
			(e.originalEvent.ctrlKey || e.originalEvent.metaKey)
		) {
			this.addWholeWayFromHover()
			return
		}

		if (!this.hoveredWayId) return

		const wayId = this.hoveredWayId
		const nodeId = this.nearestNodeIdOnWay(e.latlng, wayId)
		if (!nodeId) return

		if (!this.pick) {
			this.pick = { wayId, startNode: nodeId }
			const n = this.nodesById.get(nodeId)
			this.pickLayer.clearLayers()
			const matchHint =
				this.hoverMatch?.reasons?.length > 0
					? ` Best match: ${this.hoverMatch.reasons.join(' + ')}.`
					: ''

			L.circleMarker([n.lat, n.lon], {
				radius: 7,
				weight: 2,
				opacity: 0.9,
				fillOpacity: 0.5,
			})
				.bindTooltip('Départ', { sticky: true })
				.addTo(this.pickLayer)

			this.emitStatus({
				pickStatus: `Départ: way ${wayId}, node ${nodeId}. Clique un 2e point sur la même way.${matchHint}`,
				error: null,
			})
			return
		}

		if (this.pick.wayId !== wayId) {
			this.clearSelection()
			this.onMapClick(e)
			return
		}

		if (nodeId === this.pick.startNode) {
			this.emitStatus({
				error: 'Choisis un autre node pour définir un tronçon.',
			})
			return
		}

		let fromNode = this.pick.startNode
		let toNode = nodeId

		if (this.options.strict && this.route.length > 0) {
			const prev = this.route[this.route.length - 1]
			if (prev.toNode !== fromNode) {
				if (prev.toNode === toNode) [fromNode, toNode] = [toNode, fromNode]
				else {
					this.emitStatus({
						error: `Continuité stricte: le nouveau tronçon doit démarrer au node ${prev.toNode}.`,
					})
					return
				}
			}
		}

		const latlngs = this.sliceWayByNodes(wayId, fromNode, toNode)
		if (latlngs.length < 2) {
			this.emitStatus({
				error:
					'Impossible de créer le tronçon (nodes introuvables dans la way ?).',
			})
			return
		}

		this.dispatchEvent(
			new CustomEvent('segment-add', {
				detail: { segment: { wayId, fromNode, toNode } },
				bubbles: true,
				composed: true,
			})
		)

		const matchHint =
			this.hoverMatch?.reasons?.length > 0
				? ` Best match: ${this.hoverMatch.reasons.join(' + ')}.`
				: ''
		this.clearSelection()
		this.emitStatus({
			pickStatus: `Segment ajouté: way ${wayId}, ${fromNode} -> ${toNode}.${matchHint}`,
			error: null,
		})
	}

	addWholeWayFromHover() {
		if (!this.hoveredWayId) return

		const wayId = this.hoveredWayId
		const ids = this.wayNodeIds.get(wayId)
		if (!ids || ids.length < 2) return

		let fromNode = ids[0]
		let toNode = ids[ids.length - 1]

		this.clearSelection?.()

		if (this.options.strict && this.route.length > 0) {
			const prev = this.route[this.route.length - 1]
			if (prev.toNode === toNode) {
				;[fromNode, toNode] = [toNode, fromNode]
			}
			if (prev.toNode !== fromNode) {
				this.emitStatus?.({
					error: `Continuité stricte: la way entière doit démarrer au node ${prev.toNode}.`,
				})
				return
			}
		}

		const latlngs = this.sliceWayByNodes(wayId, fromNode, toNode)
		if (!latlngs || latlngs.length < 2) {
			this.emitStatus?.({
				error:
					"Impossible d'ajouter la way entière (nodes manquants dans le cache ?).",
			})
			return
		}

		this.dispatchEvent(
			new CustomEvent('segment-add', {
				detail: { segment: { wayId, fromNode, toNode } },
				bubbles: true,
				composed: true,
			})
		)

		this.emitStatus?.({
			pickStatus: `Ajout way entière (Ctrl + clic) : ${wayId}`,
			error: null,
		})
	}

	// ---------- Focus mode drawing ----------

	redrawSelected() {
		this.selectedLayer.clearLayers()
		this.editLayer.clearLayers()
		this.editMarkers.clear()
		this.editLines.clear()

		this.route.forEach((seg, idx) => {
			const latlngs = this.sliceWayByNodes(seg.wayId, seg.fromNode, seg.toNode)
			if (latlngs.length < 2) return

			const isSelected = idx === this.selectedIndex
			const isInvalid = this.invalidSeg.has(idx)
			const segmentColor = this.getSegmentColor(seg)

			const line = L.polyline(latlngs, {
				color: isInvalid ? '#d00' : segmentColor,
				weight: isSelected ? 10 : 7,
				opacity: isSelected ? 1.0 : 0.75,
				bubblingMouseEvents: false,
			}).addTo(this.selectedLayer)
			line.bindTooltip(
				`Segment ${idx + 1} · way ${seg.wayId}${seg.color ? ` · ${seg.color}` : ''}`,
				{
					sticky: true,
					direction: 'top',
					opacity: 0.9,
				}
			)
			line.on('click', (ev) => {
				L.DomEvent.stop(ev)
				L.DomEvent.stopPropagation(ev)
				L.DomEvent.preventDefault(ev)
				this.dispatchEvent(
					new CustomEvent('select-segment', {
						detail: { index: idx, source: 'map' },
						bubbles: true,
						composed: true,
					})
				)
			})

			this.editLines.set(idx, line)

			if (!isSelected) return

			const startLL = this.nodeLatLng(seg.fromNode)
			const endLL = this.nodeLatLng(seg.toNode)
			if (!startLL || !endLL) return

			const mStart = L.marker(startLL, { draggable: true })
				.bindTooltip(`Start (seg ${idx + 1})`, { sticky: true })
				.addTo(this.editLayer)

			const mEnd = L.marker(endLL, { draggable: true })
				.bindTooltip(`End (seg ${idx + 1})`, { sticky: true })
				.addTo(this.editLayer)

			mStart.on('drag', (ev) => this.previewDrag(idx, 'start', ev.latlng))
			mEnd.on('drag', (ev) => this.previewDrag(idx, 'end', ev.latlng))

			mStart.on('dragend', (ev) =>
				this.commitDrag(idx, 'start', ev.target.getLatLng())
			)
			mEnd.on('dragend', (ev) =>
				this.commitDrag(idx, 'end', ev.target.getLatLng())
			)

			this.editMarkers.set(`${idx}:start`, mStart)
			this.editMarkers.set(`${idx}:end`, mEnd)
		})
	}

	previewDrag(idx, which, latlng) {
		const seg = this.route[idx]
		if (!seg) return

		const snappedNode = this.nearestNodeIdOnWay(latlng, seg.wayId)
		if (!snappedNode) return

		const tmp = { ...seg }
		if (which === 'start') tmp.fromNode = snappedNode
		else tmp.toNode = snappedNode

		const latlngs = this.sliceWayByNodes(tmp.wayId, tmp.fromNode, tmp.toNode)
		if (latlngs.length < 2) return

		const line = this.editLines.get(idx)
		if (line) line.setLatLngs(latlngs)
	}

	commitDrag(idx, which, latlng) {
		const seg = this.route[idx]
		if (!seg) return

		const snappedNode = this.nearestNodeIdOnWay(latlng, seg.wayId)
		if (!snappedNode) return

		const updated = { ...seg }
		if (which === 'start') updated.fromNode = snappedNode
		else updated.toNode = snappedNode

		if (updated.fromNode === updated.toNode) {
			this.emitStatus({
				error: 'Start et End ne peuvent pas être le même node.',
			})
			return
		}

		const n = this.nodesById.get(snappedNode)
		const key = `${idx}:${which}`
		const marker = this.editMarkers.get(key)
		if (marker && n) marker.setLatLng([n.lat, n.lon])

		this.dispatchEvent(
			new CustomEvent('segment-update', {
				detail: { index: idx, segment: updated },
				bubbles: true,
				composed: true,
			})
		)
	}

	// ---------- Geometry helpers ----------

	nodeLatLng(nodeId) {
		const n = this.nodesById.get(nodeId)
		return n ? L.latLng(n.lat, n.lon) : null
	}

	wayToLatLngs(wayId) {
		const ids = this.wayNodeIds.get(wayId)
		if (!ids) return []

		const latlngs = []
		for (const nid of ids) {
			const n = this.nodesById.get(nid)
			if (!n) continue
			latlngs.push([n.lat, n.lon])
		}
		return latlngs
	}

	nearestNodeIdOnWay(latlng, wayId) {
		const ids = this.wayNodeIds.get(wayId)
		if (!ids) return null

		let best = null
		let bestD = Infinity
		for (const nid of ids) {
			const n = this.nodesById.get(nid)
			if (!n) continue
			const d = this.map.distance(latlng, L.latLng(n.lat, n.lon))
			if (d < bestD) {
				bestD = d
				best = nid
			}
		}
		return best
	}

	sliceWayByNodes(wayId, fromNode, toNode) {
		const ids = this.wayNodeIds.get(wayId)
		if (!ids) return []

		const a = ids.indexOf(fromNode)
		const b = ids.indexOf(toNode)
		if (a < 0 || b < 0) return []

		const from = Math.min(a, b)
		const to = Math.max(a, b)

		const latlngs = []
		for (const nid of ids.slice(from, to + 1)) {
			const n = this.nodesById.get(nid)
			if (!n) continue
			latlngs.push([n.lat, n.lon])
		}
		return latlngs
	}

	pointToSegmentDistanceMeters(p, a, b) {
		const P = this.map.latLngToLayerPoint(p)
		const A = this.map.latLngToLayerPoint(a)
		const B = this.map.latLngToLayerPoint(b)

		const ABx = B.x - A.x
		const ABy = B.y - A.y
		const APx = P.x - A.x
		const APy = P.y - A.y
		const ab2 = ABx * ABx + ABy * ABy

		let t = ab2 === 0 ? 0 : (APx * ABx + APy * ABy) / ab2
		t = Math.max(0, Math.min(1, t))

		const Cx = A.x + t * ABx
		const Cy = A.y + t * ABy
		const C = this.map.layerPointToLatLng(L.point(Cx, Cy))
		return this.map.distance(p, C)
	}

	distanceToWayMeters(latlng, wayId) {
		const ids = this.wayNodeIds.get(wayId)
		if (!ids || ids.length < 2) return Infinity

		const bb = this.wayBBox.get(wayId)
		if (bb) {
			const lat = latlng.lat
			const lon = latlng.lng
			const buf = 0.0003
			if (
				lat < bb.minLat - buf ||
				lat > bb.maxLat + buf ||
				lon < bb.minLon - buf ||
				lon > bb.maxLon + buf
			) {
				return Infinity
			}
		}

		let best = Infinity
		for (let i = 0; i < ids.length - 1; i++) {
			const na = this.nodesById.get(ids[i])
			const nb = this.nodesById.get(ids[i + 1])
			if (!na || !nb) continue

			const d = this.pointToSegmentDistanceMeters(
				latlng,
				L.latLng(na.lat, na.lon),
				L.latLng(nb.lat, nb.lon)
			)
			if (d < best) best = d
		}
		return best
	}

	// ---------- misc ----------

	clampBounds(bounds) {
		const s = bounds.getSouth()
		const n = bounds.getNorth()
		const w = bounds.getWest()
		const e = bounds.getEast()

		const latSpan = n - s
		const lngSpan = e - w
		if (latSpan <= this.MAX_SPAN_DEG && lngSpan <= this.MAX_SPAN_DEG)
			return bounds

		const c = bounds.getCenter()
		const half = this.MAX_SPAN_DEG / 2
		return L.latLngBounds(
			[c.lat - half, c.lng - half],
			[c.lat + half, c.lng + half]
		)
	}

	bboxString(bounds) {
		return `${bounds.getSouth().toFixed(6)},${bounds.getWest().toFixed(6)},${bounds
			.getNorth()
			.toFixed(6)},${bounds.getEast().toFixed(6)}`
	}

	debounce(fn, ms) {
		let t
		return (...args) => {
			clearTimeout(t)
			t = setTimeout(() => fn(...args), ms)
		}
	}

	emitStatus({ pickStatus, error }) {
		console.log('OSMMap status:', { pickStatus, error })
		this.dispatchEvent(
			new CustomEvent('status', {
				detail: { pickStatus, error },
				bubbles: true,
				composed: true,
			})
		)
	}

	getWayTags(wayId) {
		return this.wayTags.get(Number(wayId)) || {}
	}

	addTextAnnotationAt(latlng) {
		const color =
			this.normalizeColor(this.options.annotationDraft?.color) || '#1B2A41'
		const fontSize =
			this.normalizeAnnotationFontSize(
				this.options.annotationDraft?.fontSize
			) || 12
		const text = 'New annotation'

		this.dispatchEvent(
			new CustomEvent('annotation-add', {
				detail: {
					annotation: {
						id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
						text,
						lat: Number(latlng.lat),
						lon: Number(latlng.lng),
						color,
						fontSize,
					},
					startEditing: true,
				},
				bubbles: true,
				composed: true,
			})
		)

		this.emitStatus({
			pickStatus:
				'Annotation ajoutée : double-clique la note pour modifier son texte.',
			error: null,
		})
	}

	normalizeColor(value) {
		const color = typeof value === 'string' ? value.trim() : ''
		return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toUpperCase() : null
	}

	normalizeAnnotationFontSize(value) {
		const size = Number(value)
		if (!Number.isFinite(size)) return null
		const rounded = Math.round(size)
		if (rounded < 10 || rounded > 32) return null
		return rounded
	}

	getSegmentColor(seg) {
		return this.normalizeColor(seg?.color) || '#0060DD'
	}

	getExpectedContinuationNodeId() {
		if (!this.options.strict || this.route.length === 0) return null
		const prev = this.route[this.route.length - 1]
		const nodeId = Number(prev?.toNode)
		return Number.isInteger(nodeId) && nodeId > 0 ? nodeId : null
	}

	wayContainsNode(wayId, nodeId) {
		if (!nodeId) return false
		const ids = this.wayNodeIds.get(Number(wayId))
		return Array.isArray(ids) ? ids.includes(Number(nodeId)) : false
	}

	describeWayKind(tags = {}) {
		if (!tags || typeof tags !== 'object') return ''
		if (tags.railway === 'tram') return 'tram'
		if (tags.railway === 'light_rail') return 'light rail'
		if (tags.busway != null) return 'busway'
		if (tags['lanes:bus'] != null) return 'bus lanes'
		if (tags.bus === 'yes' || tags.bus === 'designated') return 'bus priority'
		if (tags.highway) return tags.highway
		if (tags.railway) return tags.railway
		return ''
	}

	transitMatchBonus(tags = {}) {
		if (!tags || typeof tags !== 'object') return 0
		if (tags.railway === 'tram' || tags.railway === 'light_rail') return 8
		if (tags.busway != null) return 7
		if (tags['lanes:bus'] != null) return 5
		if (tags.bus === 'yes' || tags.bus === 'designated') return 4
		return 0
	}

	rankWayCandidates(latlng, wayIds = []) {
		const expectedNodeId = this.getExpectedContinuationNodeId()
		const ranked = []

		for (const rawWayId of wayIds) {
			const wayId = Number(rawWayId)
			const distance = this.distanceToWayMeters(latlng, wayId)
			if (!Number.isFinite(distance)) continue

			const nearestNodeId = this.nearestNodeIdOnWay(latlng, wayId)
			const tags = this.getWayTags(wayId)
			const containsExpected = this.wayContainsNode(wayId, expectedNodeId)
			const reasons = []
			let score = -distance

			if (containsExpected) {
				score += 40
				reasons.push(`continuity via node ${expectedNodeId}`)
			}

			if (
				containsExpected &&
				nearestNodeId &&
				Number(nearestNodeId) !== Number(expectedNodeId)
			) {
				score += 5
				reasons.push('forward continuation')
			}

			const transitBonus = this.transitMatchBonus(tags)
			if (transitBonus > 0) {
				score += transitBonus
				reasons.push(this.describeWayKind(tags))
			}

			if (reasons.length === 0) reasons.push('closest geometry')

			ranked.push({
				wayId,
				distance,
				score,
				nearestNodeId,
				reasons,
			})
		}

		ranked.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score
			if (a.distance !== b.distance) return a.distance - b.distance
			return a.wayId - b.wayId
		})

		if (ranked[0] && ranked[1]) {
			const gap = ranked[0].score - ranked[1].score
			if (gap < 6 || Math.abs(ranked[0].distance - ranked[1].distance) < 2) {
				ranked[0].alternate = ranked[1]
			}
		}

		return ranked
	}

	segmentDistanceMeters(seg) {
		const latlngs = this.sliceWayByNodes(seg.wayId, seg.fromNode, seg.toNode)
		if (!latlngs || latlngs.length < 2) return 0

		let sum = 0
		for (let i = 0; i < latlngs.length - 1; i++) {
			sum += this.map.distance(latlngs[i], latlngs[i + 1])
		}
		return sum
	}

	uniqueWayIdsFromSegments(segments) {
		return [
			...new Set(
				(segments || [])
					.map((s) => Number(s.wayId))
					.filter((n) => Number.isInteger(n) && n > 0)
			),
		]
	}

	collectNodeIdsFromWays(ways) {
		const set = new Set()
		for (const w of ways || []) {
			for (const nid of w.nodes || []) set.add(Number(nid))
		}
		return [...set]
	}

	normalizePositiveIntegers(values) {
		return [...new Set((values || []).map(Number))].filter(
			(n) => Number.isInteger(n) && n > 0
		)
	}
}

customElements.define('osm-map', OSMMap)
