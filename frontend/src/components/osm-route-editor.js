import './osm-map.js'
import './route-panel.js'
import './json-editor.js'

class OSMRouteEditor extends HTMLElement {
	constructor() {
		super()
		this.attachShadow({ mode: 'open' })

		this.route = []
		this.annotations = []
		this.cache = {
			nodesById: new Map(),
			wayNodeIds: new Map(),
			wayTags: new Map(),
			wayBBox: new Map(),
		}

		this.ui = {
			strict: true,
			autoLoad: true,
			interactionMode: 'create',
			debugShowWays: false,
			lastSegmentColor: '#0060DD',
			selectedAnnotationId: null,
			editingAnnotationId: null,
			annotationDraft: { text: '', color: '#0060DD', fontSize: 12 },
			lastError: null,
			ioStatus: { kind: 'ok', text: 'Synchronisé' },
			pickStatus: 'Aucun point',
			dirty: false,
			selectedIndex: -1, // focus mode
		}

		this._jsonSyncTimer = null
		this._panelRefreshFrame = null
	}

	connectedCallback() {
		this.shadowRoot.innerHTML = `
      <style>
        .wrap { display:flex; height: 100vh; width:100vw; }
        osm-map { flex: 1; }
        .panel { width: 420px; border-left:1px solid #ddd; background:#fafafa; overflow:auto; }
      </style>

      <div class="wrap">
        <osm-map></osm-map>
        <div class="panel">
          <route-panel></route-panel>
          <json-editor></json-editor>
        </div>
      </div>
    `

		this.$map = this.shadowRoot.querySelector('osm-map')
		this.$panel = this.shadowRoot.querySelector('route-panel')
		this.$json = this.shadowRoot.querySelector('json-editor')

		this.renderAll()

		// ---- Panel toggles
		this.$panel.addEventListener('toggle', (e) => {
			const { name, value } = e.detail
			if (name === 'strict') this.ui.strict = !!value
			if (name === 'autoLoad') this.ui.autoLoad = !!value
			if (name === 'interactionMode') {
				this.ui.interactionMode =
					value === 'select' || value === 'annotate' ? value : 'create'
				this.ui.pickStatus =
					this.ui.interactionMode === 'select'
						? 'Mode sélection : clique un segment existant sur la carte ou dans la liste.'
						: this.ui.interactionMode === 'annotate'
							? 'Mode annotation : clique sur la carte pour poser une note.'
							: 'Mode création : clique sur la carte pour ajouter un tronçon.'
			}
			if (name === 'debugShowWays') this.ui.debugShowWays = !!value
			this.renderPanel()
			this.$map.setOptions({
				strict: this.ui.strict,
				autoLoad: this.ui.autoLoad,
				interactionMode: this.ui.interactionMode,
				debugShowWays: this.ui.debugShowWays,
				currentDrawingColor: this.ui.lastSegmentColor,
				selectedAnnotationId: this.ui.selectedAnnotationId,
				editingAnnotationId: this.ui.editingAnnotationId,
				annotationDraft: this.ui.annotationDraft,
			})
		})

		// ---- Panel actions
		this.$panel.addEventListener('action', async (e) => {
			const { type } = e.detail

			if (type === 'clear') {
				this.route = []
				this.annotations = []
				this.ui.lastError = null
				this.ui.pickStatus = 'Aucun point'
				this.ui.selectedIndex = -1
				this.ui.selectedAnnotationId = null
				this.ui.editingAnnotationId = null
				this.ui.annotationDraft = this.defaultAnnotationDraft()
				this.renderAll()
				this.$map.clearSelection()
				return
			}

			if (type === 'reload-bbox') {
				await this.$map.loadWaysInView()
				this.syncCacheFromMap()
				this.renderAll()
				return
			}

			if (type === 'load-from-route') {
				await this.loadCacheFromRouteWayIds()
				this.syncCacheFromMap()
				this.renderAll()
				this.$map.fitRoute(this.route)
				return
			}

			if (type === 'export') {
				this.$json.setJSON(this.buildFullExport())
				this.ui.dirty = false
				this.ui.ioStatus = { kind: 'ok', text: 'Synchronisé' }
				this.renderPanel()
				return
			}

			if (type === 'export-drawable') {
				await this.loadCacheFromRouteWayIds()
				this.syncCacheFromMap()
				const drawable = this.buildDrawableExport()
				if (!drawable) {
					this.renderPanel()
					return
				}
				this.$json.setJSON(drawable)
				this.ui.dirty = false
				this.ui.ioStatus = { kind: 'ok', text: 'Export dessin prêt' }
				this.renderPanel()
				return
			}

			if (type === 'format') {
				this.$json.format()
				return
			}

			if (type === 'import') {
				await this.applyEditorJSON()
				return
			}
		})

		// ---- List reorder/delete
		this.$panel.addEventListener('route-edit', (e) => {
			const { op } = e.detail

			if (op.type === 'del') {
				this.route.splice(op.index, 1)
				if (this.ui.selectedIndex === op.index) this.ui.selectedIndex = -1
				else if (this.ui.selectedIndex > op.index) this.ui.selectedIndex--
			}

			if (op.type === 'up' && op.index > 0) {
				;[this.route[op.index - 1], this.route[op.index]] = [
					this.route[op.index],
					this.route[op.index - 1],
				]
				if (this.ui.selectedIndex === op.index)
					this.ui.selectedIndex = op.index - 1
				else if (this.ui.selectedIndex === op.index - 1)
					this.ui.selectedIndex = op.index
			}

			if (op.type === 'down' && op.index < this.route.length - 1) {
				;[this.route[op.index + 1], this.route[op.index]] = [
					this.route[op.index],
					this.route[op.index + 1],
				]
				if (this.ui.selectedIndex === op.index)
					this.ui.selectedIndex = op.index + 1
				else if (this.ui.selectedIndex === op.index + 1)
					this.ui.selectedIndex = op.index
			}

			if (
				op.type === 'set-color' &&
				op.index >= 0 &&
				op.index < this.route.length
			) {
				const seg = { ...this.route[op.index] }
				const color = this.normalizeSegmentColor(op.color)
				if (color) {
					seg.color = color
					this.ui.lastSegmentColor = color
				} else {
					delete seg.color
					this.ui.lastSegmentColor = '#0060DD'
				}
				this.route[op.index] = seg
			}

			if (
				op.type === 'set-color' &&
				(op.index == null || op.index < 0 || op.index >= this.route.length)
			) {
				const color = this.normalizeSegmentColor(op.color)
				this.ui.lastSegmentColor = color || '#0060DD'
			}

			if (op.type === 'pick-color') {
				const color = this.normalizeSegmentColor(op.color)
				if (color) {
					this.ui.lastSegmentColor = color
					this.ui.annotationDraft = this.normalizeAnnotationDraft({
						...(this.ui.annotationDraft || this.defaultAnnotationDraft()),
						color,
					})
				}
			}

			this.renderAll()
			this.$json.setJSON({ route: this.route, annotations: this.annotations })
		})

		this.$map.addEventListener('route-validation', (e) => {
			const { invalidIndexes, invalidByIndex } = e.detail

			invalidIndexes.forEach((e) => {
				const list = this.$panel.shadowRoot.querySelector('#list')
				list.children[e]?.classList.add('invalid')
			})
			// 1) stocker dans ton state
			// state.invalid = new Set(invalidIndexes);
			// state.invalidInfo = invalidByIndex;

			// // 2) rerender ta liste
			// this.$panel
		})

		this.$map.addEventListener('toggle', (e) => {
			const { name, value } = e.detail
			if (name === 'interactionMode') {
				this.ui.interactionMode =
					value === 'select' || value === 'annotate' ? value : 'create'
				this.ui.pickStatus =
					this.ui.interactionMode === 'select'
						? 'Mode sélection : clique un segment existant sur la carte ou dans la liste.'
						: this.ui.interactionMode === 'annotate'
							? 'Mode annotation : clique sur la carte pour poser une note.'
							: 'Mode création : clique sur la carte pour ajouter un tronçon.'
			} else if (name === 'debugShowWays') {
				this.ui.debugShowWays = !!value
			} else {
				return
			}
			this.renderAll()
			this.$map.setOptions({
				strict: this.ui.strict,
				autoLoad: this.ui.autoLoad,
				interactionMode: this.ui.interactionMode,
				debugShowWays: this.ui.debugShowWays,
				currentDrawingColor: this.ui.lastSegmentColor,
				selectedAnnotationId: this.ui.selectedAnnotationId,
				editingAnnotationId: this.ui.editingAnnotationId,
				annotationDraft: this.ui.annotationDraft,
			})
		})

		this.$map.addEventListener('drawing-color-change', (e) => {
			const color = this.normalizeSegmentColor(e.detail?.color) || '#0060DD'
			this.ui.lastSegmentColor = color
			this.ui.annotationDraft = this.normalizeAnnotationDraft({
				...(this.ui.annotationDraft || this.defaultAnnotationDraft()),
				color,
			})
			if (
				this.ui.selectedIndex >= 0 &&
				this.ui.selectedIndex < this.route.length
			) {
				this.route[this.ui.selectedIndex] = {
					...this.route[this.ui.selectedIndex],
					color,
				}
				this.$map.redrawSelected()
				this.scheduleJsonSync()
			}
			if (this.ui.selectedAnnotationId) {
				const index = this.annotations.findIndex(
					(item) => item.id === this.ui.selectedAnnotationId
				)
				if (index >= 0) {
					this.annotations[index] = this.normalizeAnnotation({
						...this.annotations[index],
						color,
					})
					this.$map.setAnnotations(this.annotations)
					this.scheduleJsonSync()
				}
			}
			this.$map.setOptions({
				strict: this.ui.strict,
				autoLoad: this.ui.autoLoad,
				interactionMode: this.ui.interactionMode,
				debugShowWays: this.ui.debugShowWays,
				currentDrawingColor: this.ui.lastSegmentColor,
				selectedAnnotationId: this.ui.selectedAnnotationId,
				editingAnnotationId: this.ui.editingAnnotationId,
				annotationDraft: this.ui.annotationDraft,
			})
			this.schedulePanelRefresh()
		})

		this.$map.addEventListener('annotation-draft-change', (e) => {
			this.ui.annotationDraft = this.normalizeAnnotationDraft({
				...(this.ui.annotationDraft || this.defaultAnnotationDraft()),
				...(e.detail?.patch || {}),
			})
			if (this.ui.selectedAnnotationId) {
				const index = this.annotations.findIndex(
					(item) => item.id === this.ui.selectedAnnotationId
				)
				if (index >= 0) {
					this.annotations[index] = this.normalizeAnnotation({
						...this.annotations[index],
						color: this.ui.annotationDraft.color,
						fontSize: this.ui.annotationDraft.fontSize,
					})
					this.$map.setAnnotations(this.annotations)
					this.scheduleJsonSync()
				}
			}
			this.$map.setOptions({
				strict: this.ui.strict,
				autoLoad: this.ui.autoLoad,
				interactionMode: this.ui.interactionMode,
				debugShowWays: this.ui.debugShowWays,
				currentDrawingColor: this.ui.lastSegmentColor,
				selectedAnnotationId: this.ui.selectedAnnotationId,
				editingAnnotationId: this.ui.editingAnnotationId,
				annotationDraft: this.ui.annotationDraft,
			})
		})

		this.$map.addEventListener('annotation-add', (e) => {
			const annotation = this.normalizeAnnotation(e.detail?.annotation)
			if (!annotation) return
			this.annotations.push(annotation)
			this.ui.lastError = null
			this.ui.selectedAnnotationId = annotation.id
			this.ui.lastSegmentColor =
				this.normalizeSegmentColor(annotation.color) || this.ui.lastSegmentColor
			this.ui.editingAnnotationId = e.detail?.startEditing
				? annotation.id
				: null
			this.ui.annotationDraft = this.annotationToDraft(annotation)
			this.renderAll()
			this.$json.setJSON({ route: this.route, annotations: this.annotations })
		})

		this.$map.addEventListener('annotation-select', (e) => {
			const annotation = this.normalizeAnnotation(e.detail?.annotation)
			if (!annotation) return
			this.ui.selectedAnnotationId = annotation.id
			this.ui.editingAnnotationId = null
			this.ui.lastSegmentColor =
				this.normalizeSegmentColor(annotation.color) || this.ui.lastSegmentColor
			this.ui.annotationDraft = this.annotationToDraft(annotation)
			this.ui.interactionMode = 'annotate'
			this.ui.pickStatus =
				'Mode annotation : double-clique la note pour éditer le texte, ou glisse-la pour la déplacer.'
			this.renderAll()
		})

		this.$map.addEventListener('annotation-edit', (e) => {
			const annotation = this.normalizeAnnotation(e.detail?.annotation)
			if (!annotation) return
			this.ui.selectedAnnotationId = annotation.id
			this.ui.editingAnnotationId = annotation.id
			this.ui.lastSegmentColor =
				this.normalizeSegmentColor(annotation.color) || this.ui.lastSegmentColor
			this.ui.annotationDraft = this.annotationToDraft(annotation)
			this.ui.interactionMode = 'annotate'
			this.ui.pickStatus =
				'Édition annotation : modifie le texte dans la bulle sur la carte, puis clique Save ou Cancel.'
			this.renderAll()
		})

		this.$map.addEventListener('annotation-update', (e) => {
			const annotation = this.normalizeAnnotation(e.detail?.annotation)
			if (!annotation) return
			const index = this.annotations.findIndex(
				(item) => item.id === annotation.id
			)
			if (index < 0) return
			this.annotations[index] = annotation
			if (this.ui.selectedAnnotationId === annotation.id) {
				this.ui.lastSegmentColor =
					this.normalizeSegmentColor(annotation.color) ||
					this.ui.lastSegmentColor
				this.ui.annotationDraft = this.annotationToDraft(annotation)
			}
			this.ui.editingAnnotationId = null
			this.$map.setAnnotations(this.annotations)
			this.$map.setOptions({
				strict: this.ui.strict,
				autoLoad: this.ui.autoLoad,
				interactionMode: this.ui.interactionMode,
				debugShowWays: this.ui.debugShowWays,
				currentDrawingColor: this.ui.lastSegmentColor,
				selectedAnnotationId: this.ui.selectedAnnotationId,
				editingAnnotationId: this.ui.editingAnnotationId,
				annotationDraft: this.ui.annotationDraft,
			})
			this.scheduleJsonSync()
			this.schedulePanelRefresh()
		})

		this.$map.addEventListener('annotation-edit-cancel', () => {
			this.ui.editingAnnotationId = null
			this.renderAll()
		})

		this.$map.addEventListener('annotation-text-save', (e) => {
			if (!this.ui.selectedAnnotationId) return
			const index = this.annotations.findIndex(
				(item) => item.id === this.ui.selectedAnnotationId
			)
			if (index < 0) return
			const text =
				typeof e.detail?.text === 'string' ? e.detail.text.trimEnd() : ''
			if (!text.trim()) {
				this.ui.editingAnnotationId = null
				this.renderAll()
				return
			}
			this.annotations[index] = this.normalizeAnnotation({
				...this.annotations[index],
				text,
			})
			this.ui.lastSegmentColor =
				this.normalizeSegmentColor(this.annotations[index].color) ||
				this.ui.lastSegmentColor
			this.ui.annotationDraft = this.annotationToDraft(this.annotations[index])
			this.ui.editingAnnotationId = null
			this.renderAll()
			this.$json.setJSON({ route: this.route, annotations: this.annotations })
		})

		this.$map.addEventListener('annotation-delete', () => {
			if (!this.ui.selectedAnnotationId) return
			this.annotations = this.annotations.filter(
				(item) => item.id !== this.ui.selectedAnnotationId
			)
			this.ui.selectedAnnotationId = null
			this.ui.editingAnnotationId = null
			this.ui.annotationDraft = this.defaultAnnotationDraft()
			this.renderAll()
			this.$json.setJSON({ route: this.route, annotations: this.annotations })
		})

		this.$map.addEventListener('annotation-clear-selection', () => {
			this.ui.selectedAnnotationId = null
			this.ui.editingAnnotationId = null
			this.ui.annotationDraft = this.defaultAnnotationDraft({
				color: this.ui.annotationDraft?.color,
				fontSize: this.ui.annotationDraft?.fontSize,
			})
			this.renderAll()
		})

		// ---- List selection (focus mode)
		this.$panel.addEventListener('select-segment', (e) => {
			const { index } = e.detail
			this.ui.selectedIndex = this.ui.selectedIndex === index ? -1 : index // toggle
			this.renderAll()
			this.$map.setSelectedIndex(this.ui.selectedIndex)
		})

		this.$map.addEventListener('select-segment', (e) => {
			const { index } = e.detail
			this.ui.selectedIndex = this.ui.selectedIndex === index ? -1 : index
			this.renderAll()
			this.$map.setSelectedIndex(this.ui.selectedIndex)
		})

		// ---- JSON editor: dirty + auto-apply
		this.$json.addEventListener('dirty-change', (e) => {
			const { dirty, valid } = e.detail
			this.ui.dirty = dirty
			this.ui.ioStatus = valid
				? dirty
					? { kind: 'warn', text: 'Modifié (valide)' }
					: { kind: 'ok', text: 'Synchronisé' }
				: { kind: 'danger', text: 'Invalide' }
			this.renderPanel()
		})

		this.$json.addEventListener('auto-apply', async () => {
			await this.applyEditorJSON()
		})

		// ---- Map: segment add/update + status
		this.$map.addEventListener('segment-add', (e) => {
			const segment = { ...e.detail.segment }
			const color = this.normalizeSegmentColor(this.ui.lastSegmentColor)
			if (color) segment.color = color
			this.route.push(segment)
			this.ui.lastError = null
			this.ui.selectedIndex = this.route.length - 1 // auto focus on new segment
			this.renderAll()
			this.$json.setJSON({ route: this.route, annotations: this.annotations })
			this.$map.setSelectedIndex(this.ui.selectedIndex)
		})

		this.$map.addEventListener('segment-add-batch', (e) => {
			const segments = Array.isArray(e.detail?.segments) ? e.detail.segments : []
			if (segments.length === 0) return
			const color = this.normalizeSegmentColor(this.ui.lastSegmentColor)
			for (const rawSegment of segments) {
				const segment = { ...rawSegment }
				if (color) segment.color = color
				this.route.push(segment)
			}
			this.ui.lastError = null
			this.ui.selectedIndex = this.route.length - 1
			this.renderAll()
			this.$json.setJSON({ route: this.route, annotations: this.annotations })
			this.$map.setSelectedIndex(this.ui.selectedIndex)
		})

		this.$map.addEventListener('segment-update', (e) => {
			const { index, segment } = e.detail
			this.route[index] = { ...this.route[index], ...segment }
			this.renderAll()
			this.$json.setJSON({ route: this.route, annotations: this.annotations })
		})

		this.$map.addEventListener('status', (e) => {
			const { pickStatus, error } = e.detail
			if (pickStatus != null) this.ui.pickStatus = pickStatus
			if (error != null) this.ui.lastError = error
			this.renderPanel()
		})

		// ---- initial wiring
		this.$map.setOptions({
			strict: this.ui.strict,
			autoLoad: this.ui.autoLoad,
			interactionMode: this.ui.interactionMode,
			debugShowWays: this.ui.debugShowWays,
			currentDrawingColor: this.ui.lastSegmentColor,
			selectedAnnotationId: this.ui.selectedAnnotationId,
			editingAnnotationId: this.ui.editingAnnotationId,
			annotationDraft: this.ui.annotationDraft,
		})
		this.$map.setRoute(this.route)
		this.$map.setAnnotations(this.annotations)
		this.$map.setSelectedIndex(this.ui.selectedIndex)
		this.$json.setJSON({ route: this.route, annotations: this.annotations })

		// initial bbox load
		this.$map.loadWaysInView().then(() => {
			this.syncCacheFromMap()
			this.renderAll()
		})
	}

	syncCacheFromMap() {
		this.cache = this.$map.getCache()
	}

	renderAll() {
		this.renderPanel()
		this.$map.setCache(this.cache)
		this.$map.setRoute(this.route)
		this.$map.setAnnotations(this.annotations)
		this.$map.setSelectedIndex(this.ui.selectedIndex)
		this.$map.setOptions({
			strict: this.ui.strict,
			autoLoad: this.ui.autoLoad,
			interactionMode: this.ui.interactionMode,
			debugShowWays: this.ui.debugShowWays,
			currentDrawingColor: this.ui.lastSegmentColor,
			selectedAnnotationId: this.ui.selectedAnnotationId,
			editingAnnotationId: this.ui.editingAnnotationId,
			annotationDraft: this.ui.annotationDraft,
		})
		if (!this.ui.dirty)
			this.$json.setJSON({ route: this.route, annotations: this.annotations })
	}

	renderPanel() {
		this.$panel.setState({
			route: this.route,
			strict: this.ui.strict,
			autoLoad: this.ui.autoLoad,
			interactionMode: this.ui.interactionMode,
			lastError: this.ui.lastError,
			pickStatus: this.ui.pickStatus,
			ioStatus: this.ui.ioStatus,
			dirty: this.ui.dirty,
			selectedIndex: this.ui.selectedIndex,
		})
	}

	normalizeSegmentColor(value) {
		if (typeof value !== 'string') return null
		const trimmed = value.trim()
		return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toUpperCase() : null
	}

	normalizeAnnotation(annotation) {
		const text =
			typeof annotation?.text === 'string' ? annotation.text.trim() : ''
		const lat = Number(annotation?.lat)
		const lon = Number(annotation?.lon)
		if (!text || !Number.isFinite(lat) || !Number.isFinite(lon)) return null
		const color =
			this.normalizeSegmentColor(annotation?.color) ||
			this.normalizeSegmentColor(this.ui?.lastSegmentColor) ||
			'#0060DD'
		const fontSize =
			this.normalizeAnnotationFontSize(annotation?.fontSize) || 12
		return {
			id:
				typeof annotation?.id === 'string' && annotation.id
					? annotation.id
					: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			text,
			lat,
			lon,
			color,
			fontSize,
		}
	}

	annotationToDraft(annotation) {
		return {
			text: annotation?.text || '',
			color:
				this.normalizeSegmentColor(annotation?.color) ||
				this.normalizeSegmentColor(this.ui?.lastSegmentColor) ||
				'#0060DD',
			fontSize: annotation?.fontSize || 12,
		}
	}

	defaultAnnotationDraft(overrides = {}) {
		return {
			text: '',
			color: this.normalizeSegmentColor(this.ui?.lastSegmentColor) || '#0060DD',
			fontSize: 12,
			...overrides,
		}
	}

	normalizeAnnotationDraft(draft) {
		return {
			text: typeof draft?.text === 'string' ? draft.text : '',
			color:
				this.normalizeSegmentColor(draft?.color) ||
				this.normalizeSegmentColor(this.ui?.lastSegmentColor) ||
				'#0060DD',
			fontSize: this.normalizeAnnotationFontSize(draft?.fontSize) || 12,
		}
	}

	normalizeAnnotationFontSize(value) {
		const size = Number(value)
		if (!Number.isFinite(size)) return null
		const rounded = Math.round(size)
		if (rounded < 10 || rounded > 32) return null
		return rounded
	}

	buildFullExport() {
		return {
			route: this.route.map((seg) => ({ ...seg })),
			annotations: this.annotations.map((annotation) => ({ ...annotation })),
		}
	}

	buildDrawableExport() {
		const route = this.route.map((seg) => ({ ...seg }))
		const annotations = this.annotations.map((annotation) => ({ ...annotation }))
		const primitives = []
		const missing = []

		route.forEach((seg, idx) => {
			const latlngs = this.resolveSegmentLatLngs(seg)
			if (latlngs.length < 2) {
				missing.push(`segment ${idx + 1} (way ${seg.wayId})`)
				return
			}
			primitives.push({
				type: 'polyline',
				id: `segment-${idx + 1}`,
				segmentIndex: idx,
				wayId: seg.wayId,
				fromNode: seg.fromNode,
				toNode: seg.toNode,
				color: this.normalizeSegmentColor(seg.color) || '#0060DD',
				weight: 7,
				latlngs: latlngs.map(([lat, lon]) => [
					Number(lat.toFixed(7)),
					Number(lon.toFixed(7)),
				]),
			})
		})

		annotations.forEach((annotation) => {
			primitives.push({
				type: 'label',
				id: annotation.id,
				text: annotation.text,
				lat: Number(annotation.lat),
				lon: Number(annotation.lon),
				color:
					this.normalizeSegmentColor(annotation.color) ||
					this.normalizeSegmentColor(this.ui?.lastSegmentColor) ||
					'#0060DD',
				fontSize: this.normalizeAnnotationFontSize(annotation.fontSize) || 12,
			})
		})

		if (missing.length > 0) {
			this.ui.lastError =
				'Export dessin incomplet: géométrie introuvable pour ' +
				missing.slice(0, 6).join(', ')
			return null
		}

		this.ui.lastError = null
		return {
			format: 'routecraft-drawable-v1',
			route,
			annotations,
			primitives,
			bounds: this.computeDrawableBounds(primitives),
		}
	}

	resolveSegmentLatLngs(seg) {
		const wayId = Number(seg?.wayId)
		const fromNode = Number(seg?.fromNode)
		const toNode = Number(seg?.toNode)
		const nodeIds = this.cache.wayNodeIds.get(wayId)
		if (!Array.isArray(nodeIds) || nodeIds.length < 2) return []

		const isClosed =
			nodeIds.length > 3 && nodeIds[0] === nodeIds[nodeIds.length - 1]
		let orderedNodeIds = []

		if (!isClosed) {
			const a = nodeIds.indexOf(fromNode)
			const b = nodeIds.indexOf(toNode)
			if (a < 0 || b < 0) return []
			orderedNodeIds =
				a <= b ? nodeIds.slice(a, b + 1) : nodeIds.slice(b, a + 1).reverse()
		} else {
			const cycleIds = nodeIds.slice(0, -1)
			const a = cycleIds.indexOf(fromNode)
			const b = cycleIds.indexOf(toNode)
			if (a < 0 || b < 0) return []

			const direction =
				seg?.viaWrap === true ? (a <= b ? -1 : 1) : a <= b ? 1 : -1
			let index = a
			let guard = 0
			orderedNodeIds.push(cycleIds[index])
			while (index !== b && guard <= cycleIds.length) {
				index =
					direction > 0
						? (index + 1) % cycleIds.length
						: (index - 1 + cycleIds.length) % cycleIds.length
				orderedNodeIds.push(cycleIds[index])
				guard++
			}
		}

		const latlngs = []
		for (const nodeId of orderedNodeIds) {
			const node = this.cache.nodesById.get(Number(nodeId))
			if (!node) continue
			const lat = Number(node.lat)
			const lon = Number(node.lon)
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
			latlngs.push([lat, lon])
		}
		return latlngs
	}

	computeDrawableBounds(primitives) {
		let south = Infinity
		let west = Infinity
		let north = -Infinity
		let east = -Infinity

		for (const primitive of primitives) {
			if (primitive?.type === 'polyline' && Array.isArray(primitive.latlngs)) {
				for (const point of primitive.latlngs) {
					const lat = Number(point?.[0])
					const lon = Number(point?.[1])
					if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
					south = Math.min(south, lat)
					west = Math.min(west, lon)
					north = Math.max(north, lat)
					east = Math.max(east, lon)
				}
			}
			if (primitive?.type === 'label') {
				const lat = Number(primitive.lat)
				const lon = Number(primitive.lon)
				if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
				south = Math.min(south, lat)
				west = Math.min(west, lon)
				north = Math.max(north, lat)
				east = Math.max(east, lon)
			}
		}

		if (!Number.isFinite(south)) return null
		return {
			south: Number(south.toFixed(7)),
			west: Number(west.toFixed(7)),
			north: Number(north.toFixed(7)),
			east: Number(east.toFixed(7)),
		}
	}

	scheduleJsonSync() {
		if (this.ui.dirty) return
		clearTimeout(this._jsonSyncTimer)
		this._jsonSyncTimer = setTimeout(() => {
			this.$json.setJSON({ route: this.route, annotations: this.annotations })
		}, 120)
	}

	schedulePanelRefresh() {
		if (this._panelRefreshFrame != null) return
		this._panelRefreshFrame = requestAnimationFrame(() => {
			this._panelRefreshFrame = null
			this.renderPanel()
		})
	}

	async applyEditorJSON() {
		const parsed = this.$json.getParsed()
		if (!parsed.ok) {
			this.ui.lastError = parsed.errors.slice(0, 8).join(' • ')
			this.renderPanel()
			return
		}

		this.route = parsed.route
		this.annotations = parsed.annotations || []
		const lastColored = [...this.route]
			.reverse()
			.map((seg) => this.normalizeSegmentColor(seg.color))
			.find(Boolean)
		if (lastColored) this.ui.lastSegmentColor = lastColored
		this.ui.lastError = null
		this.ui.pickStatus = 'Aucun point'
		this.ui.selectedIndex = -1
		this.ui.selectedAnnotationId = null
		this.ui.editingAnnotationId = null
		this.ui.annotationDraft = this.defaultAnnotationDraft()

		await this.loadCacheFromRouteWayIds()
		this.syncCacheFromMap()
		this.$map.fitRoute(this.route)

		this.renderAll()
		this.$map.clearSelection()
		this.$json.setJSON({ route: this.route, annotations: this.annotations })
	}

	async loadCacheFromRouteWayIds() {
		await this.$map.loadWaysByIds(this.route.map((s) => s.wayId))
	}
}

customElements.define('osm-route-editor', OSMRouteEditor)
