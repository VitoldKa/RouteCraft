class JsonEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    this.cm = null;
    this.lastAppliedText = "";
    this.dirty = false;

    this._ro = null;
    this._initTried = false;
  }

  connectedCallback() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; }
        .wrap { padding: 0 12px 12px 12px; }
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
        <div class="muted"><strong>JSON</strong> (import/export, lint dans la marge)</div>
        <textarea id="ta" spellcheck="false"></textarea>
        <div id="err" class="err"></div>
      </div>
    `;

    // Init CodeMirror après layout + quand CodeMirror est dispo
    this.initWhenReady();
  }

  disconnectedCallback() {
    if (this._ro) this._ro.disconnect();
  }

  // ---------- Public API ----------
  setJSON(obj) {
    const text = JSON.stringify(obj, null, 2);
    if (this.cm) {
      this.cm.setValue(text);
      this.lastAppliedText = text;
      this.dirty = false;
      this.emitDirty({ valid: true });
      this.safeRefresh();
    } else {
      // si setJSON appelé avant init
      this._pendingValue = text;
    }
  }

  format() {
    if (!this.cm) return;
    const txt = this.cm.getValue().trim();
    if (!txt) return;
    try {
      const obj = JSON.parse(txt);
      this.cm.setValue(JSON.stringify(obj, null, 2));
      this.safeRefresh();
    } catch {
      // lint affichera l’erreur
    }
  }

  getParsed() {
    const txt = (this.cm ? this.cm.getValue() : "").trim();
    if (!txt) return { ok: false, errors: ["Champ JSON vide."], route: [] };

    let obj;
    try { obj = JSON.parse(txt); }
    catch { return { ok: false, errors: ["JSON invalide (syntaxe)."], route: [] }; }

    const arr = Array.isArray(obj) ? obj : obj?.route;
    if (!Array.isArray(arr)) return { ok: false, errors: ['Format attendu: {"route":[...]} ou [...]'], route: [] };

    const errors = [];
    const out = [];
    arr.forEach((s, i) => {
      const wayId = Number(s?.wayId);
      const fromNode = Number(s?.fromNode);
      const toNode = Number(s?.toNode);
      const color = this.normalizeSegmentColor(s?.color);

      if (!Number.isInteger(wayId) || wayId <= 0) errors.push(`Segment #${i + 1}: wayId invalide`);
      if (!Number.isInteger(fromNode) || fromNode <= 0) errors.push(`Segment #${i + 1}: fromNode invalide`);
      if (!Number.isInteger(toNode) || toNode <= 0) errors.push(`Segment #${i + 1}: toNode invalide`);
      if (Number.isInteger(fromNode) && Number.isInteger(toNode) && fromNode === toNode) errors.push(`Segment #${i + 1}: fromNode == toNode`);
      if (s?.color != null && color == null) errors.push(`Segment #${i + 1}: color invalide (attendu: #RRGGBB)`);

      if (
        Number.isInteger(wayId) && wayId > 0 &&
        Number.isInteger(fromNode) && fromNode > 0 &&
        Number.isInteger(toNode) && toNode > 0 &&
        fromNode !== toNode
      ) {
        const seg = { wayId, fromNode, toNode };
        if (color) seg.color = color;
        out.push(seg);
      }
    });

    if (!out.length) errors.push("Aucun segment valide trouvé.");
    return { ok: errors.length === 0, errors, route: out };
  }

  normalizeSegmentColor(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toUpperCase() : null;
  }

  // ---------- Init logic ----------
  async initWhenReady() {
    if (this._initTried) return;
    this._initTried = true;

    const errBox = this.shadowRoot.querySelector("#err");
    const ta = this.shadowRoot.querySelector("#ta");

    // Attendre que CodeMirror soit chargé (scripts globaux)
    const ok = await this.waitForGlobal("CodeMirror", 2000);
    if (!ok) {
      errBox.style.display = "block";
      errBox.textContent =
        "CodeMirror n'est pas disponible.\n" +
        "Vérifie que les scripts CodeMirror sont bien chargés AVANT app.js dans index.html.\n" +
        "Ex: <script src='.../codemirror.min.js'></script> puis <script type='module' src='app.js'></script>";
      return;
    }

    // Init CodeMirror
    this.cm = window.CodeMirror.fromTextArea(ta, {
      mode: { name: "javascript", json: true },
      lineNumbers: true,
      lineWrapping: true,
      gutters: ["CodeMirror-lint-markers", "CodeMirror-linenumbers"],
      lint: true,
      tabSize: 2,
      indentUnit: 2
    });

    // Valeur pending si setJSON a été appelé trop tôt
    if (this._pendingValue != null) {
      this.cm.setValue(this._pendingValue);
      this.lastAppliedText = this._pendingValue;
      this.dirty = false;
      this._pendingValue = null;
    }

    // Events
    this.cm.on("change", () => this.onChange());
    this.cm.on("blur", () => this.onBlur());

    // Refresh après montage (super important en flex + shadow)
    this.safeRefresh();

    // ResizeObserver -> refresh
    this._ro = new ResizeObserver(() => this.safeRefresh());
    this._ro.observe(this);

    // hide error box
    errBox.style.display = "none";
    errBox.textContent = "";
  }

  waitForGlobal(name, timeoutMs) {
    return new Promise((resolve) => {
      const start = performance.now();
      const tick = () => {
        if (window[name]) return resolve(true);
        if (performance.now() - start > timeoutMs) return resolve(false);
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  safeRefresh() {
    if (!this.cm) return;
    // Plusieurs passes pour être sûr que le layout est stable
    requestAnimationFrame(() => {
      try { this.cm.refresh(); } catch {}
      setTimeout(() => {
        try { this.cm.refresh(); } catch {}
      }, 0);
    });
  }

  // ---------- change/blur ----------
  onChange() {
    if (!this.cm) return;

    const now = this.cm.getValue();
    this.dirty = now !== this.lastAppliedText;

    const parsed = this.getParsed();
    const valid = parsed.ok;

    this.dispatchEvent(new CustomEvent("dirty-change", {
      detail: { dirty: this.dirty, valid },
      bubbles: true,
      composed: true
    }));
  }

  onBlur() {
    if (!this.cm || !this.dirty) return;
    const parsed = this.getParsed();
    if (parsed.ok) {
      this.dispatchEvent(new CustomEvent("auto-apply", {
        bubbles: true,
        composed: true
      }));
      // le parent fera setJSON() => reset dirty
    }
  }

  emitDirty({ valid }) {
    this.dispatchEvent(new CustomEvent("dirty-change", {
      detail: { dirty: this.dirty, valid: !!valid },
      bubbles: true,
      composed: true
    }));
  }
}

customElements.define("json-editor", JsonEditor);
