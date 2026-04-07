class MapToolbox extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.state = {
      interactionMode: "create",
      currentDrawingColor: "#0060DD",
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
  }

  updateUI() {
    const color = this.normalizeColor(this.state.currentDrawingColor);
    const hue = Math.round(this.hexToHsl(color).h);
    const isCreate = this.state.interactionMode !== "select";
    const createBtn = this.shadowRoot.querySelector("#toolCreate");
    const selectBtn = this.shadowRoot.querySelector("#toolSelect");
    const colorInput = this.shadowRoot.querySelector("#toolColorInput");
    const colorValue = this.shadowRoot.querySelector("#toolColorValue");
    const hueSlider = this.shadowRoot.querySelector("#toolHueSlider");

    if (createBtn) createBtn.classList.toggle("active", isCreate);
    if (selectBtn) selectBtn.classList.toggle("active", !isCreate);
    if (colorInput && colorInput.value !== color) colorInput.value = color;
    if (colorValue) colorValue.textContent = color;
    if (hueSlider && document.activeElement !== hueSlider) hueSlider.value = String(hue);
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
}

customElements.define("map-toolbox", MapToolbox);
