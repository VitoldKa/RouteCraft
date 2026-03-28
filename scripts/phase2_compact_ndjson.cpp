/*
g++ -O3 -std=c++17 phase2_compact_ndjson.cpp -o phase2_compact_ndjson

*/

#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace fs = std::filesystem;

struct Config
{
    std::string in_dir = "tmp_ndjson";
    std::string out_dir = "final_cache";
    std::uint64_t created_at = 0;
    std::uint64_t fetched_at = 0;
};

struct WayRecord
{
    std::uint64_t id = 0;
    std::string json_line; // JSON complet de la way, sans newline
};

struct NodeRecord
{
    std::uint64_t id = 0;
    std::string json_line; // JSON complet du node, sans newline
};

static Config parse_args(int argc, char **argv)
{
    Config cfg;

    for (int i = 1; i < argc; ++i)
    {
        std::string arg = argv[i];

        auto need_value = [&](const char *name) -> std::string
        {
            if (i + 1 >= argc)
            {
                throw std::runtime_error(std::string("Valeur manquante pour ") + name);
            }
            return argv[++i];
        };

        if (arg == "--in-dir")
        {
            cfg.in_dir = need_value("--in-dir");
        }
        else if (arg == "--out-dir")
        {
            cfg.out_dir = need_value("--out-dir");
        }
        else if (arg == "--created-at")
        {
            cfg.created_at = std::stoull(need_value("--created-at"));
        }
        else if (arg == "--fetched-at")
        {
            cfg.fetched_at = std::stoull(need_value("--fetched-at"));
        }
        else
        {
            throw std::runtime_error("Argument inconnu: " + arg);
        }
    }

    return cfg;
}

static bool ends_with(const std::string &s, const std::string &suffix)
{
    return s.size() >= suffix.size() &&
           s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
}

static std::string strip_suffix(const std::string &s, const std::string &suffix)
{
    if (!ends_with(s, suffix))
        return s;
    return s.substr(0, s.size() - suffix.size());
}

static std::string key_from_base(const std::string &base)
{
    std::string key;
    key.reserve(base.size());

    for (std::size_t i = 0; i < base.size(); ++i)
    {
        if (i + 1 < base.size() && base[i] == '_' && base[i + 1] == '_')
        {
            key.push_back(',');
            ++i;
        }
        else
        {
            key.push_back(base[i]);
        }
    }

    return key;
}

static std::optional<std::uint64_t> extract_id_value(std::string_view line)
{
    const std::string_view needle = "\"id\":";
    const std::size_t pos = line.find(needle);
    if (pos == std::string_view::npos)
        return std::nullopt;

    std::size_t i = pos + needle.size();
    while (i < line.size() && std::isspace(static_cast<unsigned char>(line[i])))
    {
        ++i;
    }

    if (i >= line.size())
        return std::nullopt;

    std::uint64_t value = 0;
    bool has_digit = false;

    while (i < line.size() && std::isdigit(static_cast<unsigned char>(line[i])))
    {
        has_digit = true;
        value = value * 10 + static_cast<unsigned>(line[i] - '0');
        ++i;
    }

    if (!has_digit)
        return std::nullopt;
    return value;
}

static std::unordered_map<std::uint64_t, WayRecord> load_ways(const fs::path &path)
{
    std::unordered_map<std::uint64_t, WayRecord> ways;

    std::ifstream in(path, std::ios::binary);
    if (!in)
    {
        throw std::runtime_error("Impossible d'ouvrir " + path.string());
    }

    std::string line;
    std::size_t count = 0;

    while (std::getline(in, line))
    {
        if (line.empty())
            continue;

        auto id_opt = extract_id_value(line);
        if (!id_opt)
            continue;

        const std::uint64_t id = *id_opt;
        ways[id] = WayRecord{id, line};

        ++count;
        if (count % 500000 == 0)
        {
            std::cerr << "  ways lues: " << count << " (" << path.filename().string() << ")\n";
        }
    }

    return ways;
}

static std::unordered_map<std::uint64_t, NodeRecord> load_nodes(const fs::path &path)
{
    std::unordered_map<std::uint64_t, NodeRecord> nodes;

    std::ifstream in(path, std::ios::binary);
    if (!in)
    {
        throw std::runtime_error("Impossible d'ouvrir " + path.string());
    }

    std::string line;
    std::size_t count = 0;

    while (std::getline(in, line))
    {
        if (line.empty())
            continue;

        auto id_opt = extract_id_value(line);
        if (!id_opt)
            continue;

        const std::uint64_t id = *id_opt;
        nodes[id] = NodeRecord{id, line};

        ++count;
        if (count % 500000 == 0)
        {
            std::cerr << "  nodes lus: " << count << " (" << path.filename().string() << ")\n";
        }
    }

    return nodes;
}

static void write_final_json(
    const fs::path &out_path,
    const std::string &bbox_key,
    std::uint64_t created_at,
    std::uint64_t fetched_at,
    const std::unordered_map<std::uint64_t, WayRecord> &ways,
    const std::unordered_map<std::uint64_t, NodeRecord> &nodes)
{
    std::ofstream out(out_path, std::ios::binary);
    if (!out)
    {
        throw std::runtime_error("Impossible d'ouvrir " + out_path.string());
    }

    out << "{";
    out << "\"version\":1,";
    out << "\"createdAt\":" << created_at << ",";
    out << "\"ways\":[";

    bool first = true;
    for (const auto &[id, rec] : ways)
    {
        if (!first)
            out << ",";
        first = false;
        out << rec.json_line;
    }

    out << "],";
    out << "\"nodes\":[";

    first = true;
    for (const auto &[id, rec] : nodes)
    {
        if (!first)
            out << ",";
        first = false;
        out << rec.json_line;
    }

    out << "],";
    out << "\"bboxes\":[{";
    out << "\"key\":\"" << bbox_key << "\",";
    out << "\"wayIds\":[";

    first = true;
    for (const auto &[id, rec] : ways)
    {
        if (!first)
            out << ",";
        first = false;
        out << id;
    }

    out << "],";
    out << "\"fetchedAt\":" << fetched_at;
    out << "}]}";
}

int main(int argc, char **argv)
{
    try
    {
        Config cfg = parse_args(argc, argv);

        if (cfg.created_at == 0)
        {
            cfg.created_at = cfg.fetched_at;
        }
        if (cfg.fetched_at == 0)
        {
            cfg.fetched_at = cfg.created_at;
        }

        if (!fs::exists(cfg.in_dir))
        {
            throw std::runtime_error("Dossier introuvable: " + cfg.in_dir);
        }

        fs::create_directories(cfg.out_dir);

        std::unordered_set<std::string> bases;

        for (const auto &entry : fs::directory_iterator(cfg.in_dir))
        {
            if (!entry.is_regular_file())
                continue;

            const std::string name = entry.path().filename().string();

            if (ends_with(name, ".ways.ndjson"))
            {
                bases.insert(strip_suffix(name, ".ways.ndjson"));
            }
            else if (ends_with(name, ".nodes.ndjson"))
            {
                bases.insert(strip_suffix(name, ".nodes.ndjson"));
            }
        }

        std::cerr << "Bboxes trouvees: " << bases.size() << "\n";

        std::size_t index = 0;
        for (const auto &base : bases)
        {
            ++index;
            if (index % 100 == 0 || index == 1)
            {
                std::cerr << "Traitement " << index << "/" << bases.size() << ": " << base << "\n";
            }

            const fs::path ways_path = fs::path(cfg.in_dir) / (base + ".ways.ndjson");
            const fs::path nodes_path = fs::path(cfg.in_dir) / (base + ".nodes.ndjson");

            if (!fs::exists(ways_path))
            {
                std::cerr << "  ignore: missing " << ways_path.filename().string() << "\n";
                continue;
            }
            if (!fs::exists(nodes_path))
            {
                std::cerr << "  ignore: missing " << nodes_path.filename().string() << "\n";
                continue;
            }

            auto ways = load_ways(ways_path);
            auto nodes = load_nodes(nodes_path);

            const std::string bbox_key = key_from_base(base);
            const fs::path out_path = fs::path(cfg.out_dir) / ("cache_" + base + ".json");

            write_final_json(out_path, bbox_key, cfg.created_at, cfg.fetched_at, ways, nodes);
        }

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