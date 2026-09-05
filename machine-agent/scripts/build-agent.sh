#!/usr/bin/env bash
set -euo pipefail

# Builds UGS Core from the exact approved source commit, then builds the local
# agent. It does not download or launch the UGS desktop GUI.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$(cd "$ROOT/.." && pwd)"
UGS_DIR="${DMHC_UGS_DIR:-$WORKSPACE/.agent-ugs/Universal-G-Code-Sender}"
UGS_REPO="https://github.com/winder/Universal-G-Code-Sender.git"
UGS_COMMIT="7c7d45b6b94a718589ce4b444865cd790c34882a"

if ! command -v java >/dev/null || ! command -v mvn >/dev/null; then
  echo "Java 17+ and Maven are required. Install a JDK before building." >&2
  exit 1
fi

if [[ ! -d "$UGS_DIR/.git" ]]; then 
  mkdir -p "$(dirname "$UGS_DIR")"
  git clone "$UGS_REPO" "$UGS_DIR"
fi

git -C "$UGS_DIR" fetch --tags --quiet
git -C "$UGS_DIR" checkout --detach "$UGS_COMMIT"

# Install just the reactor parent and ugs-core. No UGS desktop module is built.
mvn -q -f "$UGS_DIR/pom.xml" -pl ugs-core -am install -DskipTests
mvn -q -f "$ROOT/pom.xml" clean test package

mkdir -p "$ROOT/target/third-party-licenses"
cp "$UGS_DIR/COPYING" "$ROOT/target/third-party-licenses/UGS-COPYING.txt"
cp "$ROOT/NOTICE.md" "$ROOT/target/third-party-licenses/NOTICE.md"

echo
echo "Built: $ROOT/target/dmhc-machine-agent.jar"
echo "Start: java -jar $ROOT/target/dmhc-machine-agent.jar"