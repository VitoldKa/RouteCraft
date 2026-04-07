import "./osm-map.js";
import "./route-panel.js";
import "./json-editor.js";

class OSMRouteEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    this.route = [];
    this.cache = {
      nodesById: new Map(),
      wayNodeIds: new Map(),
      wayTags: new Map(),
      wayBBox: new Map(),
    };

    this.ui = {
      strict: true,
      autoLoad: true,
      interactionMode: "create",
      lastSegmentColor: "#0060DD",
      lastError: null,
      ioStatus: { kind: "ok", text: "Synchronisé" },
      pickStatus: "Aucun point",
      dirty: false,
      selectedIndex: -1, // focus mode
    };

    this._jsonSyncTimer = null;
    this._panelRefreshFrame = null;
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
    `;

    this.$map = this.shadowRoot.querySelector("osm-map");
    this.$panel = this.shadowRoot.querySelector("route-panel");
    this.$json = this.shadowRoot.querySelector("json-editor");

    this.renderAll();

    // ---- Panel toggles
    this.$panel.addEventListener("toggle", (e) => {
      const { name, value } = e.detail;
      if (name === "strict") this.ui.strict = !!value;
      if (name === "autoLoad") this.ui.autoLoad = !!value;
      if (name === "interactionMode") {
        this.ui.interactionMode = value === "select" ? "select" : "create";
        this.ui.pickStatus =
          this.ui.interactionMode === "select"
            ? "Mode sélection : clique un segment existant sur la carte ou dans la liste."
            : "Mode création : clique sur la carte pour ajouter un tronçon.";
      }
      this.renderPanel();
      this.$map.setOptions({
        strict: this.ui.strict,
        autoLoad: this.ui.autoLoad,
        interactionMode: this.ui.interactionMode,
        currentDrawingColor: this.ui.lastSegmentColor,
      });
    });

    // ---- Panel actions
    this.$panel.addEventListener("action", async (e) => {
      const { type } = e.detail;

      if (type === "clear") {
        this.route = [];
        this.ui.lastError = null;
        this.ui.pickStatus = "Aucun point";
        this.ui.selectedIndex = -1;
        this.renderAll();
        this.$map.clearSelection();
        return;
      }

      if (type === "reload-bbox") {
        await this.$map.loadWaysInView();
        this.syncCacheFromMap();
        this.renderAll();
        return;
      }

      if (type === "load-from-route") {
        await this.loadCacheFromRouteWayIds();
        this.syncCacheFromMap();
        this.renderAll();
        this.$map.fitRoute(this.route);
        return;
      }

      if (type === "export") {
        this.$json.setJSON({ route: this.route });
        this.ui.dirty = false;
        this.ui.ioStatus = { kind: "ok", text: "Synchronisé" };
        this.renderPanel();
        return;
      }

      if (type === "format") {
        this.$json.format();
        return;
      }

      if (type === "import") {
        await this.applyEditorJSON();
        return;
      }
    });

    // ---- List reorder/delete
    this.$panel.addEventListener("route-edit", (e) => {
      const { op } = e.detail;

      if (op.type === "del") {
        this.route.splice(op.index, 1);
        if (this.ui.selectedIndex === op.index) this.ui.selectedIndex = -1;
        else if (this.ui.selectedIndex > op.index) this.ui.selectedIndex--;
      }

      if (op.type === "up" && op.index > 0) {
        [this.route[op.index - 1], this.route[op.index]] = [this.route[op.index], this.route[op.index - 1]];
        if (this.ui.selectedIndex === op.index) this.ui.selectedIndex = op.index - 1;
        else if (this.ui.selectedIndex === op.index - 1) this.ui.selectedIndex = op.index;
      }

      if (op.type === "down" && op.index < this.route.length - 1) {
        [this.route[op.index + 1], this.route[op.index]] = [this.route[op.index], this.route[op.index + 1]];
        if (this.ui.selectedIndex === op.index) this.ui.selectedIndex = op.index + 1;
        else if (this.ui.selectedIndex === op.index + 1) this.ui.selectedIndex = op.index;
      }

      if (op.type === "set-color" && op.index >= 0 && op.index < this.route.length) {
        const seg = { ...this.route[op.index] };
        const color = this.normalizeSegmentColor(op.color);
        if (color) {
          seg.color = color;
          this.ui.lastSegmentColor = color;
        } else {
          delete seg.color;
          this.ui.lastSegmentColor = "#0060DD";
        }
        this.route[op.index] = seg;
      }

      if (op.type === "set-color" && (op.index == null || op.index < 0 || op.index >= this.route.length)) {
        const color = this.normalizeSegmentColor(op.color);
        this.ui.lastSegmentColor = color || "#0060DD";
      }

      this.renderAll();
      this.$json.setJSON({ route: this.route });
    });

    this.$map.addEventListener("route-validation", (e) => {
      const { invalidIndexes, invalidByIndex } = e.detail;

      invalidIndexes.forEach(e => {
        const list = this.$panel.shadowRoot.querySelector("#list");
        list.children[e]?.classList.add("invalid");
      });
      // 1) stocker dans ton state
      // state.invalid = new Set(invalidIndexes);
      // state.invalidInfo = invalidByIndex;

      // // 2) rerender ta liste
      // this.$panel
    });

    this.$map.addEventListener("toggle", (e) => {
      const { name, value } = e.detail;
      if (name !== "interactionMode") return;
      this.ui.interactionMode = value === "select" ? "select" : "create";
      this.ui.pickStatus =
        this.ui.interactionMode === "select"
          ? "Mode sélection : clique un segment existant sur la carte ou dans la liste."
          : "Mode création : clique sur la carte pour ajouter un tronçon.";
      this.renderAll();
      this.$map.setOptions({
        strict: this.ui.strict,
        autoLoad: this.ui.autoLoad,
        interactionMode: this.ui.interactionMode,
        currentDrawingColor: this.ui.lastSegmentColor,
      });
    });

    this.$map.addEventListener("drawing-color-change", (e) => {
      const color = this.normalizeSegmentColor(e.detail?.color) || "#0060DD";
      this.ui.lastSegmentColor = color;
      if (this.ui.selectedIndex >= 0 && this.ui.selectedIndex < this.route.length) {
        this.route[this.ui.selectedIndex] = {
          ...this.route[this.ui.selectedIndex],
          color,
        };
        this.$map.redrawSelected();
        this.scheduleJsonSync();
      }
      this.schedulePanelRefresh();
    });

    // ---- List selection (focus mode)
    this.$panel.addEventListener("select-segment", (e) => {
      const { index } = e.detail;
      this.ui.selectedIndex = (this.ui.selectedIndex === index) ? -1 : index; // toggle
      this.renderAll();
      this.$map.setSelectedIndex(this.ui.selectedIndex);
    });

    this.$map.addEventListener("select-segment", (e) => {
      const { index } = e.detail;
      this.ui.selectedIndex = (this.ui.selectedIndex === index) ? -1 : index;
      this.renderAll();
      this.$map.setSelectedIndex(this.ui.selectedIndex);
    });

    // ---- JSON editor: dirty + auto-apply
    this.$json.addEventListener("dirty-change", (e) => {
      const { dirty, valid } = e.detail;
      this.ui.dirty = dirty;
      this.ui.ioStatus = valid
        ? (dirty ? { kind: "warn", text: "Modifié (valide)" } : { kind: "ok", text: "Synchronisé" })
        : { kind: "danger", text: "Invalide" };
      this.renderPanel();
    });

    this.$json.addEventListener("auto-apply", async () => {
      await this.applyEditorJSON();
    });

    // ---- Map: segment add/update + status
    this.$map.addEventListener("segment-add", (e) => {
      const segment = { ...e.detail.segment };
      const color = this.normalizeSegmentColor(this.ui.lastSegmentColor);
      if (color) segment.color = color;
      this.route.push(segment);
      this.ui.lastError = null;
      this.ui.selectedIndex = this.route.length - 1; // auto focus on new segment
      this.renderAll();
      this.$json.setJSON({ route: this.route });
      this.$map.setSelectedIndex(this.ui.selectedIndex);
    });

    this.$map.addEventListener("segment-update", (e) => {
      const { index, segment } = e.detail;
      this.route[index] = { ...this.route[index], ...segment };
      this.renderAll();
      this.$json.setJSON({ route: this.route });
    });

    this.$map.addEventListener("status", (e) => {
      const { pickStatus, error } = e.detail;
      if (pickStatus != null) this.ui.pickStatus = pickStatus;
      if (error != null) this.ui.lastError = error;
      this.renderPanel();
    });

    // ---- initial wiring
    this.$map.setOptions({
      strict: this.ui.strict,
      autoLoad: this.ui.autoLoad,
      interactionMode: this.ui.interactionMode,
      currentDrawingColor: this.ui.lastSegmentColor,
    });
    this.$map.setRoute(this.route);
    this.$map.setSelectedIndex(this.ui.selectedIndex);
    this.$json.setJSON({ route: this.route });

    // initial bbox load
    this.$map.loadWaysInView().then(() => {
      this.syncCacheFromMap();
      this.renderAll();
    });
  }

  syncCacheFromMap() {
    this.cache = this.$map.getCache();
  }

  renderAll() {
    this.renderPanel();
    this.$map.setCache(this.cache);
    this.$map.setRoute(this.route);
    this.$map.setSelectedIndex(this.ui.selectedIndex);
    this.$map.setOptions({
      strict: this.ui.strict,
      autoLoad: this.ui.autoLoad,
      interactionMode: this.ui.interactionMode,
      currentDrawingColor: this.ui.lastSegmentColor,
    });
    if (!this.ui.dirty) this.$json.setJSON({ route: this.route });
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
    });
  }

  normalizeSegmentColor(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toUpperCase() : null;
  }

  scheduleJsonSync() {
    if (this.ui.dirty) return;
    clearTimeout(this._jsonSyncTimer);
    this._jsonSyncTimer = setTimeout(() => {
      this.$json.setJSON({ route: this.route });
    }, 120);
  }

  schedulePanelRefresh() {
    if (this._panelRefreshFrame != null) return;
    this._panelRefreshFrame = requestAnimationFrame(() => {
      this._panelRefreshFrame = null;
      this.renderPanel();
    });
  }

  async applyEditorJSON() {
    const parsed = this.$json.getParsed();
    if (!parsed.ok) {
      this.ui.lastError = parsed.errors.slice(0, 8).join(" • ");
      this.renderPanel();
      return;
    }

    this.route = parsed.route;
    const lastColored = [...this.route]
      .reverse()
      .map((seg) => this.normalizeSegmentColor(seg.color))
      .find(Boolean);
    if (lastColored) this.ui.lastSegmentColor = lastColored;
    this.ui.lastError = null;
    this.ui.pickStatus = "Aucun point";
    this.ui.selectedIndex = -1;

    await this.loadCacheFromRouteWayIds();
    this.syncCacheFromMap();
    this.$map.fitRoute(this.route);

    this.renderAll();
    this.$map.clearSelection();
    this.$json.setJSON({ route: this.route });
  }

  async loadCacheFromRouteWayIds() {
    await this.$map.loadWaysByIds(this.route.map(s => s.wayId));
  }
}

customElements.define("osm-route-editor", OSMRouteEditor);
