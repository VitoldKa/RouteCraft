import './components/osm-map.js'

class OSMRouteViewer extends HTMLElement {
	constructor() {
		super()
		this.attachShadow({ mode: 'open' })
		this.route = []
	}

	connectedCallback() {
		this.shadowRoot.innerHTML = `
      <style>
        .wrap { display:flex; height:100vh; width:100vw; }
        osm-map { flex:1; display:block; min-width:0; }
        .side {
          width: 380px;
          border-left: 1px solid #ddd;
          background: #fafafa;
          padding: 12px;
          box-sizing: border-box;
          overflow:auto;
          font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        }
        h3 { margin: 0 0 10px 0; }
        .muted { color:#666; font-size: 13px; line-height:1.35; }
        .pill { display:inline-block; font-size:12px; border:1px solid #e5e5e5; padding:2px 8px; border-radius:999px; background:#fff; }
        .pill.danger { border-color:#f3c0c0; }
        .pill.ok { border-color:#cde9cd; }
        .grid2 { display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-top:10px; }
        .card { background:#fff; border:1px solid #e5e5e5; border-radius:12px; padding:10px; }
        .list { display:flex; flex-direction:column; gap:8px; margin-top:10px; }
        .item { background:#fff; border:1px solid #e5e5e5; border-radius:12px; padding:8px; }
        code { background:#fff; border:1px solid #e5e5e5; padding:2px 6px; border-radius:8px; }
        .kpi { font-size: 18px; font-weight: 700; }
        .btn { padding: 8px 10px; cursor: pointer; border:1px solid #ddd; border-radius:10px; background:#fff; }
        .btnRow { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
        pre { white-space:pre-wrap; font-size:12px; background:#fff; border:1px solid #e5e5e5; border-radius:12px; padding:8px; }
      </style>

      <div class="wrap">
        <osm-map></osm-map>
        <div class="side">
          <h3>Route Viewer</h3>
          <div class="muted">Lecture seule : route fournie statiquement en JSON.</div>

          <div class="grid2">
            <div class="card">
              <div class="muted"><strong>Statut</strong></div>
              <div id="status" class="pill">Chargement…</div>
            </div>
            <div class="card">
              <div class="muted"><strong>Distance</strong></div>
              <div class="kpi" id="dist">—</div>
              <div class="muted" id="dist2"></div>
            </div>
          </div>

          <div class="btnRow">
            <button class="btn" id="zoomAll">Zoom sur la route</button>
          </div>

          <div style="margin-top:12px;" class="muted"><strong>Segments</strong></div>
          <div id="list" class="list"></div>

          <div style="margin-top:12px;" class="muted"><strong>JSON</strong></div>
          <pre id="raw"></pre>
        </div>
      </div>
    `

		this.$map = this.shadowRoot.querySelector('osm-map')
		this.$status = this.shadowRoot.querySelector('#status')
		this.$list = this.shadowRoot.querySelector('#list')
		this.$raw = this.shadowRoot.querySelector('#raw')
		this.$dist = this.shadowRoot.querySelector('#dist')
		this.$dist2 = this.shadowRoot.querySelector('#dist2')

		// Viewer: pas de pick / édition
		this.$map.setOptions({ strict: false, autoLoad: false, readOnly: true })
		this.$map.setSelectedIndex(-1)

		this.shadowRoot.querySelector('#zoomAll').addEventListener('click', () => {
			this.zoomOnRoute()
		})

		this.$map.addEventListener('status', (e) => {
			const { error } = e.detail || {}
			if (error) this.setStatus(error, true)
		})

		this.loadStaticJSONAndRender().catch((err) => {
			this.setStatus(err?.message || String(err), true)
		})
	}

	setStatus(text, isError = false) {
		this.$status.textContent = text
		this.$status.classList.toggle('danger', !!isError)
		this.$status.classList.toggle('ok', !isError)
	}

	readStaticJSON() {
		const tag = document.getElementById('route-json')
		if (!tag)
			throw new Error(
				"Balise <script id='route-json' type='application/json'> introuvable."
			)
		const txt = tag.textContent.trim()
		if (!txt) throw new Error('route-json est vide.')

		let obj
		try {
			obj = JSON.parse(txt)
		} catch {
			throw new Error('JSON invalide dans route-json.')
		}

		const arr = Array.isArray(obj) ? obj : obj.route
		if (!Array.isArray(arr))
			throw new Error(
				'Format attendu: {"route":[...]} ou directement un tableau.'
			)

		const route = arr
			.map((s) => ({
				wayId: Number(s.wayId),
				fromNode: Number(s.fromNode),
				toNode: Number(s.toNode),
			}))
			.filter(
				(s) =>
					Number.isInteger(s.wayId) &&
					Number.isInteger(s.fromNode) &&
					Number.isInteger(s.toNode)
			)

		if (!route.length) throw new Error('Aucun segment valide dans le JSON.')
		return { obj, route }
	}

	async loadStaticJSONAndRender() {
		const { obj, route } = this.readStaticJSON()
		this.route = route

		this.$raw.textContent = JSON.stringify(obj, null, 2)
		this.renderListSkeleton() // liste sans noms/distances tant que cache pas chargé

		this.setStatus('Chargement des ways…')

		// 1) charge le cache par IDs
		await this.$map.loadWaysByIds(this.route.map((s) => s.wayId))

		// 2) affiche l’itinéraire
		this.$map.setRoute(this.route)

		// 3) recalcul distances + noms (tags dispo maintenant)
		this.renderListWithNamesAndDistances()

		// 4) zoom auto sur toute la route
		this.zoomOnRoute()

		this.setStatus('OK')
	}

	zoomOnRoute() {
		// Important si flex/shadow : resize -> Leaflet recalcul
		if (this.$map.invalidate) this.$map.invalidate()

		// fit bounds route
		this.$map.fitRoute(this.route)
	}

	renderListSkeleton() {
		this.$list.innerHTML = ''
		this.route.forEach((seg, i) => {
			const div = document.createElement('div')
			div.className = 'item'
			div.innerHTML = `
        <div><strong>${i + 1}.</strong> way ${seg.wayId}</div>
        <div class="muted"><span>from</span> <code>${seg.fromNode}</code> <span>→</span> <code>${seg.toNode}</code></div>
        <div class="muted">—</div>
      `
			this.$list.appendChild(div)
		})
		this.$dist.textContent = '—'
		this.$dist2.textContent = ''
	}

	renderListWithNamesAndDistances() {
		let total = 0

		this.$list.innerHTML = ''
		this.route.forEach((seg, i) => {
			const tags = this.$map.getWayTags ? this.$map.getWayTags(seg.wayId) : {}
			const name = tags?.name ? tags.name : null

			const d = this.$map.segmentDistanceMeters
				? this.$map.segmentDistanceMeters(seg)
				: 0
			total += d

			const div = document.createElement('div')
			div.className = 'item'
			div.innerHTML = `
        <div><strong>${i + 1}.</strong> ${name ? name : `way ${seg.wayId}`}</div>
        <div class="muted"><span>way</span> <code>${seg.wayId}</code></div>
        <div class="muted">
          <span>from</span> <code>${seg.fromNode}</code> <span>→</span> <code>${seg.toNode}</code>
        </div>
        <div class="muted"><strong>${this.formatDistance(d)}</strong></div>
      `
			this.$list.appendChild(div)
		})

		this.$dist.textContent = this.formatDistance(total)
		this.$dist2.textContent = `${Math.round(total)} m`
	}

	formatDistance(m) {
		if (!isFinite(m) || m <= 0) return '0 m'
		if (m < 1000) return `${Math.round(m)} m`
		const km = m / 1000
		// 1 décimale si < 10km, sinon 0
		return km < 10 ? `${km.toFixed(1)} km` : `${km.toFixed(0)} km`
	}
}

customElements.define('osm-route-viewer', OSMRouteViewer)
