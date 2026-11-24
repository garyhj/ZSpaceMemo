#!/usr/bin/env bash
set -euo pipefail

# Download and SHA256-verify the official zspace-cli v0.3.11 sidecar binary
# into src-tauri/binaries/ for local Tauri development or bundling.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/src-tauri/binaries"
mkdir -p "${OUT_DIR}"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}/${ARCH}" in
  Darwin/arm64|Darwin/aarch64)
    URL="https://update.zenithspace.net/AgentToolkit/20261023/zspace-cli-v0.3.11-darwin-arm64"
    SHA="f438303c204702e5028751c1c3a26d0c5ff0dc956801a6ef6dd30fbbb4338f7d"
    TARGET="${OUT_DIR}/zspace-cli-aarch64-apple-darwin"
    ;;
  Darwin/x86_64)
    URL="https://update.zenithspace.net/AgentToolkit/20261023/zspace-cli-v0.3.11-darwin-x64"
    SHA="312a08e3b3ed6f5660b9490255a379cb107f43efcd684cb25717fba93a7d2f5d"
    TARGET="${OUT_DIR}/zspace-cli-x86_64-apple-darwin"
    ;;
  Linux/x86_64|Linux/amd64)
    URL="https://update.zenithspace.net/AgentToolkit/20261023/zspace-cli-v0.3.11-linux-x64"
    SHA="97ed9ea7fdeb88129498838eac3493a546008d2ef4e20778fd4d5538016616a7"
    TARGET="${OUT_DIR}/zspace-cli-x86_64-unknown-linux-gnu"
    ;;
  Linux/aarch64|Linux/arm64)
    URL="https://update.zenithspace.net/AgentToolkit/20261023/zspace-cli-v0.3.11-linux-arm64"
    SHA="200099ea0cbae6e1a4769a68975e628493301a6a19b2912043053f1a29b33fa2"
    TARGET="${OUT_DIR}/zspace-cli-aarch64-unknown-linux-gnu"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    URL="https://update.zenithspace.net/AgentToolkit/20261023/zspace-cli-v0.3.11-windows-x64.exe"
    SHA="5d5f1468dab6fd6151b03a96d7ddfd0aaf579730b4f37cbcc30ddfcdf54a8031"
    TARGET="${OUT_DIR}/zspace-cli-x86_64-pc-windows-msvc.exe"
    ;;
  *)
    echo "Unsupported platform: ${OS}/${ARCH}" >&2
    exit 1
    ;;
esac

echo "Downloading official zspace-cli v0.3.11 -> ${TARGET}"
curl -fsSL "${URL}" -o "${TARGET}"

if command -v sha256sum >/dev/null 2>&1; then
  echo "${SHA}  ${TARGET}" | sha256sum -c -
else
  echo "${SHA}  ${TARGET}" | shasum -a 256 -c -
fi

chmod +x "${TARGET}" || true
echo "Done: ${TARGET}"
