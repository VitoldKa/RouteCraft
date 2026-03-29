/*
MACOSX:
    g++ -O3 -std=c++17 phase1_spatial_index_mt.cpp \
    -I$(brew --prefix libosmium)/include \
    -I$(brew --prefix protozero)/include \
    -I$(brew --prefix expat)/include \
    -L$(brew --prefix bzip2)/lib \
    -L$(brew --prefix zlib)/lib \
    -L$(brew --prefix expat)/lib \
    -lbz2 -lz -lexpat \
    -pthread \
    -o phase1_spatial_index_mt

WINDOWS (MSYS2):
    g++ -O3 -std=c++17 phase1_spatial_index_mt.cpp -pthread -o phase1_spatial_index_mt
*/

#include <algorithm>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include <osmium/handler.hpp>
#include <osmium/handler/node_locations_for_ways.hpp>
#include <osmium/index/map/sparse_mem_array.hpp>
#include <osmium/io/any_input.hpp>
#include <osmium/tags/taglist.hpp>
#include <osmium/visitor.hpp>

namespace fs = std::filesystem;

struct Config
{
    std::string input_file;
    std::string out_dir = "tmp_spatial";
    double bbox_size = 0.01;
    double tile_size = 0.05;
    int precision = 5;
    std::size_t flush_every = 20000;
    std::size_t worker_threads = 0;     // 0 => auto
    std::size_t queue_capacity = 20000; // borné pour ne pas exploser la RAM
};

static bool value_in_list(const char *v, std::initializer_list<const char *> allowed)
{
    if (!v)
        return false;
    for (const char *a : allowed)
    {
        if (std::string_view(v) == a)
            return true;
    }
    return false;
}

static bool is_target_way(const osmium::Way &way)
{
    const char *highway = way.tags().get_value_by_key("highway");
    if (value_in_list(highway, {
                                   "pedestrian",
                                   "residential",
                                   "living_street",
                                   "tertiary",
                                   "secondary",
                                   "primary",
                                   "unclassified",
                                   "service",
                                   "path",
                                   "track",
                               }))
    {
        return true;
    }

    if (highway && way.tags().has_key("busway"))
    {
        return true;
    }

    const char *bus = way.tags().get_value_by_key("bus");
    if (highway && value_in_list(bus, {"yes", "designated"}))
    {
        return true;
    }

    if (highway && way.tags().has_key("lanes:bus"))
    {
        return true;
    }

    const char *railway = way.tags().get_value_by_key("railway");
    if (value_in_list(railway, {"tram", "light_rail"}))
    {
        return true;
    }

    return false;
}

static std::string json_escape(std::string_view s)
{
    std::string out;
    out.reserve(s.size() + 8);
    for (unsigned char c : s)
    {
        switch (c)
        {
        case '\"':
            out += "\\\"";
            break;
        case '\\':
            out += "\\\\";
            break;
        case '\b':
            out += "\\b";
            break;
        case '\f':
            out += "\\f";
            break;
        case '\n':
            out += "\\n";
            break;
        case '\r':
            out += "\\r";
            break;
        case '\t':
            out += "\\t";
            break;
        default:
            if (c < 0x20)
            {
                char buf[7];
                std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                out += buf;
            }
            else
            {
                out.push_back(static_cast<char>(c));
            }
        }
    }
    return out;
}

static std::string fmt(double v, int precision)
{
    std::ostringstream oss;
    oss.setf(std::ios::fixed);
    oss.precision(precision);
    oss << v;
    return oss.str();
}

struct GridCoord
{
    long yi = 0;
    long xi = 0;

    bool operator==(const GridCoord &other) const noexcept
    {
        return yi == other.yi && xi == other.xi;
    }

    bool operator<(const GridCoord &other) const noexcept
    {
        if (yi != other.yi)
            return yi < other.yi;
        return xi < other.xi;
    }
};

struct GridCoordHash
{
    std::size_t operator()(const GridCoord &t) const noexcept
    {
        const std::uint64_t a = static_cast<std::uint64_t>(static_cast<std::int64_t>(t.yi));
        const std::uint64_t b = static_cast<std::uint64_t>(static_cast<std::int64_t>(t.xi));
        std::uint64_t x = a * 0x9E3779B185EBCA87ULL;
        x ^= b + 0xC2B2AE3D27D4EB4FULL + (x << 6) + (x >> 2);
        return static_cast<std::size_t>(x);
    }
};

static GridCoord coord_from_latlon(double lat, double lon, double size)
{
    return GridCoord{
        static_cast<long>(std::floor(lat / size)),
        static_cast<long>(std::floor(lon / size))};
}

static std::string file_id(long yi, long xi)
{
    return std::to_string(yi) + "_" + std::to_string(xi);
}

static std::uint64_t deterministic_mix(long yi, long xi)
{
    std::uint64_t a = static_cast<std::uint64_t>(static_cast<std::int64_t>(yi));
    std::uint64_t b = static_cast<std::uint64_t>(static_cast<std::int64_t>(xi));

    std::uint64_t x = a * 0x9E3779B185EBCA87ULL;
    x ^= b + 0xC2B2AE3D27D4EB4FULL + (x << 6) + (x >> 2);
    x ^= (x >> 33);
    x *= 0xff51afd7ed558ccdULL;
    x ^= (x >> 33);
    x *= 0xc4ceb9fe1a85ec53ULL;
    x ^= (x >> 33);
    return x;
}

static fs::path deterministic_sharded_path(
    const fs::path &root,
    long yi,
    long xi,
    const std::string &suffix)
{
    const std::uint64_t h = deterministic_mix(yi, xi);
    const unsigned shard1 = static_cast<unsigned>((h >> 8) & 0xFF);
    const unsigned shard2 = static_cast<unsigned>(h & 0xFF);

    return root / std::to_string(shard1) / std::to_string(shard2) /
           (file_id(yi, xi) + suffix);
}

struct NodeCoord
{
    std::uint64_t id = 0;
    std::int32_t lat_e7 = 0;
    std::int32_t lon_e7 = 0;
};

struct TagKV
{
    std::string key;
    std::string value;
};

struct WorkItem
{
    std::uint64_t seq = 0;
    std::uint64_t way_id = 0;
    std::vector<std::uint64_t> node_ids;
    std::vector<NodeCoord> valid_nodes;
    std::vector<TagKV> tags;
    double min_lat = 0.0;
    double max_lat = 0.0;
    double min_lon = 0.0;
    double max_lon = 0.0;
};

struct WorkerResult
{
    std::uint64_t seq = 0;
    GridCoord owner_tile;
    std::string way_line;
    std::string nodes_blob;
    std::string ref_line;
    std::vector<GridCoord> bbox_refs;
};

template <typename T>
class BlockingQueue
{
public:
    explicit BlockingQueue(std::size_t capacity) : capacity_(capacity) {}

    bool push(T value)
    {
        std::unique_lock<std::mutex> lock(mutex_);
        cv_not_full_.wait(lock, [&]
                          { return closed_ || queue_.size() < capacity_; });
        if (closed_)
            return false;
        queue_.push_back(std::move(value));
        cv_not_empty_.notify_one();
        return true;
    }

    bool pop(T &out)
    {
        std::unique_lock<std::mutex> lock(mutex_);
        cv_not_empty_.wait(lock, [&]
                           { return closed_ || !queue_.empty(); });
        if (queue_.empty())
            return false;
        out = std::move(queue_.front());
        queue_.pop_front();
        cv_not_full_.notify_one();
        return true;
    }

    void close()
    {
        std::lock_guard<std::mutex> lock(mutex_);
        closed_ = true;
        cv_not_empty_.notify_all();
        cv_not_full_.notify_all();
    }

private:
    std::size_t capacity_;
    std::deque<T> queue_;
    bool closed_ = false;
    std::mutex mutex_;
    std::condition_variable cv_not_empty_;
    std::condition_variable cv_not_full_;
};

static std::string serialize_way_json(
    std::int64_t way_id,
    const std::vector<std::uint64_t> &node_ids,
    const std::vector<TagKV> &tags)
{
    std::string s;
    s.reserve(256 + node_ids.size() * 12);

    s += "{\"id\":";
    s += std::to_string(way_id);
    s += ",\"nodes\":[";

    for (std::size_t i = 0; i < node_ids.size(); ++i)
    {
        if (i)
            s += ",";
        s += std::to_string(node_ids[i]);
    }

    s += "],\"tags\":{";
    bool first = true;
    for (const auto &tag : tags)
    {
        if (!first)
            s += ",";
        first = false;
        s += "\"";
        s += json_escape(tag.key);
        s += "\":\"";
        s += json_escape(tag.value);
        s += "\"";
    }
    s += "}}\n";
    return s;
}

static std::string serialize_nodes_blob(const std::vector<NodeCoord> &nodes, int precision)
{
    std::string s;
    s.reserve(nodes.size() * 64);

    for (const auto &n : nodes)
    {
        s += "{\"id\":";
        s += std::to_string(n.id);
        s += ",\"lat\":";
        s += std::to_string(n.lat_e7);
        s += ",\"lon\":";
        s += std::to_string(n.lon_e7);
        s += "}\n";
    }

    return s;
}

static std::string serialize_bbox_ref_json(std::uint64_t way_id, long content_yi, long content_xi)
{
    std::string s;
    s.reserve(96);
    s += "{\"wayId\":";
    s += std::to_string(way_id);
    s += ",\"contentTile\":{\"yi\":";
    s += std::to_string(content_yi);
    s += ",\"xi\":";
    s += std::to_string(content_xi);
    s += "}}\n";
    return s;
}

struct BlobPair
{
    std::string a;
    std::string b;
};

class NullWriter
{
public:
    explicit NullWriter(std::string /*out_dir*/) {}

    void add_bbox_ref(long, long, const std::string &ref_line)
    {
        bytes_refs += ref_line.size();
    }

    void add_content_way_and_nodes(
        long,
        long,
        const std::string &way_line,
        const std::string &nodes_blob)
    {
        bytes_ways += way_line.size();
        bytes_nodes += nodes_blob.size();
    }

    void flush() {}

    ~NullWriter()
    {
        std::cerr << "NullWriter stats:\n";
        std::cerr << "  ways bytes:  " << bytes_ways << "\n";
        std::cerr << "  nodes bytes: " << bytes_nodes << "\n";
        std::cerr << "  refs bytes:  " << bytes_refs << "\n";
    }

private:
    std::uint64_t bytes_ways = 0;
    std::uint64_t bytes_nodes = 0;
    std::uint64_t bytes_refs = 0;
};

class BufferedAppender
{
public:
    explicit BufferedAppender(std::string out_dir)
        : out_dir_(std::move(out_dir))
    {
        fs::create_directories(fs::path(out_dir_) / "bbox_index");
        fs::create_directories(fs::path(out_dir_) / "content_tiles");
    }

    void add_bbox_ref(long bbox_yi, long bbox_xi, const std::string &ref_line)
    {
        auto &buf = bbox_buffers_[GridCoord{bbox_yi, bbox_xi}];
        buf.a += ref_line;
    }

    void add_content_way_and_nodes(
        long tile_yi,
        long tile_xi,
        const std::string &way_line,
        const std::string &nodes_blob)
    {
        auto &buf = tile_buffers_[GridCoord{tile_yi, tile_xi}];
        buf.a += way_line;
        buf.b += nodes_blob;
    }

    void flush()
    {
        flush_bbox_refs();
        flush_content_tiles();
    }

    ~BufferedAppender()
    {
        try
        {
            flush();
        }
        catch (...)
        {
        }
    }

private:
    void ensure_parent_dir(const fs::path &p)
    {
        const std::string dir = p.parent_path().string();
        if (created_dirs_.find(dir) == created_dirs_.end())
        {
            fs::create_directories(p.parent_path());
            created_dirs_.insert(dir);
        }
    }

    void flush_bbox_refs()
    {
        const fs::path root = fs::path(out_dir_) / "bbox_index";

        for (auto &kv : bbox_buffers_)
        {
            const GridCoord &key = kv.first;
            BlobPair &buf = kv.second;

            const fs::path path = deterministic_sharded_path(root, key.yi, key.xi, ".refs.ndjson");
            ensure_parent_dir(path);

            std::ofstream out(path, std::ios::binary | std::ios::app);
            if (!out)
                throw std::runtime_error("Impossible d'ouvrir " + path.string());

            out.write(buf.a.data(), static_cast<std::streamsize>(buf.a.size()));
        }

        bbox_buffers_.clear();
    }

    void flush_content_tiles()
    {
        const fs::path root = fs::path(out_dir_) / "content_tiles";

        for (auto &kv : tile_buffers_)
        {
            const GridCoord &key = kv.first;
            BlobPair &buf = kv.second;

            const fs::path ways_path = deterministic_sharded_path(root, key.yi, key.xi, ".ways.ndjson");
            const fs::path nodes_path = deterministic_sharded_path(root, key.yi, key.xi, ".nodes.ndjson");

            ensure_parent_dir(ways_path);
            ensure_parent_dir(nodes_path);

            {
                std::ofstream out(ways_path, std::ios::binary | std::ios::app);
                if (!out)
                    throw std::runtime_error("Impossible d'ouvrir " + ways_path.string());
                out.write(buf.a.data(), static_cast<std::streamsize>(buf.a.size()));
            }

            {
                std::ofstream out(nodes_path, std::ios::binary | std::ios::app);
                if (!out)
                    throw std::runtime_error("Impossible d'ouvrir " + nodes_path.string());
                out.write(buf.b.data(), static_cast<std::streamsize>(buf.b.size()));
            }
        }

        tile_buffers_.clear();
    }

    std::string out_dir_;
    std::unordered_map<GridCoord, BlobPair, GridCoordHash> bbox_buffers_;
    std::unordered_map<GridCoord, BlobPair, GridCoordHash> tile_buffers_;
    std::unordered_set<std::string> created_dirs_;
};

class ProducerHandler : public osmium::handler::Handler
{
public:
    ProducerHandler(
        BlockingQueue<WorkItem> &work_queue,
        std::atomic<std::uint64_t> &ways_seen,
        std::atomic<std::uint64_t> &ways_matched,
        std::atomic<std::uint64_t> &seq_counter)
        : work_queue_(work_queue),
          ways_seen_(ways_seen),
          ways_matched_(ways_matched),
          seq_counter_(seq_counter) {}

    void way(const osmium::Way &way)
    {
        ++ways_seen_;

        if (!is_target_way(way))
            return;

        WorkItem item;
        item.way_id = static_cast<std::uint64_t>(way.id());
        item.node_ids.reserve(way.nodes().size());
        item.valid_nodes.reserve(way.nodes().size());
        item.tags.reserve(way.tags().size());

        bool have_geom = false;

        for (const auto &tag : way.tags())
        {
            item.tags.push_back(TagKV{std::string(tag.key()), std::string(tag.value())});
        }

        for (const auto &nr : way.nodes())
        {
            item.node_ids.push_back(static_cast<std::uint64_t>(nr.ref()));

            const auto &loc = nr.location();
            if (!loc.valid())
                continue;

            const double lat = loc.lat();
            const double lon = loc.lon();

            if (!have_geom)
            {
                item.min_lat = item.max_lat = lat;
                item.min_lon = item.max_lon = lon;
                have_geom = true;
            }
            else
            {
                if (lat < item.min_lat)
                    item.min_lat = lat;
                if (lat > item.max_lat)
                    item.max_lat = lat;
                if (lon < item.min_lon)
                    item.min_lon = lon;
                if (lon > item.max_lon)
                    item.max_lon = lon;
            }

            item.valid_nodes.push_back(NodeCoord{
                static_cast<std::uint64_t>(nr.ref()),
                static_cast<std::int32_t>(std::llround(lat * 10000000.0)),
                static_cast<std::int32_t>(std::llround(lon * 10000000.0))});
        }

        if (!have_geom)
            return;

        item.seq = seq_counter_.fetch_add(1, std::memory_order_relaxed);
        ++ways_matched_;

        if (!work_queue_.push(std::move(item)))
        {
            throw std::runtime_error("Queue worker fermee pendant la production.");
        }
    }

private:
    BlockingQueue<WorkItem> &work_queue_;
    std::atomic<std::uint64_t> &ways_seen_;
    std::atomic<std::uint64_t> &ways_matched_;
    std::atomic<std::uint64_t> &seq_counter_;
};

static WorkerResult process_work_item(const Config &cfg, WorkItem &&item)
{
    WorkerResult out;
    out.seq = item.seq;

    const double center_lat = (item.min_lat + item.max_lat) * 0.5;
    const double center_lon = (item.min_lon + item.max_lon) * 0.5;
    out.owner_tile = coord_from_latlon(center_lat, center_lon, cfg.tile_size);

    out.way_line = serialize_way_json(
        static_cast<std::int64_t>(item.way_id),
        item.node_ids,
        item.tags);

    out.nodes_blob = serialize_nodes_blob(item.valid_nodes, cfg.precision);

    out.ref_line = serialize_bbox_ref_json(item.way_id, out.owner_tile.yi, out.owner_tile.xi);

    const long y0 = static_cast<long>(std::floor(item.min_lat / cfg.bbox_size));
    const long y1 = static_cast<long>(std::floor(item.max_lat / cfg.bbox_size));
    const long x0 = static_cast<long>(std::floor(item.min_lon / cfg.bbox_size));
    const long x1 = static_cast<long>(std::floor(item.max_lon / cfg.bbox_size));

    const std::size_t count =
        static_cast<std::size_t>(y1 - y0 + 1) *
        static_cast<std::size_t>(x1 - x0 + 1);

    out.bbox_refs.reserve(count);

    for (long yi = y0; yi <= y1; ++yi)
    {
        for (long xi = x0; xi <= x1; ++xi)
        {
            out.bbox_refs.push_back(GridCoord{yi, xi});
        }
    }

    return out;
}

static void worker_loop(
    const Config &cfg,
    BlockingQueue<WorkItem> &work_queue,
    BlockingQueue<WorkerResult> &result_queue)
{
    WorkItem item;
    while (work_queue.pop(item))
    {
        WorkerResult result = process_work_item(cfg, std::move(item));
        if (!result_queue.push(std::move(result)))
            return;
    }
}

static void writer_loop(
    const Config &cfg,
    BlockingQueue<WorkerResult> &result_queue,
    std::atomic<std::uint64_t> &total_bbox_refs_written)
{
    BufferedAppender writer(cfg.out_dir);
    // NullWriter writer(cfg.out_dir);

    std::unordered_map<std::uint64_t, WorkerResult> pending;
    std::uint64_t next_seq = 0;
    std::uint64_t written_results = 0;

    auto consume_ready = [&]()
    {
        for (;;)
        {
            auto it = pending.find(next_seq);
            if (it == pending.end())
                break;

            WorkerResult &r = it->second;

            writer.add_content_way_and_nodes(
                r.owner_tile.yi,
                r.owner_tile.xi,
                r.way_line,
                r.nodes_blob);

            for (const auto &bbox : r.bbox_refs)
            {
                writer.add_bbox_ref(bbox.yi, bbox.xi, r.ref_line);
            }

            total_bbox_refs_written.fetch_add(
                static_cast<std::uint64_t>(r.bbox_refs.size()),
                std::memory_order_relaxed);

            ++written_results;
            ++next_seq;
            pending.erase(it);

            if (written_results % cfg.flush_every == 0)
            {
                writer.flush();
                const auto refs = total_bbox_refs_written.load(std::memory_order_relaxed);
                std::cerr << "ways ecrits: " << written_results
                          << ", moyenne bbox/way: "
                          << (written_results
                                  ? static_cast<double>(refs) / static_cast<double>(written_results)
                                  : 0.0)
                          << "\n";
            }
        }
    };

    WorkerResult item;
    while (result_queue.pop(item))
    {
        pending.emplace(item.seq, std::move(item));
        consume_ready();
    }

    consume_ready();
    writer.flush();
}

static Config parse_args(int argc, char **argv)
{
    if (argc < 2)
    {
        throw std::runtime_error(
            "Usage: phase1_spatial_index_mt <input.osm.pbf|input.osm.bz2> "
            "[--out-dir DIR] [--bbox-size 0.01] [--tile-size 0.05] "
            "[--precision 5] [--flush-every 20000] "
            "[--threads N] [--queue-capacity N]");
    }

    Config cfg;
    cfg.input_file = argv[1];

    for (int i = 2; i < argc; ++i)
    {
        const std::string arg = argv[i];

        auto need = [&](const char *name) -> std::string
        {
            if (i + 1 >= argc)
                throw std::runtime_error(std::string("Valeur manquante pour ") + name);
            return argv[++i];
        };

        if (arg == "--out-dir")
            cfg.out_dir = need("--out-dir");
        else if (arg == "--bbox-size")
            cfg.bbox_size = std::stod(need("--bbox-size"));
        else if (arg == "--tile-size")
            cfg.tile_size = std::stod(need("--tile-size"));
        else if (arg == "--precision")
            cfg.precision = std::stoi(need("--precision"));
        else if (arg == "--flush-every")
            cfg.flush_every = static_cast<std::size_t>(std::stoull(need("--flush-every")));
        else if (arg == "--threads")
            cfg.worker_threads = static_cast<std::size_t>(std::stoull(need("--threads")));
        else if (arg == "--queue-capacity")
            cfg.queue_capacity = static_cast<std::size_t>(std::stoull(need("--queue-capacity")));
        else
            throw std::runtime_error("Argument inconnu: " + arg);
    }

    if (cfg.bbox_size <= 0.0 || cfg.tile_size <= 0.0)
        throw std::runtime_error("--bbox-size et --tile-size doivent etre > 0");

    if (cfg.worker_threads == 0)
    {
        const unsigned hc = std::thread::hardware_concurrency();
        cfg.worker_threads = hc > 2 ? static_cast<std::size_t>(hc - 1) : 1;
    }

    if (cfg.queue_capacity == 0)
        throw std::runtime_error("--queue-capacity doit etre > 0");

    return cfg;
}

int main(int argc, char **argv)
{
    try
    {
        const Config cfg = parse_args(argc, argv);

        std::atomic<std::uint64_t> ways_seen{0};
        std::atomic<std::uint64_t> ways_matched{0};
        std::atomic<std::uint64_t> seq_counter{0};
        std::atomic<std::uint64_t> total_bbox_refs_written{0};

        BlockingQueue<WorkItem> work_queue(cfg.queue_capacity);
        BlockingQueue<WorkerResult> result_queue(cfg.queue_capacity);

        std::cerr << "Lecture: " << cfg.input_file << "\n";
        std::cerr << "bbox-size=" << cfg.bbox_size
                  << " | tile-size=" << cfg.tile_size
                  << " | worker_threads=" << cfg.worker_threads
                  << " | queue_capacity=" << cfg.queue_capacity << "\n";

        std::thread writer_thread(
            writer_loop,
            std::cref(cfg),
            std::ref(result_queue),
            std::ref(total_bbox_refs_written));

        std::vector<std::thread> workers;
        workers.reserve(cfg.worker_threads);
        for (std::size_t i = 0; i < cfg.worker_threads; ++i)
        {
            workers.emplace_back(
                worker_loop,
                std::cref(cfg),
                std::ref(work_queue),
                std::ref(result_queue));
        }

        using index_type =
            osmium::index::map::SparseMemArray<osmium::unsigned_object_id_type, osmium::Location>;
        using location_handler_type =
            osmium::handler::NodeLocationsForWays<index_type>;

        osmium::io::File infile{cfg.input_file};
        osmium::io::Reader reader{
            infile,
            osmium::osm_entity_bits::node | osmium::osm_entity_bits::way};

        index_type index;
        location_handler_type location_handler{index};
        location_handler.ignore_errors();

        ProducerHandler producer(work_queue, ways_seen, ways_matched, seq_counter);

        osmium::apply(reader, location_handler, producer);
        reader.close();

        work_queue.close();

        for (auto &t : workers)
            t.join();

        result_queue.close();
        writer_thread.join();

        std::cerr << "Phase 1 terminee.\n";
        std::cerr << "- ways lus: " << ways_seen.load() << "\n";
        std::cerr << "- ways retenus: " << ways_matched.load() << "\n";
        std::cerr << "- bbox refs ecrits: " << total_bbox_refs_written.load() << "\n";
        return 0;
    }
    catch (const std::exception &e)
    {
        std::cerr << "Erreur: " << e.what() << "\n";
        return 1;
    }
}