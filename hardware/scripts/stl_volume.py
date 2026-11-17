#!/usr/bin/env python3
"""Print 'volume xmin xmax ymin ymax zmin zmax' of an ASCII STL (absolute signed volume)."""
import sys, os
tri = []; cur = []
if not os.path.exists(sys.argv[1]):      # OpenSCAD writes nothing for an empty result
    print("0 - - - - - -"); sys.exit(0)
for line in open(sys.argv[1]):
    if line.strip().startswith('vertex'):
        cur.append(tuple(float(v) for v in line.split()[1:4]))
        if len(cur) == 3: tri.append(cur); cur = []
if not tri:
    print("0 - - - - - -"); sys.exit(0)
vol = 0.0
for a, b, c in tri:
    vol += (a[0]*(b[1]*c[2]-b[2]*c[1]) - a[1]*(b[0]*c[2]-b[2]*c[0]) + a[2]*(b[0]*c[1]-b[1]*c[0])) / 6.0
pts = [p for t in tri for p in t]
bb = [f(p[i] for p in pts) for i in range(3) for f in (min, max)]
print(f"{abs(vol):.3f} " + " ".join(f"{v:.1f}" for v in bb))
