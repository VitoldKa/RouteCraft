import { t } from '../i18n.js'

class JsonEditor extends HTMLElement {
	constructor() {
		super()
		this.attachShadow({ mode: 'open' })

		this.cm = null
		this.lastAppliedText = ''
		this.dirty = false
		this.expanded = false

		this._ro = null
		this._initTried = false
	}

	get editorTitle() {
		const value = this.getAttribute('title')
		return value && value.trim() ? value.trim() : t('json')
	}

	get editorMeta() {
		const value = this.getAttribute('meta')
		return value && value.trim() ? value.trim() : t('jsonMeta')
	}

	get editorDescription() {
		const value = this.getAttribute('description')
		return value && value.trim()
			? value.trim()
			: t('jsonDescription')
	}

	get isReadOnly() {
		return this.hasAttribute('readonly')
	}

	connectedCallback() {
		this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; }
        .wrap { padding: 0 12px 12px 12px; }
        .section {
          border:1px solid #e5e5e5;
          border-radius:12px;
          background:#fbfbfb;
          overflow:hidden;
        }
        .summary {
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:12px;
          padding:10px 12px;
          cursor:pointer;
          user-select:none;
          list-style:none;
          font-weight:600;
        }
        .summary::-webkit-details-marker { display:none; }
        .summary::after {
          content:'▸';
          color:#666;
          font-size:12px;
          transform:translateY(1px);
        }
        .section[open] .summary::after {
          content:'▾';
        }
        .summaryMeta {
          color:#666;
          font-size:12px;
          font-weight:500;
        }
        .body {
          padding: 0 12px 12px 12px;
        }
        .muted { color:#666; font-size: 13px; line-height:1.35; }
        .err {
          margin-top: 8px;
          padding: 8px 10px;
          border: 1px solid #f3c0c0;
          background: #fff;
          border-radius: 12px;
          color: #8a1f1f;
          font-size: 12px;
          display:none;
          white-space: pre-wrap;
        }

        /* Ajustements locaux (dans le shadow) */
        .CodeMirror {
          height: 220px;
          border: 1px solid #e5e5e5;
          border-radius: 12px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
          font-size: 12px;
          background: #fff;
        }
        .CodeMirror-lint-tooltip { z-index: 9999; }
      </style>

      <!-- CSS CodeMirror DANS le shadow DOM -->
      <link rel="stylesheet"
            href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css">
      <link rel="stylesheet"
            href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/lint/lint.min.css">

      <div class="wrap">
        <details id="jsonSection" class="section" ${this.expanded ? 'open' : ''}>
          <summary class="summary">
            <span>${this.editorTitle}</span>
            <span class="summaryMeta">${this.editorMeta}</span>
          </summary>
          <div class="body">
            <div class="muted">${this.editorDescription}</div>
            <textarea id="ta" spellcheck="false"></textarea>
            <div id="err" class="err"></div>
          </div>
        </details>
      </div>
    `

		this.shadowRoot
			.querySelector('#jsonSection')
			.addEventListener('toggle', (e) => {
				this.expanded = e.currentTarget.open
				if (this.expanded) this.safeRefresh()
			})

		// Init CodeMirror après layout + quand CodeMirror est dispo
		this.initWhenReady()
	}

	disconnectedCallback() {
		if (this._ro) this._ro.disconnect()
	}

	// ---------- Public API ----------
	setJSON(obj) {
		const text = JSON.stringify(obj, null, 2)
		if (this.cm) {
			this.cm.setValue(text)
			this.lastAppliedText = text
			this.dirty = false
			this.emitDirty({ valid: true })
			this.safeRefresh()
		} else {
			// si setJSON appelé avant init
			this._pendingValue = text
		}
	}

	format() {
		if (!this.cm) return
		const txt = this.cm.getValue().trim()
		if (!txt) return
		try {
			const obj = JSON.parse(txt)
			this.cm.setValue(JSON.stringify(obj, null, 2))
			this.safeRefresh()
		} catch {
			// lint affichera l’erreur
		}
	}

	getParsed() {
		const txt = (this.cm ? this.cm.getValue() : '').trim()
		if (!txt)
			return {
				ok: false,
				errors: [t('jsonEmpty')],
				route: [],
				annotations: [],
			}

		let obj
		try {
			obj = JSON.parse(txt)
		} catch {
			return {
				ok: false,
				errors: [t('jsonInvalidSyntax')],
				route: [],
				annotations: [],
			}
		}

		const arr = Array.isArray(obj)
			? obj
			: Array.isArray(obj?.route)
				? obj.route
				: []
		if (
			!Array.isArray(obj) &&
			obj != null &&
			obj.route != null &&
			!Array.isArray(obj.route)
		) {
			return {
				ok: false,
				errors: [t('jsonFormatExpected')],
				route: [],
				annotations: [],
			}
		}
		const rawAnnotations = Array.isArray(obj?.annotations)
			? obj.annotations
			: []

		const errors = []
		const out = []
		arr.forEach((s, i) => {
			const wayId = Number(s?.wayId)
			const fromNode = Number(s?.fromNode)
			const toNode = Number(s?.toNode)
			const color = this.normalizeSegmentColor(s?.color)
			const viaWrap = s?.viaWrap === true

			if (!Number.isInteger(wayId) || wayId <= 0)
				errors.push(t('jsonInvalidWayId', { index: i + 1 }))
			if (!Number.isInteger(fromNode) || fromNode <= 0)
				errors.push(t('jsonInvalidFromNode', { index: i + 1 }))
			if (!Number.isInteger(toNode) || toNode <= 0)
				errors.push(t('jsonInvalidToNode', { index: i + 1 }))
			if (
				Number.isInteger(fromNode) &&
				Number.isInteger(toNode) &&
				fromNode === toNode
			)
				errors.push(t('jsonEqualNodes', { index: i + 1 }))
			if (s?.color != null && color == null)
				errors.push(t('jsonInvalidColor', { index: i + 1 }))

			if (
				Number.isInteger(wayId) &&
				wayId > 0 &&
				Number.isInteger(fromNode) &&
				fromNode > 0 &&
				Number.isInteger(toNode) &&
				toNode > 0 &&
				fromNode !== toNode
			) {
				const seg = { wayId, fromNode, toNode }
				if (color) seg.color = color
				if (viaWrap) seg.viaWrap = true
				out.push(seg)
			}
		})

		const annotations = []
		rawAnnotations.forEach((annotation, i) => {
			const text =
				typeof annotation?.text === 'string' ? annotation.text.trim() : ''
			const lat = Number(annotation?.lat)
			const lon = Number(annotation?.lon)
			const color = this.normalizeSegmentColor(annotation?.color)
			const fontSize = this.normalizeAnnotationFontSize(annotation?.fontSize)
			if (!text) {
				errors.push(t('jsonAnnotationInvalidText', { index: i + 1 }))
				return
			}
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
				errors.push(t('jsonAnnotationInvalidLatLon', { index: i + 1 }))
				return
			}
			if (annotation?.color != null && color == null) {
				errors.push(t('jsonAnnotationInvalidColor', { index: i + 1 }))
				return
			}
			if (annotation?.fontSize != null && fontSize == null) {
				errors.push(t('jsonAnnotationInvalidFontSize', { index: i + 1 }))
				return
			}
			annotations.push({
				id:
					typeof annotation?.id === 'string' && annotation.id
						? annotation.id
						: `ann-${i + 1}`,
				text,
				lat,
				lon,
				...(color ? { color } : {}),
				...(fontSize ? { fontSize } : {}),
			})
		})

		if (!out.length && !annotations.length)
			errors.push(t('jsonNoValidContent'))
		return { ok: errors.length === 0, errors, route: out, annotations }
	}

	normalizeSegmentColor(value) {
		if (typeof value !== 'string') return null
		const trimmed = value.trim()
		return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toUpperCase() : null
	}

	normalizeAnnotationFontSize(value) {
		if (value == null || value === '') return null
		const size = Number(value)
		if (!Number.isFinite(size)) return null
		const rounded = Math.round(size)
		return rounded >= 10 && rounded <= 32 ? rounded : null
	}

	// ---------- Init logic ----------
	async initWhenReady() {
		if (this._initTried) return
		this._initTried = true

		const errBox = this.shadowRoot.querySelector('#err')
		const ta = this.shadowRoot.querySelector('#ta')

		// Attendre que CodeMirror soit chargé (scripts globaux)
		const ok = await this.waitForGlobal('CodeMirror', 2000)
		if (!ok) {
			errBox.style.display = 'block'
			errBox.textContent = t('codeMirrorMissing')
			return
		}

		// Init CodeMirror
		this.cm = window.CodeMirror.fromTextArea(ta, {
			mode: { name: 'javascript', json: true },
			lineNumbers: true,
			lineWrapping: true,
			gutters: ['CodeMirror-lint-markers', 'CodeMirror-linenumbers'],
			lint: true,
			tabSize: 2,
			indentUnit: 2,
			readOnly: this.isReadOnly,
		})

		// Valeur pending si setJSON a été appelé trop tôt
		if (this._pendingValue != null) {
			this.cm.setValue(this._pendingValue)
			this.lastAppliedText = this._pendingValue
			this.dirty = false
			this._pendingValue = null
		}

		// Events
		this.cm.on('change', () => this.onChange())
		this.cm.on('blur', () => this.onBlur())

		// Refresh après montage (super important en flex + shadow)
		this.safeRefresh()

		// ResizeObserver -> refresh
		this._ro = new ResizeObserver(() => this.safeRefresh())
		this._ro.observe(this)

		// hide error box
		errBox.style.display = 'none'
		errBox.textContent = ''
	}

	waitForGlobal(name, timeoutMs) {
		return new Promise((resolve) => {
			const start = performance.now()
			const tick = () => {
				if (window[name]) return resolve(true)
				if (performance.now() - start > timeoutMs) return resolve(false)
				requestAnimationFrame(tick)
			}
			tick()
		})
	}

	safeRefresh() {
		if (!this.cm) return
		// Plusieurs passes pour être sûr que le layout est stable
		requestAnimationFrame(() => {
			try {
				this.cm.refresh()
			} catch {}
			setTimeout(() => {
				try {
					this.cm.refresh()
				} catch {}
			}, 0)
		})
	}

	// ---------- change/blur ----------
	onChange() {
		if (!this.cm || this.isReadOnly) return

		const now = this.cm.getValue()
		this.dirty = now !== this.lastAppliedText

		const parsed = this.getParsed()
		const valid = parsed.ok

		this.dispatchEvent(
			new CustomEvent('dirty-change', {
				detail: { dirty: this.dirty, valid },
				bubbles: true,
				composed: true,
			})
		)
	}

	onBlur() {
		if (!this.cm || this.isReadOnly || !this.dirty) return
		const parsed = this.getParsed()
		if (parsed.ok) {
			this.dispatchEvent(
				new CustomEvent('auto-apply', {
					bubbles: true,
					composed: true,
				})
			)
			// le parent fera setJSON() => reset dirty
		}
	}

	emitDirty({ valid }) {
		this.dispatchEvent(
			new CustomEvent('dirty-change', {
				detail: { dirty: this.dirty, valid: !!valid },
				bubbles: true,
				composed: true,
			})
		)
	}
}

customElements.define('json-editor', JsonEditor)
