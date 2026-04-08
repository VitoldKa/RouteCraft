#pragma once

#include <chrono>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>

#include <osmium/io/reader.hpp>
#include <osmium/version.hpp>

namespace spatial_metadata
{
namespace fs = std::filesystem;

struct MetadataConfig
{
    std::string generator;
    std::string input_file;
    std::string out_dir;
    std::string metadata_file_name = "metadata.json";
    std::string command_field_name = "phaseCommand";
    double bbox_size = 0.0;
    double tile_size = 0.0;
    int precision = 5;
    std::size_t flush_every = 0;
    std::size_t worker_threads = 0;
    std::size_t queue_capacity = 0;
};

struct InputMetadata
{
    std::string header_generator;
    std::string header_timestamp;
    std::string replication_timestamp;
    std::string replication_sequence_number;
    std::string replication_base_url;
    bool header_box_valid = false;
    double header_box_min_lon = 0.0;
    double header_box_min_lat = 0.0;
    double header_box_max_lon = 0.0;
    double header_box_max_lat = 0.0;
    std::uint64_t file_size_bytes = 0;
    std::string file_sha256;
    std::uint64_t file_mtime_ms = 0;
    std::string file_mtime_iso;
};

struct OutputMetadata
{
    std::uint64_t bbox_tile_count = 0;
    std::uint64_t content_tile_count = 0;
};

struct GenerationMetadata
{
    std::uint64_t started_at_ms = 0;
    std::string started_at_iso;
    std::uint64_t finished_at_ms = 0;
    std::string finished_at_iso;
    std::uint64_t duration_ms = 0;
    std::uint64_t ways_seen = 0;
    std::uint64_t ways_matched = 0;
    std::uint64_t bbox_refs_written = 0;
    std::string phase_command;
    std::string git_commit;
};

inline constexpr int cache_format_version = 1;

inline std::string json_escape(std::string_view s)
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

inline std::string fmt(double v, int precision)
{
    std::ostringstream oss;
    oss.setf(std::ios::fixed);
    oss.precision(precision);
    oss << v;
    return oss.str();
}

inline bool ends_with(const std::string &s, const std::string &suffix)
{
    return s.size() >= suffix.size() &&
           s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
}

inline std::uint64_t unix_time_ms()
{
    return static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch())
            .count());
}

inline std::string trim_ascii(std::string s)
{
    while (!s.empty() && std::isspace(static_cast<unsigned char>(s.back())))
    {
        s.pop_back();
    }
    std::size_t start = 0;
    while (start < s.size() && std::isspace(static_cast<unsigned char>(s[start])))
    {
        ++start;
    }
    return s.substr(start);
}

inline std::string iso_utc_from_time_t(std::time_t value)
{
    std::tm tm{};
#ifdef _WIN32
    gmtime_s(&tm, &value);
#else
    gmtime_r(&value, &tm);
#endif

    char buf[32];
    if (std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tm) == 0)
    {
        throw std::runtime_error("Impossible de formatter le timestamp UTC");
    }
    return buf;
}

inline std::string iso_utc_now()
{
    return iso_utc_from_time_t(std::time(nullptr));
}

inline std::string shell_quote(const std::string &value)
{
    std::string out = "'";
    for (char c : value)
    {
        if (c == '\'')
        {
            out += "'\\''";
        }
        else
        {
            out.push_back(c);
        }
    }
    out.push_back('\'');
    return out;
}

inline std::string join_command_line(int argc, char **argv)
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

inline std::string capture_command_output(const std::string &command)
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
    {
        out += buf;
    }

    const int rc = pclose(pipe);
    if (rc != 0)
        return "";
    return trim_ascii(out);
#endif
}

inline std::string sha256_of_file(const std::string &path)
{
#ifdef _WIN32
    return "";
#else
    const std::string quoted = shell_quote(path);
    const std::string shasum_out =
        capture_command_output("shasum -a 256 " + quoted + " 2>/dev/null");
    if (!shasum_out.empty())
    {
        const std::size_t pos = shasum_out.find_first_of(" \t");
        return pos == std::string::npos ? shasum_out : shasum_out.substr(0, pos);
    }

    const std::string sha256sum_out =
        capture_command_output("sha256sum " + quoted + " 2>/dev/null");
    if (!sha256sum_out.empty())
    {
        const std::size_t pos = sha256sum_out.find_first_of(" \t");
        return pos == std::string::npos ? sha256sum_out : sha256sum_out.substr(0, pos);
    }

    return "";
#endif
}

inline std::string git_commit_from_cwd()
{
#ifdef _WIN32
    return "";
#else
    return capture_command_output("git rev-parse HEAD 2>/dev/null");
#endif
}

inline InputMetadata collect_input_metadata(const std::string &input_file)
{
    InputMetadata meta;

    try
    {
        meta.file_size_bytes = fs::file_size(input_file);
    }
    catch (...)
    {
    }

    try
    {
        const auto ftime = fs::last_write_time(input_file);
        const auto system_now = std::chrono::system_clock::now();
        const auto file_now = fs::file_time_type::clock::now();
        const auto system_tp = std::chrono::time_point_cast<std::chrono::system_clock::duration>(
            ftime - file_now + system_now);
        const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            system_tp.time_since_epoch());
        if (ms.count() > 0)
        {
            meta.file_mtime_ms = static_cast<std::uint64_t>(ms.count());
            meta.file_mtime_iso = iso_utc_from_time_t(
                std::chrono::system_clock::to_time_t(system_tp));
        }
    }
    catch (...)
    {
    }

    try
    {
        osmium::io::File infile{input_file};
        osmium::io::Reader header_reader{
            infile,
            osmium::osm_entity_bits::nothing};
        const osmium::io::Header header = header_reader.header();
        header_reader.close();

        meta.header_generator = header.get("generator");
        meta.header_timestamp = header.get("timestamp");
        meta.replication_timestamp = header.get("osmosis_replication_timestamp");
        meta.replication_sequence_number = header.get("osmosis_replication_sequence_number");
        meta.replication_base_url = header.get("osmosis_replication_base_url");

        const osmium::Box joined_box = header.joined_boxes();
        if (joined_box.valid())
        {
            meta.header_box_valid = true;
            meta.header_box_min_lon = joined_box.bottom_left().lon_without_check();
            meta.header_box_min_lat = joined_box.bottom_left().lat_without_check();
            meta.header_box_max_lon = joined_box.top_right().lon_without_check();
            meta.header_box_max_lat = joined_box.top_right().lat_without_check();
        }
    }
    catch (...)
    {
    }

    meta.file_sha256 = sha256_of_file(input_file);
    return meta;
}

inline OutputMetadata collect_output_metadata(
    const std::string &out_dir,
    const std::string &bbox_root_name = "bbox_index",
    const std::string &content_root_name = "content_tiles",
    const std::string &bbox_suffix = ".refs.ndjson",
    const std::string &content_suffix = ".ways.ndjson")
{
    OutputMetadata meta;

    const fs::path bbox_root = fs::path(out_dir) / bbox_root_name;
    if (fs::exists(bbox_root))
    {
        for (const auto &entry : fs::recursive_directory_iterator(bbox_root))
        {
            if (entry.is_regular_file() && ends_with(entry.path().string(), bbox_suffix))
            {
                ++meta.bbox_tile_count;
            }
        }
    }

    const fs::path content_root = fs::path(out_dir) / content_root_name;
    if (fs::exists(content_root))
    {
        for (const auto &entry : fs::recursive_directory_iterator(content_root))
        {
            if (entry.is_regular_file() && ends_with(entry.path().string(), content_suffix))
            {
                ++meta.content_tile_count;
            }
        }
    }

    return meta;
}

template <typename ExtraWriter>
inline void write_metadata_file(
    const MetadataConfig &cfg,
    const InputMetadata &input_meta,
    const OutputMetadata &output_meta,
    const GenerationMetadata &generation_meta,
    ExtraWriter &&extra_writer)
{
    fs::create_directories(cfg.out_dir);

    const fs::path path = fs::path(cfg.out_dir) / cfg.metadata_file_name;
    const fs::path tmp_path = path.string() + ".tmp";

    std::ofstream out(tmp_path, std::ios::binary | std::ios::trunc);
    if (!out)
    {
        throw std::runtime_error("Impossible d'ouvrir " + tmp_path.string());
    }

    out << "{\n"
        << "  \"cacheFormatVersion\": " << cache_format_version << ",\n"
        << "  \"generator\": \"" << json_escape(cfg.generator) << "\",\n"
        << "  \"libosmiumVersion\": \"" << LIBOSMIUM_VERSION_STRING << "\",\n"
        << "  \"gitCommit\": \"" << json_escape(generation_meta.git_commit) << "\",\n"
        << "  \"" << json_escape(cfg.command_field_name) << "\": \""
        << json_escape(generation_meta.phase_command) << "\",\n"
        << "  \"writtenAt\": " << generation_meta.finished_at_ms << ",\n"
        << "  \"writtenAtIso\": \"" << json_escape(generation_meta.finished_at_iso) << "\",\n"
        << "  \"generationStartedAt\": " << generation_meta.started_at_ms << ",\n"
        << "  \"generationStartedAtIso\": \"" << json_escape(generation_meta.started_at_iso) << "\",\n"
        << "  \"generationFinishedAt\": " << generation_meta.finished_at_ms << ",\n"
        << "  \"generationFinishedAtIso\": \"" << json_escape(generation_meta.finished_at_iso) << "\",\n"
        << "  \"generationDurationMs\": " << generation_meta.duration_ms << ",\n"
        << "  \"inputFile\": \"" << json_escape(cfg.input_file) << "\",\n"
        << "  \"inputFileSize\": " << input_meta.file_size_bytes << ",\n"
        << "  \"inputFileSha256\": \"" << json_escape(input_meta.file_sha256) << "\",\n"
        << "  \"outDir\": \"" << json_escape(cfg.out_dir) << "\",\n"
        << "  \"bboxSize\": " << fmt(cfg.bbox_size, cfg.precision) << ",\n"
        << "  \"tileSize\": " << fmt(cfg.tile_size, cfg.precision) << ",\n"
        << "  \"precision\": " << cfg.precision << ",\n"
        << "  \"flushEvery\": " << cfg.flush_every << ",\n"
        << "  \"workerThreads\": " << cfg.worker_threads << ",\n"
        << "  \"queueCapacity\": " << cfg.queue_capacity << ",\n";

    extra_writer(out);

    out << "  \"stats\": {\n"
        << "    \"waysSeen\": " << generation_meta.ways_seen << ",\n"
        << "    \"waysMatched\": " << generation_meta.ways_matched << ",\n"
        << "    \"bboxRefsWritten\": " << generation_meta.bbox_refs_written << ",\n"
        << "    \"bboxTileCount\": " << output_meta.bbox_tile_count << ",\n"
        << "    \"contentTileCount\": " << output_meta.content_tile_count << "\n"
        << "  },\n"
        << "  \"inputFileMeta\": {\n"
        << "    \"headerGenerator\": \"" << json_escape(input_meta.header_generator) << "\",\n"
        << "    \"headerTimestamp\": \"" << json_escape(input_meta.header_timestamp) << "\",\n"
        << "    \"osmosisReplicationTimestamp\": \"" << json_escape(input_meta.replication_timestamp) << "\",\n"
        << "    \"osmosisReplicationSequenceNumber\": \"" << json_escape(input_meta.replication_sequence_number) << "\",\n"
        << "    \"osmosisReplicationBaseUrl\": \"" << json_escape(input_meta.replication_base_url) << "\",\n"
        << "    \"headerBox\": {\n"
        << "      \"valid\": " << (input_meta.header_box_valid ? "true" : "false") << ",\n"
        << "      \"minLon\": " << fmt(input_meta.header_box_min_lon, cfg.precision) << ",\n"
        << "      \"minLat\": " << fmt(input_meta.header_box_min_lat, cfg.precision) << ",\n"
        << "      \"maxLon\": " << fmt(input_meta.header_box_max_lon, cfg.precision) << ",\n"
        << "      \"maxLat\": " << fmt(input_meta.header_box_max_lat, cfg.precision) << "\n"
        << "    },\n"
        << "    \"fileLastWriteAt\": " << input_meta.file_mtime_ms << ",\n"
        << "    \"fileLastWriteAtIso\": \"" << json_escape(input_meta.file_mtime_iso) << "\"\n"
        << "  }\n"
        << "}\n";

    out.close();
    if (!out)
    {
        throw std::runtime_error("Erreur d'ecriture " + tmp_path.string());
    }

    fs::rename(tmp_path, path);
}

} // namespace spatial_metadata
