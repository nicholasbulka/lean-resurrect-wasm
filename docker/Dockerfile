# Lean 4 WASM build environment.
#
# Image bakes in: build-essential, cmake, ccache, the 32-bit cross-compile bits
# Lean's stage0 needs (-m32 on clang), and emsdk pinned to a known-working
# version. The Lean source tree, build dir, and ccache cache are all mounted
# from the host so rebuilds persist across container runs.
#
# Build:   docker build -t lean-wasm-build docker/
# Run:     scripts/docker-build.sh    (see that script for volumes/entry)

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Build deps. gcc-multilib provides 32-bit headers and libs for -m32 stage0.
# i386-arch package list provides libuv:i386 since Lean's stage0 links a
# native 32-bit libuv.
RUN dpkg --add-architecture i386 \
  && apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      gcc-multilib g++-multilib \
      clang \
      make ninja-build \
      git ca-certificates \
      python3 python3-pip \
      ccache zstd \
      libgmp-dev libuv1-dev pkg-config \
      libuv1-dev:i386 libgmp-dev:i386 \
      curl xz-utils \
  && rm -rf /var/lib/apt/lists/*

# Lean's stage1 CMakeLists uses `block()` (CMake 3.25+). Ubuntu 22.04 ships
# 3.22, so install a newer CMake from upstream's binary release.
ARG CMAKE_VERSION=3.30.5
RUN curl -fsSL "https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-linux-x86_64.tar.gz" \
    | tar -xz -C /opt && ln -s /opt/cmake-${CMAKE_VERSION}-linux-x86_64 /opt/cmake \
  && /opt/cmake/bin/cmake --version | head -1

# Pin emsdk. Latest known to work for the linux_wasm32 path is recent main;
# we'll pin to a tagged release for reproducibility. Adjust if upstream
# moves required minimum.
ARG EMSDK_VERSION=3.1.74
RUN git clone --depth 1 https://github.com/emscripten-core/emsdk.git /opt/emsdk \
  && cd /opt/emsdk \
  && ./emsdk install ${EMSDK_VERSION} \
  && ./emsdk activate ${EMSDK_VERSION} \
  && bash -c 'source /opt/emsdk/emsdk_env.sh && embuilder build sysroot'

# Wire emsdk into PATH and EMSDK env var for non-interactive use.
ENV EMSDK=/opt/emsdk
# PATH order matters. Stage0 uses unqualified `clang` and `-fuse-ld=lld`,
# which must resolve to Ubuntu's apt-installed clang/ld.lld so that the
# 32-bit multilib link works. Emsdk's clang/lld can't handle the m32
# Lean stage0 layout. Stage1 invokes emcc/emcmake/emconfigure/embuilder
# directly — those land further down PATH and still resolve fine.
ENV PATH=/opt/cmake/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/emsdk:/opt/emsdk/upstream/emscripten:/opt/emsdk/node/22.16.0_64bit/bin
ENV CCACHE_DIR=/cache/ccache
ENV CCACHE_MAXSIZE=10G

# Sanity check
RUN cmake --version && clang --version | head -1 && emcc --version | head -1

WORKDIR /work
CMD ["/bin/bash"]
