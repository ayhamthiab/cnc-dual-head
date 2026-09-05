"""
Report Generator (Volume 9 / Volume 10)
Compiles all pipeline results into a unified JSON report.
"""
from __future__ import annotations

from dmhc_em.partition.engine import PartitionPlan
from dmhc_em.partition.scheduler import ScheduledExecution
from dmhc_em.collision.validator import ValidationResult
from dmhc_em.verification.equivalence import EquivalenceResult
from dmhc_em.partition.gap import GapRegion


def build_report(
    filename: str,
    plan: PartitionPlan,
    schedule: ScheduledExecution,
    validation: ValidationResult,
    equivalence: EquivalenceResult,
    config: dict,
) -> dict:
    """Build the full JSON report for a processing job."""
    gap = plan.gap

    return {
        "status": "PASS" if (validation.approved and equivalence.passed) else "FAIL",
        "filename": filename,
        "config": config,
        "partition": {
            "gap_center": round(gap.y_center, 4),
            "gap_width_nominal": gap.width,
            "gap_width_effective": round(gap.half_effective * 2, 4),
            "gap_y_min": round(gap.y_min_effective, 4),
            "gap_y_max": round(gap.y_max_effective, 4),
            # Legacy keys retained so older UI clients do not crash.
            "gap_x_min": round(gap.y_min_effective, 4),
            "gap_x_max": round(gap.y_max_effective, 4),
            "head1_segment_count": len(plan.head1_segments),
            "head2_segment_count": len(plan.head2_segments),
            "gap_segment_count": len(plan.gap_segments),
            "head1_effort": round(plan.head1_effort, 4),
            "head2_effort": round(plan.head2_effort, 4),
            "balance_score": round(plan.balance_score, 4),
        },
        "schedule": {
            "phase1_heads": schedule.phase1_heads,
            "phase2_head": schedule.phase2_head,
            "estimated_phase1_time_s": schedule.estimated_phase1_time_s,
            "estimated_phase2_time_s": schedule.estimated_phase2_time_s,
            "estimated_total_time_s": schedule.estimated_total_time_s,
            "estimated_serial_time_s": schedule.estimated_serial_time_s,
            "speedup_factor": schedule.speedup_factor,
        },
        "validation": validation.to_dict(),
        "equivalence": equivalence.to_dict(),
    }
