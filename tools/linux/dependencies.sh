#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends build-essential curl ca-certificates file pkg-config \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf \
  libdbus-1-dev libudev-dev libxdo-dev libssl-dev xvfb xauth dbus-x11 openssh-client rpm
