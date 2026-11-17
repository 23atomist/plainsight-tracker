#!/usr/bin/env python3
"""Print name, size and min Z of binary STLs (print placement sanity: min Z should be ~0)."""
import struct, sys
for path in sys.argv[1:]:
    with open(path, 'rb') as f:
        f.seek(80); n = struct.unpack('<I', f.read(4))[0]
        mn = [1e9]*3; mx = [-1e9]*3
        for _ in range(n):
            d = struct.unpack('<12fH', f.read(50))
            for v in range(3):
                for k in range(3):
                    c = d[3 + v*3 + k]; mn[k] = min(mn[k], c); mx[k] = max(mx[k], c)
    name = path.split('/')[-1].replace('.stl', '')
    print(f"{name:18s} {mx[0]-mn[0]:6.1f} x {mx[1]-mn[1]:6.1f} x {mx[2]-mn[2]:6.1f} mm   minZ {mn[2]:6.2f}  tris {n}")
