/*
g++ -O3 -std=c++17 phase1_split_ndjson.cpp \
  -I$(brew --prefix libosmium)/include \
  -I$(brew --prefix protozero)/include \
  -I$(brew --prefix expat)/include \
  -L$(brew --prefix bzip2)/lib \
  -L$(brew --prefix zlib)/lib \
  -L$(brew --prefix expat)/lib \
  -lbz2 -lz -lexpat \
  -o phase1_split_ndjson

*/

#include <algorithm>
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
#include <utility>
#include <vector>

#include <osmium/handler/node_locations_for_ways.hpp>
#include <osmium/handler.hpp>
#include <osmium/index/map/sparse_mem_array.hpp>
#include <osmium/io/any_input.hpp>
#include <osmium/tags/taglist.hpp>
#include <osmium/visitor.hpp>

namespace fs = std::filesystem;

struct Config
{
    std::string input_file;
    std::string out_dir = "tmp_ndjson";
    std::string tag = "building";
    std::string tag_value;
    bool has_tag_value = false;
    double tile_size = 0.02;
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

static std::string format_coord(double v, int precision)
{
    std::ostringstream oss;
    oss.setf(std::ios::fixed);
    oss.precision(precision);
    oss << v;
    return oss.str();
}

static std::string bbox_key(double south, double west, double north, double east, int precision)
{
    return format_coord(south, precision) + "," +
           format_coord(west, precision) + "," +
           format_coord(north, precision) + "," +
           format_coord(east, precision);
}

static std::string key_to_filename(const std::string &key)
{
    std::string out;
    out.reserve(key.size() + 16);
    for (char c : key)
    {
        if (c == ',')
        {
            out += "__";
        }
        else
        {
            out.push_back(c);
        }
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

static std::string serialize_node_json(std::uint64_t node_id, double lat, double lon)
{
    std::string s;
    s.reserve(96);
    s += "{\"id\":";
    s += std::to_string(node_id);
    s += ",\"lat\":";
    s += format_coord(lat, 7);
    s += ",\"lon\":";
    s += format_coord(lon, 7);
    s += "}\n";
    return s;
}

struct TileBuffer
{
    std::string ways_blob;
    std::string nodes_blob;
};

class BufferedAppender
{
public:
    explicit BufferedAppender(std::string out_dir) : out_dir_(std::move(out_dir))
    {
        fs::create_directories(out_dir_);
    }

    void add(const std::string &key, const std::string &way_line, const std::string &nodes_blob)
    {
        auto &buf = buffers_[key];
        buf.ways_blob += way_line;
        buf.nodes_blob += nodes_blob;
    }

    void flush()
    {
        if (buffers_.empty())
            return;

        std::size_t touched = 0;
        for (auto &[key, buf] : buffers_)
        {
            const std::string base = key_to_filename(key);
            const fs::path ways_path = fs::path(out_dir_) / (base + ".ways.ndjson");
            const fs::path nodes_path = fs::path(out_dir_) / (base + ".nodes.ndjson");

            {
                std::ofstream fw(ways_path, std::ios::binary | std::ios::app);
                if (!fw)
                    throw std::runtime_error("Impossible d'ouvrir " + ways_path.string());
                fw.write(buf.ways_blob.data(), static_cast<std::streamsize>(buf.ways_blob.size()));
            }

            {
                std::ofstream fn(nodes_path, std::ios::binary | std::ios::app);
                if (!fn)
                    throw std::runtime_error("Impossible d'ouvrir " + nodes_path.string());
                fn.write(buf.nodes_blob.data(), static_cast<std::streamsize>(buf.nodes_blob.size()));
            }

            ++touched;
        }

        buffers_.clear();
        ++flush_count_;
        std::cerr << "Flush #" << flush_count_ << ": " << touched << " bboxes ecrites\n";
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
    std::string out_dir_;
    std::unordered_map<std::string, TileBuffer> buffers_;
    std::size_t flush_count_ = 0;
};

class SplitHandler : public osmium::handler::Handler
{
public:
    SplitHandler(const Config &cfg, BufferedAppender &appender)
        : cfg_(cfg), appender_(appender) {}

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

        bool have_bbox = false;
        double min_lat = 0.0, max_lat = 0.0, min_lon = 0.0, max_lon = 0.0;

        for (const auto &nr : way.nodes())
        {
            node_ids.push_back(nr.ref());

            const auto &loc = nr.location();
            if (!loc.valid())
                continue;

            const double lat = loc.lat();
            const double lon = loc.lon();

            if (!have_bbox)
            {
                min_lat = max_lat = lat;
                min_lon = max_lon = lon;
                have_bbox = true;
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

        if (!have_bbox)
            return;

        const std::string way_line = serialize_way_json(
            static_cast<std::int64_t>(way.id()),
            node_ids,
            way.tags());

        const double ts = cfg_.tile_size;
        const long y0 = static_cast<long>(std::floor(min_lat / ts));
        const long y1 = static_cast<long>(std::floor(max_lat / ts));
        const long x0 = static_cast<long>(std::floor(min_lon / ts));
        const long x1 = static_cast<long>(std::floor(max_lon / ts));

        std::size_t tiles_for_way = 0;

        for (long yi = y0; yi <= y1; ++yi)
        {
            const double south = yi * ts;
            const double north = south + ts;

            for (long xi = x0; xi <= x1; ++xi)
            {
                const double west = xi * ts;
                const double east = west + ts;

                const std::string key = bbox_key(south, west, north, east, cfg_.precision);
                appender_.add(key, way_line, node_blob);
                ++tiles_for_way;
            }
        }

        ++ways_matched_;
        total_tiles_ += tiles_for_way;

        if (ways_matched_ % cfg_.flush_every == 0)
        {
            std::cerr << "ways retenus: " << ways_matched_
                      << ", moyenne tuiles/way: "
                      << (ways_matched_ ? static_cast<double>(total_tiles_) / ways_matched_ : 0.0)
                      << "\n";
            appender_.flush();
        }
    }

    std::uint64_t ways_seen() const noexcept { return ways_seen_; }
    std::uint64_t ways_matched() const noexcept { return ways_matched_; }
    std::uint64_t total_tiles() const noexcept { return total_tiles_; }

private:
    const Config &cfg_;
    BufferedAppender &appender_;
    std::uint64_t ways_seen_ = 0;
    std::uint64_t ways_matched_ = 0;
    std::uint64_t total_tiles_ = 0;
};

static Config parse_args(int argc, char **argv)
{
    if (argc < 2)
    {
        throw std::runtime_error(
            "Usage: phase1_split_ndjson <input.osm.pbf|input.osm.bz2> "
            "[--out-dir DIR] [--tag KEY] [--tag-value VALUE] "
            "[--tile-size 0.02] [--precision 5] [--flush-every 20000]");
    }

    Config cfg;
    cfg.input_file = argv[1];

    for (int i = 2; i < argc; ++i)
    {
        const std::string arg = argv[i];

        auto need_value = [&](const char *name) -> std::string
        {
            if (i + 1 >= argc)
                throw std::runtime_error(std::string("Valeur manquante pour ") + name);
            return argv[++i];
        };

        if (arg == "--out-dir")
        {
            cfg.out_dir = need_value("--out-dir");
        }
        else if (arg == "--tag")
        {
            cfg.tag = need_value("--tag");
        }
        else if (arg == "--tag-value")
        {
            cfg.tag_value = need_value("--tag-value");
            cfg.has_tag_value = true;
        }
        else if (arg == "--tile-size")
        {
            cfg.tile_size = std::stod(need_value("--tile-size"));
        }
        else if (arg == "--precision")
        {
            cfg.precision = std::stoi(need_value("--precision"));
        }
        else if (arg == "--flush-every")
        {
            cfg.flush_every = static_cast<std::size_t>(std::stoull(need_value("--flush-every")));
        }
        else
        {
            throw std::runtime_error("Argument inconnu: " + arg);
        }
    }

    if (cfg.tile_size <= 0.0)
    {
        throw std::runtime_error("--tile-size doit etre > 0");
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

        BufferedAppender appender{cfg.out_dir};
        SplitHandler handler{cfg, appender};

        std::cerr << "Lecture: " << cfg.input_file << "\n";
        std::cerr << "Tag: " << cfg.tag;
        if (cfg.has_tag_value)
            std::cerr << "=" << cfg.tag_value;
        std::cerr << ", tile-size: " << cfg.tile_size << "\n";

        osmium::apply(reader, location_handler, handler);
        reader.close();

        appender.flush();

        std::cerr << "Termine.\n";
        std::cerr << "- ways lus: " << handler.ways_seen() << "\n";
        std::cerr << "- ways retenus: " << handler.ways_matched() << "\n";
        std::cerr << "- moyenne tuiles/way: "
                  << (handler.ways_matched()
                          ? static_cast<double>(handler.total_tiles()) / handler.ways_matched()
                          : 0.0)
                  << "\n";

        return 0;
    }
    catch (const std::exception &e)
    {
        std::cerr << "Erreur: " << e.what() << "\n";
        return 1;
    }
}