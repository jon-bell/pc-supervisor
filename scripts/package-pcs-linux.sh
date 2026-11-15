#!/usr/bin/env bash
# Builds the `pcs` command line (with `pcs eval`, the federated evaluation kit) as a Linux .deb: the cli's uber jar plus a jlink'd runtime,
# the same way scripts/package-linux.sh builds the app (see its header for why jpackage runs on an uber jar and a jlink'd runtime).
# The runtime's modules are the list in app/build.gradle.kts. The LLM checks' directory is not packaged: `pcs eval --engine` needs
# PCS_AGENT_CHECKS to point at a checkout's agent/checks; a deterministic run needs nothing.
#
# Usage: scripts/package-pcs-linux.sh [JDK25_HOME]     (default $JAVA_HOME). Output: cli/build/linux-package/*.deb
set -euo pipefail
cd "$(dirname "$0")/.."
JDK="${1:-${JAVA_HOME:-}}"
[ -x "$JDK/bin/jpackage" ] && [ -x "$JDK/bin/jlink" ] || { echo "pass a JDK 25 home that has bin/jpackage and bin/jlink" >&2; exit 2; }
VERSION=$(sed -n 's/^val appVersion = "\(.*\)"/\1/p' app/build.gradle.kts)
MODULES=$(sed -n '/^            modules($/,/^            )$/p' app/build.gradle.kts | grep -o '"[a-z.]*"' | tr -d '"' | paste -sd, -)
[ -n "$VERSION" ] && [ -n "$MODULES" ] || { echo "could not read the version and module list from app/build.gradle.kts" >&2; exit 2; }

./gradlew :cli:pcsUberJar -q
jar=$(ls cli/build/libs/cli-all.jar)
out=cli/build/linux-package
rm -rf "$out" && mkdir -p "$out/input"
cp "$jar" "$out/input/pcs.jar"
"$JDK/bin/jlink" --add-modules "$MODULES" --strip-debug --no-header-files --no-man-pages --output "$out/runtime"
"$JDK/bin/jpackage" --type deb --name pcs --app-version "$VERSION" --vendor "PC Supervisor contributors" \
  --description "pcs: the PC Supervisor command line, including the federated evaluation kit (pcs eval)" \
  --input "$out/input" --main-jar pcs.jar --main-class net.jonbell.pcs.cli.MainKt \
  --java-options --enable-native-access=ALL-UNNAMED --runtime-image "$out/runtime" --dest "$out"
deb=$(ls "$out"/*.deb)
dpkg-deb -x "$deb" "$out/root"
echo "built $deb ($(du -h "$deb" | cut -f1))"
# smoke: with no arguments `pcs eval` prints its usage and exits 2; an export directory with nothing in it is refused, offline, with a message
pcs="$out/root/opt/pcs/bin/pcs"
msg=$("$pcs" eval 2>&1 || true)
case "$msg" in *"usage: pcs eval"*) ;; *) echo "smoke failed: no usage from pcs eval" >&2; exit 1 ;; esac
mkdir -p "$out/empty"
msg=$("$pcs" eval --export "$out/empty" 2>&1 || true)
case "$msg" in *"has no pc.json"*) echo "smoke ok" ;; *) echo "smoke failed: empty export not refused: $msg" >&2; exit 1 ;; esac
