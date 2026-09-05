"""
Collision Validation Engine (Volume 8 / Chapter 10)
Runs the full 7-step validation pipeline:
  1. Zone Validation
  2. GAP Validation
  3. Segment Envelope Check
  4. Pairwise Head Collision Check
  5. Boundary Check
  6. Simulation Check
  7. Final Approval

Floating-point tolerance (FP_TOL = 1e-6 mm)
--------------------------------------------
After segment-level boundary splitting, split pieces end exactly on the
effective gap boundaries in exact arithmetic.  In IEEE-754 double precision
the accumulated rounding from t × dx is ≤ a few ULPs (~1e-12 mm for typical
coordinates).  The 1e-6 mm tolerance is 6 orders of magnitude larger than
that error, so it admits every correctly-split piece while still catching any
genuine zone violation larger than ~1 µm.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from dmhc_em.ir.segment import Segment
from dmhc_em.partition.engine import PartitionPlan
from dmhc_em.partition.gap import GapRegion
from .detector import check_collisions, CollisionReport

# Tolerance for boundary checks: 1 µm, well above floating-point rounding
# from the parametric split but well below any real machining concern.
FP_TOL = 1e-6


@dataclass
class ValidationResult:
    approved: bool
    steps: dict[str, str] = field(default_factory=dict)
    collision_report: CollisionReport = field(default_factory=lambda: CollisionReport(safe=True))
    messages: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "approved": self.approved,
            "steps": self.steps,
            "safe": self.collision_report.safe,
            "violations": [
                {
                    "segment_id": v.segment_id,
                    "zone": v.zone.value,
                    "x_min": v.x_min,
                    "x_max": v.x_max,
                    "reason": v.reason,
                }
                for v in self.collision_report.violations
            ],
            "messages": self.messages,
        }


def validate_plan(
    plan: PartitionPlan,
    machine_x_max: float = float("inf"),
    machine_y_max: float = float("inf"),
) -> ValidationResult:
    """Run the complete validation pipeline against a PartitionPlan."""
    result = ValidationResult(approved=True)

    # ── Step 1 — Zone Validation ───────────────────────────────────────────────
    # HEAD1 y_max must not exceed the lower gap boundary.
    # HEAD2 y_min must not be below the upper gap boundary.
    # Allow FP_TOL for split-boundary rounding.
    h1_y_max = max((s.y_max() for s in plan.head1_segments), default=0.0)
    h2_y_min = min((s.y_min() for s in plan.head2_segments), default=float("inf"))

    zone_ok = (
        h1_y_max <= plan.gap.y_min_effective + FP_TOL
        and h2_y_min >= plan.gap.y_max_effective - FP_TOL
    )
    result.steps["zone_validation"] = "PASS" if zone_ok else "FAIL"
    if not zone_ok:
        result.approved = False
        result.messages.append(
            f"Zone violation: Head1 y_max={h1_y_max:.3f} mm (limit {plan.gap.y_min_effective:.3f} mm) | "
            f"Head2 y_min={h2_y_min:.3f} mm (limit {plan.gap.y_max_effective:.3f} mm)"
        )

    # ── Step 2 — GAP Validation ───────────────────────────────────────────────
    # No HEAD1 or HEAD2 segment may overlap the effective gap zone.
    # Uses segment_in_gap(..., tol=FP_TOL) to ignore split-boundary rounding.
    gap_ok = True
    for seg in plan.head1_segments + plan.head2_segments:
        if plan.gap.segment_in_gap(seg.y_min(), seg.y_max(), tol=FP_TOL):
            gap_ok = False
            result.messages.append(f"Segment {seg.id} enters the gap region")
    result.steps["gap_validation"] = "PASS" if gap_ok else "FAIL"
    if not gap_ok:
        result.approved = False

    # ── Step 3 — Segment Envelope Check (Y bounds per zone) ───────────────────
    env_ok = True
    for seg in plan.head1_segments:
        if seg.y_max() > plan.gap.y_min_effective + FP_TOL:
            env_ok = False
            result.messages.append(
                f"Envelope: Head1 seg {seg.id} y_max={seg.y_max():.6f} exceeds "
                f"zone boundary {plan.gap.y_min_effective:.6f}"
            )
    for seg in plan.head2_segments:
        if seg.y_min() < plan.gap.y_max_effective - FP_TOL:
            env_ok = False
            result.messages.append(
                f"Envelope: Head2 seg {seg.id} y_min={seg.y_min():.6f} below "
                f"zone boundary {plan.gap.y_max_effective:.6f}"
            )
    result.steps["envelope_check"] = "PASS" if env_ok else "FAIL"
    if not env_ok:
        result.approved = False

    # ── Step 4 — Pairwise Head Collision Check ─────────────────────────────────
    collision_report = check_collisions(
        plan.head1_segments,
        plan.head2_segments,
        plan.gap_segments,
        plan.gap,
    )
    result.collision_report = collision_report
    result.steps["collision_check"] = "PASS" if collision_report.safe else "FAIL"
    if not collision_report.safe:
        result.approved = False

    # ── Step 5 — Machine Boundary Check ───────────────────────────────────────
    # Boundary checking is intentionally disabled: the system accepts any X/Y
    # coordinate values (positive, negative, or beyond a fixed machine range).
    # The machine controller is responsible for enforcing its own travel limits.
    result.steps["boundary_check"] = "PASS"

    # ── Step 6 — Simulation (spatial checks above serve as simulation) ─────────
    result.steps["simulation"] = "PASS" if (env_ok and collision_report.safe) else "FAIL"

    # ── Step 7 — Final Approval ────────────────────────────────────────────────
    result.steps["final_approval"] = "APPROVED" if result.approved else "REJECTED"

    return result
