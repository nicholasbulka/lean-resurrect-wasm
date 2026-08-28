# nanoda-wasm-spike: compile the nanoda_lib Rust Lean-kernel to wasm and run it.
#
# Feasibility probe for a CLIENT-SIDE Lean proof checker (no emscripten, no fork,
# no pthreads). Two stages:
#   build  — clone nanoda_lib, compile for wasm32-wasip1, report artifacts
#   run    — debian + wasmtime + the .wasm, ready to check an export via stdin
#
# The point of stage `build` is to LEARN whether nanoda compiles to wasi cleanly.
# Its `cargo build` output is the primary signal; capture it.

# ---- stage: build the wasm artifact -----------------------------------------
FROM rust:slim AS build
RUN rustup target add wasm32-wasip1
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 https://github.com/ammkrn/nanoda_lib
WORKDIR /src/nanoda_lib

# Show the crate layout so we know whether there's a bin target (nanoda_bin) or
# just a lib (in which case we add a thin main.rs wrapper in a later iteration).
RUN echo "=== crate layout ===" && ls -la && \
    echo "=== Cargo.toml ===" && cat Cargo.toml && \
    echo "=== src ===" && ls -la src 2>/dev/null && \
    (test -d nanoda_bin && echo "=== nanoda_bin ===" && ls -la nanoda_bin || true)

# Build the runnable checker binary (nanoda_bin) for wasi. The lib already
# compiles clean; the bin is what we actually run under wasmtime.
RUN echo "=== cargo build --bin nanoda_bin --target wasm32-wasip1 ===" && \
    cargo build --release --bin nanoda_bin --target wasm32-wasip1

RUN echo "=== wasm artifacts ===" && \
    find target/wasm32-wasip1/release -maxdepth 1 -name '*.wasm' -exec ls -la {} + && \
    mkdir -p /out && cp target/wasm32-wasip1/release/nanoda_bin.wasm /out/ && \
    ls -la /out

# ---- stage: runnable image with wasmtime ------------------------------------
FROM debian:bookworm-slim AS run
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates xz-utils \
    && rm -rf /var/lib/apt/lists/*
# wasmtime CLI (pinned) — runs the wasi module, granting stdin + a mapped dir.
ARG WASMTIME_VERSION=v27.0.0
RUN curl -sSfL "https://github.com/bytecodealliance/wasmtime/releases/download/${WASMTIME_VERSION}/wasmtime-${WASMTIME_VERSION}-x86_64-linux.tar.xz" \
      | tar -xJ -C /usr/local/bin --strip-components=1 --wildcards '*/wasmtime' \
    && wasmtime --version
COPY --from=build /out/ /nanoda/
WORKDIR /work
# Usage (config on stdin path or mapped dir):
#   docker run --rm -i -v $PWD:/work nanoda-wasm \
#     wasmtime run --dir /work /nanoda/<binary>.wasm /work/config.json
CMD ["ls", "-la", "/nanoda"]
