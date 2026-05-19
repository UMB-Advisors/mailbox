#!/usr/bin/env bash
# factory-bootstrap.sh — MailBox appliance: mDNS / Avahi host-identity setup
#
# PURPOSE: Run ONCE on a freshly-flashed Jetson AFTER jetson-bootstrap-ssh.sh
# and BEFORE `docker compose up -d`. Installs avahi-daemon, sets the hostname
# to "mailbox" so the appliance advertises as mailbox.local on the LAN, and
# drops the Avahi service record that tells browsers where the dashboard is.
#
# After this script the customer can open https://mailbox.local/ in any
# browser on the same LAN, accept a one-time cert warning (Caddy local CA),
# and land on the onboarding wizard — without knowing the appliance's IP.
#
# IMPORTANT: Run this script on CUSTOMER #3+ APPLIANCES ONLY.
# Do NOT run on M1 (mailbox.heronlabsinc.com) or M2 (mailbox.staqs.io).
# Both are already operational. Renaming their hostname to "mailbox" would:
#   - Break their Tailscale identity (mailbox1 / mailbox2) and ACL tags
#   - Collide with any per-customer DNS record pointing at their public domain
# The safety check below will abort if tailscale status shows an already-enrolled
# mailboxN device. If somehow that check passes and you're still unsure, stop
# and verify `hostname` + `tailscale status` manually before continuing.
#
# v2 note (STAQPRO-409 slug-stamping): once factory-bootstrap.sh can read
# /etc/mailbox-customer for a per-appliance slug, this script will set
# the hostname to "<customer-slug>" instead of the static "mailbox". The
# MAILBOX_LAN_HOSTNAME env var in .env is the Caddy-side seam for that same
# slug. For now both are hardcoded to "mailbox" / "mailbox.local".
#
# USAGE:
#   sudo bash ./scripts/factory-bootstrap.sh
#
# Idempotent — safe to re-run.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: must run with sudo. Try: sudo bash $0" >&2
  exit 1
fi

echo ""
echo "========================================"
echo "  MailBox — factory-bootstrap.sh"
echo "  $(date)"
echo "========================================"
echo ""

# ── Safety gate: refuse to run on an already-deployed appliance ─────────────
# If `tailscale status` lists a hostname matching mailboxN (e.g. mailbox1,
# mailbox2), this box is already enrolled in the tailnet under a permanent
# identity. Re-running factory-bootstrap would rename the host to the generic
# "mailbox", breaking that identity.

if command -v tailscale >/dev/null 2>&1; then
  TS_STATUS="$(tailscale status 2>/dev/null || true)"
  if echo "${TS_STATUS}" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+[[:space:]]+mailbox[0-9]'; then
    echo "ERROR: This box appears to be an already-deployed appliance." >&2
    echo "       tailscale status shows a mailboxN hostname — refusing to re-bootstrap." >&2
    echo "       factory-bootstrap.sh is for customer #3+ fresh appliances only." >&2
    exit 1
  fi
fi

# ── Step 1: Install avahi-daemon + avahi-utils ───────────────────────────────
echo "[1/4] installing avahi-daemon + avahi-utils"
if dpkg -s avahi-daemon >/dev/null 2>&1 && dpkg -s avahi-utils >/dev/null 2>&1; then
  echo "      already installed"
else
  apt-get update -qq
  apt-get install -y avahi-daemon avahi-utils
  echo "      installed"
fi

# ── Step 2: Set hostname to "mailbox" ───────────────────────────────────────
# %h in the avahi service file expands to the system hostname; the avahi-daemon
# will then advertise this host as mailbox.local on the LAN multicast group.
# v2 (STAQPRO-409): read /etc/mailbox-customer for the per-customer slug here.
echo "[2/4] setting hostname to 'mailbox'"
CURRENT_HOST="$(hostname)"
if [[ "${CURRENT_HOST}" == "mailbox" ]]; then
  echo "      already 'mailbox' — no change"
else
  hostnamectl set-hostname mailbox
  echo "      hostname changed from '${CURRENT_HOST}' to 'mailbox'"
fi

# ── Step 3: Install Avahi service record ─────────────────────────────────────
# The repo file is the source of truth; /etc/avahi/services/ is the live copy.
# avahi-daemon picks up the drop-in automatically via inotify — no restart needed.
echo "[3/4] installing avahi service record"
install -m 644 -o root -g root \
  "${REPO_ROOT}/config/avahi/mailbox.service" \
  /etc/avahi/services/mailbox.service
echo "      /etc/avahi/services/mailbox.service installed"

# ── Step 4: Enable + start avahi-daemon ─────────────────────────────────────
echo "[4/4] enabling + starting avahi-daemon"
systemctl enable --now avahi-daemon
echo "      avahi-daemon enabled and running"

# ── Verification hints ───────────────────────────────────────────────────────
echo ""
echo "========================================"
echo "  factory-bootstrap.sh complete"
echo "========================================"
echo ""
echo "Verify from a workstation on the SAME LAN:"
echo ""
echo "  avahi-resolve -n mailbox.local"
echo "  # → mailbox.local  192.168.x.x"
echo ""
echo "  dig @224.0.0.251 -p 5353 mailbox.local"
echo "  # → ANSWER section with the appliance IP"
echo ""
echo "On macOS, Bonjour is built in — just: ping mailbox.local"
echo ""
echo "Next steps:"
echo "  1. Continue with scripts in the provisioning runbook (§2 Tailscale + §3 Docker)"
echo "  2. After 'docker compose up -d', open https://mailbox.local/ in a browser"
echo "     (accept the one-time Caddy local CA cert warning)"
echo ""
