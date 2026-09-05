---
name: Arc support — full fix
description: G2/G3 arc instructions were previously silently dropped or treated as straight chord lines; full fix applied across 6 files.
---

## Root cause (before fix)
- `parser.py`: `is_motion()` only recognized G0/G1 → G2/G3 were non-motion, never entered instruction stream
- `machine_state.py`: G2/G3 fell through `apply()` without updating position → arcs had wrong start/end
- `instruction_stream.py`: zero-movement guard filtered full circles (start==end) even for arcs
- `segment.py`: no arc fields; `x_min()`/`x_max()` used endpoints only → circles showed as a point
- `generator.py`: always emitted `G1`, never `G2`/`G3`

## Layers fixed (in order)
1. **parser.py** — Added `i`, `j` fields; G2/G02/G3/G03 in `is_motion()` / `is_cut()`; I, J extracted from regex
2. **machine_state.py** — G2/G3 handled same as G1 (endpoint updates X, Y; I, J are local)
3. **instruction_stream.py** — `g_code`, `i_offset`, `j_offset` on ResolvedInstruction; arcs skip the zero-movement guard
4. **segment.py** — `g_code`, `i_offset`, `j_offset` fields; `_arc_bbox()` + `_angle_in_arc()` helpers for true CW/CCW bounding boxes; `_arc_length()` computes arc length
5. **graph.py** — passes arc fields from ResolvedInstruction to Segment
6. **generator.py** — `_cut_line()` emits G2/G3 with I J for arc segments
7. **canonical.py** — CanonicalSegment includes `g_code`, `i_offset`, `j_offset`; arcs are direction-sensitive (no endpoint swap)

## Bounding box algorithm
`_arc_bbox(x1,y1,x2,y2,i,j,clockwise)`: seeds from endpoints, then checks each cardinal point (0°,90°,180°,270°) via `_angle_in_arc()`. Full circle detected by `abs(x1-x2)<1e-6 and abs(y1-y2)<1e-6` → returns cx±r, cy±r.
`_angle_in_arc(angle, θ_start, θ_end, CW)`: uses modular angular distance — `(θ_start - angle) % 2π ≤ sweep` for CW.

## Gap center after arc fix
Arcs now add true bounding boxes to density map. `find_density_valley()` returns `None` when NO zero-density bins exist (fully packed). `partition()` uses `valley_x` (widest zero-density run) as primary, `balanced_x` only as fallback. Do NOT blend: inter-shape gaps also have zero density near the 50% cumulative crossing, causing gap center drift when blended.

**Why:** Blending (70% valley + 30% balanced) caused gap center to drift from 500 to 430 because the balanced 50%-crossing landed in a small inter-shape gap at X=269, not the main gap at X=500.
