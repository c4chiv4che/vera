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
    && rm -rf /var/lib/apt/lists/*

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
COPY agent/app/vera/pyproject.toml agent/app/vera/uv.lock ./
RUN uv sync --frozen --no-dev

# -------- Stage 2: runtime --------
FROM python:3.12-slim-bookworm AS runtime

# Runtime libs only (no -dev headers, no build tools)
RUN apt-get update && apt-get install -y --no-install-recommends \
        libssl3 \
        libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Copy compiled pjproject shared libraries from builder
COPY --from=builder /usr/local/lib/libpj*.so* /usr/local/lib/
# pjsua2 Python module: paths below are the typical destination of
# `setup.py install` on python:3.12-bookworm. If `docker build` shows
# them empty, we'll fix here once we see the actual install location.
COPY --from=builder /usr/local/lib/python3.12/site-packages/pjsua2*.so /usr/local/lib/python3.12/site-packages/
COPY --from=builder /usr/local/lib/python3.12/site-packages/pjsua2.py /usr/local/lib/python3.12/site-packages/
RUN ldconfig

# Copy the uv-managed venv from builder
COPY --from=builder /app/.venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH"

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
