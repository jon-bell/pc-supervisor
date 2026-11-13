#!/usr/bin/env bash
# Build the Lean-in-core native library: lake's shared facet plus the C shim.
# Output: model/.lake/build/lib/libpcsffi.so (Linux; macOS and Windows: see PLAN M1 spike notes).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
lake build ReviewProcess:shared
LEAN="$(lean --print-prefix)"
cc -O2 -Wall -shared -fPIC ffi/pcs_ffi.c -I"$LEAN/include" -L.lake/build/lib -L"$LEAN/lib/lean" \
  -lReviewProcess_ReviewProcess -lleanshared -lInit_shared \
  -Wl,-rpath,"$PWD/.lake/build/lib" -Wl,-rpath,"$LEAN/lib/lean" -o .lake/build/lib/libpcsffi.so
echo "built model/.lake/build/lib/libpcsffi.so"
