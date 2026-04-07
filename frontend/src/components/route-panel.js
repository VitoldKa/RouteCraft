class RoutePanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.state = {
      route: [],
      strict: true,
      autoLoad: true,
      lastError: null,
      pickStatus: "Aucun point",
      ioStatus: { kind: "ok", text: "Synchronisé" },
      dirty: false,
      selectedIndex: -1,
    };
  }

  connectedCallback() {
    this.render();
  }

  setState(next) {
    this.state = { ...this.state, ...next };
    this.render();
  }

  render() {
    const s = this.state;
    const errStyle = s.lastError ? "" : "display:none;";
    const ioClass = s.ioStatus?.kind || "";
    const ioText = s.ioStatus?.text || "—";

    this.shadowRoot.innerHTML = `
      <style>
        .panel { padding: 12px; }
        h3 { margin: 0 0 8px 0; }
        .muted { color:#666; font-size: 13px; line-height:1.35; }
        .row { display:flex; gap:8px; align-items:center; margin:10px 0; flex-wrap:wrap; }
        .grid2 { display:grid; grid-template-columns: 1fr 1fr; gap:8px; }
        button { padding: 8px 10px; cursor: pointer; }
        button.small { padding: 4px 8px; }
        .pill { display:inline-block; font-size:12px; border:1px solid #e5e5e5; padding:2px 8px; border-radius:999px; background:#fff; }
        .pill.danger { border-color:#f3c0c0; }
        .pill.ok { border-color:#cde9cd; }
        .pill.warn { border-color:#f1df9c; }
        .list { display:flex; flex-direction:column; gap:8px; margin-top:10px; }
        .item {
          background:#fff; border:1px solid #e5e5e5; border-radius:12px;
          padding:8px; display:flex; flex-direction:column; gap:6px;
          cursor:pointer;
        }
        .item.selected {
          outline: 3px solid rgba(60, 130, 255, 0.25);
          border-color: rgba(60, 130, 255, 0.55);
        }
        .item.invalid {
          outline: 3px solid rgba(201, 42, 42, 0.26);
        	border-color: #ff0000ff;
        }
        .itemTop { display:flex; justify-content:space-between; gap:8px; align-items:center; }
        code { background:#fff; border:1px solid #e5e5e5; padding:2px 6px; border-radius:8px; }
        .swatch {
          display:inline-block;
          width:12px;
          height:12px;
          border-radius:999px;
          border:1px solid rgba(0,0,0,0.15);
          vertical-align:middle;
          margin-right:6px;
        }
      </style>

      <div class="panel">
        <h3>OSM Route Editor</h3>
        <div class="muted">
          Focus mode : clique un segment pour afficher ses handles Start/End (clique à nouveau pour désélectionner).
        </div>

        <div class="row">
          <label class="row" style="gap:6px;">
            <input id="autoLoad" type="checkbox" ${s.autoLoad ? "checked" : ""}/>
            <span>Charger la zone visible</span>
          </label>

          <label class="row" style="gap:6px;">
            <input id="strict" type="checkbox" ${s.strict ? "checked" : ""}/>
            <span>Continuité stricte</span>
          </label>
        </div>

        <div class="row">
          <button id="reload">Recharger (bbox)</button>
          <button id="clear">Vider</button>
        </div>

        <div class="grid2">
          <div class="muted">
            <div><strong>Statut sélection</strong></div>
            <div class="pill">${s.pickStatus}</div>
          </div>
          <div class="muted">
            <div><strong>Dernière erreur</strong></div>
            <div id="err" class="pill danger" style="${errStyle}">${s.lastError || ""}</div>
          </div>
        </div>

        <div style="margin-top:12px;" class="muted"><strong>Itinéraire (tronçons)</strong> :</div>
        <div class="list" id="list"></div>

        <div class="row" style="margin-top:12px;">
          <button id="export">Exporter</button>
          <button id="import">Importer</button>
          <button id="loadFromRoute">Charger les ways</button>
          <button id="format" class="small">Formater JSON</button>
        </div>

        <div class="row">
          <span class="pill ${ioClass}">${ioText}</span>
          ${s.dirty ? `<span class="pill warn">Non appliqué</span>` : ``}
        </div>
      </div>
    `;

    // toggles
    this.shadowRoot.querySelector("#autoLoad").addEventListener("change", (e) => {
      this.dispatchEvent(new CustomEvent("toggle", { detail: { name: "autoLoad", value: e.target.checked }, bubbles: true, composed: true }));
    });
    this.shadowRoot.querySelector("#strict").addEventListener("change", (e) => {
      this.dispatchEvent(new CustomEvent("toggle", { detail: { name: "strict", value: e.target.checked }, bubbles: true, composed: true }));
    });

    // actions
    this.shadowRoot.querySelector("#reload").addEventListener("click", () => this.emitAction("reload-bbox"));
    this.shadowRoot.querySelector("#clear").addEventListener("click", () => this.emitAction("clear"));
    this.shadowRoot.querySelector("#export").addEventListener("click", () => this.emitAction("export"));
    this.shadowRoot.querySelector("#import").addEventListener("click", () => this.emitAction("import"));
    this.shadowRoot.querySelector("#loadFromRoute").addEventListener("click", () => this.emitAction("load-from-route"));
    this.shadowRoot.querySelector("#format").addEventListener("click", () => this.emitAction("format"));

    // list
    const list = this.shadowRoot.querySelector("#list");
    s.route.forEach((seg, idx) => {
      const div = document.createElement("div");
      div.className = "item" + (s.selectedIndex === idx ? " selected" : "");
      div.innerHTML = `
        <div class="itemTop">
          <div>
            <strong>${idx + 1}.</strong> way ${seg.wayId}<br>
            <span class="muted">from</span> <code>${seg.fromNode}</code> <span class="muted">→ to</span> <code>${seg.toNode}</code>
            ${seg.color ? `<br><span class="muted"><span class="swatch" style="background:${seg.color}"></span>${seg.color}</span>` : ``}
          </div>
          <div style="display:flex; gap:6px; align-items:center;">
            <button class="small" data-act="up">↑</button>
            <button class="small" data-act="down">↓</button>
            <button class="small" data-act="del">✕</button>
          </div>
        </div>
      `;



      // click item = select (focus mode)
      div.addEventListener("click", (ev) => {
        // si click sur un bouton, ne pas sélectionner
        if (ev.target.tagName === "BUTTON") return;
        this.dispatchEvent(new CustomEvent("select-segment", {
          detail: { index: idx },
          bubbles: true, composed: true
        }));
      });

      div.querySelectorAll("button").forEach(btn => {
        btn.addEventListener("click", () => {
          const act = btn.getAttribute("data-act");
          this.dispatchEvent(new CustomEvent("route-edit", {
            detail: { op: { type: act, index: idx } },
            bubbles: true, composed: true
          }));
        });
      });

      list.appendChild(div);
    });
  }

  emitAction(type) {
    this.dispatchEvent(new CustomEvent("action", { detail: { type }, bubbles: true, composed: true }));
  }
}

customElements.define("route-panel", RoutePanel);
