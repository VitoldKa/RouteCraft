#include <cstdint>
#include <iostream>

#include <osmium/handler.hpp>
#include <osmium/io/any_input.hpp>
#include <osmium/visitor.hpp>

struct NodeCoord
{
    std::uint64_t id = 0;
    std::int32_t lat_e7 = 0;
    std::int32_t lon_e7 = 0;
};

class CountHandler : public osmium::handler::Handler
{
public:
    std::uint64_t nodes = 0;
    std::uint64_t ways = 0;
    std::uint64_t relations = 0;

    void node(const osmium::Node &nd) noexcept
    {
        ++nodes;
    }

    void way(const osmium::Way &) noexcept
    {
        ++ways;
    }

    void relation(const osmium::Relation &) noexcept
    {
        ++relations;
    }
};

int main(int argc, char **argv)
{
    if (argc < 2)
    {
        std::cerr << "Usage: count_osm <input.osm.pbf>\n";
        return 1;
    }

    try
    {
        osmium::io::File infile{argv[1]};
        osmium::io::Reader reader{
            infile,
            osmium::osm_entity_bits::node |
                osmium::osm_entity_bits::way |
                osmium::osm_entity_bits::relation};

        CountHandler handler;
        handler.nodemap.reserve(800'000'000);
        osmium::apply(reader, handler);
        reader.close();

        // std::cout << "map size: " << handler.nodemap.count() << "\n";
        std::cout << "nodes: " << handler.nodes << "\n";
        std::cout << "ways: " << handler.ways << "\n";
        std::cout << "relations: " << handler.relations << "\n";
    }
    catch (const std::exception &e)
    {
        std::cerr << "Erreur: " << e.what() << "\n";
        return 1;
    }

    return 0;
}
