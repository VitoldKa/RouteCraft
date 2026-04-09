import { t } from '../i18n.js'

class MapAnnotationEditor extends HTMLElement {
	constructor() {
		super()
		this.attachShadow({ mode: 'open' })
		this.state = {
			open: false,
			annotation: null,
			position: { x: 0, y: 0 },
		}
		this.activeAnnotationId = null
	}

	connectedCallback() {
		if (!this.shadowRoot.hasChildNodes()) {
			this.render()
			this.bindEvents()
		}
		this.updateUI()
	}

	setState(next) {
		this.state = {
			...this.state,
			...next,
			position: {
				...(this.state.position || { x: 0, y: 0 }),
				...(next?.position || {}),
			},
		}
		this.updateUI()
	}

	render() {
		this.shadowRoot.innerHTML = `
      <style>
        :host {
          position: absolute;
          inset: 0;
          pointer-events: none;
          z-index: 1100;
        }
        .editor {
          position: absolute;
          width: 280px;
          display: none;
          flex-direction: column;
          gap: 8px;
          padding: 10px;
          border: 1px solid rgba(18, 32, 56, 0.14);
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.98);
          box-shadow: 0 16px 36px rgba(14, 30, 48, 0.18);
          pointer-events: auto;
        }
        .editor.open {
          display: flex;
        }
        .textarea {
          width: 100%;
          min-height: 92px;
          padding: 10px 12px;
          border: 1px solid rgba(18, 32, 56, 0.14);
          border-radius: 10px;
          resize: vertical;
          outline: none;
          background: #fff;
          box-sizing: border-box;
          white-space: pre;
        }
        .actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
        }
        .btn {
          border-radius: 10px;
          padding: 7px 11px;
          font: 600 12px/1.2 system-ui, sans-serif;
          cursor: pointer;
        }
        .btn.primary {
          border: 1px solid rgba(33, 83, 181, 0.35);
          background: #eef4ff;
          color: #1847a5;
        }
        .btn.secondary {
          border: 1px solid rgba(18, 32, 56, 0.14);
          background: #fff;
          color: #1b2a41;
        }
      </style>
      <div id="editor" class="editor">
        <textarea id="textarea" class="textarea" aria-label="${t('editAnnotationText')}" spellcheck="false"></textarea>
        <div class="actions">
          <button id="cancel" class="btn secondary" type="button">${t('cancel')}</button>
          <button id="save" class="btn primary" type="button">${t('save')}</button>
        </div>
      </div>
    `
	}

	bindEvents() {
		const editor = this.shadowRoot.querySelector('#editor')
		const textarea = this.shadowRoot.querySelector('#textarea')
		const save = this.shadowRoot.querySelector('#save')
		const cancel = this.shadowRoot.querySelector('#cancel')

		const stop = (event) => {
			event.stopPropagation()
		}

		;['pointerdown', 'mousedown', 'click', 'dblclick'].forEach((eventName) => {
			editor.addEventListener(eventName, stop)
			textarea.addEventListener(eventName, stop)
			save.addEventListener(eventName, stop)
			cancel.addEventListener(eventName, stop)
		})

		textarea.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') {
				event.preventDefault()
				this.emitCancel()
				return
			}
			if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault()
				this.emitSave()
			}
		})

		save.addEventListener('click', () => this.emitSave())
		cancel.addEventListener('click', () => this.emitCancel())
	}

	updateUI() {
		const editor = this.shadowRoot.querySelector('#editor')
		const textarea = this.shadowRoot.querySelector('#textarea')
		if (!editor || !textarea) return

		const open = !!this.state.open && !!this.state.annotation
		const annotation = this.state.annotation || null
		const annotationId = annotation?.id || null
		const isNewSession = open && annotationId !== this.activeAnnotationId
		editor.classList.toggle('open', open)

		if (!open) {
			this.activeAnnotationId = null
			return
		}

		const fontSize = this.normalizeFontSize(annotation.fontSize)
		const color = this.normalizeColor(annotation.color)
		textarea.style.font = `600 ${fontSize}px/1.25 Georgia, serif`
		textarea.style.color = color
		if (isNewSession) {
			this.activeAnnotationId = annotationId
			textarea.value = String(annotation.text || '')
		}

		requestAnimationFrame(() => {
			this.positionEditor(editor)
			if (isNewSession && this.shadowRoot.activeElement !== textarea) {
				textarea.focus()
				textarea.setSelectionRange(textarea.value.length, textarea.value.length)
			}
		})
	}

	positionEditor(editor) {
		const width = this.clientWidth || 0
		const height = this.clientHeight || 0
		const editorWidth = editor.offsetWidth || 280
		const editorHeight = editor.offsetHeight || 160
		const desiredX = Math.round(this.state.position?.x ?? 0)
		const desiredY = Math.round(this.state.position?.y ?? 0)
		const x = Math.max(
			12,
			Math.min(desiredX, Math.max(12, width - editorWidth - 12))
		)
		const y = Math.max(
			12,
			Math.min(desiredY, Math.max(12, height - editorHeight - 12))
		)
		editor.style.left = `${x}px`
		editor.style.top = `${y}px`
	}

	emitSave() {
		const textarea = this.shadowRoot.querySelector('#textarea')
		this.dispatchEvent(
			new CustomEvent('annotation-editor-save', {
				detail: { text: textarea?.value ?? '' },
				bubbles: true,
				composed: true,
			})
		)
	}

	emitCancel() {
		this.dispatchEvent(
			new CustomEvent('annotation-editor-cancel', {
				bubbles: true,
				composed: true,
			})
		)
	}

	normalizeColor(value) {
		const color = typeof value === 'string' ? value.trim() : ''
		return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toUpperCase() : '#1B2A41'
	}

	normalizeFontSize(value) {
		const size = Number(value)
		if (!Number.isFinite(size)) return 12
		return Math.max(10, Math.min(32, Math.round(size)))
	}
}

customElements.define('map-annotation-editor', MapAnnotationEditor)
