/*
g++ -O3 -std=c++17 phase2_spatial_compact_mt.cpp -pthread -o phase2_spatial_compact_mt
*/

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <ctime>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace fs = std::filesystem;

struct Config
{
    std::string in_dir = "tmp_spatial";
    std::string out_dir = "spatial_cache";
    std::uint64_t created_at = 0;
    std::uint64_t fetched_at = 0;
    double bbox_size = 0.01;
    double tile_size = 0.05;
    int precision = 5;
    std::size_t worker_threads = 0;      // 0 => auto
    std::size_t queue_capacity = 8192;
    std::uint64_t progress_interval_ms = 500;
};

class HelpRequested : public std::runtime_error
{
public:
    using std::runtime_error::runtime_error;
};

static std::string cli_program_name(const char *argv0)
{
    const fs::path path = argv0 ? fs::path(argv0) : fs::path("phase2_spatial_compact");
    const std::string name = path.filename().string();
    return name.empty() ? "phase2_spatial_compact" : name;
}

static std::string build_help_text(const std::string &program_name)
{
    std::ostringstream out;
    out << "Compact the intermediate spatial cache into frontend-ready JSON shards.\n"
        << "\n"
        << "This phase reads the temporary output from phase 1, merges duplicate\n"
        << "records per tile, and writes the final sharded cache consumed by the app.\n"
        << "\n"
        << "Usage:\n"
        << "  " << program_name << " [options]\n"
        << "\n"
        << "Options:\n"
        << "  --in-dir DIR\n"
        << "      Input directory produced by phase 1.\n"
        << "      Default: tmp_spatial\n"
        << "\n"
        << "  --out-dir DIR\n"
        << "      Output directory for the compacted cache.\n"
        << "      Default: spatial_cache\n"
        << "\n"
        << "  --threads N\n"
        << "      Number of worker threads.\n"
        << "      Use 0 to auto-select based on available CPU cores.\n"
        << "      Default: 0\n"
        << "\n"
        << "  --queue-capacity N\n"
        << "      Maximum number of pending jobs in the work queues.\n"
        << "      Default: 8192\n"
        << "\n"
        << "  --progress-interval-ms N\n"
        << "      Minimum delay between live progress updates in milliseconds.\n"
        << "      Default: 500\n"
        << "\n"
        << "  -h, --help\n"
        << "      Show this help message.\n"
        << "\n"
        << "Behavior:\n"
        << "  - Reads phase 1 metadata from <in-dir>/phase1_config.json.\n"
        << "  - Reuses phase 1 bbox size, tile size, precision, and timestamps.\n"
        << "  - Reuses phase 1 tile counts to show live compaction progress.\n"
        << "  - Copies phase 1 metadata into the final cache output.\n"
        << "  - Writes <out-dir>/phase2_config.json with compaction stats.\n"
        << "\n"
        << "Outputs:\n"
        << "  <out-dir>/bbox-index/\n"
        << "      Final sharded bbox index JSON files.\n"
        << "  <out-dir>/content-tiles/\n"
        << "      Final sharded way/node payload JSON files.\n"
        << "  <out-dir>/phase1_config.json\n"
        << "      Phase 1 metadata copied forward when present.\n"
        << "  <out-dir>/phase2_config.json\n"
        << "      Metadata describing the compaction run and output counts.\n"
        << "\n"
        << "Examples:\n"
        << "  " << program_name << "\n"
        << "  " << program_name << " --in-dir tmp_spatial --out-dir spatial_cache\n"
        << "  " << program_name << " --in-dir tmp_spatial --out-dir spatial_cache --threads 8\n"
        << "  " << program_name << " --progress-interval-ms 200\n";
    return out.str();
}

struct TileId
{
    long yi = 0;
    long xi = 0;

    bool operator==(const TileId &other) const noexcept
    {
        return yi == other.yi && xi == other.xi;
    }

    bool operator<(const TileId &other) const noexcept
    {
        if (yi != other.yi) return yi < other.yi;
        return xi < other.xi;
    }
};

struct TileIdHash
{
    std::size_t operator()(const TileId &t) const noexcept
    {
        const std::uint64_t a = static_cast<std::uint64_t>(static_cast<std::int64_t>(t.yi));
        const std::uint64_t b = static_cast<std::uint64_t>(static_cast<std::int64_t>(t.xi));

        std::uint64_t x = a * 0x9E3779B185EBCA87ULL;
        x ^= b + 0xC2B2AE3D27D4EB4FULL + (x << 6) + (x >> 2);
        return static_cast<std::size_t>(x);
    }
};

struct TileFiles
{
    fs::path ways;
    fs::path nodes;
};

enum class JobKind
{
    BboxIndex,
    ContentTile
};

struct BboxJob
{
    TileId bbox;
    fs::path refs_path;
};

struct ContentJob
{
    TileId tile;
    fs::path ways_path;
    fs::path nodes_path;
};

struct Job
{
    std::uint64_t seq = 0;
    JobKind kind = JobKind::BboxIndex;
    BboxJob bbox_job;
    ContentJob content_job;
};

struct Result
{
    std::uint64_t seq = 0;
    JobKind kind = JobKind::BboxIndex;
    TileId id;
    std::string json;
};

struct RunStats
{
    std::uint64_t total_jobs = 0;
    std::uint64_t bbox_jobs = 0;
    std::uint64_t content_jobs = 0;
};

struct Phase1Stats
{
    bool loaded = false;
    std::optional<std::uint64_t> ways_matched;
    std::optional<std::uint64_t> bbox_refs_written;
    std::optional<std::uint64_t> bbox_tile_count;
    std::optional<std::uint64_t> content_tile_count;
    std::optional<std::uint64_t> written_at;
    std::optional<double> bbox_size;
    std::optional<double> tile_size;
    std::optional<int> precision;
};

struct ProgressState
{
    std::uint64_t total_jobs = 0;
    std::uint64_t bbox_jobs_total = 0;
    std::uint64_t content_jobs_total = 0;
    std::atomic<std::uint64_t> jobs_enqueued{0};
    std::atomic<std::uint64_t> jobs_written{0};
    std::atomic<std::uint64_t> bbox_written{0};
    std::atomic<std::uint64_t> content_written{0};
};

template <typename T>
class BlockingQueue
{
public:
    explicit BlockingQueue(std::size_t capacity) : capacity_(capacity) {}

    bool push(T value)
    {
        std::unique_lock<std::mutex> lock(mutex_);
        cv_not_full_.wait(lock, [&] { return closed_ || queue_.size() < capacity_; });
        if (closed_) return false;
        queue_.push_back(std::move(value));
        cv_not_empty_.notify_one();
        return true;
    }

    bool pop(T &out)
    {
        std::unique_lock<std::mutex> lock(mutex_);
        cv_not_empty_.wait(lock, [&] { return closed_ || !queue_.empty(); });
        if (queue_.empty()) return false;
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

class DirCache
{
public:
    void ensure_parent(const fs::path &path)
    {
        const std::string dir = path.parent_path().string();
        if (created_.find(dir) == created_.end())
        {
            fs::create_directories(path.parent_path());
            created_.insert(dir);
        }
    }

private:
    std::unordered_set<std::string> created_;
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

static std::string fmt(double v, int precision)
{
    std::ostringstream oss;
    oss.setf(std::ios::fixed);
    oss.precision(precision);
    oss << v;
    return oss.str();
}

static std::string json_escape(std::string_view s)
{
    std::string out;
    out.reserve(s.size() + 8);
    for (unsigned char c : s)
    {
        switch (c)
        {
        case '\"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
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

static std::uint64_t unix_time_ms()
{
    return static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch())
            .count());
}

static std::string trim_ascii(std::string s)
{
    while (!s.empty() && std::isspace(static_cast<unsigned char>(s.back())))
        s.pop_back();

    std::size_t start = 0;
    while (start < s.size() && std::isspace(static_cast<unsigned char>(s[start])))
        ++start;

    return s.substr(start);
}

static std::string iso_utc_from_time_t(std::time_t value)
{
    std::tm tm{};
#ifdef _WIN32
    gmtime_s(&tm, &value);
#else
    gmtime_r(&value, &tm);
#endif

    char buf[32];
    if (std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tm) == 0)
        throw std::runtime_error("Impossible de formatter le timestamp UTC");

    return buf;
}

static std::string iso_utc_now()
{
    return iso_utc_from_time_t(std::time(nullptr));
}

static std::string shell_quote(const std::string &value)
{
    std::string out = "'";
    for (char c : value)
    {
        if (c == '\'')
            out += "'\\''";
        else
            out.push_back(c);
    }
    out.push_back('\'');
    return out;
}

static std::string join_command_line(int argc, char **argv)
{
    std::string out;
    for (int i = 0; i < argc; ++i)
    {
        if (i)
            out.push_back(' ');
        out += shell_quote(argv[i] ? argv[i] : "");
    }
    return out;
}

static std::string capture_command_output(const std::string &command)
{
#ifdef _WIN32
    return "";
#else
    FILE *pipe = popen(command.c_str(), "r");
    if (!pipe)
        return "";

    std::string out;
    char buf[512];
    while (std::fgets(buf, sizeof(buf), pipe))
        out += buf;

    const int rc = pclose(pipe);
    if (rc != 0)
        return "";

    return trim_ascii(out);
#endif
}

static std::string git_commit_from_cwd()
{
#ifdef _WIN32
    return "";
#else
    return capture_command_output("git rev-parse HEAD 2>/dev/null");
#endif
}

static RunStats collect_compacted_output_stats(const Config &cfg)
{
    RunStats stats;

    const fs::path bbox_root = fs::path(cfg.out_dir) / "bbox-index";
    if (fs::exists(bbox_root))
    {
        for (const auto &entry : fs::recursive_directory_iterator(bbox_root))
        {
            if (entry.is_regular_file() && ends_with(entry.path().string(), ".json"))
                ++stats.bbox_jobs;
        }
    }

    const fs::path content_root = fs::path(cfg.out_dir) / "content-tiles";
    if (fs::exists(content_root))
    {
        for (const auto &entry : fs::recursive_directory_iterator(content_root))
        {
            if (entry.is_regular_file() && ends_with(entry.path().string(), ".json"))
                ++stats.content_jobs;
        }
    }

    stats.total_jobs = stats.bbox_jobs + stats.content_jobs;
    return stats;
}

static std::optional<std::uint64_t> extract_uint_field(std::string_view line, std::string_view field)
{
    const std::string needle = "\"" + std::string(field) + "\":";
    const auto pos = line.find(needle);
    if (pos == std::string_view::npos) return std::nullopt;

    std::size_t i = pos + needle.size();
    while (i < line.size() && std::isspace(static_cast<unsigned char>(line[i]))) ++i;

    std::uint64_t v = 0;
    bool has_digit = false;
    while (i < line.size() && std::isdigit(static_cast<unsigned char>(line[i])))
    {
        has_digit = true;
        v = v * 10 + static_cast<unsigned>(line[i] - '0');
        ++i;
    }
    if (!has_digit) return std::nullopt;
    return v;
}

static std::optional<long> extract_long_field(std::string_view line, std::string_view field)
{
    const std::string needle = "\"" + std::string(field) + "\":";
    const auto pos = line.find(needle);
    if (pos == std::string_view::npos) return std::nullopt;

    std::size_t i = pos + needle.size();
    while (i < line.size() && std::isspace(static_cast<unsigned char>(line[i]))) ++i;

    bool neg = false;
    if (i < line.size() && line[i] == '-')
    {
        neg = true;
        ++i;
    }

    long v = 0;
    bool has_digit = false;
    while (i < line.size() && std::isdigit(static_cast<unsigned char>(line[i])))
    {
        has_digit = true;
        v = v * 10 + static_cast<long>(line[i] - '0');
        ++i;
    }

    if (!has_digit) return std::nullopt;
    return neg ? -v : v;
}

static std::optional<double> extract_double_field(std::string_view line, std::string_view field)
{
    const std::string needle = "\"" + std::string(field) + "\":";
    const auto pos = line.find(needle);
    if (pos == std::string_view::npos) return std::nullopt;

    std::size_t i = pos + needle.size();
    while (i < line.size() && std::isspace(static_cast<unsigned char>(line[i]))) ++i;

    std::size_t end = i;
    if (end < line.size() && (line[end] == '-' || line[end] == '+')) ++end;
    while (end < line.size())
    {
        const unsigned char c = static_cast<unsigned char>(line[end]);
        if (std::isdigit(c) || c == '.' || c == 'e' || c == 'E' || c == '-' || c == '+')
            ++end;
        else
            break;
    }

    if (end == i) return std::nullopt;

    try
    {
        return std::stod(std::string(line.substr(i, end - i)));
    }
    catch (...)
    {
        return std::nullopt;
    }
}

static Phase1Stats read_phase1_stats(const Config &cfg)
{
    const fs::path path = fs::path(cfg.in_dir) / "phase1_config.json";
    Phase1Stats stats;

    std::ifstream in(path, std::ios::binary);
    if (!in)
        return stats;

    stats.loaded = true;

    std::string line;
    while (std::getline(in, line))
    {
        if (!stats.ways_matched)
            stats.ways_matched = extract_uint_field(line, "waysMatched");
        if (!stats.bbox_refs_written)
            stats.bbox_refs_written = extract_uint_field(line, "bboxRefsWritten");
        if (!stats.bbox_tile_count)
            stats.bbox_tile_count = extract_uint_field(line, "bboxTileCount");
        if (!stats.content_tile_count)
            stats.content_tile_count = extract_uint_field(line, "contentTileCount");
        if (!stats.written_at)
            stats.written_at = extract_uint_field(line, "writtenAt");
        if (!stats.bbox_size)
            stats.bbox_size = extract_double_field(line, "bboxSize");
        if (!stats.tile_size)
            stats.tile_size = extract_double_field(line, "tileSize");
        if (!stats.precision)
        {
            const auto p = extract_uint_field(line, "precision");
            if (p) stats.precision = static_cast<int>(*p);
        }
    }

    return stats;
}

static void print_phase1_stats_summary(const Phase1Stats &stats)
{
    if (!stats.loaded)
        return;

    std::cerr << "Phase 1 metadata:";
    if (stats.bbox_size)
        std::cerr << " bboxSize=" << *stats.bbox_size;
    if (stats.tile_size)
        std::cerr << " tileSize=" << *stats.tile_size;
    if (stats.precision)
        std::cerr << " precision=" << *stats.precision;
    if (stats.ways_matched)
        std::cerr << " waysMatched=" << *stats.ways_matched;
    if (stats.bbox_refs_written)
        std::cerr << " bboxRefsWritten=" << *stats.bbox_refs_written;
    if (stats.bbox_tile_count)
        std::cerr << " bboxTileCount=" << *stats.bbox_tile_count;
    if (stats.content_tile_count)
        std::cerr << " contentTileCount=" << *stats.content_tile_count;
    std::cerr << "\n";
}

static void apply_phase1_config_defaults(
    Config &cfg,
    const Phase1Stats &phase1_stats,
    std::uint64_t fallback_time_ms)
{
    if (phase1_stats.bbox_size)
        cfg.bbox_size = *phase1_stats.bbox_size;
    if (phase1_stats.tile_size)
        cfg.tile_size = *phase1_stats.tile_size;
    if (phase1_stats.precision)
        cfg.precision = *phase1_stats.precision;

    const std::uint64_t derived_time = phase1_stats.written_at.value_or(fallback_time_ms);
    cfg.created_at = derived_time;
    cfg.fetched_at = derived_time;
}

static void warn_if_phase1_counts_differ(const Phase1Stats &phase1_stats, const RunStats &run_stats)
{
    if (phase1_stats.bbox_tile_count && *phase1_stats.bbox_tile_count != run_stats.bbox_jobs)
    {
        std::cerr << "Warning: phase1 bboxTileCount=" << *phase1_stats.bbox_tile_count
                  << " but phase2 indexed " << run_stats.bbox_jobs << " bbox jobs\n";
    }

    if (phase1_stats.content_tile_count && *phase1_stats.content_tile_count != run_stats.content_jobs)
    {
        std::cerr << "Warning: phase1 contentTileCount=" << *phase1_stats.content_tile_count
                  << " but phase2 indexed " << run_stats.content_jobs << " content jobs\n";
    }
}

static void print_progress_line(const ProgressState &progress)
{
    const std::uint64_t total = progress.total_jobs;
    const std::uint64_t queued = progress.jobs_enqueued.load();
    const std::uint64_t written = progress.jobs_written.load();
    const std::uint64_t bbox_written = progress.bbox_written.load();
    const std::uint64_t content_written = progress.content_written.load();
    const std::uint64_t pct = total == 0 ? 100 : (written * 100 / total);

    std::cerr << "\rProgress: " << written << "/" << total
              << " jobs (" << pct << "%)"
              << " | queued " << queued << "/" << total
              << " | bbox " << bbox_written << "/" << progress.bbox_jobs_total
              << " | content " << content_written << "/" << progress.content_jobs_total
              << "   "
              << std::flush;
}

static void progress_loop(
    const ProgressState &progress,
    std::atomic<bool> &done,
    std::uint64_t interval_ms)
{
    const auto sleep_for = std::chrono::milliseconds(
        interval_ms == 0 ? 500 : interval_ms);

    while (!done.load())
    {
        print_progress_line(progress);
        std::this_thread::sleep_for(sleep_for);
    }

    print_progress_line(progress);
    std::cerr << "\n";
}

static std::optional<TileId> parse_tile_id_from_base(const std::string &base)
{
    const auto pos = base.find('_');
    if (pos == std::string::npos) return std::nullopt;

    try
    {
        TileId t;
        t.yi = std::stol(base.substr(0, pos));
        t.xi = std::stol(base.substr(pos + 1));
        return t;
    }
    catch (...)
    {
        return std::nullopt;
    }
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

static std::string key_from_indices(long yi, long xi, double size, int precision)
{
    const double s = yi * size;
    const double w = xi * size;
    const double n = s + size;
    const double e = w + size;
    return fmt(s, precision) + "," + fmt(w, precision) + "," +
           fmt(n, precision) + "," + fmt(e, precision);
}

static std::string build_bbox_json(const Config &cfg, const BboxJob &job)
{
    std::unordered_set<std::uint64_t> way_ids_set;
    std::unordered_set<TileId, TileIdHash> content_tiles_set;

    std::ifstream in(job.refs_path, std::ios::binary);
    if (!in)
        throw std::runtime_error("Impossible d'ouvrir " + job.refs_path.string());

    std::string line;
    while (std::getline(in, line))
    {
        if (line.empty()) continue;

        auto way_id = extract_uint_field(line, "wayId");
        auto cyi = extract_long_field(line, "yi");
        auto cxi = extract_long_field(line, "xi");

        if (way_id) way_ids_set.insert(*way_id);
        if (cyi && cxi) content_tiles_set.insert(TileId{*cyi, *cxi});
    }

    std::vector<std::uint64_t> way_ids(way_ids_set.begin(), way_ids_set.end());
    std::sort(way_ids.begin(), way_ids.end());

    std::vector<TileId> content_tiles(content_tiles_set.begin(), content_tiles_set.end());
    std::sort(content_tiles.begin(), content_tiles.end());

    const std::string key = key_from_indices(job.bbox.yi, job.bbox.xi, cfg.bbox_size, cfg.precision);

    std::ostringstream out;
    out << "{";
    out << "\"key\":\"" << json_escape(key) << "\",";
    out << "\"bbox\":{\"yi\":" << job.bbox.yi << ",\"xi\":" << job.bbox.xi << "},";
    out << "\"wayIds\":[";
    for (std::size_t i = 0; i < way_ids.size(); ++i)
    {
        if (i) out << ",";
        out << way_ids[i];
    }
    out << "],";
    out << "\"contentTiles\":[";
    for (std::size_t i = 0; i < content_tiles.size(); ++i)
    {
        if (i) out << ",";
        out << "{\"yi\":" << content_tiles[i].yi << ",\"xi\":" << content_tiles[i].xi << "}";
    }
    out << "],";
    out << "\"fetchedAt\":" << cfg.fetched_at;
    out << "}";

    return out.str();
}

static std::string build_content_json(const Config &cfg, const ContentJob &job)
{
    std::unordered_map<std::uint64_t, std::string> ways_map;
    std::unordered_map<std::uint64_t, std::string> nodes_map;

    {
        std::ifstream in(job.ways_path, std::ios::binary);
        if (!in)
            throw std::runtime_error("Impossible d'ouvrir " + job.ways_path.string());

        std::string line;
        while (std::getline(in, line))
        {
            if (line.empty()) continue;
            auto id = extract_uint_field(line, "id");
            if (!id) continue;
            ways_map[*id] = std::move(line);
        }
    }

    {
        std::ifstream in(job.nodes_path, std::ios::binary);
        if (!in)
            throw std::runtime_error("Impossible d'ouvrir " + job.nodes_path.string());

        std::string line;
        while (std::getline(in, line))
        {
            if (line.empty()) continue;
            auto id = extract_uint_field(line, "id");
            if (!id) continue;
            nodes_map[*id] = std::move(line);
        }
    }

    std::vector<std::pair<std::uint64_t, std::string>> ways;
    ways.reserve(ways_map.size());
    for (auto &kv : ways_map) ways.push_back(std::move(kv));
    std::sort(ways.begin(), ways.end(),
              [](const auto &a, const auto &b) { return a.first < b.first; });

    std::vector<std::pair<std::uint64_t, std::string>> nodes;
    nodes.reserve(nodes_map.size());
    for (auto &kv : nodes_map) nodes.push_back(std::move(kv));
    std::sort(nodes.begin(), nodes.end(),
              [](const auto &a, const auto &b) { return a.first < b.first; });

    const std::string tile_key = key_from_indices(job.tile.yi, job.tile.xi, cfg.tile_size, cfg.precision);

    std::ostringstream out;
    out << "{";
    out << "\"tile\":\"" << json_escape(tile_key) << "\",";
    out << "\"tileCoord\":{\"yi\":" << job.tile.yi << ",\"xi\":" << job.tile.xi << "},";
    out << "\"createdAt\":" << cfg.created_at << ",";
    out << "\"ways\":[";
    for (std::size_t i = 0; i < ways.size(); ++i)
    {
        if (i) out << ",";
        out << ways[i].second;
    }
    out << "],";
    out << "\"nodes\":[";
    for (std::size_t i = 0; i < nodes.size(); ++i)
    {
        if (i) out << ",";
        out << nodes[i].second;
    }
    out << "],";
    out << "\"fetchedAt\":" << cfg.fetched_at;
    out << "}";

    return out.str();
}

static void worker_loop(const Config &cfg, BlockingQueue<Job> &job_queue, BlockingQueue<Result> &result_queue)
{
    Job job;
    while (job_queue.pop(job))
    {
        Result r;
        r.seq = job.seq;
        r.kind = job.kind;

        if (job.kind == JobKind::BboxIndex)
        {
            r.id = job.bbox_job.bbox;
            r.json = build_bbox_json(cfg, job.bbox_job);
        }
        else
        {
            r.id = job.content_job.tile;
            r.json = build_content_json(cfg, job.content_job);
        }

        if (!result_queue.push(std::move(r)))
            return;
    }
}

static void writer_loop(const Config &cfg, BlockingQueue<Result> &result_queue, ProgressState *progress)
{
    const fs::path bbox_root = fs::path(cfg.out_dir) / "bbox-index";
    const fs::path content_root = fs::path(cfg.out_dir) / "content-tiles";

    fs::create_directories(bbox_root);
    fs::create_directories(content_root);

    DirCache dir_cache;
    std::unordered_map<std::uint64_t, Result> pending;
    std::uint64_t next_seq = 0;

    auto flush_ready = [&]()
    {
        for (;;)
        {
            auto it = pending.find(next_seq);
            if (it == pending.end()) break;

            const Result &r = it->second;
            fs::path out_path = (r.kind == JobKind::BboxIndex)
                ? deterministic_sharded_path(bbox_root, r.id.yi, r.id.xi, ".json")
                : deterministic_sharded_path(content_root, r.id.yi, r.id.xi, ".json");

            dir_cache.ensure_parent(out_path);

            std::ofstream out(out_path, std::ios::binary);
            if (!out)
                throw std::runtime_error("Impossible d'ouvrir " + out_path.string());

            out.write(r.json.data(), static_cast<std::streamsize>(r.json.size()));

            pending.erase(it);
            ++next_seq;

            if (progress)
            {
                progress->jobs_written.fetch_add(1);
                if (r.kind == JobKind::BboxIndex)
                    progress->bbox_written.fetch_add(1);
                else
                    progress->content_written.fetch_add(1);
            }
        }
    };

    Result r;
    while (result_queue.pop(r))
    {
        pending.emplace(r.seq, std::move(r));
        flush_ready();
    }

    flush_ready();
}

static bool copy_phase1_config_if_present(const Config &cfg)
{
    const fs::path source = fs::path(cfg.in_dir) / "phase1_config.json";
    if (!fs::exists(source))
        return false;

    const fs::path destination = fs::path(cfg.out_dir) / "phase1_config.json";
    fs::copy_file(source, destination, fs::copy_options::overwrite_existing);
    return true;
}

static void write_phase2_metadata(
    const Config &cfg,
    const RunStats &stats,
    const Phase1Stats &phase1_stats,
    bool phase1_config_copied,
    const std::string &phase2_command,
    const std::string &git_commit,
    std::uint64_t started_at_ms,
    const std::string &started_at_iso,
    std::uint64_t finished_at_ms,
    const std::string &finished_at_iso,
    std::uint64_t duration_ms)
{
    const RunStats compacted_output_stats = collect_compacted_output_stats(cfg);

    const fs::path path = fs::path(cfg.out_dir) / "phase2_config.json";
    const fs::path tmp_path = path.string() + ".tmp";

    std::ofstream out(tmp_path, std::ios::binary | std::ios::trunc);
    if (!out)
        throw std::runtime_error("Impossible d'ouvrir " + tmp_path.string());

    out << "{\n"
        << "  \"generator\": \"phase2_spatial_compact\",\n"
        << "  \"gitCommit\": \"" << json_escape(git_commit) << "\",\n"
        << "  \"phase2Command\": \"" << json_escape(phase2_command) << "\",\n"
        << "  \"writtenAt\": " << finished_at_ms << ",\n"
        << "  \"writtenAtIso\": \"" << json_escape(finished_at_iso) << "\",\n"
        << "  \"generationStartedAt\": " << started_at_ms << ",\n"
        << "  \"generationStartedAtIso\": \"" << json_escape(started_at_iso) << "\",\n"
        << "  \"generationFinishedAt\": " << finished_at_ms << ",\n"
        << "  \"generationFinishedAtIso\": \"" << json_escape(finished_at_iso) << "\",\n"
        << "  \"generationDurationMs\": " << duration_ms << ",\n"
        << "  \"inDir\": \"" << json_escape(cfg.in_dir) << "\",\n"
        << "  \"outDir\": \"" << json_escape(cfg.out_dir) << "\",\n"
        << "  \"createdAt\": " << cfg.created_at << ",\n"
        << "  \"fetchedAt\": " << cfg.fetched_at << ",\n"
        << "  \"bboxSize\": " << fmt(cfg.bbox_size, cfg.precision) << ",\n"
        << "  \"tileSize\": " << fmt(cfg.tile_size, cfg.precision) << ",\n"
        << "  \"precision\": " << cfg.precision << ",\n"
        << "  \"workerThreads\": " << cfg.worker_threads << ",\n"
        << "  \"queueCapacity\": " << cfg.queue_capacity << ",\n"
        << "  \"phase1ConfigCopied\": " << (phase1_config_copied ? "true" : "false") << ",\n"
        << "  \"stats\": {\n"
        << "    \"jobCount\": " << stats.total_jobs << ",\n"
        << "    \"bboxJobCount\": " << stats.bbox_jobs << ",\n"
        << "    \"contentJobCount\": " << stats.content_jobs << ",\n"
        << "    \"phase1WaysMatched\": " << (phase1_stats.ways_matched ? std::to_string(*phase1_stats.ways_matched) : "null") << ",\n"
        << "    \"phase1BboxRefsWritten\": " << (phase1_stats.bbox_refs_written ? std::to_string(*phase1_stats.bbox_refs_written) : "null") << ",\n"
        << "    \"phase1BboxTileCount\": " << (phase1_stats.bbox_tile_count ? std::to_string(*phase1_stats.bbox_tile_count) : "null") << ",\n"
        << "    \"phase1ContentTileCount\": " << (phase1_stats.content_tile_count ? std::to_string(*phase1_stats.content_tile_count) : "null") << ",\n"
        << "    \"bboxTileCount\": " << compacted_output_stats.bbox_jobs << ",\n"
        << "    \"contentTileCount\": " << compacted_output_stats.content_jobs << "\n"
        << "  }\n"
        << "}\n";

    out.close();
    if (!out)
        throw std::runtime_error("Erreur d'ecriture " + tmp_path.string());

    fs::rename(tmp_path, path);
}

static Config parse_args(int argc, char **argv, const std::string &program_name)
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

        if (arg == "-h" || arg == "--help")
            throw HelpRequested(build_help_text(program_name));
        else if (arg == "--in-dir")
            cfg.in_dir = need("--in-dir");
        else if (arg == "--out-dir")
            cfg.out_dir = need("--out-dir");
        else if (arg == "--threads")
            cfg.worker_threads = static_cast<std::size_t>(std::stoull(need("--threads")));
        else if (arg == "--queue-capacity")
            cfg.queue_capacity = static_cast<std::size_t>(std::stoull(need("--queue-capacity")));
        else if (arg == "--progress-interval-ms")
            cfg.progress_interval_ms = std::stoull(need("--progress-interval-ms"));
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
        if (argc > 1)
        {
            const std::string_view first = argv[1] ? std::string_view(argv[1]) : std::string_view();
            if (first == "-h" || first == "--help")
            {
                std::cout << build_help_text(cli_program_name(argv[0]));
                return 0;
            }
        }

        Config cfg = parse_args(argc, argv, cli_program_name(argv[0]));
        const auto started_clock = std::chrono::steady_clock::now();
        const std::uint64_t started_at_ms = unix_time_ms();
        const std::string started_at_iso = iso_utc_now();
        const std::string phase2_command = join_command_line(argc, argv);
        const std::string git_commit = git_commit_from_cwd();

        if (!fs::exists(cfg.in_dir))
            throw std::runtime_error("Dossier introuvable: " + cfg.in_dir);

        fs::create_directories(cfg.out_dir);

        const fs::path bbox_in = fs::path(cfg.in_dir) / "bbox_index";
        const fs::path content_in = fs::path(cfg.in_dir) / "content_tiles";
        const Phase1Stats phase1_stats = read_phase1_stats(cfg);
        apply_phase1_config_defaults(cfg, phase1_stats, started_at_ms);

        if (!phase1_stats.loaded)
        {
            std::cerr << "Warning: phase1_config.json not found in " << cfg.in_dir
                      << "; using built-in defaults for layout and timestamps\n";
        }

        std::vector<Job> jobs;
        jobs.reserve(200000);
        RunStats run_stats;

        std::uint64_t seq = 0;

        // Indexation bbox refs
        if (fs::exists(bbox_in))
        {
            std::vector<fs::path> refs_files;
            for (const auto &entry : fs::recursive_directory_iterator(bbox_in))
            {
                if (!entry.is_regular_file()) continue;
                const std::string name = entry.path().filename().string();
                if (ends_with(name, ".refs.ndjson"))
                    refs_files.push_back(entry.path());
            }
            std::sort(refs_files.begin(), refs_files.end());

            for (const auto &path : refs_files)
            {
                const std::string base = strip_suffix(path.filename().string(), ".refs.ndjson");
                const auto bbox_id = parse_tile_id_from_base(base);
                if (!bbox_id) continue;

                Job job;
                job.seq = seq++;
                job.kind = JobKind::BboxIndex;
                job.bbox_job = BboxJob{*bbox_id, path};
                jobs.push_back(std::move(job));
                ++run_stats.bbox_jobs;
            }
        }

        // Indexation content tiles en un seul passage
        if (fs::exists(content_in))
        {
            std::unordered_map<TileId, TileFiles, TileIdHash> index;
            index.reserve(100000);

            for (const auto &entry : fs::recursive_directory_iterator(content_in))
            {
                if (!entry.is_regular_file()) continue;

                const std::string name = entry.path().filename().string();
                std::string base;

                if (ends_with(name, ".ways.ndjson"))
                    base = strip_suffix(name, ".ways.ndjson");
                else if (ends_with(name, ".nodes.ndjson"))
                    base = strip_suffix(name, ".nodes.ndjson");
                else
                    continue;

                const auto tile_id = parse_tile_id_from_base(base);
                if (!tile_id) continue;

                auto &slot = index[*tile_id];
                if (ends_with(name, ".ways.ndjson"))
                    slot.ways = entry.path();
                else
                    slot.nodes = entry.path();
            }

            std::vector<TileId> tiles;
            tiles.reserve(index.size());
            for (const auto &[tile, files] : index)
            {
                if (!files.ways.empty() && !files.nodes.empty())
                    tiles.push_back(tile);
            }
            std::sort(tiles.begin(), tiles.end());

            for (const auto &tile : tiles)
            {
                const auto it = index.find(tile);
                if (it == index.end()) continue;

                Job job;
                job.seq = seq++;
                job.kind = JobKind::ContentTile;
                job.content_job = ContentJob{tile, it->second.ways, it->second.nodes};
                jobs.push_back(std::move(job));
                ++run_stats.content_jobs;
            }
        }

        run_stats.total_jobs = static_cast<std::uint64_t>(jobs.size());
        warn_if_phase1_counts_differ(phase1_stats, run_stats);

        std::cerr << "Jobs total: " << jobs.size()
                  << " | worker_threads=" << cfg.worker_threads
                  << " | queue_capacity=" << cfg.queue_capacity << "\n";
        print_phase1_stats_summary(phase1_stats);

        BlockingQueue<Job> job_queue(cfg.queue_capacity);
        BlockingQueue<Result> result_queue(cfg.queue_capacity);
        ProgressState progress;
        progress.total_jobs = run_stats.total_jobs;
        progress.bbox_jobs_total = run_stats.bbox_jobs;
        progress.content_jobs_total = run_stats.content_jobs;
        std::atomic<bool> progress_done = false;

        std::thread writer(writer_loop, std::cref(cfg), std::ref(result_queue), &progress);
        std::thread progress_reporter(progress_loop,
                                      std::cref(progress),
                                      std::ref(progress_done),
                                      cfg.progress_interval_ms);

        std::vector<std::thread> workers;
        workers.reserve(cfg.worker_threads);
        for (std::size_t i = 0; i < cfg.worker_threads; ++i)
        {
            workers.emplace_back(worker_loop,
                                 std::cref(cfg),
                                 std::ref(job_queue),
                                 std::ref(result_queue));
        }

        for (std::size_t i = 0; i < jobs.size(); ++i)
        {
            if (!job_queue.push(std::move(jobs[i])))
                throw std::runtime_error("Queue jobs fermee trop tôt.");
            progress.jobs_enqueued.fetch_add(1);
        }

        job_queue.close();

        for (auto &t : workers) t.join();

        result_queue.close();
        writer.join();
        progress_done.store(true);
        progress_reporter.join();

        const bool phase1_config_copied = copy_phase1_config_if_present(cfg);
        const auto finished_clock = std::chrono::steady_clock::now();
        const std::uint64_t finished_at_ms = unix_time_ms();
        const std::string finished_at_iso = iso_utc_now();
        const std::uint64_t duration_ms = static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::milliseconds>(
                finished_clock - started_clock)
                .count());

        write_phase2_metadata(
            cfg,
            run_stats,
            phase1_stats,
            phase1_config_copied,
            phase2_command,
            git_commit,
            started_at_ms,
            started_at_iso,
            finished_at_ms,
            finished_at_iso,
            duration_ms);

        std::cerr << "Phase 2 terminee.\n";
        std::cerr << "Sortie: " << cfg.out_dir << "\n";
        return 0;
    }
    catch (const HelpRequested &help)
    {
        std::cout << help.what();
        return 0;
    }
    catch (const std::exception &e)
    {
        std::cerr << "Erreur: " << e.what() << "\n";
        return 1;
    }
}
