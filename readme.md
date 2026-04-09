# Routecraft

![License: GPLv3](https://img.shields.io/badge/license-GPLv3-blue.svg)
![Status](https://img.shields.io/badge/status-active%20development-orange)
![OSM](https://img.shields.io/badge/data-OpenStreetMap-lightgrey)

**Operational transit route editor using OpenStreetMap data**, designed for planning, operations, and GIS workflows.

Routecraft enables defining **realistic service paths on the real network** — including depots, yards, service roads, terminal loops, and restricted-access infrastructure.

> ⚠️ **Not a passenger navigation app.**  
> Routecraft is for **operational path definition**, not turn-by-turn routing.

> ⚠️ **Requires preprocessing and containerized runtime.**  
> Routecraft depends on a prebuilt spatial cache and is intended to run from the project Docker image.  
> A lightweight **Rust runtime built with Actix Web** serves the UI and cache files.  
> Serving the repository directly with a generic static file server is not sufficient.

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
Routecraft instead focuses on **topology and operational reality**, allowing planners to work directly with the relevant OSM network.

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

- reproducible
- lightweight
- easy to serialize
- reconstructable from OSM
- suitable for editing, auditing, and simulation

---

## ✨ Features

- 🗺 **OSM-based network graph**
- ✍️ **Manual route editing on OSM ways**
- 🧰 **Floating map toolbox**
  - create mode
  - select mode
  - annotation mode
- 🎯 **Segment-level selection and smart picking**
  - click → segment between intersections
  - ctrl-click → full way
  - prefers the screen-space closest way at high zoom
- ⛓ **Continuity mode**
  - enforce shared nodes between segments
- 🎨 **Per-segment colors**
  - new segments inherit the current toolbox color
- ➡️ **Direction arrows on route segments**
- 📝 **Text annotations**
  - draggable on the map
  - inline text editing by double-click
  - shared color tool and font-size control
- 🛰 **Map / satellite basemap toggle**
- 🚫 **Operational routing without access filtering**
- 💾 **Persistent caching (IndexedDB)**
- 📤 **JSON import/export**
- 🔍 **Viewer mode**
- 🧩 **Framework-free Web Components**
- 🔌 **Modular architecture**

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

```text
           ┌───────────────────────┐
           │     Routecraft UI     │
           │  (Web Components)     │
           └────────────┬──────────┘
                        │
                        ▼
           ┌───────────────────────┐
           │  Actix Web runtime    │
           │                       │
           └────────────┬──────────┘
                        │
        ┌───────────────┼────────────────┐
        ▼                                ▼
┌──────────────────────┐      ┌──────────────────────┐
│ spatial_cache/       │      │ static app files     │
│ bbox-index/          │      │ src/                 │
│ content-tiles/       │      │ assets               │
└──────────────────────┘      └──────────────────────┘
```

### Runtime model

Routecraft is primarily a **client-side route editor** operating on preprocessed OpenStreetMap cache data.

At runtime, a lightweight **Rust service built with Actix Web** serves the application and cache files through two routes. Rust is used here mainly because it has a **very small memory footprint**, which keeps the container runtime lean.

---

## ⚙️ Build Overview

Routecraft is built in two stages:

1. **Preprocessing stage**  
   Raw OSM data is transformed into a static spatial cache.

2. **Runtime stage**  
   A Docker image serves the UI and cache files through a lightweight Rust service built with Actix Web.

---

## ⚙️ Preprocessing Pipeline (OSM → Spatial Cache)

```text
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

Routecraft uses **preprocessed OpenStreetMap data**, generated offline before runtime.

Pipeline:

1. Download OSM data (`.osm.pbf`)
2. Process it with the preprocessing tools
3. Generate:
   - `bbox-index/` (bbox → way IDs + content tiles)
   - `content-tiles/` (ways + nodes)

### Design goals

- no runtime dependency on Overpass API
- no external routing API calls
- offline-capable deployment once data has been prepared

---

## ⚡ Performance

Routecraft is designed for **fast spatial interaction on preprocessed network data**:

- no runtime Overpass queries
- static cache delivery
- IndexedDB for repeated access
- spatial tiling to minimize transfer and lookup cost

This shifts computational cost to the preprocessing stage so runtime editing stays responsive.

Typical workflow:

1. first load → fetch relevant cache tiles
2. subsequent loads → reuse browser-side cached data

👉 near-zero latency after the cache is warm

The map editor itself is centered around direct visual editing:

- hover and click to pick routable ways
- draw colored segments
- select existing segments from the panel or directly on the map
- switch between map and satellite imagery while editing
- add operational notes as on-map annotations

---

## 💾 Caching

### 1. Static spatial cache

| Layer         | Description                 |
| ------------- | --------------------------- |
| bbox-index    | maps bbox → way IDs + tiles |
| content-tiles | contains full ways + nodes  |

### 2. Browser HTTP cache

- long-lived
- avoids re-downloading static JSON

### 3. IndexedDB

| Store  | Key    | Content               |
| ------ | ------ | --------------------- |
| ways   | wayId  | nodes + tags          |
| nodes  | nodeId | lat/lon               |
| bboxes | key    | wayIds + contentTiles |

---

## 🗂 Project Structure

```text
backend/
├── src/main.rs
├── Cargo.toml
└── static/

frontend/
└── src/components/
    ├── osm-map.js
    ├── osm-cache.js
    ├── osm-route-editor.js
    ├── route-panel.js
    ├── map-toolbox.js
    ├── map-annotation-layer.js
    ├── map-annotation-editor.js
    └── json-editor.js

tools/
├── CMakeLists.txt
├── phase1_spatial_index.cpp
├── phase2_spatial_compact.cpp
├── count_osm.cpp
└── spatial_cache_metadata.hpp

spatial_cache/
├── bbox-index/
└── content-tiles/

tmp_spatial/
├── bbox_index/
└── content_tiles/
```

---

## 📦 Build and Run

Routecraft does **not** run directly from the source tree with a generic static file server.

Before running Routecraft, you must:

1. download OSM source data
2. preprocess the spatial cache
3. build the Docker image
4. run the container

---

## 🐳 Build & Deployment

### 1. Fetch OSM data

Example sources:

```sh
wget https://download.geofabrik.de/europe/switzerland-latest.osm.pbf
```

or:

```sh
wget https://download.geofabrik.de/europe-latest.osm.pbf
```

For full-planet processing:

```sh
wget https://planet.openstreetmap.org/planet/planet-latest.osm.bz2
```

---

### 2. Filter tags to keep

```sh
osmium cat planet-latest.osm.bz2 -o planet-latest.osm.pbf

osmium tags-filter planet-latest.osm.pbf \
  w/highway=motorway_link,trunk_link,primary_link,secondary_link,tertiary_link,pedestrian,residential,living_street,tertiary,secondary,primary,unclassified,service,path,track \
  w/railway=tram,light_rail \
  w/busway \
  w/lanes:bus \
  w/bus=yes,designated \
  -o europe_transport.osm.pbf
```

or with Docker:

```sh
docker run --rm -v "$PWD:/data" iboates/osmium \
  tags-filter /data/area.osm.pbf \
  w/highway=motorway_link,trunk_link,primary_link,secondary_link,tertiary_link,pedestrian,residential,living_street,tertiary,secondary,primary,unclassified,service,path,track \
  w/railway=tram,light_rail \
  w/busway \
  w/lanes:bus \
  w/bus=yes,designated \
  -o /data/prefiltered.osm.pbf
```

---

### 3. Build the spatial cache

```sh
cmake -S tools -B tools/build
cmake --build tools/build -j

./tools/build/phase1_spatial_index data/input.osm.pbf --out-dir tmp_spatial

./tools/build/phase2_spatial_compact --in-dir tmp_spatial --out-dir spatial_cache
```

This produces:

- `tmp_spatial/` for the intermediate sharded phase-1 output
- `spatial_cache/` for the final runtime cache
- `phase1_config.json` and `phase2_config.json` metadata files describing the build inputs and parameters

or with Docker:

```sh
docker build -t spatial-pipeline tools

docker run --rm -v "$PWD:/data" spatial-pipeline \
  ./build/phase1_spatial_index /data/input.osm.pbf --out-dir /data/tmp_spatial

docker run --rm -v "$PWD:/data" spatial-pipeline \
  ./build/phase2_spatial_compact --in-dir /data/tmp_spatial --out-dir /data/spatial_cache
```

---

### 4. Build the Routecraft image

```sh
docker build -t routecraft --output=type=docker .
```

or:

```sh
docker buildx build --platform linux/amd64 -t routecraft --output=type=docker .
```

---

### 5. Export and deploy

```sh
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

## 🔧 Build C++ Tools

```sh
cmake -S tools -B tools/build
cmake --build tools/build -j
```

### Run pipeline

```sh
./tools/build/phase1_spatial_index data/switzerland.osm.pbf --out-dir tmp_spatial
./tools/build/phase2_spatial_compact --in-dir tmp_spatial --out-dir spatial_cache
```

---

## 📤 Import / Export

### Export

Click **Export**:

```json
{
  "route": [
    {
      "wayId": 301772495,
      "fromNode": 2993269964,
      "toNode": 2993269970,
      "color": "#0060DD"
    }
  ],
  "annotations": [
    {
      "id": "ann-1",
      "text": "Depot exit",
      "lat": 46.201,
      "lon": 6.147,
      "color": "#0060DD",
      "fontSize": 14
    }
  ]
}
```

### Import

- supported shapes:
  - `[...]` for route-only imports
  - `{ "route": [...] }`
  - `{ "route": [...], "annotations": [...] }`
  - `{ "annotations": [...] }`
- segment colors are preserved
- annotations preserve text, position, color, and font size

---

## ⚠️ Limitations

- no legal access validation
- depends on OSM data quality
- large datasets require preprocessing
- preprocessing is required before runtime
- not intended for passenger routing or navigation

---

## 🛣 Roadmap

- GTFS integration
- depot / yard modeling
- tram & rail enhancements
- topology validation
- offline-first improvements
- simulation exports

---

## 🤝 Contributing

Contributions welcome in:

- transit data integration
- performance optimization
- UI/UX
- spatial indexing
- offline capabilities
- delta updates for spatial data

---

## 📜 License

- Map data © OpenStreetMap contributors (ODbL)
- Code licensed under **GPLv3**

---

## ⭐ Acknowledgements

- OpenStreetMap contributors
- libosmium
- Leaflet.js
- Actix Web
