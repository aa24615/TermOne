FROM node:24-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a
COPY dependencies.sh /tmp/termone-linux/dependencies.sh
RUN bash /tmp/termone-linux/dependencies.sh && rm -rf /var/lib/apt/lists/*
COPY setup.sh /tmp/termone-linux/setup.sh
RUN bash /tmp/termone-linux/setup.sh --rust-only
ENV PATH="/root/.cargo/bin:${PATH}" CARGO_HTTP_MULTIPLEXING=false CARGO_HTTP_TIMEOUT=60
WORKDIR /work
