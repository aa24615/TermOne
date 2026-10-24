#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" != "--rust-only" ]]; then bash "$(dirname "$0")/dependencies.sh"; fi
arch="$(uname -m)"
target="${arch}-unknown-linux-gnu"
download() { curl --proto '=https' --tlsv1.2 --http1.1 -fsSL --connect-timeout 20 --max-time 240 --retry 2 "$1" -o "$2"; }
mkdir -p /tmp/termone-rust
download "https://static.rust-lang.org/rustup/dist/${target}/rustup-init?termone=linux" /tmp/termone-rust/rustup-init
chmod +x /tmp/termone-rust/rustup-init
# Populate rustup's checksum-addressed cache with bounded curl downloads; a slow
# CDN connection otherwise makes the bootstrap appear stuck for several minutes.
mkdir -p /root/.rustup/downloads
for component in cargo rust-std rustc; do
  url="https://static.rust-lang.org/dist/${component}-1.99.1-${target}.tar.xz"
  download "${url}.sha256?termone=linux" /tmp/termone-component.sha256
  checksum="$(cut -d ' ' -f 1 /tmp/termone-component.sha256)"
  download "${url}?termone=linux" "/root/.rustup/downloads/${checksum}"
  printf '%s  %s\n' "$checksum" "/root/.rustup/downloads/${checksum}" | sha256sum -c -
done
/tmp/termone-rust/rustup-init -y --profile minimal --default-toolchain 1.99.1 --no-modify-path
rm /tmp/termone-rust/rustup-init /tmp/termone-component.sha256
