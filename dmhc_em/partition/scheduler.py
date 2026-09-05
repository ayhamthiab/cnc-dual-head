"""
Scheduler (Volume 6 / Chapter 9)
Determines the temporal execution order for the multi-head plan.

Head 1 and Head 2 execute in parallel (t0 → t1).
Gap Fill (Head 3) executes ONLY after both Head 1 and Head 2 finish (t1 → t2).
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from .engine import PartitionPlan


class ExecutionPhase(str, Enum):
    PARALLEL   = "parallel"    # Head 1 + Head 2 simultaneously
    SEQUENTIAL = "sequential"  # Gap fill after both complete


@dataclass
class ScheduledExecution:
    """
    Describes the execution schedule for a partition plan.
    """
    phase1_heads: list[str]   # ["head1", "head2"]
    phase2_head: str          # "gapfill"
    estimated_phase1_time_s: float   # seconds (effort-based estimate)
    estimated_phase2_time_s: float
    estimated_total_time_s: float
    estimated_serial_time_s: float   # what single-head would take
    speedup_factor: float


_FEED_RATE_TO_TIME = 60.0 / 1000.0  # effort unit → seconds (rough proxy)


def schedule(plan: PartitionPlan, feed_rate_mm_per_min: float = 1000.0) -> ScheduledExecution:
    """
    Build an execution schedule from a PartitionPlan.
    Timing is a rough estimate based on machining effort.
    """
    effort_h1   = plan.head1_effort
    effort_h2   = plan.head2_effort
    effort_gap  = sum(s.machining_effort() for s in plan.gap_segments)
    effort_total = effort_h1 + effort_h2 + effort_gap

    # Parallel phase: bottleneck is the slower head
    t_phase1 = max(effort_h1, effort_h2) / max(feed_rate_mm_per_min / 60.0, 1.0)
    t_phase2 = effort_gap / max(feed_rate_mm_per_min / 60.0, 1.0)
    t_total  = t_phase1 + t_phase2
    t_serial = effort_total / max(feed_rate_mm_per_min / 60.0, 1.0)
    speedup  = t_serial / max(t_total, 1e-9)

    return ScheduledExecution(
        phase1_heads=["head1", "head2"],
        phase2_head="gapfill",
        estimated_phase1_time_s=round(t_phase1, 2),
        estimated_phase2_time_s=round(t_phase2, 2),
        estimated_total_time_s=round(t_total, 2),
        estimated_serial_time_s=round(t_serial, 2),
        speedup_factor=round(speedup, 3),
    )
