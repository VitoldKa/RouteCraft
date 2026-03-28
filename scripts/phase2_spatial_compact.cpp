/*
g++ -O3 -std=c++17 phase2_spatial_compact.cpp -o phase2_spatial_compact
*/

#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>

namespace fs = std::filesystem;

struct Config
{
    std::string in_dir = "tmp_spatial";
    std::string out_dir = "spatial_cache";
    std::uint64_t created_at = 0;
    std::uint64_t fetched_at = 0;
};

static bool ends_with(const std::string &s, const std::string &suffix)
{
    return s.size() >= suffix.size() &&
           s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
}

static std::string strip_suffix(const std::string &s, const std::string &suffix)
{
    return ends_with(s, suffix) ? s.substr(0, s.size() - suffix.size()) : s;
}

static std::string key_from_filename_base(const std::string &base)
{
    std::string out;
    out.reserve(base.size());
    for (std::size_t i = 0; i < base.size(); ++i)
    {
        if (i + 1 < base.size() && base[i] == '_' && base[i + 1] == '_')
        {
            out.push_back(',');
            ++i;
        }
        else
        {
            out.push_back(base[i]);
        }
    }
    return out;
}

static std::optional<std::uint64_t> extract_uint_field(std::string_view line, std::string_view field)
{
    const std::string needle = "\"" + std::string(field) + "\":";
    const auto pos = line.find(needle);
    if (pos == std::string_view::npos)
        return std::nullopt;

    std::size_t i = pos + needle.size();
    while (i < line.size() && std::isspace(static_cast<unsigned char>(line[i])))
        ++i;

    std::uint64_t v = 0;
    bool has_digit = false;
    while (i < line.size() && std::isdigit(static_cast<unsigned char>(line[i])))
    {
        has_digit = true;
        v = v * 10 + static_cast<unsigned>(line[i] - '0');
        ++i;
    }
    if (!has_digit)
        return std::nullopt;
    return v;
}

static std::optional<std::string> extract_string_field(std::string_view line, std::string_view field)
{
    const std::string needle = "\"" + std::string(field) + "\":\"";
    const auto pos = line.find(needle);
    if (pos == std::string_view::npos)
        return std::nullopt;

    std::size_t i = pos + needle.size();
    std::string out;
    while (i < line.size())
    {
        char c = line[i++];
        if (c == '\\')
        {
            if (i < line.size())
                out.push_back(line[i++]);
        }
        else if (c == '"')
        {
            return out;
        }
        else
        {
            out.push_back(c);
        }
    }
    return std::nullopt;
}

static Config parse_args(int argc, char **argv)
{
    Config cfg;
    for (int i = 1; i < argc; ++i)
    {
        std::string arg = argv[i];
        auto need = [&](const char *name) -> std::string
        {
            if (i + 1 >= argc)
                throw std::runtime_error(std::string("Valeur manquante pour ") + name);
            return argv[++i];
        };

        if (arg == "--in-dir")
            cfg.in_dir = need("--in-dir");
        else if (arg == "--out-dir")
            cfg.out_dir = need("--out-dir");
        else if (arg == "--created-at")
            cfg.created_at = std::stoull(need("--created-at"));
        else if (arg == "--fetched-at")
            cfg.fetched_at = std::stoull(need("--fetched-at"));
        else
            throw std::runtime_error("Argument inconnu: " + arg);
    }

    if (cfg.created_at == 0)
        cfg.created_at = cfg.fetched_at;
    if (cfg.fetched_at == 0)
        cfg.fetched_at = cfg.created_at;
    return cfg;
}

static void compact_bbox_indexes(const Config &cfg)
{
    const fs::path in_dir = fs::path(cfg.in_dir) / "bbox_index";
    const fs::path out_dir = fs::path(cfg.out_dir) / "bbox-index";
    fs::create_directories(out_dir);

    std::size_t count = 0;
    for (const auto &entry : fs::directory_iterator(in_dir))
    {
        if (!entry.is_regular_file())
            continue;
        const std::string name = entry.path().filename().string();
        if (!ends_with(name, ".refs.ndjson"))
            continue;

        ++count;
        if (count % 500 == 0 || count == 1)
        {
            std::cerr << "bbox-index " << count << ": " << name << "\n";
        }

        std::unordered_set<std::uint64_t> way_ids;
        std::unordered_set<std::string> content_tiles;

        std::ifstream in(entry.path(), std::ios::binary);
        if (!in)
            throw std::runtime_error("Impossible d'ouvrir " + entry.path().string());

        std::string line;
        while (std::getline(in, line))
        {
            if (line.empty())
                continue;
            auto way_id = extract_uint_field(line, "wayId");
            auto content_tile = extract_string_field(line, "contentTile");
            if (way_id)
                way_ids.insert(*way_id);
            if (content_tile)
                content_tiles.insert(*content_tile);
        }

        const std::string base = strip_suffix(name, ".refs.ndjson");
        const std::string key = key_from_filename_base(base);

        const fs::path out_path = out_dir / (base + ".json");
        std::ofstream out(out_path, std::ios::binary);
        if (!out)
            throw std::runtime_error("Impossible d'ouvrir " + out_path.string());

        out << "{";
        out << "\"key\":\"" << key << "\",";
        out << "\"wayIds\":[";
        bool first = true;
        for (const auto &id : way_ids)
        {
            if (!first)
                out << ",";
            first = false;
            out << id;
        }
        out << "],";
        out << "\"contentTiles\":[";
        first = true;
        for (const auto &tile : content_tiles)
        {
            if (!first)
                out << ",";
            first = false;
            out << "\"" << tile << "\"";
        }
        out << "],";
        out << "\"fetchedAt\":" << cfg.fetched_at;
        out << "}";
    }
}

static void compact_content_tiles(const Config &cfg)
{
    const fs::path in_dir = fs::path(cfg.in_dir) / "content_tiles";
    const fs::path out_dir = fs::path(cfg.out_dir) / "content-tiles";
    fs::create_directories(out_dir);

    std::unordered_set<std::string> bases;
    for (const auto &entry : fs::directory_iterator(in_dir))
    {
        if (!entry.is_regular_file())
            continue;
        const std::string name = entry.path().filename().string();
        if (ends_with(name, ".ways.ndjson"))
            bases.insert(strip_suffix(name, ".ways.ndjson"));
        else if (ends_with(name, ".nodes.ndjson"))
            bases.insert(strip_suffix(name, ".nodes.ndjson"));
    }

    std::size_t idx = 0;
    for (const auto &base : bases)
    {
        ++idx;
        if (idx % 500 == 0 || idx == 1)
        {
            std::cerr << "content-tile " << idx << ": " << base << "\n";
        }

        const fs::path ways_path = in_dir / (base + ".ways.ndjson");
        const fs::path nodes_path = in_dir / (base + ".nodes.ndjson");
        if (!fs::exists(ways_path))
            continue;
        if (!fs::exists(nodes_path))
            continue;

        std::unordered_map<std::uint64_t, std::string> ways;
        std::unordered_map<std::uint64_t, std::string> nodes;

        {
            std::ifstream in(ways_path, std::ios::binary);
            if (!in)
                throw std::runtime_error("Impossible d'ouvrir " + ways_path.string());
            std::string line;
            while (std::getline(in, line))
            {
                if (line.empty())
                    continue;
                auto id = extract_uint_field(line, "id");
                if (!id)
                    continue;
                ways[*id] = line;
            }
        }

        {
            std::ifstream in(nodes_path, std::ios::binary);
            if (!in)
                throw std::runtime_error("Impossible d'ouvrir " + nodes_path.string());
            std::string line;
            while (std::getline(in, line))
            {
                if (line.empty())
                    continue;
                auto id = extract_uint_field(line, "id");
                if (!id)
                    continue;
                nodes[*id] = line;
            }
        }

        const std::string tile_key = key_from_filename_base(base);
        const fs::path out_path = out_dir / (base + ".json");
        std::ofstream out(out_path, std::ios::binary);
        if (!out)
            throw std::runtime_error("Impossible d'ouvrir " + out_path.string());

        out << "{";
        out << "\"tile\":\"" << tile_key << "\",";
        out << "\"createdAt\":" << cfg.created_at << ",";
        out << "\"ways\":[";
        bool first = true;
        for (const auto &[id, json] : ways)
        {
            if (!first)
                out << ",";
            first = false;
            out << json;
        }
        out << "],";
        out << "\"nodes\":[";
        first = true;
        for (const auto &[id, json] : nodes)
        {
            if (!first)
                out << ",";
            first = false;
            out << json;
        }
        out << "],";
        out << "\"fetchedAt\":" << cfg.fetched_at;
        out << "}";
    }
}

int main(int argc, char **argv)
{
    try
    {
        const Config cfg = parse_args(argc, argv);

        if (!fs::exists(cfg.in_dir))
        {
            throw std::runtime_error("Dossier introuvable: " + cfg.in_dir);
        }

        fs::create_directories(cfg.out_dir);

        compact_bbox_indexes(cfg);
        compact_content_tiles(cfg);

        std::cerr << "Phase 2 terminee.\n";
        std::cerr << "Sortie: " << cfg.out_dir << "\n";
        return 0;
    }
    catch (const std::exception &e)
    {
        std::cerr << "Erreur: " << e.what() << "\n";
        return 1;
    }
}