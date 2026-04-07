class MapToolbox extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.state = {
      interactionMode: "create",
      currentDrawingColor: "#0060DD",
      selectedAnnotationId: null,
      annotationDraft: {
        text: "",
        color: "#1B2A41",
        fontSize: 12,
      },
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
    this.state = { ...this.state, ...next };
    this.updateUI();
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
          min-width:148px;
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
        .toolHue {
          width:100%;
          margin:0;
          cursor:pointer;
          accent-color:#0060DD;
        }
        .annotationBox {
          min-width: 220px;
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
        .annotationText {
          width:100%;
          min-height:64px;
          resize:vertical;
          border:1px solid rgba(18, 32, 56, 0.14);
          border-radius:10px;
          padding:8px 10px;
          font: 13px/1.35 Georgia, serif;
          color:#1b2a41;
          box-sizing:border-box;
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
        <button id="toolCreate" class="toolBtn" type="button" title="Creation tool" aria-label="Creation tool">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 18L10 6L14 13L17 10L20 18"></path>
            <path d="M6 18H20"></path>
            <path d="M18 4V8"></path>
            <path d="M16 6H20"></path>
          </svg>
        </button>
        <button id="toolSelect" class="toolBtn" type="button" title="Selection tool" aria-label="Selection tool">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 4L16 15"></path>
            <path d="M5 4L9 18L12 11L19 8Z"></path>
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
          <input id="toolHueSlider" class="toolHue" type="range" min="0" max="360" step="1" value="216" aria-label="Hue">
        </div>
        <div class="annotationBox">
          <div class="annotationTitle">Annotation</div>
          <div id="annotationHint" class="annotationHint">Switch to annotation mode and click the map to place the current note.</div>
          <textarea id="annotationText" class="annotationText" placeholder="Enter note text"></textarea>
          <div class="annotationRow">
            <input id="annotationColor" class="toolColorSwatch" type="color" value="#1B2A41" aria-label="Annotation color">
            <input id="annotationFontSize" class="annotationNumber" type="number" min="10" max="32" step="1" value="12" aria-label="Annotation font size">
          </div>
          <div class="annotationRow">
            <button id="annotationApply" class="annotationBtn primary" type="button">Apply</button>
            <button id="annotationNew" class="annotationBtn" type="button">New</button>
            <button id="annotationDelete" class="annotationBtn danger" type="button">Delete</button>
          </div>
        </div>
      </div>
    `;
  }

  bindEvents() {
    this.shadowRoot.querySelector("#toolCreate").addEventListener("click", () => {
      this.emitToggle("create");
    });
    this.shadowRoot.querySelector("#toolSelect").addEventListener("click", () => {
      this.emitToggle("select");
    });
    this.shadowRoot.querySelector("#toolAnnotate").addEventListener("click", () => {
      this.emitToggle("annotate");
    });
    this.shadowRoot.querySelector("#toolColorInput").addEventListener("input", (e) => {
      this.emitDrawingColorChange(e.target.value);
    });
    this.shadowRoot.querySelector("#toolHueSlider").addEventListener("input", (e) => {
      const currentColor = this.normalizeColor(this.state.currentDrawingColor);
      const nextColor = this.withUpdatedHue(currentColor, Number(e.target.value));
      const colorInput = this.shadowRoot.querySelector("#toolColorInput");
      const colorValue = this.shadowRoot.querySelector("#toolColorValue");
      if (colorInput) colorInput.value = nextColor;
      if (colorValue) colorValue.textContent = nextColor;
      this.emitDrawingColorChange(nextColor);
    });
    this.shadowRoot.querySelector("#annotationText").addEventListener("input", (e) => {
      this.emitAnnotationDraftChange({ text: e.target.value });
    });
    this.shadowRoot.querySelector("#annotationColor").addEventListener("input", (e) => {
      this.emitAnnotationDraftChange({ color: e.target.value });
    });
    this.shadowRoot.querySelector("#annotationFontSize").addEventListener("input", (e) => {
      this.emitAnnotationDraftChange({ fontSize: Number(e.target.value) });
    });
    this.shadowRoot.querySelector("#annotationApply").addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("annotation-save", {
        bubbles: true,
        composed: true,
      }));
    });
    this.shadowRoot.querySelector("#annotationNew").addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("annotation-clear-selection", {
        bubbles: true,
        composed: true,
      }));
    });
    this.shadowRoot.querySelector("#annotationDelete").addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("annotation-delete", {
        bubbles: true,
        composed: true,
      }));
    });
  }

  updateUI() {
    const color = this.normalizeColor(this.state.currentDrawingColor);
    const hue = Math.round(this.hexToHsl(color).h);
    const isCreate = this.state.interactionMode === "create";
    const isAnnotate = this.state.interactionMode === "annotate";
    const createBtn = this.shadowRoot.querySelector("#toolCreate");
    const selectBtn = this.shadowRoot.querySelector("#toolSelect");
    const annotateBtn = this.shadowRoot.querySelector("#toolAnnotate");
    const colorInput = this.shadowRoot.querySelector("#toolColorInput");
    const colorValue = this.shadowRoot.querySelector("#toolColorValue");
    const hueSlider = this.shadowRoot.querySelector("#toolHueSlider");
    const annotationDraft = this.normalizeAnnotationDraft(this.state.annotationDraft);
    const annotationText = this.shadowRoot.querySelector("#annotationText");
    const annotationColor = this.shadowRoot.querySelector("#annotationColor");
    const annotationFontSize = this.shadowRoot.querySelector("#annotationFontSize");
    const annotationHint = this.shadowRoot.querySelector("#annotationHint");
    const annotationApply = this.shadowRoot.querySelector("#annotationApply");
    const annotationDelete = this.shadowRoot.querySelector("#annotationDelete");

    if (createBtn) createBtn.classList.toggle("active", isCreate);
    if (selectBtn) selectBtn.classList.toggle("active", this.state.interactionMode === "select");
    if (annotateBtn) annotateBtn.classList.toggle("active", isAnnotate);
    if (colorInput && colorInput.value !== color) colorInput.value = color;
    if (colorValue) colorValue.textContent = color;
    if (hueSlider && document.activeElement !== hueSlider) hueSlider.value = String(hue);
    if (annotationText && document.activeElement !== annotationText && annotationText.value !== annotationDraft.text) {
      annotationText.value = annotationDraft.text;
    }
    if (annotationColor && annotationColor.value !== annotationDraft.color) annotationColor.value = annotationDraft.color;
    if (annotationFontSize && document.activeElement !== annotationFontSize) annotationFontSize.value = String(annotationDraft.fontSize);
    if (annotationHint) {
      annotationHint.textContent = this.state.selectedAnnotationId
        ? "Edit the selected annotation, then apply or drag it on the map."
        : "In annotation mode, click the map to place the current note.";
    }
    if (annotationApply) annotationApply.textContent = this.state.selectedAnnotationId ? "Apply" : "Ready";
    if (annotationDelete) annotationDelete.disabled = !this.state.selectedAnnotationId;
  }

  emitToggle(value) {
    this.dispatchEvent(new CustomEvent("toggle", {
      detail: { name: "interactionMode", value },
      bubbles: true,
      composed: true,
    }));
  }

  emitDrawingColorChange(color) {
    this.dispatchEvent(new CustomEvent("drawing-color-change", {
      detail: { color },
      bubbles: true,
      composed: true,
    }));
  }

  emitAnnotationDraftChange(patch) {
    this.dispatchEvent(new CustomEvent("annotation-draft-change", {
      detail: { patch },
      bubbles: true,
      composed: true,
    }));
  }

  normalizeColor(value) {
    const color = typeof value === "string" ? value.trim() : "";
    return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toUpperCase() : "#0060DD";
  }

  hexToHsl(hex) {
    const normalized = this.normalizeColor(hex);
    const r = parseInt(normalized.slice(1, 3), 16) / 255;
    const g = parseInt(normalized.slice(3, 5), 16) / 255;
    const b = parseInt(normalized.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0;
    let s = 0;

    if (d !== 0) {
      s = d / (1 - Math.abs(2 * l - 1));
      switch (max) {
        case r:
          h = 60 * (((g - b) / d) % 6);
          break;
        case g:
          h = 60 * ((b - r) / d + 2);
          break;
        default:
          h = 60 * ((r - g) / d + 4);
          break;
      }
    }

    if (h < 0) h += 360;
    return { h, s, l };
  }

  hslToHex(h, s, l) {
    const hue = ((Number(h) % 360) + 360) % 360;
    const sat = Math.max(0, Math.min(1, Number(s)));
    const lig = Math.max(0, Math.min(1, Number(l)));
    const c = (1 - Math.abs(2 * lig - 1)) * sat;
    const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
    const m = lig - c / 2;
    let r = 0;
    let g = 0;
    let b = 0;

    if (hue < 60) [r, g, b] = [c, x, 0];
    else if (hue < 120) [r, g, b] = [x, c, 0];
    else if (hue < 180) [r, g, b] = [0, c, x];
    else if (hue < 240) [r, g, b] = [0, x, c];
    else if (hue < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];

    const toHex = (value) =>
      Math.round((value + m) * 255)
        .toString(16)
        .padStart(2, "0")
        .toUpperCase();

    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  withUpdatedHue(hex, hue) {
    const { s, l } = this.hexToHsl(hex);
    return this.hslToHex(hue, s, l);
  }

  normalizeAnnotationDraft(draft) {
    return {
      text: typeof draft?.text === "string" ? draft.text : "",
      color: this.normalizeColor(draft?.color || "#1B2A41"),
      fontSize: this.normalizeFontSize(draft?.fontSize),
    };
  }

  normalizeFontSize(value) {
    const size = Number(value);
    if (!Number.isFinite(size)) return 12;
    return Math.max(10, Math.min(32, Math.round(size)));
  }
}

customElements.define("map-toolbox", MapToolbox);
