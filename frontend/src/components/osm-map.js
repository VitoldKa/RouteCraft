import { getWays, putWays, getNodes, putNodes } from "./osm-cache.js";
import { getBBox, putBBox, pruneBBoxes } from "./osm-cache.js";

class OSMMap extends HTMLElement {
	constructor() {
		super();
		this.attachShadow({ mode: "open" });

		this.route = [];
		this.options = { strict: true, autoLoad: true, readOnly: false };
		this.selectedIndex = -1; // focus mode
		this.invalidSeg = new Map(); // index -> { codes:[], message:"..." }
		this.invalidWayIds = new Set(); // optionnel


		// cache
		this.nodesById = new Map();
		this.wayNodeIds = new Map();
		this.wayTags = new Map();
		this.wayBBox = new Map();

		// hover / pick
		this.pick = null;
		this.hoveredWayId = null;

		// Leaflet
		this.map = null;
		this.hoverLayer = null;
		this.selectedLayer = null;
		this.editLayer = null;
		this.pickLayer = null;

		this.editMarkers = new Map();
		this.editLines = new Map();

		// Overpass
		this.OVERPASS_ENDPOINTS = [
			"https://maps.mail.ru/osm/tools/overpass/api/interpreter",
			// "https://overpass-api.de/api/interpreter",
			// "https://overpass.private.coffee/api/interpreter",
			// "http://51.91.252.49:12345/api/interpreter"
		];
		this.MIN_ZOOM = 17;
		this.HIGHWAY_REGEX = "pedestrian|residential|living_street|tertiary|secondary|primary|unclassified|service|path|track";
		// this.HIGHWAY_REGEX = "residential|living_street|tertiary|secondary|primary|unclassified|service|path|track";
		this.MAX_SPAN_DEG = 0.03;

		this.loading = false;
		this.lastLoadKey = "";

		// Spatial index (grid in pixels)
		this.spatial = {
			enabled: true,
			cellSize: 80, // px
			zoom: null,
			grid: new Map(), // key "cx,cy" -> Set(wayId)
			wayPixelBBox: new Map(), // wayId -> {minx,miny,maxx,maxy}
		};
	}

	connectedCallback() {
		this.shadowRoot.innerHTML = `
  <style>
    :host { display:block; height:100%; width:100%; }
    #map { height: 100%; width: 100%; }

    /* important si tu as un reset global type img{max-width:100%} */
    .leaflet-container img { max-width: none !important; }
  </style>

  <link rel="stylesheet"
        href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">

  <div id="map"></div>
    `;

		this.map = L.map(this.shadowRoot.querySelector("#map")).setView([46.2044, 6.1432], 14);
		L.Icon.Default.imagePath = "https://unpkg.com/leaflet@1.9.4/dist/images/";
		L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
			maxZoom: 19,
			attribution: "&copy; OpenStreetMap contributors"
		}).addTo(this.map);

		// Leaflet + flex + shadow DOM => il faut recalculer la taille après montage
		requestAnimationFrame(() => this.map.invalidateSize());
		setTimeout(() => this.map.invalidateSize(), 0);

		this._ro = new ResizeObserver(() => {
			if (this.map) this.map.invalidateSize();
		});
		this._ro.observe(this);



		this.hoverLayer = L.layerGroup().addTo(this.map);
		this.selectedLayer = L.layerGroup().addTo(this.map);
		this.editLayer = L.layerGroup().addTo(this.map);
		this.pickLayer = L.layerGroup().addTo(this.map);

		this.map.on("mousemove", (e) => this.onMouseMove(e));
		this.map.on("click", (e) => this.onMapClick(e));
		this.map.on("moveend", this.debounce(() => {
			if (this.options.autoLoad) this.loadWaysInView();
		}, 250));

		// rebuild spatial index on zoomend (pixel coords changed)
		this.map.on("zoomend", () => {
			this.buildSpatialIndex();
		});

		this.emitStatus({ pickStatus: "Aucun point", error: null });
	}

	// ---------- Public API ----------
	setOptions(opts) { this.options = { ...this.options, ...opts }; }
	setRoute(route) {
		this.route = route || []; this.redrawSelected();
		// const report = this.validateRoute(this.route, { strict: true, autoFetch: true });
		this.validateAndMarkRoute({ autoFetch: true }).catch(() => {});
	}
	setSelectedIndex(i) { this.selectedIndex = Number(i ?? -1); this.redrawSelected(); }

	clearSelection() {
		this.pick = null;
		this.pickLayer.clearLayers();
		this.emitStatus({ pickStatus: "Aucun point" });
	}

	setCache(cache) {
		if (!cache) return;
		this.nodesById = cache.nodesById || this.nodesById;
		this.wayNodeIds = cache.wayNodeIds || this.wayNodeIds;
		this.wayTags = cache.wayTags || this.wayTags;
		this.wayBBox = cache.wayBBox || this.wayBBox;
		this.clearHover();
		this.buildSpatialIndex();
		this.redrawSelected();
	}

	getCache() {
		return {
			nodesById: this.nodesById,
			wayNodeIds: this.wayNodeIds,
			wayTags: this.wayTags,
			wayBBox: this.wayBBox,
		};
	}

	// --- XYZ tile helpers (Web Mercator) ---
	tileXY(lat, lon, z) {
		const n = 2 ** z;
		const x = Math.floor(((lon + 180) / 360) * n);
		const latRad = (lat * Math.PI) / 180;
		const y = Math.floor(
			(1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n
		);
		return {
			x: Math.max(0, Math.min(n - 1, x)),
			y: Math.max(0, Math.min(n - 1, y)),
		};
	}

	tileBounds(x, y, z) {
		const n = 2 ** z;

		const w = (x / n) * 360 - 180;
		const e = ((x + 1) / n) * 360 - 180;

		const nLat = (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
		const sLat = (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n)));

		return { s: sLat, w, n: nLat, e };
	}

	tilesCoveringBounds(bounds, z) {
		const s = bounds.getSouth(), w = bounds.getWest(), n = bounds.getNorth(), e = bounds.getEast();
		const tl = this.tileXY(n, w, z); // top-left
		const br = this.tileXY(s, e, z); // bottom-right

		const tiles = [];
		for (let x = tl.x; x <= br.x; x++) {
			for (let y = tl.y; y <= br.y; y++) {
				tiles.push({ x, y, z });
			}
		}
		return tiles;
	}

	tileKey(t) {
		return `t${t.z}/${t.x}/${t.y}`;
	}

	async validateAndMarkRoute({ strict = this.options.strict, autoFetch = true } = {}) {
		// reset
		this.invalidSeg.clear();
		this.invalidWayIds.clear();

		// 1) charger les ways si besoin
		const wayIds = [...new Set((this.route || []).map(s => Number(s.wayId)).filter(Number.isInteger))];
		if (autoFetch && wayIds.length) {
			await this.loadWaysByIds(wayIds);
		}

		// 2) valider segments
		for (let i = 0; i < (this.route || []).length; i++) {
			const seg = this.route[i];
			const r = this.validateSegment(seg);

			// Continuité stricte (optionnel)
			if (strict && i > 0) {
				const prev = this.route[i - 1];
				if (Number(prev.toNode) !== Number(seg.fromNode)) {
					r.ok = false;
					r.errors = r.errors || [];
					r.errors.push({
						code: "STRICT_CONTINUITY",
						message: `Continuité stricte: doit démarrer au node ${prev.toNode}`
					});
				}
			}

			if (!r.ok) {
				const msg = (r.errors?.[0]?.message) || "Segment invalide";
				this.invalidSeg.set(i, {
					codes: (r.errors || []).map(e => e.code),
					message: msg
				});
				this.invalidWayIds.add(Number(seg.wayId));
			}
		}

		// 3) notifier l’UI externe (éditeur)
		this.dispatchEvent(new CustomEvent("route-validation", {
			detail: {
				ok: this.invalidSeg.size === 0,
				invalidIndexes: [...this.invalidSeg.keys()],
				invalidByIndex: Object.fromEntries(
					[...this.invalidSeg.entries()].map(([k, v]) => [k, v])
				)
			},
			bubbles: true,
			composed: true
		}));

		// 4) redraw map
		this.redrawSelected?.();
	}

	async validateRoute(route = this.route, { strict = this.options.strict, autoFetch = true } = {}) {
		const segments = Array.isArray(route) ? route : [];
		const report = {
			ok: true,
			errors: [],   // { index, code, message, segment }
			warnings: [], // idem
			fixed: [],    // { index, before, after, note }
		};

		if (segments.length === 0) return report;

		// 1) Précharger toutes les ways requises (cache-first, Overpass si missing)
		const wayIds = [...new Set(segments.map(s => Number(s.wayId)).filter(n => Number.isInteger(n) && n > 0))];

		if (autoFetch && wayIds.length) {
			await this.loadWaysByIds(wayIds);
		}

		// 2) Valider segment par segment
		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			const r = this.validateSegment(seg);

			if (!r.ok) {
				report.ok = false;
				report.errors.push(...r.errors.map(e => ({ index: i, segment: seg, ...e })));
			}
			report.warnings.push(...r.warnings.map(w => ({ index: i, segment: seg, ...w })));

			// continuité stricte (optionnel)
			if (strict && i > 0) {
				const prev = segments[i - 1];
				if (Number(prev.toNode) !== Number(seg.fromNode)) {
					// petite tentative de “fix” : si inversable, on inverse
					if (Number(prev.toNode) === Number(seg.toNode)) {
						const before = { ...seg };
						const after = { ...seg, fromNode: seg.toNode, toNode: seg.fromNode };
						// revalider après inversion
						const r2 = this.validateSegment(after);
						if (r2.ok) {
							segments[i] = after;
							report.fixed.push({ index: i, before, after, note: "Inversé pour respecter la continuité stricte." });
						} else {
							report.ok = false;
							report.errors.push({
								index: i,
								segment: seg,
								code: "STRICT_CONTINUITY",
								message: `Continuité stricte cassée: le segment ${i} doit démarrer au node ${prev.toNode}.`
							});
						}
					} else {
						report.ok = false;
						report.errors.push({
							index: i,
							segment: seg,
							code: "STRICT_CONTINUITY",
							message: `Continuité stricte cassée: le segment ${i} doit démarrer au node ${prev.toNode}.`
						});
					}
				}
			}
		}

		return report;
	}

	validateSegment(seg) {
		const errors = [];
		const warnings = [];

		const wayId = Number(seg?.wayId);
		const fromNode = Number(seg?.fromNode);
		const toNode = Number(seg?.toNode);

		if (!Number.isInteger(wayId) || wayId <= 0) {
			errors.push({ code: "BAD_WAY_ID", message: "wayId invalide." });
			return { ok: false, errors, warnings };
		}

		const nodeIds = this.wayNodeIds.get(wayId);
		if (!nodeIds || nodeIds.length < 2) {
			errors.push({ code: "WAY_NOT_LOADED", message: `Way ${wayId} absente du cache mémoire (ou trop courte).` });
			return { ok: false, errors, warnings };
		}

		if (!Number.isInteger(fromNode) || !Number.isInteger(toNode) || fromNode <= 0 || toNode <= 0) {
			errors.push({ code: "BAD_NODE_ID", message: "fromNode/toNode invalide(s)." });
			return { ok: false, errors, warnings };
		}

		if (fromNode === toNode) {
			errors.push({ code: "SAME_NODE", message: "fromNode et toNode ne peuvent pas être identiques." });
		}

		const a = nodeIds.indexOf(fromNode);
		const b = nodeIds.indexOf(toNode);
		if (a < 0) errors.push({ code: "FROM_NOT_IN_WAY", message: `fromNode ${fromNode} n'appartient pas à way ${wayId}.` });
		if (b < 0) errors.push({ code: "TO_NOT_IN_WAY", message: `toNode ${toNode} n'appartient pas à way ${wayId}.` });

		// Optionnel : vérifier que les coords des nodes sont connues (utile pour rendu)
		if (!this.nodesById.get(fromNode)) warnings.push({ code: "FROM_NODE_NO_COORD", message: `Coordonnées manquantes pour node ${fromNode}.` });
		if (!this.nodesById.get(toNode)) warnings.push({ code: "TO_NODE_NO_COORD", message: `Coordonnées manquantes pour node ${toNode}.` });

		return { ok: errors.length === 0, errors, warnings };
	}

	async loadWaysInView() {
		if (this.loading) return;

		// Réglages cache tuiles
		const CACHE_Z = 14; // niveau de tuile pour le cache (indépendant du zoom Leaflet)
		const TILE_MAX_AGE_MS = 7 * 24 * 3600 * 1000; // 7 jours (augmente si tu veux)

		const bounds = this.clampBounds(this.map.getBounds());
		const tiles = this.tilesCoveringBounds(bounds, CACHE_Z);

		// clé stable (indépendante du zoom Leaflet)
		const tilesKey = tiles.map(t => this.tileKey(t)).sort().join("|");
		if (tilesKey === this.lastLoadKey) return;
		this.lastLoadKey = tilesKey;

		this.loading = true;

		try {
			const canFetch = this.map.getZoom() >= this.MIN_ZOOM;
			const wayIdSet = new Set();

			for (const t of tiles) {
				const key = this.tileKey(t);

				// 1) cache tuile -> wayIds
				let row = null;
				try {
					row = await getBBox(key, { maxAgeMs: TILE_MAX_AGE_MS });
				} catch {
					row = null;
				}

				let wayIds = row?.wayIds || null;

				// 2) si pas en cache: fetch Overpass (uniquement si zoom ok)
				if (!wayIds && canFetch) {
					const bb = this.tileBounds(t.x, t.y, t.z);
					const bboxQuery = `${bb.s.toFixed(6)},${bb.w.toFixed(6)},${bb.n.toFixed(6)},${bb.e.toFixed(6)}`;

					const q = `
          [out:json][timeout:90];
          (
            way["highway"~"${this.HIGHWAY_REGEX}"](${bboxQuery});

            way["highway"]["busway"](${bboxQuery});
            way["highway"]["bus"~"yes|designated"](${bboxQuery});
            way["highway"]["lanes:bus"](${bboxQuery});

            way["railway"~"tram|light_rail"](${bboxQuery});
          );
          out ids qt;
        `;

					const data = await this.overpass(q);
					wayIds = (data.elements || [])
						.filter(el => el.type === "way" && Number.isInteger(el.id))
						.map(el => el.id);

					// save cache tuile
					try {
						await putBBox({ key, wayIds, fetchedAt: Date.now() });
						pruneBBoxes(5000).catch(() => { });
					} catch {
						// ignore
					}
				}

				if (wayIds && wayIds.length) {
					for (const id of wayIds) wayIdSet.add(id);
				}
			}

			// Si zoom trop bas: on ne tape pas Overpass.
			// On garde l'existant, mais si on a des IDs depuis le cache tuile, on peut charger localement.
			if (!canFetch) {
				this.emitStatus?.({ error: `Zoome à ${this.MIN_ZOOM}+ pour charger (sinon Overpass timeout).` });
			}

			if (wayIdSet.size) {
				await this.loadWaysByIds([...wayIdSet]);
				this.emitStatus?.({ error: null });
			} else {
				this.emitStatus?.({ error: null });
				// pas de clear ici: on garde l'affichage existant
			}

			this.clearHover?.();
			this.redrawSelected?.();
		} catch (e) {
			this.emitStatus?.({ error: e?.message || String(e) });
			throw e;
		} finally {
			this.loading = false;
		}
	}
	async loadWaysByIds(wayIds) {
		const ids = [...new Set((wayIds || []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
		if (!ids.length) return;

		const MAX_AGE_MS = 7 * 24 * 3600 * 1000; // 7 jours

		// 1) cache-first ways
		let foundWays = [];
		let missing = ids;

		try {
			const res = await getWays(ids, { maxAgeMs: MAX_AGE_MS });
			foundWays = res.found;
			missing = res.missing;
		} catch (e) {
			// cache KO -> on traite tout comme missing
			foundWays = [];
			missing = ids;
		}

		// 2) inject cache en mémoire
		for (const w of foundWays) {
			if (Array.isArray(w.nodes) && w.nodes.length >= 2) {
				this.wayNodeIds.set(w.id, w.nodes);
				this.wayTags.set(w.id, w.tags || {});
			}
		}

		// 3) récupérer nodes nécessaires pour ces ways depuis cache nodes
		if (foundWays.length) {
			const nodeSet = new Set();
			for (const w of foundWays) for (const nid of (w.nodes || [])) nodeSet.add(nid);
			const nodeIds = [...nodeSet];

			try {
				const nodeRows = await getNodes(nodeIds);
				for (const row of nodeRows) {
					this.nodesById.set(row.id, { lat: row.lat, lon: row.lon });
				}
			} catch {
				// ignore
			}
		}

		// 4) fetch Overpass pour missing/stale
		if (missing.length) {
			const CHUNK = 150;
			const fetchedNodes = new Map(); // nid -> {lat,lon}
			const fetchedWays = []; // rows ways pour cache

			for (let i = 0; i < missing.length; i += CHUNK) {
				const part = missing.slice(i, i + CHUNK);
				const q = `
        [out:json][timeout:90];
        (
          ${part.map((id) => `way(${id});`).join("\n")}
        );
        out body;
        >;
        out skel qt;
      `;

				const data = await this.overpass(q);

				for (const el of (data.elements || [])) {
					if (el.type === "node") fetchedNodes.set(el.id, { lat: el.lat, lon: el.lon });
				}
				for (const el of (data.elements || [])) {
					if (el.type === "way" && Array.isArray(el.nodes) && el.nodes.length >= 2) {
						const row = { id: el.id, nodes: el.nodes, tags: el.tags || {}, fetchedAt: Date.now() };
						fetchedWays.push(row);
					}
				}
			}

			// ingest mémoire
			for (const [nid, coord] of fetchedNodes.entries()) {
				this.nodesById.set(nid, coord);
			}
			for (const w of fetchedWays) {
				this.wayNodeIds.set(w.id, w.nodes);
				this.wayTags.set(w.id, w.tags || {});
			}

			// persist cache
			try {
				await putNodes([...fetchedNodes.entries()].map(([id, c]) => ({ id, lat: c.lat, lon: c.lon })));
				await putWays(fetchedWays);
			} catch {
				// ignore
			}
		}

		// post-processing
		this.recomputeWayBBox?.();
		this.recomputeIntersections?.();
		this.buildSpatialIndex?.();
		this.clearHover?.();
		this.redrawSelected?.();
	}

	fitRoute(route) {
		const pts = [];
		for (const seg of (route || [])) {
			const a = this.nodesById.get(seg.fromNode);
			const b = this.nodesById.get(seg.toNode);
			if (a) pts.push([a.lat, a.lon]);
			if (b) pts.push([b.lat, b.lon]);
		}
		if (pts.length >= 2) this.map.fitBounds(L.latLngBounds(pts).pad(0.3));
	}

	// ---------- Overpass ----------
	async overpass(query) {
		const body = "data=" + encodeURIComponent(query);
		let lastErr = null;

		for (const url of this.OVERPASS_ENDPOINTS) {
			try {
				const res = await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
					body
				});

				if (!res.ok) {
					if ([429, 502, 504].includes(res.status)) {
						lastErr = new Error(`${url} -> HTTP ${res.status}`);
						continue;
					}
					throw new Error(`${url} -> HTTP ${res.status}`);
				}
				return await res.json();
			} catch (e) {
				lastErr = e;
			}
		}
		throw lastErr || new Error("Overpass: échec sur tous les endpoints");
	}

	// ---------- Cache ingest ----------
	clearOSMCache() {
		this.nodesById = new Map();
		this.wayNodeIds = new Map();
		this.wayTags = new Map();
		this.wayBBox = new Map();
		this.clearHover();
		this.buildSpatialIndex();
		this.redrawSelected();
	}

	ingestOverpassReplace(json) {
		this.nodesById = new Map();
		this.wayNodeIds = new Map();
		this.wayTags = new Map();
		this.wayBBox = new Map();

		for (const el of json.elements) {
			if (el.type === "node") this.nodesById.set(el.id, { lat: el.lat, lon: el.lon });
			else if (el.type === "way") {
				if (Array.isArray(el.nodes) && el.nodes.length >= 2) {
					this.wayNodeIds.set(el.id, el.nodes);
					this.wayTags.set(el.id, el.tags || {});
				}
			}
		}
		this.recomputeWayBBox();
	}

	recomputeWayBBox() {
		this.wayBBox = new Map();
		for (const [wayId, nodeIds] of this.wayNodeIds.entries()) {
			let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
			for (const nid of nodeIds) {
				const n = this.nodesById.get(nid);
				if (!n) continue;
				minLat = Math.min(minLat, n.lat);
				maxLat = Math.max(maxLat, n.lat);
				minLon = Math.min(minLon, n.lon);
				maxLon = Math.max(maxLon, n.lon);
			}
			this.wayBBox.set(wayId, { minLat, minLon, maxLat, maxLon });
		}
	}

	// ---------- Spatial index (grid in pixels) ----------
	buildSpatialIndex() {
		if (!this.spatial.enabled || !this.map) return;

		const zoom = this.map.getZoom();
		if (this.spatial.zoom === zoom && this.spatial.grid.size > 0) return;

		this.spatial.zoom = zoom;
		this.spatial.grid = new Map();
		this.spatial.wayPixelBBox = new Map();

		const cell = this.spatial.cellSize;

		for (const [wayId, nodeIds] of this.wayNodeIds.entries()) {
			let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;

			for (const nid of nodeIds) {
				const n = this.nodesById.get(nid);
				if (!n) continue;
				const p = this.map.latLngToLayerPoint([n.lat, n.lon]);
				minx = Math.min(minx, p.x);
				miny = Math.min(miny, p.y);
				maxx = Math.max(maxx, p.x);
				maxy = Math.max(maxy, p.y);
			}

			if (!isFinite(minx)) continue;
			this.spatial.wayPixelBBox.set(wayId, { minx, miny, maxx, maxy });

			const cx0 = Math.floor(minx / cell), cy0 = Math.floor(miny / cell);
			const cx1 = Math.floor(maxx / cell), cy1 = Math.floor(maxy / cell);

			for (let cx = cx0; cx <= cx1; cx++) {
				for (let cy = cy0; cy <= cy1; cy++) {
					const key = `${cx},${cy}`;
					let set = this.spatial.grid.get(key);
					if (!set) { set = new Set(); this.spatial.grid.set(key, set); }
					set.add(wayId);
				}
			}
		}
	}

	candidatesNear(latlng) {
		this.buildSpatialIndex();

		const p = this.map.latLngToLayerPoint(latlng);
		const cell = this.spatial.cellSize;
		const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);

		const out = new Set();
		// 3x3 neighborhood
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				const key = `${cx + dx},${cy + dy}`;
				const set = this.spatial.grid.get(key);
				if (!set) continue;
				for (const id of set) out.add(id);
			}
		}
		return out;
	}

	// ---------- Hover ----------
	clearHover() {
		this.hoverLayer.clearLayers();
		this.hoveredWayId = null;
	}

	renderHoverWay(wayId) {
		this.hoverLayer.clearLayers();
		this.hoveredWayId = wayId;

		const latlngs = this.wayToLatLngs(wayId);
		if (latlngs.length < 2) return;

		const poly = L.polyline(latlngs, { weight: 7, opacity: 0.9 }).addTo(this.hoverLayer);
		const tags = this.wayTags.get(wayId) || {};
		const name = tags.name ? ` (${tags.name})` : "";

		const hint = (window.event?.ctrlKey || window.event?.metaKey)
			? "Ctrl + clic : ajouter la way entière"
			: "Clic : tronçon / intersections";

		poly.bindTooltip(`way ${wayId}${name}<br><small>${hint}</small>`, {
			sticky: true, direction: "top",
			opacity: 0.9
		});
	}

	onMouseMove(e) {
		if (this.options.readOnly) return;
		if (this.wayNodeIds.size === 0) return;
		if (this._moveTicking) return;
		this._moveTicking = true;

		requestAnimationFrame(() => {
			this._moveTicking = false;

			let bestWay = null;
			let bestD = Infinity;

			const candidates = this.candidatesNear(e.latlng);
			if (candidates.size === 0) {
				this.clearHover();
				return;
			}

			for (const wayId of candidates) {
				const d = this.distanceToWayMeters(e.latlng, wayId);
				if (d < bestD) { bestD = d; bestWay = wayId; }
			}

			const THRESHOLD = 15;
			if (!bestWay || bestD > THRESHOLD) {
				this.clearHover();
				return;
			}
			if (bestWay !== this.hoveredWayId) this.renderHoverWay(bestWay);
		});
	}

	// ---------- Click pick segment ----------
	onMapClick(e) {
		if (this.options.readOnly) return;
		if (e.originalEvent && (e.originalEvent.ctrlKey || e.originalEvent.metaKey)) {
			this.addWholeWayFromHover();
			return;
		}
		if (!this.hoveredWayId) return;

		const wayId = this.hoveredWayId;
		const nodeId = this.nearestNodeIdOnWay(e.latlng, wayId);
		if (!nodeId) return;

		if (!this.pick) {
			this.pick = { wayId, startNode: nodeId };
			const n = this.nodesById.get(nodeId);
			this.pickLayer.clearLayers();
			L.circleMarker([n.lat, n.lon], { radius: 7, weight: 2, opacity: 0.9, fillOpacity: 0.5 })
				.bindTooltip("Départ", { sticky: true })
				.addTo(this.pickLayer);
			this.emitStatus({ pickStatus: `Départ: way ${wayId}, node ${nodeId}. Clique un 2e point sur la même way.`, error: null });
			return;
		}

		if (this.pick.wayId !== wayId) {
			this.clearSelection();
			this.onMapClick(e);
			return;
		}

		if (nodeId === this.pick.startNode) {
			this.emitStatus({ error: "Choisis un autre node pour définir un tronçon." });
			return;
		}

		let fromNode = this.pick.startNode;
		let toNode = nodeId;

		if (this.options.strict && this.route.length > 0) {
			const prev = this.route[this.route.length - 1];
			if (prev.toNode !== fromNode) {
				if (prev.toNode === toNode) [fromNode, toNode] = [toNode, fromNode];
				else {
					this.emitStatus({ error: `Continuité stricte: le nouveau tronçon doit démarrer au node ${prev.toNode}.` });
					return;
				}
			}
		}

		const latlngs = this.sliceWayByNodes(wayId, fromNode, toNode);
		if (latlngs.length < 2) {
			this.emitStatus({ error: "Impossible de créer le tronçon (nodes introuvables dans la way ?)." });
			return;
		}

		this.dispatchEvent(new CustomEvent("segment-add", {
			detail: { segment: { wayId, fromNode, toNode } },
			bubbles: true, composed: true
		}));

		this.clearSelection();
	}

	addWholeWayFromHover() {
		if (!this.hoveredWayId) return;

		const wayId = this.hoveredWayId;
		const ids = this.wayNodeIds.get(wayId);
		if (!ids || ids.length < 2) return;

		let fromNode = ids[0];
		let toNode = ids[ids.length - 1];

		// Annule un éventuel pick en cours
		this.clearSelection?.();

		// Continuité stricte : orienter la way si possible
		if (this.options.strict && this.route.length > 0) {
			const prev = this.route[this.route.length - 1];
			if (prev.toNode === toNode) {
				[fromNode, toNode] = [toNode, fromNode];
			}
			if (prev.toNode !== fromNode) {
				this.emitStatus?.({
					error: `Continuité stricte: la way entière doit démarrer au node ${prev.toNode}.`
				});
				return;
			}
		}

		// Vérifier que la géométrie existe
		const latlngs = this.sliceWayByNodes(wayId, fromNode, toNode);
		if (!latlngs || latlngs.length < 2) {
			this.emitStatus?.({
				error: "Impossible d'ajouter la way entière (nodes manquants dans le cache ?)."
			});
			return;
		}

		this.dispatchEvent(new CustomEvent("segment-add", {
			detail: { segment: { wayId, fromNode, toNode } },
			bubbles: true,
			composed: true
		}));

		this.emitStatus?.({
			pickStatus: `Ajout way entière (Ctrl + clic) : ${wayId}`,
			error: null
		});
	}

	// ---------- Focus mode drawing ----------
	redrawSelected() {
		this.selectedLayer.clearLayers();
		this.editLayer.clearLayers();
		this.editMarkers.clear();
		this.editLines.clear();

		// draw all segments
		this.route.forEach((seg, idx) => {
			const latlngs = this.sliceWayByNodes(seg.wayId, seg.fromNode, seg.toNode);
			if (latlngs.length < 2) return;

			const isSelected = (idx === this.selectedIndex);
			const isInvalid = this.invalidSeg.has(idx);

			const line = L.polyline(latlngs, {
				color: isInvalid ? "#d00" : "#0060ddff", // Leaflet accepte undefined => couleur par défaut
				weight: isSelected ? 10 : 7,
				opacity: isSelected ? 1.0 : 0.75
			}).addTo(this.selectedLayer);

			this.editLines.set(idx, line);

			// handles ONLY for selected segment (focus mode)
			if (!isSelected) return;

			const startLL = this.nodeLatLng(seg.fromNode);
			const endLL = this.nodeLatLng(seg.toNode);
			if (!startLL || !endLL) return;

			const mStart = L.marker(startLL, { draggable: true })
				.bindTooltip(`Start (seg ${idx + 1})`, { sticky: true })
				.addTo(this.editLayer);

			const mEnd = L.marker(endLL, { draggable: true })
				.bindTooltip(`End (seg ${idx + 1})`, { sticky: true })
				.addTo(this.editLayer);

			mStart.on("drag", (ev) => this.previewDrag(idx, "start", ev.latlng));
			mEnd.on("drag", (ev) => this.previewDrag(idx, "end", ev.latlng));

			mStart.on("dragend", (ev) => this.commitDrag(idx, "start", ev.target.getLatLng()));
			mEnd.on("dragend", (ev) => this.commitDrag(idx, "end", ev.target.getLatLng()));

			this.editMarkers.set(`${idx}:start`, mStart);
			this.editMarkers.set(`${idx}:end`, mEnd);
		});
	}

	previewDrag(idx, which, latlng) {
		const seg = this.route[idx];
		if (!seg) return;

		const snappedNode = this.nearestNodeIdOnWay(latlng, seg.wayId);
		if (!snappedNode) return;

		const tmp = { ...seg };
		if (which === "start") tmp.fromNode = snappedNode;
		else tmp.toNode = snappedNode;

		const latlngs = this.sliceWayByNodes(tmp.wayId, tmp.fromNode, tmp.toNode);
		if (latlngs.length < 2) return;

		const line = this.editLines.get(idx);
		if (line) line.setLatLngs(latlngs);
	}

	commitDrag(idx, which, latlng) {
		const seg = this.route[idx];
		if (!seg) return;

		const snappedNode = this.nearestNodeIdOnWay(latlng, seg.wayId);
		if (!snappedNode) return;

		const updated = { ...seg };
		if (which === "start") updated.fromNode = snappedNode;
		else updated.toNode = snappedNode;

		if (updated.fromNode === updated.toNode) {
			this.emitStatus({ error: "Start et End ne peuvent pas être le même node." });
			return;
		}

		const n = this.nodesById.get(snappedNode);
		const key = `${idx}:${which}`;
		const marker = this.editMarkers.get(key);
		if (marker && n) marker.setLatLng([n.lat, n.lon]);

		this.dispatchEvent(new CustomEvent("segment-update", {
			detail: { index: idx, segment: updated },
			bubbles: true, composed: true
		}));
	}

	// ---------- Geometry helpers ----------
	nodeLatLng(nodeId) {
		const n = this.nodesById.get(nodeId);
		return n ? L.latLng(n.lat, n.lon) : null;
	}

	wayToLatLngs(wayId) {
		const ids = this.wayNodeIds.get(wayId);
		if (!ids) return [];
		const latlngs = [];
		for (const nid of ids) {
			const n = this.nodesById.get(nid);
			if (!n) continue;
			latlngs.push([n.lat, n.lon]);
		}
		return latlngs;
	}

	nearestNodeIdOnWay(latlng, wayId) {
		const ids = this.wayNodeIds.get(wayId);
		if (!ids) return null;

		let best = null;
		let bestD = Infinity;
		for (const nid of ids) {
			const n = this.nodesById.get(nid);
			if (!n) continue;
			const d = this.map.distance(latlng, L.latLng(n.lat, n.lon));
			if (d < bestD) { bestD = d; best = nid; }
		}
		return best;
	}

	sliceWayByNodes(wayId, fromNode, toNode) {
		const ids = this.wayNodeIds.get(wayId);
		if (!ids) return [];
		const a = ids.indexOf(fromNode);
		const b = ids.indexOf(toNode);
		if (a < 0 || b < 0) return [];

		const from = Math.min(a, b);
		const to = Math.max(a, b);

		const latlngs = [];
		for (const nid of ids.slice(from, to + 1)) {
			const n = this.nodesById.get(nid);
			if (!n) continue;
			latlngs.push([n.lat, n.lon]);
		}
		return latlngs;
	}

	pointToSegmentDistanceMeters(p, a, b) {
		const P = this.map.latLngToLayerPoint(p);
		const A = this.map.latLngToLayerPoint(a);
		const B = this.map.latLngToLayerPoint(b);

		const ABx = B.x - A.x, ABy = B.y - A.y;
		const APx = P.x - A.x, APy = P.y - A.y;
		const ab2 = ABx * ABx + ABy * ABy;

		let t = ab2 === 0 ? 0 : (APx * ABx + APy * ABy) / ab2;
		t = Math.max(0, Math.min(1, t));

		const Cx = A.x + t * ABx;
		const Cy = A.y + t * ABy;
		const C = this.map.layerPointToLatLng(L.point(Cx, Cy));
		return this.map.distance(p, C);
	}

	distanceToWayMeters(latlng, wayId) {
		const ids = this.wayNodeIds.get(wayId);
		if (!ids || ids.length < 2) return Infinity;

		const bb = this.wayBBox.get(wayId);
		if (bb) {
			const lat = latlng.lat, lon = latlng.lng;
			const buf = 0.0003;
			if (lat < bb.minLat - buf || lat > bb.maxLat + buf || lon < bb.minLon - buf || lon > bb.maxLon + buf) {
				return Infinity;
			}
		}

		let best = Infinity;
		for (let i = 0; i < ids.length - 1; i++) {
			const na = this.nodesById.get(ids[i]);
			const nb = this.nodesById.get(ids[i + 1]);
			if (!na || !nb) continue;

			const d = this.pointToSegmentDistanceMeters(
				latlng,
				L.latLng(na.lat, na.lon),
				L.latLng(nb.lat, nb.lon)
			);
			if (d < best) best = d;
		}
		return best;
	}

	// ---------- misc ----------
	clampBounds(bounds) {
		const s = bounds.getSouth(), n = bounds.getNorth(), w = bounds.getWest(), e = bounds.getEast();
		const latSpan = n - s;
		const lngSpan = e - w;
		if (latSpan <= this.MAX_SPAN_DEG && lngSpan <= this.MAX_SPAN_DEG) return bounds;

		const c = bounds.getCenter();
		const half = this.MAX_SPAN_DEG / 2;
		return L.latLngBounds([c.lat - half, c.lng - half], [c.lat + half, c.lng + half]);
	}

	bboxString(bounds) {
		return `${bounds.getSouth().toFixed(6)},${bounds.getWest().toFixed(6)},${bounds.getNorth().toFixed(6)},${bounds.getEast().toFixed(6)}`;
	}

	debounce(fn, ms) {
		let t;
		return (...args) => {
			clearTimeout(t);
			t = setTimeout(() => fn(...args), ms);
		};
	}

	emitStatus({ pickStatus, error }) {
		console.log("OSMMap status:", { pickStatus, error });
		this.dispatchEvent(new CustomEvent("status", {
			detail: { pickStatus, error },
			bubbles: true, composed: true
		}));
	}

	getWayTags(wayId) {
		return this.wayTags.get(Number(wayId)) || {};
	}

	segmentDistanceMeters(seg) {
		const latlngs = this.sliceWayByNodes(seg.wayId, seg.fromNode, seg.toNode);
		if (!latlngs || latlngs.length < 2) return 0;

		let sum = 0;
		for (let i = 0; i < latlngs.length - 1; i++) {
			sum += this.map.distance(latlngs[i], latlngs[i + 1]);
		}
		return sum;
	}

	invalidate() {
		if (!this.map) return;
		requestAnimationFrame(() => this.map.invalidateSize());
		setTimeout(() => this.map.invalidateSize(), 0);
	}
}

customElements.define("osm-map", OSMMap);
