"""
Main Pipeline Orchestrator (Volume 10)
Connects all stages of the DMHC-EM compiler:

  G-code → Parser → State Tracker → IR Graph → Density Model →
  Partition Engine → Scheduler → G-code Generator →
  Collision Validator → Equivalence Verifier → Output
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class PipelineConfig:
    num_heads: int = 2
    gap_width: float = 80.0
    # Retained as compatibility fields; the pen machine does not use them.
    tool_radius: float = 0.0
    safety_margin: float = 0.0
    head2_reference_y: float = 620.0
    pen_up_z: float = 5.0
    pen_down_z: float = 0.0
    spindle_speed: float = 12000.0
    cut_depth: float = -1.0
    feed_rate_mm_per_min: float = 1000.0
    # When set, the gap is placed with its lower boundary exactly at this Y
    # coordinate instead of being auto-selected by the density optimizer.
    # Set to None (the default) to let the optimizer choose.
    gap_start_y: Optional[float] = None
    # Physical machine workspace limits.  Set these to the actual machine travel
    # range (mm) so the boundary validator catches coordinates that fall outside
    # the machine envelope.  Leave as float("inf") (the default) to disable the
    # upper-bound check, e.g. when the machine size is unknown.
    machine_x_max: float = float("inf")
    machine_y_max: float = float("inf")


@dataclass
class PipelineResult:
    success: bool
    head1_code: str = ""
    head2_code: str = ""
    gap_code: str = ""
    report: dict = None
    error: Optional[str] = None

    def __post_init__(self):
        if self.report is None:
            self.report = {}


def run_pipeline(
    gcode_text: str,
    filename: str,
    config: Optional[PipelineConfig] = None,
) -> PipelineResult:
    """Execute the full DMHC-EM pipeline on a G-code program."""
    if config is None:
        config = PipelineConfig()

    try:
        # Stage 1: Parse + State Tracking → Instruction Stream
        from dmhc_em.core.instruction_stream import build_instruction_stream
        resolved = build_instruction_stream(gcode_text)

        if not resolved:
            return PipelineResult(
                success=False,
                error="No motion instructions found in G-code file",
            )

        # Stage 2: Build Toolpath Graph (IR)
        from dmhc_em.ir.graph import ToolpathGraph
        graph = ToolpathGraph()
        graph.build_from_resolved(resolved)

        # Stage 3: Dynamic Partition
        from dmhc_em.partition.engine import partition
        plan = partition(
            graph,
            gap_width=config.gap_width,
            tool_radius=config.tool_radius,
            safety_margin=config.safety_margin,
            gap_start_y=config.gap_start_y,
        )

        # Stage 4: Schedule
        from dmhc_em.partition.scheduler import schedule
        sched = schedule(plan, feed_rate_mm_per_min=config.feed_rate_mm_per_min)

        # Stage 5: G-code Generation
        from dmhc_em.generation.generator import generate_file
        head1_code = generate_file(
            plan.head1_segments, "HEAD 1 — Zone A",
            spindle_speed=config.spindle_speed,
            cut_depth=config.cut_depth,
            pen_up_z=config.pen_up_z,
            pen_down_z=config.pen_down_z,
            mirror_x=True,
        )
        head2_code = generate_file(
            plan.head2_segments, "HEAD 2 — Zone B",
            spindle_speed=config.spindle_speed,
            cut_depth=config.cut_depth,
            pen_up_z=config.pen_up_z,
            pen_down_z=config.pen_down_z,
            # Head 2 runs in its local coordinate frame.  The reference
            # boundary becomes Y0, with geometry below it represented by
            # negative Y values.
            y_reference=config.head2_reference_y,
            mirror_x=True,
        )
        gap_code = generate_file(
            plan.gap_segments, "GAP FILL — Zone C",
            spindle_speed=config.spindle_speed,
            cut_depth=config.cut_depth,
            pen_up_z=config.pen_up_z,
            pen_down_z=config.pen_down_z,
            mirror_x=True,
        )

        # Stage 6: Collision Validation
        # Use machine bounds from config when provided (non-infinite); otherwise
        # the validator uses its own float("inf") defaults and the upper-bound
        # check is effectively disabled (segments can never exceed infinity).
        from dmhc_em.collision.validator import validate_plan
        validation = validate_plan(
            plan,
            machine_x_max=config.machine_x_max,
            machine_y_max=config.machine_y_max,
        )

        # Stage 7: Geometric Equivalence Verification
        from dmhc_em.verification.equivalence import verify_equivalence
        original_segments = graph.toolpath.all_segments() if graph.toolpath else graph.segments
        equivalence = verify_equivalence(
            original_segments,
            plan.head1_segments,
            plan.head2_segments,
            plan.gap_segments,
        )
        if not equivalence.passed:
            raise ValueError(
                "Generated split failed zero-gap/zero-overlap validation: "
                + "; ".join(equivalence.messages)
            )

        # Stage 8: Build Report
        from dmhc_em.output.reporter import build_report
        report = build_report(
            filename=filename,
            plan=plan,
            schedule=sched,
            validation=validation,
            equivalence=equivalence,
            config={
                "numHeads": config.num_heads,
                "gapWidth": config.gap_width,
                "toolRadius": config.tool_radius,
                "safetyMargin": config.safety_margin,
                "head2ReferenceY": config.head2_reference_y,
                "penUpZ": config.pen_up_z,
                "penDownZ": config.pen_down_z,
            },
        )

        return PipelineResult(
            success=True,
            head1_code=head1_code,
            head2_code=head2_code,
            gap_code=gap_code,
            report=report,
        )

    except Exception as exc:
        import traceback
        return PipelineResult(
            success=False,
            error=f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}",
        )
