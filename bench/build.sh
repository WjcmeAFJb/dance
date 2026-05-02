#!/usr/bin/env bash
# Build the recorder benchmark using esbuild with vscode aliased to our mock.
set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p bench/out
node_modules/.bin/esbuild \
  --bundle \
  --platform=node \
  --target=node18 \
  --format=cjs \
  --alias:vscode=./bench/vscode-mock.ts \
  --external:child_process \
  --outfile=bench/out/recorder-bench.js \
  --keep-names \
  --sourcemap \
  bench/recorder-bench.ts
