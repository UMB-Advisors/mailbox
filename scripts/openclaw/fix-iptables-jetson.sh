#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# VENDORED for MBOX-291 from NVIDIA/NemoClaw PR #560 (closed, NOT merged as of
# 2026-05-23). The gateway-image iptables-legacy fix never landed upstream
# (issues #404/#539 closed as roadmap-consolidation), so we carry it ourselves
# until NVIDIA ships official Jetson support. See
# docs/spike-m0-openshell-jetson-gateway-v0_1-2026-05-22.md.
#
# Patch the OpenShell gateway image to use iptables-legacy.
#
# On Jetson devices the kernel lacks nf_tables NAT modules (verified on MB2:
# `grep -c nft_chain_nat /proc/modules` == 0), so the gateway container's
# default iptables-nft binary fails and k3s panics with
#   iptables v1.8.10 (nf_tables): RULE_INSERT failed (No such file or directory)
# This rebuilds the gateway image with one extra layer that symlinks iptables
# to iptables-legacy, then re-tags it with the same name so the next
# `openshell gateway start` (via `nemoclaw onboard`) picks it up from cache.
#
# Run this AFTER an initial gateway start that crashed (the image must exist
# locally), THEN re-run `nemoclaw onboard` to recreate the gateway.
#
# Usage: ./fix-iptables-jetson.sh [gateway-name]   (default gateway-name: nemoclaw)

set -euo pipefail

GATEWAY_NAME="${1:-nemoclaw}"
CONTAINER="openshell-cluster-${GATEWAY_NAME}"

# ── 1. Locate the crashed container and its image ────────────────
IMAGE=$(docker inspect "$CONTAINER" --format '{{.Config.Image}}' 2>/dev/null || true)

if [ -z "$IMAGE" ]; then
  echo "  ERROR: Could not find gateway container '$CONTAINER'."
  echo "  Has 'openshell gateway start' (via 'nemoclaw onboard') been run at least once?"
  exit 1
fi

echo "  Patching image '${IMAGE}' to use iptables-legacy..."

# ── 2. Build a patched image on top of the original ──────────────
docker build -q -t "$IMAGE" --build-arg BASE="$IMAGE" - <<'DOCKERFILE'
ARG BASE
FROM ${BASE}
RUN set -e; \
    if [ -x /usr/sbin/iptables-legacy ]; then \
      ln -sf /usr/sbin/iptables-legacy /usr/sbin/iptables; \
      ln -sf /usr/sbin/ip6tables-legacy /usr/sbin/ip6tables; \
    elif command -v update-alternatives >/dev/null 2>&1; then \
      update-alternatives --set iptables /usr/sbin/iptables-legacy 2>/dev/null || true; \
      update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy 2>/dev/null || true; \
    fi
DOCKERFILE

echo "  ✓ Image patched with iptables-legacy"
