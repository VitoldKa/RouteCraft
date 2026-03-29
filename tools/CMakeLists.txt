cmake_minimum_required(VERSION 3.16)
project(phase1_spatial_index LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(phase1_spatial_index
    phase1_spatial_index.cpp
)

add_executable(phase2_spatial_compact
    phase2_spatial_compact.cpp
)

add_executable(count_osm
    count_osm.cpp
)

# Optimization flags
if(MSVC)
    target_compile_options(phase1_spatial_index PRIVATE /O2)
    target_compile_options(phase2_spatial_compact PRIVATE /O2)
    target_compile_options(count_osm PRIVATE /O2)
else()
    target_compile_options(phase1_spatial_index PRIVATE -O3)
    target_compile_options(phase2_spatial_compact PRIVATE -O3)
    target_compile_options(count_osm PRIVATE -O3)
endif()

if(WIN32 AND MINGW)
    target_include_directories(phase1_spatial_index PRIVATE /mingw64/include)
    target_include_directories(phase1_spatial_index PRIVATE build/libosmium/include)
    target_include_directories(phase1_spatial_index PRIVATE build/protozero/include)

    target_include_directories(count_osm PRIVATE /mingw64/include)
    target_include_directories(count_osm PRIVATE build/libosmium/include)
    target_include_directories(count_osm PRIVATE build/protozero/include)
elseif(APPLE)
    execute_process(COMMAND brew --prefix OUTPUT_VARIABLE BREW_PREFIX OUTPUT_STRIP_TRAILING_WHITESPACE)
    target_include_directories(phase1_spatial_index PRIVATE ${BREW_PREFIX}/include)
    target_include_directories(count_osm PRIVATE ${BREW_PREFIX}/include)
endif()

# Dependencies
find_package(Threads REQUIRED)
find_package(EXPAT REQUIRED)
find_package(ZLIB REQUIRED)
find_package(BZip2 REQUIRED)


target_link_libraries(phase1_spatial_index PRIVATE
    EXPAT::EXPAT
    ZLIB::ZLIB
    BZip2::BZip2
    Threads::Threads
)

target_link_libraries(count_osm PRIVATE
    EXPAT::EXPAT
    ZLIB::ZLIB
    BZip2::BZip2
    Threads::Threads
)

# libosmium and protozero are mostly header-only.
# If CMake can't find them automatically, uncomment:
#
# target_include_directories(phase1_spatial_index PRIVATE
#     /mingw64/include
# )