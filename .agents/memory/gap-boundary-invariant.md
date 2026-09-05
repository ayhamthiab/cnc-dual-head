---
name: Nominal vs effective gap boundaries
description: Critical invariant — two distinct gap boundary concepts must never be conflated in the partition engine.
---

## Rule
Contour zone membership (`_assign_contour`, `_assign_segment`) uses **nominal** gap boundaries (`gap.x_min_nominal`, `gap.x_max_nominal`).
The collision validator uses **effective** boundaries (`gap.x_min_effective`, `gap.x_max_effective`).

**Why:** Effective boundaries add `tool_radius + safety_margin`. On small or normalised workpieces these additions can exceed the entire domain, causing every contour to route to GAP FILL and leaving HEAD1/HEAD2 empty. This was the root cause of the "all 20 segments go to gap fill" bug.

**How to apply:**
- Anywhere geometry is classified into zones → nominal.
- Anywhere the validator checks whether a head's cut path violates the safe envelope → effective.
- `GapRegion` exposes both as named properties; always use the named property, never compute offsets inline.
- `pipeline.py` re-raises `ValueError` (not wrapping it) so unit-mismatch errors from the partition engine surface as a clean error to the API caller rather than a generic `success=False`.
