---
name: Density Gap Placement
description: How the gap center is computed and what bugs existed / were fixed
---

## Algorithm (as of fix)

1. `find_density_valley` — two-pass via `_widest_run_center`:
   - Pass 1: widest **density == 0** contiguous run in interior (margin 5%)
   - Pass 2 fallback: widest run at global minimum density
   - Ultimate fallback: single lowest-density bin center

2. `find_balanced_split` — locates first bin where cumulative effort >= 50%, then:
   - If that bin has density == 0: expand left+right through zero-density bins → return zone center
   - If that bin has density > 0: walk LEFT to find the zero-density run ending before the crossing → return that zone center
   - Fallback: crossing bin's x_mid

3. Gap center = 0.7 × valley_x + 0.3 × balanced_x

**Why:** The original `find_density_valley` returned the FIRST zero-density bin (e.g. X=183 for a small inter-shape gap) instead of the widest zero-density run (the actual physical gap zone X=400-600). The original `find_balanced_split` returned the edge of the left work zone (X=370) instead of the center of the gap. Combined, gap center was at X=295 instead of X=500.

## Machine Bounds Validation

`PipelineConfig.machine_x_max` / `machine_y_max` (default `float("inf")`) are passed directly to `validate_plan()`. When `inf`, upper-bound check is disabled. Callers must explicitly set these to enable meaningful machine envelope validation. The old hardcoded 300mm default falsely rejected any job larger than 300mm.
