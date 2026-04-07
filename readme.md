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
```

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
* 💾 **Persistent caching (IndexedDB)**
* 📤 **JSON import/export**
* 🔍 **Viewer mode**
* 🧩 **Framework-free Web Components**
* 🔌 **Modular architecture**

---

## 🚌 Use Cases

Routecraft is designed for:

- public transit agencies
- bus / tram / trolleybus / BRT operations
- depot and yard routing
- detour engineering
- GIS network modeling
- demand-responsive transport (DRT)
- simulation and research
- mobility consulting

---

### Example scenarios

- define a **bus loop inside a depot**
- route a vehicle through a **private access road**
- model a **tram alignment on mixed infrastructure**
- create a **temporary detour due to construction**
- trace an **out-of-service route** (depot → terminal)
- design a **turnaround loop at a terminus**
- simulate **non-public infrastructure usage**

---

## 🧱 Architecture

```
           ┌───────────────────────┐
           │     Routecraft UI     │
           │  (Web Components)     │
           └────────────┬──────────┘
                        │
                        ↓
             ┌────────────────────┐
             │   OSM Map Engine   │
             │    (Leaflet.js)    │
             └─────────┬──────────┘
                       │
                       ↓
      ┌─────────────────────────────────┐
      │   Static Spatial Cache (JSON)   │
      │  bbox-index + content-tiles     │
      └─────────────────────────────────┘
                       │
                       ↓
      ┌─────────────────────────────────┐
      │ IndexedDB (ways, nodes, bboxes) │
      └─────────────────────────────────┘
```

---

## ⚙️ C++ Pipeline (OSM → Spatial Cache)

```
        ┌──────────────────────────────┐
        │   planet.osm.pbf / region    │
        └────────────┬─────────────────┘
                     │
                     ▼
      ┌──────────────────────────────┐
      │ phase1_spatial_index (C++)   │
      │ - filter highways/rail       │
      │ - build bbox index           │
      │ - assign ways → tiles        │
      └────────────┬─────────────────┘
                   │
                   ▼
      ┌──────────────────────────────┐
      │ intermediate (NDJSON / tmp)  │
      └────────────┬─────────────────┘
                   │
                   ▼
      ┌──────────────────────────────┐
      │ phase2_spatial_compact (C++) │
      │ - group tiles                │
      │ - pack ways + nodes          │
      │ - deduplicate nodes          │
      └────────────┬─────────────────┘
                   │
                   ▼
      ┌────────────────────────────────────────┐
      │ spatial_cache/                         │
      │ ├── bbox-index/                        │
      │ └── content-tiles/                     │
      └────────────────────────────────────────┘
```

---

## 🛰 Data Source

Routecraft uses **preprocessed OpenStreetMap data**, built offline into a spatial cache.

Pipeline:

1. Download OSM data (`.osm.pbf`)
2. Process with C++ tools
3. Generate:

   * `bbox-index/` (bbox → way IDs + content tiles)
   * `content-tiles/` (ways + nodes)

👉 No runtime dependency on Overpass
👉 No external API calls
👉 Fully offline-capable

---

## ⚡ Performance

Routecraft is designed for **high-performance spatial interaction**:

* no runtime Overpass queries
* static JSON delivery (CDN-friendly)
* IndexedDB for instant access
* spatial tiling minimizes data transfer

Workflow:

1. first load → fetch tiles
2. subsequent loads → fully local

👉 near-zero latency after warm cache

---

## 💾 Caching

### 1. Static spatial cache

| Layer         | Description                 |
| ------------- | --------------------------- |
| bbox-index    | maps bbox → way IDs + tiles |
| content-tiles | contains full ways + nodes  |

---

### 2. Browser HTTP cache

* long-lived (immutable)
* avoids re-downloading JSON

---

### 3. IndexedDB

| Store  | Key    | Content               |
| ------ | ------ | --------------------- |
| ways   | wayId  | nodes + tags          |
| nodes  | nodeId | lat/lon               |
| bboxes | key    | wayIds + contentTiles |

---

## 🗂 Project Structure

```
src/
├── osm-map.js
├── osm-cache.js
├── route-editor.js
├── index.html
└── view.html

scripts/
├── phase1_spatial_index.cpp
├── phase2_spatial_compact.cpp

spatial_cache/
├── bbox-index/
└── content-tiles/
```

---

## 📦 Installation

```sh
git clone https://github.com/VitoldKa/RouteCraft
cd routecraft
npx serve .
```

Open:

```
http://localhost:8080/src/index.html
```

---

## 🐳 Build & Deployment

### Data

```sh
https://planet.openstreetmap.org/planet/planet-latest.osm.bz2
osmium cat planet-latest.osm.bz2 -o planet.osm.pbf
```

or:

```sh
https://download.geofabrik.de/europe/switzerland-latest.osm.pbf
```

---

### Build C++

```sh
g++ -O3 -std=c++17 scripts/phase1_spatial_index.cpp \
  -I$(brew --prefix libosmium)/include \
  -I$(brew --prefix protozero)/include \
  -I$(brew --prefix expat)/include \
  -L$(brew --prefix bzip2)/lib \
  -L$(brew --prefix zlib)/lib \
  -L$(brew --prefix expat)/lib \
  -lbz2 -lz -lexpat \
  -o dist/phase1_spatial_index

g++ -O3 -std=c++17 scripts/phase2_spatial_compact.cpp \
  -o dist/phase2_spatial_compact
```

---

### Run pipeline

```sh
dist/phase1_spatial_index data/switzerland.osm.pbf
dist/phase2_spatial_compact
```

---

### Docker

```sh
docker build -t routecraft --output=type=docker .
or
docker buildx build --platform linux/amd64 -t routecraft --output=type=docker .

docker save routecraft -o dist/routecraft.tar
rsync -avz dist/routecraft.tar ubuntu@example.net:/home/ubuntu/routecraft/
```

Deploy:

```sh
sudo docker compose stop
sudo docker compose rm
sudo docker image rm routecraft
sudo docker image rm routecraft:amd64

sudo docker load -i routecraft.tar
sudo docker compose up -d
```

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

* paste JSON → click **Import**

---

## ⚠️ Limitations

* no legal access validation
* depends on OSM data quality
* large datasets require preprocessing

---

## 🛣 Roadmap

* GTFS integration
* depot / yard modeling
* tram & rail enhancements
* topology validation
* offline-first improvements
* simulation exports

---

## 📜 License

* Map data © OpenStreetMap contributors (ODbL)
* Code licensed under **GPLv3**

---

## 🤝 Contributing

Contributions welcome:

* transit data integration
* performance optimization
* UI/UX
* spatial indexing
* offline capabilities
* delta update of spacial data

---

## ⭐ Acknowledgements

* OpenStreetMap contributors
* libosmium
* Leaflet.js

---
