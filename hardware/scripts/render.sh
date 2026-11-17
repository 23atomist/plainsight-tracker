#!/usr/bin/env bash
# Render one part: scripts/render.sh <name> <file.scad> [-D ...]  -> build/stl/<name>.stl + build/png/<name>.png
set -u
cd "$(dirname "$0")/.."
OS=${OPENSCAD:-/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD}
name=$1; file=$2; shift 2
mkdir -p build/stl build/png
log="build/png/$name.log"
if "$OS" -o "build/stl/$name.stl" --export-format binstl "$@" "$file" > "$log" 2>&1 \
   && "$OS" -o "build/png/$name.png" --render --viewall --autocenter --imgsize=800,600 --colorscheme=Tomorrow "$@" "$file" >> "$log" 2>&1; then
    if grep -qi "warning\|error:" "$log"; then echo "WARN  $name"; grep -i "warning\|error:" "$log" | head -5; else echo "ok    $name"; fi
else echo "FAIL  $name"; grep -i "error\|warning" "$log" | head -8; exit 1; fi
