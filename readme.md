# Routecraft

**Operational transit route editor using OpenStreetMap data**, designed for planning and engineering workflows in public transport.

> **Not a passenger navigation app.** Routecraft is built for transit planners, operations teams and GIS engineers needing to define realistic service paths on the real network, including depots, yards, service roads and restricted access sections.

---

## 🚦 Motivation

Public transit often requires routing over infrastructure that is *not* available to standard navigation engines:

- access-only depot roads
- service roads & maintenance tracks
- parking/HOV/TOD areas
- terminal loops
- bus-only corridors
- trolleybus wire alignments
- tram/rail rights-of-way
- temporary detours and construction bypasses

Traditional routing engines reject these paths due to legal or traffic restrictions.  
Routecraft focuses on **topology** rather than **traffic legality**, enabling **unrestricted operational routing**.

---

## ✨ Features

- 🗺 **OSM-based network graph**
- 🎯 **Manual routing on ways** (hover → segment)
- ⛓ **Continuity mode** (force shared nodes between segments)
- ↕️ **Unrestricted routing** across private/service/depot ways
- ✍️ **Segment selection**
  - click = segment between intersections
  - ctrl-click = full way
- 💾 **Persistent caching (IndexedDB)**
  - ways
  - nodes
  - bbox -> wayIds index
- 📤 **JSON import/export**
- 🔍 **Viewer mode** (static route display)
- 🔧 **Web components** (no framework required)
- 🧩 **Modular architecture** for integration

---

## 🚌 Use cases

Routecraft is useful for:

- Public transit agencies (bus, tram, trolley, BRT)
- Service planning / replanning
- Detour engineering (accidents, construction)
- Depot & yard access routing
- GIS network modeling
- On-demand transit design (DRT)
- Simulation & research
- Urban mobility consulting

Example scenarios:

- Define a **bus loop inside a depot**
- Add a **layover segment on a private access road**
- Model a **tram run along a mixed right-of-way**
- Define a **temporary detour around construction**
- Trace the **out-of-service path** between depot and terminal

---

## 🧱 Architecture (high-level)

```
           ┌───────────────────────┐
           │     Routecraft UI     │
           │  (Web Components)     │
           └────────────┬──────────┘
                        │
        hover/select    │   draw
                        ↓
             ┌────────────────────┐
             │   OSM Map Engine   │
             │    (Leaflet.js)    │
             └─────────┬──────────┘
                       │
              query    │   ingest
                       ↓
      ┌─────────────────────────────────┐
      │    Overpass API (OSM network)   │
      └─────────────────────────────────┘
                       │
            cache      │   persist
                       ↓
      ┌─────────────────────────────────┐
      │ IndexedDB (ways, nodes, bboxes) │
      └─────────────────────────────────┘
```

---

## 🗂 Data model

Routecraft represents a route as **segments of OSM ways**:

```json
[
  { "wayId": 123456, "fromNode": 111, "toNode": 222 },
  { "wayId": 789012, "fromNode": 222, "toNode": 333 }
]
```

Where:

* `wayId` = OSM way identifier
* `fromNode` / `toNode` = OSM node identifiers defining the segment

This allows reconstructing geometry from OSM on demand.

---

## 🧩 Components (technical)

* `osm-map.js` → map UI + selection
* `osm-cache.js` → IndexedDB persistent cache
* `route-editor.js` → JSON import/export + UI glue
* `view.html` → viewer-only mode
* `index.html` → full editor UI

No framework required — pure Web Components.

---

## 📦 Installation & Dev

Clone:

```sh
git clone https://github.com/YOUR_ORG/routecraft.git
cd routecraft
```

Serve statically (IndexedDB requires http://):

```sh
npx serve .
# or
python -m http.server 8080
```

Open:

```
http://localhost:8080/src/index.html
```

---

## 🛰 Overpass API

Routecraft uses Overpass to fetch:

* `highway=*` ways
* their nodes
* metadata (tags)

Minimal example query:

```overpass
[out:json][timeout:90];
(
  way["highway"](bbox);
);
out body;
>;
out skel qt;
```

---

## 💾 Caching

To avoid repeated Overpass queries:

| Cache      | IndexedDB store | Key                 |
| ---------- | --------------- | ------------------- |
| ways       | `ways`          | wayId               |
| nodes      | `nodes`         | nodeId              |
| bbox index | `bboxes`        | `z{zoom}_{s,w,n,e}` |

TTL defaults:

| Data       | TTL      |
| ---------- | -------- |
| way / node | 7 days   |
| bbox index | 24 hours |

---

## 📤 Import / Export

### Export JSON

Press **Export** to retrieve route:

```json
[
  { "wayId": 301772495, "fromNode": 2993269964, "toNode": 2993269970 }
]
```

### Import JSON

Paste JSON and press **Import**, cache auto-hydrates.

---

## 🔒 Notes & Limitations

* Routecraft does **not** validate legal access tags
* Not intended for **passenger navigation**
* Requires Overpass availability
* Large areas may hit Overpass timeouts (cache mitigates this)

---

## 📜 Licensing & Attribution

Map data © [OpenStreetMap](https://www.openstreetmap.org/) contributors, licensed under ODbL.

Routecraft source code is licensed under **GPLv3** (unless specified otherwise).
See the LICENSE file for details.

---

## 🤝 Contributing

Contributions welcome!

Useful areas:

* transit data integration (GTFS)
* OSM tagging improvements
* depot/yard modeling
* rail & tram enhancements
* UI/UX improvements
* caching strategies
* offline routing

Feel free to open an issue or PR.
