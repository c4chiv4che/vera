# ============================================================================
# Vera M2 Gateway — multi-stage Dockerfile
# ============================================================================
# Builder stage: compiles pjproject from source + Python bindings via SWIG,
# then uv-syncs the vera package deps.
# Runtime stage: slim image with only runtime libs + compiled artifacts + code.
#
# The pjproject build recipe is taken verbatim from the M1 spike's
# SIP_SPIKE_NOTES.md Fallback B, with PJPROJECT_TAG pinned to a release
# tag instead of HEAD (which during M1 was the moving 2.17-dev target).
# ============================================================================

ARG PJPROJECT_TAG=2.17

# -------- Stage 1: builder --------
FROM python:3.12-bookworm AS builder

# Build deps from M1 spike Fallback B + git for the clone
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        git \
        swig \
        libssl-dev \
        libasound2-dev \
        portaudio19-dev \
    && rm -rf /var/lib/apt/lists/*

# setuptools is required by pjproject SWIG's setup.py; distutils
# was removed from Python 3.12 so we explicitly install it.
RUN pip install --no-cache-dir setuptools wheel

# Compile pjproject
ARG PJPROJECT_TAG
WORKDIR /build
RUN git clone --depth 1 --branch ${PJPROJECT_TAG} https://github.com/pjsip/pjproject.git
WORKDIR /build/pjproject
RUN ./configure --enable-shared \
    && make dep \
    && make \
    && make install \
    && ldconfig

# Python bindings via SWIG
WORKDIR /build/pjproject/pjsip-apps/src/swig
RUN make python
WORKDIR /build/pjproject/pjsip-apps/src/swig/python
RUN python setup.py install

# Install uv (package manager used by the vera project)
RUN pip install --no-cache-dir uv

# uv-sync the vera package
WORKDIR /app
COPY agent/app/vera/ ./
RUN uv sync --frozen --no-dev

# -------- Stage 2: runtime --------
FROM python:3.12-slim-bookworm AS runtime

# Runtime libs only (no -dev headers, no build tools)
RUN apt-get update && apt-get install -y --no-install-recommends \
        libssl3 \
        libasound2 \
        libportaudio2 \
    && rm -rf /var/lib/apt/lists/*

# Copy compiled pjproject shared libraries AND its third_party deps
# from the builder. The libpj* glob alone misses libsrtp, libspeex,
# libresample, libwebrtc, libgsmcodec, libilbccodec — all linked by
# the _pjsua2 extension. Using a broader glob avoids re-discovering
# this every time pjproject adds a codec.
COPY --from=builder /usr/local/lib/*.so* /usr/local/lib/
# Copy the uv-managed venv from builder first, so we can drop
# pjsua2 INTO it on the next step (order matters — copying the venv
# after the pjsua2 copy would overwrite it).
COPY --from=builder /app/.venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH"

# pjsua2 Python bindings from the SWIG build in the builder stage:
#   - pjsua2.py: the Python wrapper module
#   - _pjsua2.cpython-312-x86_64-linux-gnu.so: the C extension (33MB)
#   - pjsua2-X.Y-py3.12.egg-info/: metadata directory
# Copied INTO the venv (not the system site-packages) because the
# venv has an isolated sys.path that does not look at the global Python
# site-packages by design. Verified empirically in iteration 5:
# files at /usr/local/lib/python3.12/site-packages were on disk but
# CMD's `python -m bidi.gateway_stub` could not import them.
COPY --from=builder /usr/local/lib/python3.12/site-packages/*pjsua2* /app/.venv/lib/python3.12/site-packages/
RUN ldconfig

# Copy vera source code
WORKDIR /app
COPY agent/app/vera/ ./

# Stub entrypoint — NOT the spike code, see bidi/gateway_stub.py.
# Minimal pjsua2 init that proves the image is well-formed end-to-end
# (libs load, bindings work, process stays alive). Replaced when the
# real production gateway lands.
CMD ["python", "-m", "bidi.gateway_stub"]

# Ports declared informatively. Actual exposure is at SG + ECS level.
EXPOSE 5060/udp
EXPOSE 8080/tcp
