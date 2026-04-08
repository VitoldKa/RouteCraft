class MapToolbox extends HTMLElement {
	constructor() {
		super()
		this.attachShadow({ mode: 'open' })
		this.state = {
			interactionMode: 'create',
			currentDrawingColor: '#0060DD',
			selectedAnnotationId: null,
			editingAnnotationId: null,
			annotationDraft: {
				text: '',
				color: '#0060DD',
				fontSize: 12,
			},
		}
	}

	connectedCallback() {
		if (!this.shadowRoot.hasChildNodes()) {
			this.render()
			this.bindEvents()
		}
		this.updateUI()
	}

	setState(next) {
		this.state = { ...this.state, ...next }
		this.updateUI()
	}

	render() {
		this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; }
        .toolbox {
          display:flex;
          align-items:flex-start;
          gap:8px;
          padding:8px;
          border:1px solid rgba(18, 32, 56, 0.12);
          border-radius:14px;
          background:rgba(255, 255, 255, 0.96);
          box-shadow:0 10px 28px rgba(14, 30, 48, 0.14);
          backdrop-filter: blur(8px);
        }
        .toolBtn {
          width:44px;
          height:44px;
          display:grid;
          place-items:center;
          border:1px solid rgba(18, 32, 56, 0.14);
          border-radius:12px;
          background:#fff;
          color:#213547;
          cursor:pointer;
          transition:background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
        }
        .toolBtn:hover {
          background:#f4f8ff;
          border-color:rgba(33, 83, 181, 0.35);
        }
        .toolBtn.active {
          background:#e9f1ff;
          border-color:rgba(33, 83, 181, 0.65);
          color:#1847a5;
        }
        .toolBtn:active {
          transform:translateY(1px);
        }
        .toolBtn svg {
          width:22px;
          height:22px;
          stroke:currentColor;
          fill:none;
          stroke-width:1.8;
          stroke-linecap:round;
          stroke-linejoin:round;
          pointer-events:none;
        }
        .toolColor {
          display:flex;
          flex-direction:column;
          gap:8px;
          padding:8px 10px;
          border:1px solid rgba(18, 32, 56, 0.14);
          border-radius:12px;
          background:#fff;
        }
        .toolColorTop {
          display:flex;
          align-items:center;
          gap:8px;
        }
        .toolColorSwatch {
          width:28px;
          height:28px;
          padding:0;
          border:1px solid rgba(18, 32, 56, 0.18);
          border-radius:8px;
          background:#fff;
          cursor:pointer;
        }
        .toolColorMeta {
          min-width:0;
          display:flex;
          flex-direction:column;
          gap:2px;
        }
        .toolColorLabel {
          font-size:11px;
          font-weight:600;
          color:#1b2a41;
        }
        .toolColorValue {
          font-size:11px;
          color:#5a6b7f;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        }
        .annotationBox {
          display:flex;
          flex-direction:column;
          gap:8px;
          padding:8px 10px;
          border:1px solid rgba(18, 32, 56, 0.14);
          border-radius:12px;
          background:#fff;
        }
        .annotationTitle {
          font-size:11px;
          font-weight:700;
          color:#1b2a41;
        }
        .annotationHint {
          font-size:11px;
          line-height:1.35;
          color:#5a6b7f;
        }
        .annotationRow {
          display:flex;
          align-items:center;
          gap:8px;
        }
        .annotationNumber {
          width:72px;
          border:1px solid rgba(18, 32, 56, 0.14);
          border-radius:10px;
          padding:6px 8px;
          box-sizing:border-box;
        }
        .annotationBtn {
          border:1px solid rgba(18, 32, 56, 0.14);
          border-radius:10px;
          background:#fff;
          padding:7px 10px;
          cursor:pointer;
          font-size:12px;
        }
        .annotationBtn.primary {
          background:#eef4ff;
          border-color:rgba(33, 83, 181, 0.35);
          color:#1847a5;
        }
        .annotationBtn.danger {
          color:#a11d2d;
          border-color:rgba(161, 29, 45, 0.25);
        }
      </style>

      <div class="toolbox" aria-label="Map tools">
        <button id="toolSelect" class="toolBtn" type="button" title="Selection tool" aria-label="Selection tool">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 4L16 15"></path>
            <path d="M5 4L9 18L12 11L19 8Z"></path>
          </svg>
        </button>
        <button id="toolCreate" class="toolBtn" type="button" title="Creation tool" aria-label="Creation tool">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 18L10 6L14 13L17 10L20 18"></path>
            <path d="M6 18H20"></path>
            <path d="M18 4V8"></path>
            <path d="M16 6H20"></path>
          </svg>
        </button>
        <button id="toolAnnotate" class="toolBtn" type="button" title="Text annotation tool" aria-label="Text annotation tool">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 6H19"></path>
            <path d="M12 6V18"></path>
            <path d="M9 18H15"></path>
          </svg>
        </button>
        <div class="toolColor">
          <div class="toolColorTop">
            <input id="toolColorInput" class="toolColorSwatch" type="color" value="#0060DD" aria-label="Drawing color">
            <div class="toolColorMeta">
              <div class="toolColorLabel">Color</div>
              <div id="toolColorValue" class="toolColorValue">#0060DD</div>
            </div>
          </div>
        </div>
        <div class="annotationBox">
          <div class="annotationTitle">Annotation</div>
          <div id="annotationHint" class="annotationHint" style="display:none;">Switch to annotation mode and click the map to place a note, then double-click it to edit the text.</div>
          <div class="annotationRow">
            <input id="annotationFontSize" class="annotationNumber" type="number" min="10" max="32" step="1" value="12" aria-label="Annotation font size">
          </div>
          <div class="annotationRow">
            <button id="annotationNew" class="annotationBtn primary" type="button">New</button>
            <button id="annotationDelete" class="annotationBtn danger" type="button">Delete</button>
          </div>
        </div>
      </div>
    `
	}

	bindEvents() {
		this.shadowRoot
			.querySelector('#toolCreate')
			.addEventListener('click', () => {
				this.emitToggle('create')
			})
		this.shadowRoot
			.querySelector('#toolSelect')
			.addEventListener('click', () => {
				this.emitToggle('select')
			})
		this.shadowRoot
			.querySelector('#toolAnnotate')
			.addEventListener('click', () => {
				this.emitToggle('annotate')
			})
		this.shadowRoot
			.querySelector('#toolColorInput')
			.addEventListener('input', (e) => {
				this.emitDrawingColorChange(e.target.value)
			})
		this.shadowRoot
			.querySelector('#annotationFontSize')
			.addEventListener('input', (e) => {
				this.emitAnnotationDraftChange({ fontSize: Number(e.target.value) })
			})
		this.shadowRoot
			.querySelector('#annotationNew')
			.addEventListener('click', () => {
				this.dispatchEvent(
					new CustomEvent('annotation-clear-selection', {
						bubbles: true,
						composed: true,
					})
				)
			})
		this.shadowRoot
			.querySelector('#annotationDelete')
			.addEventListener('click', () => {
				this.dispatchEvent(
					new CustomEvent('annotation-delete', {
						bubbles: true,
						composed: true,
					})
				)
			})
	}

	updateUI() {
		const color = this.normalizeColor(this.state.currentDrawingColor)
		const isCreate = this.state.interactionMode === 'create'
		const isAnnotate = this.state.interactionMode === 'annotate'
		const createBtn = this.shadowRoot.querySelector('#toolCreate')
		const selectBtn = this.shadowRoot.querySelector('#toolSelect')
		const annotateBtn = this.shadowRoot.querySelector('#toolAnnotate')
		const colorInput = this.shadowRoot.querySelector('#toolColorInput')
		const colorValue = this.shadowRoot.querySelector('#toolColorValue')
		const annotationDraft = this.normalizeAnnotationDraft(
			this.state.annotationDraft
		)
		const annotationFontSize = this.shadowRoot.querySelector(
			'#annotationFontSize'
		)
		const annotationHint = this.shadowRoot.querySelector('#annotationHint')
		const annotationDelete = this.shadowRoot.querySelector('#annotationDelete')

		if (createBtn) createBtn.classList.toggle('active', isCreate)
		if (selectBtn)
			selectBtn.classList.toggle(
				'active',
				this.state.interactionMode === 'select'
			)
		if (annotateBtn) annotateBtn.classList.toggle('active', isAnnotate)
		if (colorInput && colorInput.value !== color) colorInput.value = color
		if (colorValue) colorValue.textContent = color
		if (annotationFontSize && document.activeElement !== annotationFontSize)
			annotationFontSize.value = String(annotationDraft.fontSize)
		if (annotationHint) {
			annotationHint.textContent = this.state.editingAnnotationId
				? 'Double-click editing active on the map. Click outside the note to save.'
				: this.state.selectedAnnotationId
					? 'Selected note: double-click it to edit text, or drag it to move.'
					: 'In annotation mode, click the map to place a note, then double-click it to edit.'
		}
		if (annotationDelete)
			annotationDelete.disabled = !this.state.selectedAnnotationId
	}

	emitToggle(value) {
		this.dispatchEvent(
			new CustomEvent('toggle', {
				detail: { name: 'interactionMode', value },
				bubbles: true,
				composed: true,
			})
		)
	}

	emitDrawingColorChange(color) {
		this.dispatchEvent(
			new CustomEvent('drawing-color-change', {
				detail: { color },
				bubbles: true,
				composed: true,
			})
		)
	}

	emitAnnotationDraftChange(patch) {
		this.dispatchEvent(
			new CustomEvent('annotation-draft-change', {
				detail: { patch },
				bubbles: true,
				composed: true,
			})
		)
	}

	normalizeColor(value) {
		const color = typeof value === 'string' ? value.trim() : ''
		return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toUpperCase() : '#0060DD'
	}

	normalizeAnnotationDraft(draft) {
		return {
			text: typeof draft?.text === 'string' ? draft.text : '',
			color: this.normalizeColor(
				draft?.color || this.state.currentDrawingColor
			),
			fontSize: this.normalizeFontSize(draft?.fontSize),
		}
	}

	normalizeFontSize(value) {
		const size = Number(value)
		if (!Number.isFinite(size)) return 12
		return Math.max(10, Math.min(32, Math.round(size)))
	}
}

customElements.define('map-toolbox', MapToolbox)
