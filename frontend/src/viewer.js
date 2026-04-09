import './components/osm-map.js'

class OSMRouteViewer extends HTMLElement {
	constructor() {
		super()
		this.attachShadow({ mode: 'open' })
		this.route = []
		this.primitives = []
		this.annotations = []
		this.bounds = null
	}

	connectedCallback() {
		this.shadowRoot.innerHTML = `
      <style>
        .wrap { height:100vh; width:100vw; }
        osm-map { display:block; height:100%; width:100%; }
      </style>

      <div class="wrap">
        <osm-map></osm-map>
      </div>
    `

		this.$map = this.shadowRoot.querySelector('osm-map')

		// Viewer: pas de pick / édition
		this.$map.setOptions({
			strict: false,
			autoLoad: false,
			readOnly: true,
			showToolbox: false,
		})
		this.$map.setSelectedIndex(-1)

		this.$map.addEventListener('status', (e) => {
			const { error } = e.detail || {}
			if (error) this.setStatus(error, true)
		})

		this.loadStaticJSONAndRender().catch((err) => {
			this.setStatus(err?.message || String(err), true)
		})
	}

	setStatus(text, isError = false) {
		if (isError) console.error('[viewer]', text)
		else console.info('[viewer]', text)
	}

	readStaticJSON() {
		const tag = document.getElementById('route-json')
		if (!tag)
			throw new Error(
				"Balise <script id='route-json' type='application/json'> introuvable."
			)
		const txt = tag.textContent.trim()
		if (!txt) throw new Error('route-json est vide.')

		let obj
		try {
			obj = JSON.parse(txt)
		} catch {
			throw new Error('JSON invalide dans route-json.')
		}

		const arr = Array.isArray(obj) ? obj : Array.isArray(obj?.route) ? obj.route : []

		const route = arr
			.map((s) => ({
				wayId: Number(s.wayId),
				fromNode: Number(s.fromNode),
				toNode: Number(s.toNode),
				...(s?.viaWrap === true ? { viaWrap: true } : {}),
				...(this.normalizeColor(s?.color)
					? { color: this.normalizeColor(s.color) }
					: {}),
			}))
			.filter(
				(s) =>
					Number.isInteger(s.wayId) &&
					Number.isInteger(s.fromNode) &&
					Number.isInteger(s.toNode)
			)

		const annotations = Array.isArray(obj?.annotations)
			? obj.annotations
					.map((annotation) => this.normalizeAnnotation(annotation))
					.filter(Boolean)
			: []

		const primitives = Array.isArray(obj?.primitives)
			? obj.primitives
					.map((primitive) => this.normalizePrimitive(primitive))
					.filter(Boolean)
			: []

		const bounds = this.normalizeBounds(obj?.bounds)

		if (!route.length && !primitives.length && !annotations.length) {
			throw new Error(
				'Format attendu: {"route":[...]} ou {"route":[...], "primitives":[...]}'
			)
		}
		return { obj, route, annotations, primitives, bounds }
	}

	async loadStaticJSONAndRender() {
		const { obj, route, annotations, primitives, bounds } =
			this.readStaticJSON()
		this.route = route
		this.annotations = annotations
		this.primitives = primitives
		this.bounds = bounds

		this.$map.setDrawableBounds(this.bounds)

		if (this.primitives.length > 0) {
			this.$map.setRoute([])
			this.$map.setAnnotations([])
			this.$map.setDrawablePrimitives(this.primitives)
			this.zoomOnRoute()
			this.setStatus('OK (autonome)')
			return
		}

		this.setStatus('Chargement des ways…')

		await this.$map.loadWaysByIds(this.route.map((s) => s.wayId))
		this.$map.setDrawablePrimitives([])
		this.$map.setRoute(this.route)
		this.zoomOnRoute()
		this.setStatus('OK')
	}

	zoomOnRoute() {
		if (this.$map.invalidate) this.$map.invalidate()
		if (this.primitives.length > 0) {
			this.$map.fitDrawableContent()
			return
		}
		this.$map.fitRoute(this.route)
	}

	normalizeColor(value) {
		if (typeof value !== 'string') return null
		const trimmed = value.trim()
		return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toUpperCase() : null
	}

	normalizePrimitive(primitive) {
		if (primitive?.type === 'polyline') {
			const latlngs = Array.isArray(primitive.latlngs)
				? primitive.latlngs
						.map((point) => [Number(point?.[0]), Number(point?.[1])])
						.filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]))
				: []
			if (latlngs.length < 2) return null
			return {
				type: 'polyline',
				id: typeof primitive.id === 'string' ? primitive.id : null,
				segmentIndex: Number.isInteger(primitive.segmentIndex)
					? primitive.segmentIndex
					: null,
				color: this.normalizeColor(primitive.color) || '#0060DD',
				weight: Number.isFinite(Number(primitive.weight))
					? Number(primitive.weight)
					: 7,
				latlngs,
			}
		}
		if (primitive?.type === 'label') {
			const text =
				typeof primitive.text === 'string' ? primitive.text.trimEnd() : ''
			const lat = Number(primitive.lat)
			const lon = Number(primitive.lon)
			if (!text.trim() || !Number.isFinite(lat) || !Number.isFinite(lon))
				return null
			return {
				type: 'label',
				id: typeof primitive.id === 'string' ? primitive.id : null,
				text,
				lat,
				lon,
				color: this.normalizeColor(primitive.color) || '#0060DD',
				fontSize: Number.isFinite(Number(primitive.fontSize))
					? Math.round(Number(primitive.fontSize))
					: 12,
			}
		}
		return null
	}

	normalizeAnnotation(annotation) {
		const text =
			typeof annotation?.text === 'string' ? annotation.text.trimEnd() : ''
		const lat = Number(annotation?.lat)
		const lon = Number(annotation?.lon)
		if (!text.trim() || !Number.isFinite(lat) || !Number.isFinite(lon))
			return null
		return {
			id: typeof annotation?.id === 'string' ? annotation.id : null,
			text,
			lat,
			lon,
			color: this.normalizeColor(annotation?.color) || '#0060DD',
			fontSize: Number.isFinite(Number(annotation?.fontSize))
				? Math.round(Number(annotation.fontSize))
				: 12,
		}
	}

	normalizeBounds(bounds) {
		if (!bounds || typeof bounds !== 'object') return null
		const south = Number(bounds.south)
		const west = Number(bounds.west)
		const north = Number(bounds.north)
		const east = Number(bounds.east)
		if (
			!Number.isFinite(south) ||
			!Number.isFinite(west) ||
			!Number.isFinite(north) ||
			!Number.isFinite(east)
		) {
			return null
		}
		return { south, west, north, east }
	}
}

customElements.define('osm-route-viewer', OSMRouteViewer)
