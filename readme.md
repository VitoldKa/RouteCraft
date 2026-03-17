# Routecraft

![License: GPLv3](https://img.shields.io/badge/license-GPLv3-blue.svg)
![Status](https://img.shields.io/badge/status-active%20development-orange)
![OSM](https://img.shields.io/badge/data-OpenStreetMap-lightgrey)

**Operational transit route editor using OpenStreetMap data**, designed for planning, operations, and GIS workflows.

Routecraft enables defining **realistic service paths on the real network** — including depots, yards, service roads, terminal loops, and restricted-access infrastructure.

> ⚠️ **Not a passenger navigation app.**  
> Routecraft is for **operational path definition**, not turn-by-turn routing.

---

## 🚦 Motivation

Public transport operations often rely on infrastructure that standard navigation engines cannot use:

- depot access roads  
- service and maintenance roads  
- terminal loops  
- bus-only corridors  
- private access segments  
- trolleybus alignments  
- tram / rail rights-of-way  
- temporary detours and construction bypasses  

Traditional routing engines optimize for **legal access and traffic rules**.  
Routecraft instead focuses on **topology and operational reality**, allowing planners to work directly with the full OSM network.

---

## 🧠 Core Concept

A Routecraft route is a sequence of **OSM way segments**, defined by node pairs:

```json
[
  { "wayId": 123456, "fromNode": 111, "toNode": 222 },
  { "wayId": 789012, "fromNode": 222, "toNode": 333 }
]
````

This makes routes:

* reproducible
* lightweight
* easy to serialize
* reconstructable from OSM
* suitable for editing, auditing, and simulation

---

## ✨ Features

* 🗺 **OSM-based network graph**
* ✍️ **Manual route editing on OSM ways**
* 🎯 **Segment-level selection**

  * click → segment between intersections
  * ctrl-click → full way
* ⛓ **Continuity mode**

  * enforce shared nodes between segments
* 🚫 **Operational routing without access filtering**

  * works across service, depot, and private ways
* 💾 **Persistent caching (IndexedDB)**

  * ways
  * nodes
  * bbox → way index
* 📤 **JSON import/export**
* 🔍 **Viewer mode** (read-only)
* 🧩 **Framework-free Web Components**
* 🔌 **Modular architecture**

---

## 🚌 Use Cases

Routecraft is designed for:

* public transit agencies
* bus / tram / trolleybus / BRT operations
* detour engineering
* depot and yard access routing
* GIS network modeling
* demand-responsive transport (DRT)
* simulation and research
* mobility consulting

### Example scenarios

* define a **bus loop inside a depot**
* add a **layover on a private access road**
* model a **tram path along mixed right-of-way**
* create a **temporary detour**
* trace an **out-of-service route** between depot and terminal

---

## 🧱 Architecture

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

## 🗂 Project Structure

```
src/
├── osm-map.js        # map UI + interaction
├── osm-cache.js      # IndexedDB cache layer
├── route-editor.js   # editor logic + import/export
├── index.html        # full editor
└── view.html         # viewer mode
```

---

## 📦 Installation

Clone the repository:

```sh
git clone https://github.com/YOUR_ORG/routecraft.git
cd routecraft
```

Serve locally (required for IndexedDB):

```sh
npx serve .
# or
python -m http.server 8080
```

Open in browser:

```
http://localhost:8080/src/index.html
```

---

## 🐳 Build & Deployment

### Build (local machine)

```sh
docker build -t routecraft --output=type=docker .
docker buildx build --platform linux/amd64 -t routecraft --output=type=docker .

docker save routecraft -o dist/routecraft.tar
rsync -avz dist/routecraft.tar ubuntu@example.net:/home/ubuntu/routecraft/
```

### Deploy (server)

```sh
sudo docker compose stop
sudo docker compose rm
sudo docker image rm routecraft
sudo docker image rm routecraft:amd64

sudo docker load -i routecraft.tar
sudo docker compose up -d
```

---

## 🛰 Overpass API

Routecraft fetches:

* `highway=*` ways
* their nodes
* associated metadata

Example query:

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

### IndexedDB stores

| Cache      | Store  | Key               |
| ---------- | ------ | ----------------- |
| ways       | ways   | wayId             |
| nodes      | nodes  | nodeId            |
| bbox index | bboxes | z{zoom}_{s,w,n,e} |

### TTL

| Data       | TTL      |
| ---------- | -------- |
| ways/nodes | 7 days   |
| bbox index | 24 hours |

---

## 📤 Import / Export

### Export

Click **Export**:

```json
[
  { "wayId": 301772495, "fromNode": 2993269964, "toNode": 2993269970 }
]
```

### Import

Paste JSON → click **Import**
Missing geometry is automatically fetched and cached.

---

## ⚠️ Limitations

* no validation of legal access restrictions
* not intended for passenger navigation
* depends on Overpass API availability
* large queries may timeout
* relies on OSM topology quality

---

## 🛣 Roadmap

* GTFS integration
* depot / yard modeling tools
* tram & rail enhancements
* topology validation
* offline mode
* richer metadata
* detour/version management
* simulation exports

---

## 📜 License

* Map data © OpenStreetMap contributors (ODbL)
* Code licensed under **GPLv3**

See `LICENSE` for details.

---

## 🤝 Contributing

Contributions are welcome.

Areas of interest:

* transit data integration (GTFS)
* OSM tagging workflows
* depot/yard modeling
* rail & tram support
* UI/UX improvements
* caching & performance
* offline capabilities

Open an issue or PR to get started.

---

## ⭐ Acknowledgements

* OpenStreetMap contributors
* Overpass API
* Leaflet.js ecosystem

---
