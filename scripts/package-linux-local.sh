#!/usr/bin/env bash
# Local check that the Linux package builds and starts, for a machine whose JDK 25 has no jmods/
# directory (so Compose's jlink step, `./gradlew :app:packageDeb`, can't run). CI uses Temurin 25
# with jmods and the Gradle task. This script runs the same jpackage step on the app's uber jar,
# with the whole JDK as the runtime image (larger than the jlink'd one), then starts the result
# headless with --smoke. Usage: scripts/package-linux-local.sh [JDK25_HOME]
set -euo pipefail
cd "$(dirname "$0")/.."
JDK="${1:-${JAVA_HOME:-}}"
[ -x "$JDK/bin/jpackage" ] || { echo "pass a JDK 25 home that has bin/jpackage" >&2; exit 2; }
./gradlew :app:packageUberJarForCurrentOS -q
jar=$(ls app/build/compose/jars/pc-supervisor-linux-x64-*.jar)
out=app/build/local-package
rm -rf "$out" && mkdir -p "$out/input"
cp "$jar" "$out/input/"
# signed dependencies leave signature files in the uber jar that no longer match it
zip -q -d "$out/input/$(basename "$jar")" "META-INF/*.SF" "META-INF/*.RSA" "META-INF/*.DSA" || true
"$JDK/bin/jpackage" --type deb --name pc-supervisor --app-version 0.4.0 --vendor "PC Supervisor contributors" \
  --input "$out/input" --main-jar "$(basename "$jar")" --main-class pcs.app.MainKt \
  --java-options --enable-native-access=ALL-UNNAMED --runtime-image "$JDK" --dest "$out"
deb=$(ls "$out"/*.deb)
dpkg-deb -x "$deb" "$out/root"
echo "built $deb ($(du -h "$deb" | cut -f1))"
PCS_CONFERENCES="$out/none" "$out/root/opt/pc-supervisor/bin/pc-supervisor" --smoke
