class MapAnnotationEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.state = {
      open: false,
      annotation: null,
      position: { x: 0, y: 0 },
    };
  }

  connectedCallback() {
    if (!this.shadowRoot.hasChildNodes()) {
      this.render();
      this.bindEvents();
    }
    this.updateUI();
  }

  setState(next) {
    this.state = {
      ...this.state,
      ...next,
      position: {
        ...(this.state.position || { x: 0, y: 0 }),
        ...(next?.position || {}),
      },
    };
    this.updateUI();
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
        <textarea id="textarea" class="textarea" aria-label="Edit annotation text" spellcheck="false"></textarea>
        <div class="actions">
          <button id="cancel" class="btn secondary" type="button">Cancel</button>
          <button id="save" class="btn primary" type="button">Save</button>
        </div>
      </div>
    `;
  }

  bindEvents() {
    const editor = this.shadowRoot.querySelector("#editor");
    const textarea = this.shadowRoot.querySelector("#textarea");
    const save = this.shadowRoot.querySelector("#save");
    const cancel = this.shadowRoot.querySelector("#cancel");

    const stop = (event) => {
      event.stopPropagation();
    };

    ["pointerdown", "mousedown", "click", "dblclick"].forEach((eventName) => {
      editor.addEventListener(eventName, stop);
      textarea.addEventListener(eventName, stop);
      save.addEventListener(eventName, stop);
      cancel.addEventListener(eventName, stop);
    });

    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.emitCancel();
        return;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.emitSave();
      }
    });

    save.addEventListener("click", () => this.emitSave());
    cancel.addEventListener("click", () => this.emitCancel());
  }

  updateUI() {
    const editor = this.shadowRoot.querySelector("#editor");
    const textarea = this.shadowRoot.querySelector("#textarea");
    if (!editor || !textarea) return;

    const open = !!this.state.open && !!this.state.annotation;
    editor.classList.toggle("open", open);
    editor.style.left = `${Math.round(this.state.position?.x ?? 0)}px`;
    editor.style.top = `${Math.round(this.state.position?.y ?? 0)}px`;

    if (!open) return;

    const annotation = this.state.annotation || {};
    const fontSize = this.normalizeFontSize(annotation.fontSize);
    const color = this.normalizeColor(annotation.color);
    textarea.style.font = `600 ${fontSize}px/1.25 Georgia, serif`;
    textarea.style.color = color;
    if (textarea.value !== String(annotation.text || "")) {
      textarea.value = String(annotation.text || "");
    }

    requestAnimationFrame(() => {
      if (document.activeElement !== textarea) {
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }
    });
  }

  emitSave() {
    const textarea = this.shadowRoot.querySelector("#textarea");
    this.dispatchEvent(new CustomEvent("annotation-editor-save", {
      detail: { text: textarea?.value ?? "" },
      bubbles: true,
      composed: true,
    }));
  }

  emitCancel() {
    this.dispatchEvent(new CustomEvent("annotation-editor-cancel", {
      bubbles: true,
      composed: true,
    }));
  }

  normalizeColor(value) {
    const color = typeof value === "string" ? value.trim() : "";
    return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toUpperCase() : "#1B2A41";
  }

  normalizeFontSize(value) {
    const size = Number(value);
    if (!Number.isFinite(size)) return 12;
    return Math.max(10, Math.min(32, Math.round(size)));
  }
}

customElements.define("map-annotation-editor", MapAnnotationEditor);
