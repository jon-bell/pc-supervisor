#!/usr/bin/env bash
# Builds the Linux .deb from the app's uber jar and a jlink'd runtime, then starts the result headless with --smoke.
#
# Why not `./gradlew :app:packageDeb`: Temurin 25 ships no jmods/ directory (JEP 493), so Compose's jlink step can run only with
# the module list in app/build.gradle.kts (it can't add jdk.jlink), and the launcher jpackage then builds for Compose's ~80-entry
# classpath crashes in setenv (SIGSEGV in jvmLauncherStartJvm, before the JVM starts; seen with Temurin 25.0.5). With the uber
# jar the classpath is one entry and the package starts. jlink runs from the JDK's own run-time image, no jmods needed.
# The runtime's modules are the list in app/build.gradle.kts (`modules(...)`); keep the two in step.
#
# Usage: scripts/package-linux.sh [JDK25_HOME]     (default $JAVA_HOME). Output: app/build/linux-package/*.deb
set -euo pipefail
cd "$(dirname "$0")/.."
JDK="${1:-${JAVA_HOME:-}}"
[ -x "$JDK/bin/jpackage" ] && [ -x "$JDK/bin/jlink" ] || { echo "pass a JDK 25 home that has bin/jpackage and bin/jlink" >&2; exit 2; }
VERSION=$(sed -n 's/^val appVersion = "\(.*\)"/\1/p' app/build.gradle.kts)
MODULES=$(sed -n '/^            modules($/,/^            )$/p' app/build.gradle.kts | grep -o '"[a-z.]*"' | tr -d '"' | paste -sd, -)
[ -n "$VERSION" ] && [ -n "$MODULES" ] || { echo "could not read the version and module list from app/build.gradle.kts" >&2; exit 2; }

./gradlew :app:packageUberJarForCurrentOS -q
jar=$(ls app/build/compose/jars/pc-supervisor-linux-x64-*.jar)
out=app/build/linux-package
rm -rf "$out" && mkdir -p "$out/input"
cp "$jar" "$out/input/"
# signed dependencies leave signature files in the uber jar that no longer match it
zip -q -d "$out/input/$(basename "$jar")" "META-INF/*.SF" "META-INF/*.RSA" "META-INF/*.DSA" || true
"$JDK/bin/jlink" --add-modules "$MODULES" --strip-debug --no-header-files --no-man-pages --output "$out/runtime"
"$JDK/bin/jpackage" --type deb --name pc-supervisor --app-version "$VERSION" --vendor "PC Supervisor contributors" \
  --description "Supervises a HotCRP review process for the conference chairs" \
  --input "$out/input" --main-jar "$(basename "$jar")" --main-class pcs.app.MainKt \
  --java-options --enable-native-access=ALL-UNNAMED --runtime-image "$out/runtime" --dest "$out"
deb=$(ls "$out"/*.deb)
dpkg-deb -x "$deb" "$out/root"
echo "built $deb ($(du -h "$deb" | cut -f1))"
PCS_CONFERENCES="$out/none" "$out/root/opt/pc-supervisor/bin/pc-supervisor" --smoke
