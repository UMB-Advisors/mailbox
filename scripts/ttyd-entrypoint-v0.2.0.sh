#!/bin/sh
# ttyd entrypoint wrapper
# Version: 0.2.0
# Installs ssh client (Debian-based ttyd image), then launches ttyd with SSH to host.

set -eu

# Install openssh-client if not already present (idempotent)
if ! command -v ssh >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y --no-install-recommends openssh-client >/dev/null
fi

# Sanity-check required env vars
: "${TTYD_USER:?TTYD_USER must be set}"
: "${TTYD_PASS:?TTYD_PASS must be set}"

# Launch ttyd
exec ttyd \
    -W \
    -c "${TTYD_USER}:${TTYD_PASS}" \
    -t fontSize=14 \
    ssh -o StrictHostKeyChecking=accept-new bob@jetson-host
