#!/usr/bin/env bash
# fix-sandbox-mount-jetson.sh — MBOX-291 compat-mount workaround.
#
# On JetPack 6.2 (glibc 2.35) OpenShell 0.0.44's gateway runs inside an
# ubuntu:24.04 "compatibility container" (its dynamic binaries need glibc 2.39).
# When that compat-gateway creates the sandbox container via the host docker
# socket, it bind-mounts the sandbox runtime binary from a content-addressed
# staged path that exists INSIDE the compat container but NOT on the host:
#     /root/.local/share/openshell/docker-supervisor/sha256-<hash>/openshell-sandbox
# dockerd resolves that path host-side, finds nothing, and auto-creates an empty
# directory there -> sandbox start fails with:
#     exec "/opt/openshell/bin/openshell-sandbox": is a directory: permission denied
#
# This materializes the real binary at that host path so the bind-mount resolves.
# Run AFTER the first failed `nemoclaw onboard`, THEN re-run onboard.
#
# Empirically green on MB2 2026-05-22: sandbox starts, dashboard :18789 live,
# NIM round-trip HTTP 200. See docs/spike-m0-openshell-jetson-gateway-v0_1-2026-05-22.md.
#
# CAVEAT: unsupported & fragile. The sha256-<hash> is tied to the sandbox binary
# build; re-derive on any OpenShell version change. The durable fix is an
# Ubuntu-24.04 / glibc-2.39 appliance base (no compat container, no workaround).
#
# Usage: ./fix-sandbox-mount-jetson.sh [gateway-container-name]   (default: nemoclaw-openshell-gateway)
set -euo pipefail

GW="${1:-nemoclaw-openshell-gateway}"

docker inspect "$GW" >/dev/null 2>&1 || {
  echo "ERROR: gateway container '$GW' not found. Run 'nemoclaw onboard' once first." >&2
  exit 1
}

# Discover the staged sandbox-binary path inside the compat gateway.
P=$(docker exec "$GW" sh -lc 'ls -d /root/.local/share/openshell/docker-supervisor/sha256-*/openshell-sandbox 2>/dev/null' | head -1 || true)
[ -n "$P" ] || { echo "ERROR: could not locate staged openshell-sandbox inside '$GW'." >&2; exit 1; }
echo "  staged binary path: $P"

docker cp "$GW:$P" /tmp/oss-sandbox
echo "  extracted $(stat -c '%s' /tmp/oss-sandbox) bytes"

# Replace the empty dir dockerd created on the host with the real binary file.
sudo rm -rf "$P"
sudo install -D -m 0755 /tmp/oss-sandbox "$P"
rm -f /tmp/oss-sandbox

case "$(sudo stat -c '%F' "$P")" in
  "regular file") echo "  ✓ host path is now a regular file — re-run 'nemoclaw onboard'";;
  *) echo "  ✗ unexpected: host path is not a regular file" >&2; exit 1;;
esac
