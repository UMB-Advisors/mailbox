#!/usr/bin/env bash
# first-boot.sh — MailBox One appliance bring-up script
#
# PURPOSE: Brings a freshly-flashed Jetson Orin Nano Super from post-JetPack
# state to fully operational appliance. Runs ONCE per device.
#
# PREREQUISITE: JetPack 6.2 must already be installed via NVIDIA SDK Manager
# BEFORE running this script. This script validates that installation — it does
# NOT flash the device. Use NVIDIA SDK Manager (https://developer.nvidia.com/sdk-manager)
# to flash JetPack 6.2.2 to the device before proceeding.
#
# USAGE: sudo bash scripts/first-boot.sh
#
# Stages:
#   1. Validate JetPack Version
#   2. Install Docker via JetsonHacks
#   3. Verify GPU Passthrough
#   4. Set MAXN Power Mode
#   5. LUKS Encrypt Data Partition
#   6. Pre-pull Ollama Models
#   7. Start Docker Compose Stack

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly MAX_RETRIES=1
readonly OLLAMA_IMAGE_DEFAULT="dustynv/ollama:0.18.4-r36.4-cu126-22.04"

# Stage tracking for summary table
declare -A STAGE_STATUS

# ---------------------------------------------------------------------------
# Trap for clean Ctrl+C handling
# ---------------------------------------------------------------------------

cleanup() {
  echo ""
  echo "[INTERRUPTED] First-boot script interrupted by user."
  echo "You may re-run this script to continue from where you left off."
  echo "Stages already completed do not need to be repeated."
  exit 130
}
trap cleanup INT TERM

# ---------------------------------------------------------------------------
# Root check
# ---------------------------------------------------------------------------

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root or with sudo."
  echo "Usage: sudo bash scripts/first-boot.sh"
  exit 1
fi

# ---------------------------------------------------------------------------
# Helper: print a section header
# ---------------------------------------------------------------------------

print_header() {
  echo ""
  echo "========================================"
  echo "  $1"
  echo "========================================"
}

# ---------------------------------------------------------------------------
# Helper: pause and wait for operator to press Enter
# ---------------------------------------------------------------------------

pause_for_verification() {
  echo ""
  echo "--- Stage complete. Review output above for any warnings. ---"
  echo "Press Enter to continue to the next stage (Ctrl+C to abort)..."
  read -r _
}

# ---------------------------------------------------------------------------
# run_stage: executes a stage function with retry-once logic
#
# Usage: run_stage "Stage Name" stage_function_name
# On first failure: waits 5s, retries once
# On second failure: prints diagnostics and exits 1
# ---------------------------------------------------------------------------

run_stage() {
  local stage_name="$1"
  local stage_fn="$2"
  local retry_count=0

  print_header "${stage_name}"

  while true; do
    if "${stage_fn}"; then
      echo ""
      echo "[PASS] ${stage_name}"
      STAGE_STATUS["${stage_name}"]="PASS"
      return 0
    fi

    retry_count=$((retry_count + 1))
    if [[ ${retry_count} -gt ${MAX_RETRIES} ]]; then
      echo ""
      echo "[FAIL] ${stage_name} failed after ${MAX_RETRIES} retry."
      STAGE_STATUS["${stage_name}"]="FAIL"
      echo "--- Diagnostics ---"
      "diag_${stage_fn}" 2>/dev/null || true
      echo ""
      echo "Halting. Fix the issue above and re-run: sudo bash scripts/first-boot.sh"
      exit 1
    fi

    echo "[RETRY] ${stage_name} failed. Waiting 5s before retry (attempt ${retry_count}/${MAX_RETRIES})..."
    sleep 5
  done
}

# ---------------------------------------------------------------------------
# STAGE 1: Validate JetPack Version
# ---------------------------------------------------------------------------
# IMPORTANT: This script does NOT flash the device.
# JetPack 6.2 must already be installed via NVIDIA SDK Manager before running.
# This stage only validates that the correct version is present.

stage_validate_jetpack() {
  local tegra_release="/etc/nv_tegra_release"
  local jetpack_major=""
  local jetpack_revision=""
  local revision_float=""

  echo "NOTE: This script validates a pre-existing JetPack installation."
  echo "      Flashing is a manual prerequisite done via NVIDIA SDK Manager."
  echo "      If JetPack is not yet installed, abort now and flash first."
  echo ""

  if [[ ! -f "${tegra_release}" ]]; then
    echo "ERROR: ${tegra_release} not found."
    echo ""
    echo "This device does not appear to have JetPack installed."
    echo "Flash the device with JetPack 6.2.2 using NVIDIA SDK Manager:"
    echo "  https://developer.nvidia.com/sdk-manager"
    echo ""
    echo "Steps:"
    echo "  1. Install SDK Manager on a host PC"
    echo "  2. Connect the Jetson in recovery mode"
    echo "  3. Select JetPack 6.2.2 (r36.5) as the target"
    echo "  4. Flash the device, then re-run this script"
    return 1
  fi

  echo "Reading ${tegra_release}:"
  cat "${tegra_release}"
  echo ""

  # Extract R-level (e.g., "R36" from "# R36 (release), ...")
  jetpack_major=$(grep -oP 'R\d+' "${tegra_release}" | head -1 || true)

  # Extract REVISION value (e.g., "5.0" from "REVISION: 5.0")
  jetpack_revision=$(grep -i 'REVISION' "${tegra_release}" | grep -oP '\d+\.\d+' | head -1 || true)

  echo "Detected JetPack major version: ${jetpack_major:-unknown}"
  echo "Detected revision: ${jetpack_revision:-unknown}"

  if [[ -z "${jetpack_major}" ]]; then
    echo "ERROR: Could not parse JetPack version from ${tegra_release}."
    echo "Expected format: '# R36 (release), REVISION: 5.0, ...'"
    return 1
  fi

  # Extract numeric part (e.g., "36" from "R36")
  local major_num="${jetpack_major#R}"

  if [[ "${major_num}" -lt 36 ]]; then
    echo ""
    echo "ERROR: JetPack version too old."
    echo "  Found:    ${jetpack_major} (revision ${jetpack_revision:-unknown})"
    echo "  Required: R36 (revision 4.0+) = JetPack 6.2+"
    echo ""
    echo "Re-flash with NVIDIA SDK Manager using JetPack 6.2.2:"
    echo "  https://developer.nvidia.com/sdk-manager"
    return 1
  fi

  # Check revision >= 4.0 (JetPack 6.2 = r36.4; 6.2.2 = r36.5)
  if [[ -n "${jetpack_revision}" ]]; then
    revision_float="${jetpack_revision}"
    # Use awk for float comparison
    local rev_ok
    rev_ok=$(awk -v r="${revision_float}" 'BEGIN { print (r >= 4.0) ? "yes" : "no" }')
    if [[ "${rev_ok}" != "yes" ]]; then
      echo ""
      echo "ERROR: JetPack revision too old."
      echo "  Found:    ${jetpack_major} revision ${jetpack_revision}"
      echo "  Required: R36 revision 4.0+ (JetPack 6.2+)"
      echo ""
      echo "Re-flash with NVIDIA SDK Manager using JetPack 6.2.2 (r36.5):"
      echo "  https://developer.nvidia.com/sdk-manager"
      return 1
    fi

    # Warn if revision < 5.0 (r36.5 = JetPack 6.2.2 with CUDA memory fix)
    local rev_new
    rev_new=$(awk -v r="${revision_float}" 'BEGIN { print (r >= 5.0) ? "yes" : "no" }')
    if [[ "${rev_new}" != "yes" ]]; then
      echo ""
      echo "WARNING: r36.4 detected (JetPack 6.2 or 6.2.1)."
      echo "  r36.5 (JetPack 6.2.2) is strongly recommended — it contains a"
      echo "  CUDA memory allocation fix that improves Ollama GPU stability."
      echo "  Upgrade path: sudo apt-get update && sudo apt-get dist-upgrade"
      echo "  Or re-flash with SDK Manager selecting JetPack 6.2.2."
      echo "  Continuing with r36.4 (may encounter GPU allocation issues)..."
    fi
  fi

  echo ""
  echo "JetPack version check passed."
  return 0
}

diag_stage_validate_jetpack() {
  echo "  File: /etc/nv_tegra_release"
  cat /etc/nv_tegra_release 2>/dev/null || echo "  (file not found)"
  echo ""
  echo "  Remediation: Flash with NVIDIA SDK Manager using JetPack 6.2.2"
  echo "  URL: https://developer.nvidia.com/sdk-manager"
}

# ---------------------------------------------------------------------------
# STAGE 2: Install Docker via JetsonHacks
# ---------------------------------------------------------------------------

stage_install_docker() {
  # Check if Docker is already installed
  if docker --version 2>/dev/null; then
    echo "Docker is already installed."
    docker --version
    # Verify it's the NVIDIA-compatible install (should not be docker-ce from Docker Inc)
    echo "Skipping install — Docker already present."
    return 0
  fi

  echo "Docker not found. Installing via JetsonHacks script..."
  echo "(This installs Docker 27.5.1 with NVIDIA runtime support)"
  echo ""

  # Clone JetsonHacks install-docker repo
  local install_dir="/tmp/install-docker"
  if [[ -d "${install_dir}" ]]; then
    echo "Removing existing /tmp/install-docker..."
    rm -rf "${install_dir}"
  fi

  echo "Cloning https://github.com/jetsonhacks/install-docker.git ..."
  git clone https://github.com/jetsonhacks/install-docker.git "${install_dir}"

  echo ""
  echo "Running install_nvidia_docker.sh..."
  cd "${install_dir}"
  bash install_nvidia_docker.sh

  echo ""
  echo "Running configure_nvidia_docker.sh..."
  bash configure_nvidia_docker.sh

  cd "${REPO_ROOT}"

  # Verify Docker installed successfully
  if ! docker --version 2>/dev/null; then
    echo "ERROR: Docker install completed but 'docker --version' failed."
    return 1
  fi

  echo ""
  echo "Docker installed:"
  docker --version
  return 0
}

diag_stage_install_docker() {
  echo "  docker --version output:"
  docker --version 2>&1 || echo "  (not available)"
  echo ""
  echo "  Possible causes:"
  echo "    - No internet connection (check: ping github.com)"
  echo "    - JetsonHacks repo changed (check: https://github.com/jetsonhacks/install-docker)"
  echo "    - Insufficient disk space (check: df -h)"
  df -h 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# STAGE 3: Verify GPU Passthrough
# ---------------------------------------------------------------------------

stage_verify_gpu() {
  echo "Testing GPU passthrough via Docker + nvidia-smi..."
  echo "Command: docker run --rm --runtime nvidia nvidia/cuda:12.3.0-base-ubuntu22.04 nvidia-smi"
  echo ""

  if docker run --rm --runtime nvidia nvidia/cuda:12.3.0-base-ubuntu22.04 nvidia-smi; then
    echo ""
    echo "GPU passthrough verified."
    return 0
  else
    echo "ERROR: GPU passthrough test failed."
    return 1
  fi
}

diag_stage_verify_gpu() {
  echo "  nvidia-ctk version:"
  nvidia-ctk --version 2>&1 || echo "  (nvidia-ctk not found)"
  echo ""
  echo "  Docker runtime config:"
  cat /etc/docker/daemon.json 2>/dev/null || echo "  /etc/docker/daemon.json not found"
  echo ""
  echo "  Remediation:"
  echo "    sudo nvidia-ctk runtime configure --runtime=docker"
  echo "    sudo systemctl restart docker"
  echo "  Then re-run this script."
}

stage_verify_gpu_retry_hook() {
  echo "Restarting Docker daemon before retry..."
  systemctl restart docker
  sleep 3
}

# Override run_stage to call retry hook for stage 3
run_stage_with_retry_hook() {
  local stage_name="$1"
  local stage_fn="$2"
  local retry_hook="${3:-}"
  local retry_count=0

  print_header "${stage_name}"

  while true; do
    if "${stage_fn}"; then
      echo ""
      echo "[PASS] ${stage_name}"
      STAGE_STATUS["${stage_name}"]="PASS"
      return 0
    fi

    retry_count=$((retry_count + 1))
    if [[ ${retry_count} -gt ${MAX_RETRIES} ]]; then
      echo ""
      echo "[FAIL] ${stage_name} failed after ${MAX_RETRIES} retry."
      STAGE_STATUS["${stage_name}"]="FAIL"
      echo "--- Diagnostics ---"
      "diag_${stage_fn}" 2>/dev/null || true
      echo ""
      echo "Halting. Fix the issue above and re-run: sudo bash scripts/first-boot.sh"
      exit 1
    fi

    echo "[RETRY] ${stage_name} failed. Waiting 5s before retry (attempt ${retry_count}/${MAX_RETRIES})..."
    if [[ -n "${retry_hook}" ]]; then
      "${retry_hook}" || true
    fi
    sleep 5
  done
}

# ---------------------------------------------------------------------------
# STAGE 4: Set MAXN Power Mode
# ---------------------------------------------------------------------------

stage_set_power_mode() {
  echo "Querying available nvpmodel power modes..."
  local verbose_output
  verbose_output=$(nvpmodel -q --verbose 2>&1 || true)
  echo "${verbose_output}"
  echo ""

  # Find the MAXN mode ID by looking for a line containing "MAXN" (case-insensitive)
  # nvpmodel output format example:
  #   NV Power Mode: MAXN
  #   0
  # or:
  #   < ID:0 power_model: MAXN >
  local maxn_id=""

  # Try multiple output formats
  # Format 1: "< ID:N power_model: MAXN >" or similar
  if echo "${verbose_output}" | grep -qi 'MAXN'; then
    # Try to extract ID from "< ID:N" pattern
    maxn_id=$(echo "${verbose_output}" | grep -i 'MAXN' | grep -oP '(?i)id\s*:\s*\K\d+' | head -1 || true)

    # If that didn't work, try extracting from lines preceding "MAXN"
    if [[ -z "${maxn_id}" ]]; then
      # Look for a number on the line before or after MAXN
      maxn_id=$(echo "${verbose_output}" | grep -B2 -A2 -i 'MAXN' | grep -oP '^\s*\K\d+$' | head -1 || true)
    fi

    # Last resort: find any standalone number near MAXN context
    if [[ -z "${maxn_id}" ]]; then
      # On many Jetson boards MAXN is mode 0
      echo "WARNING: Could not auto-detect MAXN mode ID from nvpmodel output."
      echo "Attempting to use mode 0 (standard MAXN ID on Orin Nano Super)..."
      maxn_id="0"
    fi
  else
    echo "ERROR: nvpmodel did not list a MAXN mode. Output above may indicate an issue."
    echo "Check: sudo nvpmodel -q --verbose"
    return 1
  fi

  echo "Detected MAXN mode ID: ${maxn_id}"
  echo ""
  echo "Setting MAXN power mode: nvpmodel -m ${maxn_id}"
  nvpmodel -m "${maxn_id}"

  # Verify the mode was set
  local current_mode
  current_mode=$(nvpmodel -q 2>&1 || true)
  echo "Current power mode: ${current_mode}"

  if ! echo "${current_mode}" | grep -qi 'MAXN'; then
    echo "ERROR: Power mode set but MAXN not confirmed in nvpmodel -q output."
    return 1
  fi

  echo ""
  echo "Creating systemd service to persist MAXN mode across reboots..."

  cat > /etc/systemd/system/set-maxn-power.service << EOF
[Unit]
Description=Set Jetson Orin to MAXN power mode
After=multi-user.target

[Service]
Type=oneshot
ExecStart=/usr/bin/nvpmodel -m ${maxn_id}
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable set-maxn-power.service
  echo "systemd service set-maxn-power.service enabled."

  return 0
}

diag_stage_set_power_mode() {
  echo "  All available power modes:"
  nvpmodel -q --verbose 2>&1 || echo "  (nvpmodel not available)"
  echo ""
  echo "  Remediation: Run 'sudo nvpmodel -q --verbose' to see mode IDs,"
  echo "  then manually run 'sudo nvpmodel -m <id>' for the MAXN mode."
}

# ---------------------------------------------------------------------------
# STAGE 5: LUKS Encrypt Data Partition
# ---------------------------------------------------------------------------

stage_luks_encrypt() {
  echo "Installing LUKS and TPM2 prerequisites..."
  apt-get update -qq
  apt-get install -y cryptsetup-bin tpm2-tools

  echo ""
  echo "Checking for TPM device..."
  if [[ -e /dev/tpm0 ]]; then
    echo "  Found: /dev/tpm0"
  elif [[ -e /dev/tpmrm0 ]]; then
    echo "  Found: /dev/tpmrm0"
  else
    echo "  WARNING: Neither /dev/tpm0 nor /dev/tpmrm0 found."
    echo "  LUKS key binding to device TPM may not work."
    echo "  Continuing — LUKS will still encrypt the partition."
  fi

  echo ""
  echo "Checking for Jetson-native gen_luks.sh..."
  local gen_luks="/usr/sbin/gen_luks.sh"

  if [[ ! -f "${gen_luks}" ]]; then
    echo "WARNING: ${gen_luks} not found."
    echo "Attempting to install nvidia-l4t-security-utils..."
    apt-get install -y nvidia-l4t-security-utils || true

    if [[ ! -f "${gen_luks}" ]]; then
      echo ""
      echo "FAIL: LUKS encryption requires gen_luks.sh."
      echo ""
      echo "  gen_luks.sh is part of nvidia-l4t-security-utils and is installed"
      echo "  with JetPack 6.2.2 (r36.5). It uses Jetson's OP-TEE luks-srv"
      echo "  Trusted Application to bind the LUKS key to the device fTPM."
      echo ""
      echo "  Possible fixes:"
      echo "    1. Upgrade to JetPack 6.2.2 (r36.5):"
      echo "       sudo apt-get update && sudo apt-get dist-upgrade"
      echo "    2. Check NVIDIA Jetson Linux r36.5 Developer Guide:"
      echo "       'Disk Encryption' section for manual installation"
      echo "    3. If hardware is pre-r36.5: manually install from NVIDIA L4T packages"
      echo ""
      return 1
    fi
    echo "nvidia-l4t-security-utils installed. gen_luks.sh found."
  else
    echo "  Found: ${gen_luks}"
  fi

  echo ""
  echo "Using Jetson-native LUKS encryption (gen_luks.sh + OP-TEE luks-srv)"
  echo ""
  echo "You must identify the data partition to encrypt."
  echo "Typical partition for data: /dev/nvme0n1p4 (may vary by device)"
  echo ""
  echo "Current NVMe partition table:"
  lsblk -o NAME,SIZE,TYPE,MOUNTPOINT /dev/nvme0n1 2>/dev/null || lsblk 2>/dev/null || true
  echo ""

  local data_partition=""
  while [[ -z "${data_partition}" ]]; do
    echo "Enter the data partition to encrypt (e.g., /dev/nvme0n1p4),"
    echo "or press Enter to skip LUKS encryption (NOT recommended for production):"
    read -r data_partition

    if [[ -z "${data_partition}" ]]; then
      echo "WARNING: Skipping LUKS encryption. Customer data will NOT be encrypted at rest."
      echo "This is acceptable for development/testing only. Re-run to encrypt before shipping."
      return 0
    fi

    if [[ ! -b "${data_partition}" ]]; then
      echo "ERROR: ${data_partition} is not a block device. Please try again."
      data_partition=""
    fi
  done

  echo ""
  echo "WARNING: This will ENCRYPT ${data_partition}."
  echo "All existing data on this partition will be INACCESSIBLE without the LUKS key."
  echo "Ensure this is the correct partition and that any important data is backed up."
  echo ""
  echo "Type 'ENCRYPT' (all caps) to confirm, or press Enter to abort:"
  read -r confirm

  if [[ "${confirm}" != "ENCRYPT" ]]; then
    echo "Aborted by user. LUKS encryption skipped."
    echo "Re-run this script and confirm ENCRYPT to enable disk encryption."
    return 1
  fi

  echo ""
  echo "Running gen_luks.sh on ${data_partition}..."
  /usr/sbin/gen_luks.sh "${data_partition}"

  echo ""
  echo "Verifying LUKS header..."
  if cryptsetup luksDump "${data_partition}"; then
    echo ""
    echo "LUKS encryption applied to ${data_partition}."
    return 0
  else
    echo "ERROR: cryptsetup luksDump failed — LUKS header not found."
    return 1
  fi
}

diag_stage_luks_encrypt() {
  echo "  gen_luks.sh search:"
  ls /usr/sbin/gen_luks* 2>/dev/null || echo "  (not found)"
  echo ""
  echo "  nvidia-l4t-security packages:"
  dpkg -l | grep nvidia-l4t-security 2>/dev/null || echo "  (none installed)"
  echo ""
  echo "  TPM devices:"
  ls /dev/tpm* 2>/dev/null || echo "  (none found)"
}

# ---------------------------------------------------------------------------
# STAGE 6: Pre-pull Ollama Models
# ---------------------------------------------------------------------------

stage_prepull_models() {
  # Load OLLAMA_IMAGE from .env if available
  local ollama_image="${OLLAMA_IMAGE_DEFAULT}"
  local env_file="${REPO_ROOT}/.env"

  if [[ -f "${env_file}" ]]; then
    local env_image
    env_image=$(grep -E '^OLLAMA_IMAGE=' "${env_file}" | cut -d= -f2- | tr -d '"' || true)
    if [[ -n "${env_image}" ]]; then
      ollama_image="${env_image}"
      echo "Using OLLAMA_IMAGE from .env: ${ollama_image}"
    fi
  fi

  # Check if jetson-containers autotag is available to resolve the correct image
  if command -v autotag &>/dev/null; then
    echo "jetson-containers autotag available. Resolving Ollama image..."
    local resolved_image
    resolved_image=$(autotag ollama 2>/dev/null || true)
    if [[ -n "${resolved_image}" ]]; then
      ollama_image="${resolved_image}"
      echo "Resolved Ollama image via autotag: ${ollama_image}"
    else
      echo "autotag returned empty result; using default: ${ollama_image}"
    fi
  else
    echo "jetson-containers autotag not found; using image: ${ollama_image}"
  fi

  echo ""
  echo "Creating ollama_models named volume (if not exists)..."
  docker volume create ollama_models

  echo ""
  echo "Pre-pulling Qwen3-4B (Q4_K_M, ~2.7GB)..."
  echo "This may take several minutes depending on network speed."
  docker run --rm --runtime nvidia \
    -v ollama_models:/root/.ollama \
    "${ollama_image}" \
    ollama pull qwen3:4b

  echo ""
  echo "Pre-pulling nomic-embed-text v1.5 (~274MB)..."
  docker run --rm --runtime nvidia \
    -v ollama_models:/root/.ollama \
    "${ollama_image}" \
    ollama pull nomic-embed-text:v1.5

  echo ""
  echo "Verifying both models are present in the volume..."
  local model_list
  model_list=$(docker run --rm \
    -v ollama_models:/root/.ollama \
    "${ollama_image}" \
    ollama list 2>&1 || true)
  echo "${model_list}"

  if ! echo "${model_list}" | grep -q "qwen3:4b"; then
    echo "ERROR: qwen3:4b not found in ollama list after pull."
    return 1
  fi

  if ! echo "${model_list}" | grep -q "nomic-embed-text"; then
    echo "ERROR: nomic-embed-text not found in ollama list after pull."
    return 1
  fi

  echo ""
  echo "Both models verified in ollama_models volume."
  return 0
}

diag_stage_prepull_models() {
  echo "  Disk space:"
  df -h 2>/dev/null || true
  echo ""
  echo "  Docker images:"
  docker images 2>/dev/null || true
  echo ""
  echo "  Docker volumes:"
  docker volume ls 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# STAGE 7: Start Docker Compose Stack
# ---------------------------------------------------------------------------

stage_start_compose() {
  cd "${REPO_ROOT}"

  # Ensure .env file exists
  if [[ ! -f ".env" ]]; then
    if [[ -f ".env.example" ]]; then
      cp .env.example .env
      echo "WARNING: .env file not found. Copied from .env.example."
      echo ""
      echo "IMPORTANT: Edit .env before production deployment."
      echo "  Required changes:"
      echo "    - POSTGRES_PASSWORD: change from default"
      echo "    - N8N_ENCRYPTION_KEY: set a unique random key"
      echo "    - ANTHROPIC_API_KEY: add your API key"
      echo ""
      echo "Continuing with defaults (safe for initial testing only)..."
    else
      echo "ERROR: Neither .env nor .env.example found in ${REPO_ROOT}."
      echo "Clone the full repository before running this script."
      return 1
    fi
  fi

  echo "Starting Docker Compose stack..."
  docker compose up -d

  echo ""
  echo "Waiting for all services to become healthy (timeout: 180s)..."

  local elapsed=0
  local timeout=180
  local all_healthy=false

  while [[ ${elapsed} -lt ${timeout} ]]; do
    # Get compose service health status
    local ps_output
    ps_output=$(docker compose ps --format '{{.Name}}\t{{.Health}}' 2>/dev/null || \
                docker compose ps 2>/dev/null || true)

    # Count services that are healthy or running (some services don't have healthcheck)
    local healthy_count
    healthy_count=$(echo "${ps_output}" | grep -cE 'healthy|running' || echo "0")
    local total_count
    total_count=$(docker compose ps --quiet 2>/dev/null | wc -l || echo "0")

    echo "  [${elapsed}s/${timeout}s] Healthy/Running: ${healthy_count}/${total_count}"

    # Check if any service has "unhealthy" status
    if echo "${ps_output}" | grep -q "unhealthy"; then
      echo "  WARNING: One or more services are unhealthy. Waiting..."
    fi

    # Check if all expected services are up (5 services in compose)
    if [[ "${healthy_count}" -ge 5 ]]; then
      all_healthy=true
      break
    fi

    sleep 10
    elapsed=$((elapsed + 10))
  done

  echo ""
  echo "--- Final Docker Compose Status ---"
  docker compose ps

  if [[ "${all_healthy}" != "true" ]]; then
    echo ""
    echo "WARNING: Not all services reached healthy state within ${timeout}s."
    echo "Some services may still be starting up. Check logs:"
    echo "  docker compose logs --tail=20"
    echo ""
    echo "Common causes on first boot:"
    echo "  - Qdrant ARM64 jemalloc issue: check MALLOC_CONF=narenas:1 is set in compose"
    echo "  - n8n Postgres connection: ensure POSTGRES_PASSWORD matches .env"
    echo "  - Ollama GPU: ensure no mem_limit is set on ollama service"
    return 1
  fi

  return 0
}

diag_stage_start_compose() {
  cd "${REPO_ROOT}" 2>/dev/null || true
  echo "  Recent compose logs:"
  docker compose logs --tail=20 2>/dev/null || true
  echo ""
  echo "  Compose process status:"
  docker compose ps 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Main execution
# ---------------------------------------------------------------------------

main() {
  echo ""
  echo "========================================"
  echo "  MailBox One — First-Boot Setup"
  echo "  $(date)"
  echo "========================================"
  echo ""
  echo "This script will bring up a fresh Jetson Orin Nano Super from"
  echo "post-JetPack state to fully operational appliance."
  echo ""
  echo "PREREQUISITE: JetPack 6.2 must already be installed via NVIDIA SDK Manager."
  echo "This script validates that installation — it does NOT flash the device."
  echo ""
  echo "Stages to complete:"
  echo "  1. Validate JetPack Version"
  echo "  2. Install Docker via JetsonHacks"
  echo "  3. Verify GPU Passthrough"
  echo "  4. Set MAXN Power Mode"
  echo "  5. LUKS Encrypt Data Partition"
  echo "  6. Pre-pull Ollama Models"
  echo "  7. Start Docker Compose Stack"
  echo ""
  echo "Press Enter to begin, or Ctrl+C to abort..."
  read -r _

  # Stage 1: JetPack Version Validation
  run_stage "Stage 1: Validate JetPack Version" stage_validate_jetpack
  pause_for_verification

  # Stage 2: Install Docker
  run_stage "Stage 2: Install Docker via JetsonHacks" stage_install_docker
  pause_for_verification

  # Stage 3: GPU Passthrough (with restart-docker retry hook)
  run_stage_with_retry_hook "Stage 3: Verify GPU Passthrough" stage_verify_gpu stage_verify_gpu_retry_hook
  pause_for_verification

  # Stage 4: Power Mode
  run_stage "Stage 4: Set MAXN Power Mode" stage_set_power_mode
  pause_for_verification

  # Stage 5: LUKS Encryption
  run_stage "Stage 5: LUKS Encrypt Data Partition" stage_luks_encrypt
  pause_for_verification

  # Stage 6: Pre-pull Models
  run_stage "Stage 6: Pre-pull Ollama Models" stage_prepull_models
  pause_for_verification

  # Stage 7: Start Compose
  run_stage "Stage 7: Start Docker Compose Stack" stage_start_compose

  # ---------------------------------------------------------------------------
  # Summary
  # ---------------------------------------------------------------------------
  print_header "First-Boot Summary"

  printf "%-40s %s\n" "Stage" "Status"
  printf "%-40s %s\n" "-----" "------"
  printf "%-40s %s\n" "Stage 1: Validate JetPack Version"    "${STAGE_STATUS["Stage 1: Validate JetPack Version"]:-UNKNOWN}"
  printf "%-40s %s\n" "Stage 2: Install Docker via JetsonHacks" "${STAGE_STATUS["Stage 2: Install Docker via JetsonHacks"]:-UNKNOWN}"
  printf "%-40s %s\n" "Stage 3: Verify GPU Passthrough"       "${STAGE_STATUS["Stage 3: Verify GPU Passthrough"]:-UNKNOWN}"
  printf "%-40s %s\n" "Stage 4: Set MAXN Power Mode"          "${STAGE_STATUS["Stage 4: Set MAXN Power Mode"]:-UNKNOWN}"
  printf "%-40s %s\n" "Stage 5: LUKS Encrypt Data Partition"  "${STAGE_STATUS["Stage 5: LUKS Encrypt Data Partition"]:-UNKNOWN}"
  printf "%-40s %s\n" "Stage 6: Pre-pull Ollama Models"       "${STAGE_STATUS["Stage 6: Pre-pull Ollama Models"]:-UNKNOWN}"
  printf "%-40s %s\n" "Stage 7: Start Docker Compose Stack"   "${STAGE_STATUS["Stage 7: Start Docker Compose Stack"]:-UNKNOWN}"

  echo ""
  echo "First-boot complete. Run scripts/smoke-test.sh to verify all services."
  echo ""
}

main "$@"
