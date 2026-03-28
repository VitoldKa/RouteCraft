/*
g++ -O3 -std=c++17 phase1_spatial_index.cpp \
  -I$(brew --prefix libosmium)/include \
  -I$(brew --prefix protozero)/include \
  -I$(brew --prefix expat)/include \
  -L$(brew --prefix bzip2)/lib \
  -L$(brew --prefix zlib)/lib \
  -L$(brew --prefix expat)/lib \
  -lbz2 -lz -lexpat \
  -o phase1_spatial_index
*/

#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
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
    std::string tag = "building";
    std::string tag_value;
    bool has_tag_value = false;
    double bbox_size = 0.01;
    double tile_size = 0.05;
    int precision = 5;
    std::size_t flush_every = 20000;
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
    if (value_in_list(highway, {"pedestrian",
                                "residential",
                                "living_street",
                                "tertiary",
                                "secondary",
                                "primary",
                                "unclassified",
                                "service",
                                "path",
                                "track"}))
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

static std::string bbox_key(double s, double w, double n, double e, int precision)
{
    return fmt(s, precision) + "," + fmt(w, precision) + "," +
           fmt(n, precision) + "," + fmt(e, precision);
}

static std::string tile_key(double lat, double lon, double size, int precision)
{
    const long yi = static_cast<long>(std::floor(lat / size));
    const long xi = static_cast<long>(std::floor(lon / size));
    const double s = yi * size;
    const double w = xi * size;
    const double n = s + size;
    const double e = w + size;
    return bbox_key(s, w, n, e, precision);
}

static std::string key_to_filename(const std::string &key)
{
    std::string out;
    out.reserve(key.size() + 16);
    for (char c : key)
    {
        if (c == ',')
            out += "__";
        else
            out.push_back(c);
    }
    return out;
}

static std::string serialize_way_json(
    std::int64_t way_id,
    const std::vector<std::uint64_t> &node_ids,
    const osmium::TagList &tags)
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
        s += json_escape(tag.key());
        s += "\":\"";
        s += json_escape(tag.value());
        s += "\"";
    }
    s += "}}\n";
    return s;
}

static std::string serialize_node_json(std::uint64_t id, double lat, double lon)
{
    std::string s;
    s.reserve(96);
    s += "{\"id\":";
    s += std::to_string(id);
    s += ",\"lat\":";
    s += fmt(lat, 7);
    s += ",\"lon\":";
    s += fmt(lon, 7);
    s += "}\n";
    return s;
}

static std::string serialize_bbox_ref_json(std::uint64_t way_id, const std::string &content_tile_key)
{
    std::string s;
    s.reserve(96 + content_tile_key.size());
    s += "{\"wayId\":";
    s += std::to_string(way_id);
    s += ",\"contentTile\":\"";
    s += content_tile_key;
    s += "\"}\n";
    return s;
}

struct BlobPair
{
    std::string a;
    std::string b;
};

class BufferedAppender
{
public:
    explicit BufferedAppender(std::string out_dir) : out_dir_(std::move(out_dir))
    {
        fs::create_directories(fs::path(out_dir_) / "bbox_index");
        fs::create_directories(fs::path(out_dir_) / "content_tiles");
    }

    void add_bbox_ref(const std::string &bbox_key_s, const std::string &ref_line)
    {
        auto &buf = bbox_buffers_[bbox_key_s];
        buf.a += ref_line;
    }

    void add_content_way_and_nodes(
        const std::string &tile_key_s,
        const std::string &way_line,
        const std::string &nodes_blob)
    {
        auto &buf = tile_buffers_[tile_key_s];
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
    void flush_bbox_refs()
    {
        for (auto &[key, buf] : bbox_buffers_)
        {
            const fs::path path = fs::path(out_dir_) / "bbox_index" /
                                  (key_to_filename(key) + ".refs.ndjson");
            std::ofstream out(path, std::ios::binary | std::ios::app);
            if (!out)
                throw std::runtime_error("Impossible d'ouvrir " + path.string());
            out.write(buf.a.data(), static_cast<std::streamsize>(buf.a.size()));
        }
        bbox_buffers_.clear();
    }

    void flush_content_tiles()
    {
        for (auto &[key, buf] : tile_buffers_)
        {
            const std::string base = key_to_filename(key);

            const fs::path ways_path = fs::path(out_dir_) / "content_tiles" / (base + ".ways.ndjson");
            const fs::path nodes_path = fs::path(out_dir_) / "content_tiles" / (base + ".nodes.ndjson");

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
    std::unordered_map<std::string, BlobPair> bbox_buffers_;
    std::unordered_map<std::string, BlobPair> tile_buffers_;
};

class SplitHandler : public osmium::handler::Handler
{
public:
    SplitHandler(const Config &cfg, BufferedAppender &writer)
        : cfg_(cfg), writer_(writer) {}

    void way(const osmium::Way &way)
    {
        ++ways_seen_;

        // const char *tag_val = way.tags().get_value_by_key(cfg_.tag.c_str());
        // if (!tag_val)
        //     return;
        // if (cfg_.has_tag_value && cfg_.tag_value != tag_val)
        //     return;
        if (!is_target_way(way))
        {
            return;
        }
        std::vector<std::uint64_t> node_ids;
        node_ids.reserve(way.nodes().size());

        std::string node_blob;
        node_blob.reserve(way.nodes().size() * 64);

        bool have_geom = false;
        double min_lat = 0.0, max_lat = 0.0, min_lon = 0.0, max_lon = 0.0;

        for (const auto &nr : way.nodes())
        {
            node_ids.push_back(nr.ref());

            const auto &loc = nr.location();
            if (!loc.valid())
                continue;

            const double lat = loc.lat();
            const double lon = loc.lon();

            if (!have_geom)
            {
                min_lat = max_lat = lat;
                min_lon = max_lon = lon;
                have_geom = true;
            }
            else
            {
                if (lat < min_lat)
                    min_lat = lat;
                if (lat > max_lat)
                    max_lat = lat;
                if (lon < min_lon)
                    min_lon = lon;
                if (lon > max_lon)
                    max_lon = lon;
            }

            node_blob += serialize_node_json(nr.ref(), lat, lon);
        }

        if (!have_geom)
            return;

        const std::uint64_t way_id = way.id();
        const std::string way_line = serialize_way_json(way_id, node_ids, way.tags());

        const double center_lat = (min_lat + max_lat) * 0.5;
        const double center_lon = (min_lon + max_lon) * 0.5;
        const std::string owner_tile = tile_key(center_lat, center_lon, cfg_.tile_size, cfg_.precision);

        writer_.add_content_way_and_nodes(owner_tile, way_line, node_blob);

        const double bs = cfg_.bbox_size;
        const long y0 = static_cast<long>(std::floor(min_lat / bs));
        const long y1 = static_cast<long>(std::floor(max_lat / bs));
        const long x0 = static_cast<long>(std::floor(min_lon / bs));
        const long x1 = static_cast<long>(std::floor(max_lon / bs));

        const std::string ref_line = serialize_bbox_ref_json(way_id, owner_tile);

        std::size_t bbox_count_for_way = 0;
        for (long yi = y0; yi <= y1; ++yi)
        {
            const double s = yi * bs;
            const double n = s + bs;

            for (long xi = x0; xi <= x1; ++xi)
            {
                const double w = xi * bs;
                const double e = w + bs;

                const std::string key = bbox_key(s, w, n, e, cfg_.precision);
                writer_.add_bbox_ref(key, ref_line);
                ++bbox_count_for_way;
            }
        }

        ++ways_matched_;
        total_bbox_refs_ += bbox_count_for_way;

        if (ways_matched_ % cfg_.flush_every == 0)
        {
            std::cerr << "ways retenus: " << ways_matched_
                      << ", moyenne bbox/way: "
                      << (ways_matched_ ? static_cast<double>(total_bbox_refs_) / ways_matched_ : 0.0)
                      << "\n";
            writer_.flush();
        }
    }

    std::uint64_t ways_seen() const noexcept { return ways_seen_; }
    std::uint64_t ways_matched() const noexcept { return ways_matched_; }

private:
    const Config &cfg_;
    BufferedAppender &writer_;
    std::uint64_t ways_seen_ = 0;
    std::uint64_t ways_matched_ = 0;
    std::uint64_t total_bbox_refs_ = 0;
};

static Config parse_args(int argc, char **argv)
{
    if (argc < 2)
    {
        throw std::runtime_error(
            "Usage: phase1_spatial_index <input.osm.pbf|input.osm.bz2> "
            "[--out-dir DIR] [--tag KEY] [--tag-value VALUE] "
            "[--bbox-size 0.01] [--tile-size 0.05] [--precision 5] [--flush-every 20000]");
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
        else if (arg == "--tag")
            cfg.tag = need("--tag");
        else if (arg == "--tag-value")
        {
            cfg.tag_value = need("--tag-value");
            cfg.has_tag_value = true;
        }
        else if (arg == "--bbox-size")
            cfg.bbox_size = std::stod(need("--bbox-size"));
        else if (arg == "--tile-size")
            cfg.tile_size = std::stod(need("--tile-size"));
        else if (arg == "--precision")
            cfg.precision = std::stoi(need("--precision"));
        else if (arg == "--flush-every")
            cfg.flush_every = static_cast<std::size_t>(std::stoull(need("--flush-every")));
        else
            throw std::runtime_error("Argument inconnu: " + arg);
    }

    if (cfg.bbox_size <= 0.0 || cfg.tile_size <= 0.0)
    {
        throw std::runtime_error("--bbox-size et --tile-size doivent etre > 0");
    }

    return cfg;
}

int main(int argc, char **argv)
{
    try
    {
        const Config cfg = parse_args(argc, argv);

        using index_type =
            osmium::index::map::SparseMemArray<osmium::unsigned_object_id_type, osmium::Location>;
        using location_handler_type = osmium::handler::NodeLocationsForWays<index_type>;

        osmium::io::File infile{cfg.input_file};
        osmium::io::Reader reader{infile, osmium::osm_entity_bits::node | osmium::osm_entity_bits::way};

        index_type index;
        location_handler_type location_handler{index};
        location_handler.ignore_errors();

        BufferedAppender writer{cfg.out_dir};
        SplitHandler handler{cfg, writer};

        std::cerr << "Lecture: " << cfg.input_file << "\n";
        std::cerr << "Tag: " << cfg.tag;
        if (cfg.has_tag_value)
            std::cerr << "=" << cfg.tag_value;
        std::cerr << " | bbox-size=" << cfg.bbox_size
                  << " | tile-size=" << cfg.tile_size << "\n";

        osmium::apply(reader, location_handler, handler);
        reader.close();
        writer.flush();

        std::cerr << "Phase 1 terminee.\n";
        std::cerr << "- ways lus: " << handler.ways_seen() << "\n";
        std::cerr << "- ways retenus: " << handler.ways_matched() << "\n";
        return 0;
    }
    catch (const std::exception &e)
    {
        std::cerr << "Erreur: " << e.what() << "\n";
        return 1;
    }
}