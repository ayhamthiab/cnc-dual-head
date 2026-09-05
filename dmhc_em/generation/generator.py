"""
G-code Generator (Volume 7)
Converts abstract zone assignments back into valid, executable G-code programs.

Core principle: We REGENERATE G-code from structured geometry.
We do NOT split or copy the original G-code text.
Arc segments (G2/G3) are faithfully reproduced with their I and J parameters.
"""
from __future__ import annotations

from dataclasses import replace

from dmhc_em.ir.segment import Segment, MotionType
from .state_builder import (
    build_preamble,
    build_postamble,
    rapid_to,
    plunge_to,
    PEN_UP_Z,
    PEN_DOWN_Z,
)


def _cut_line(seg: Segment) -> str:
    """Generate a single cut line for a segment (G1, G2, or G3)."""
    if seg.g_code == 2:
        return (
            f"G2 X{seg.x2:.4f} Y{seg.y2:.4f}"
            f" I{seg.i_offset:.4f} J{seg.j_offset:.4f}"
            f" F{seg.feed_rate:.1f}"
        )
    if seg.g_code == 3:
        return (
            f"G3 X{seg.x2:.4f} Y{seg.y2:.4f}"
            f" I{seg.i_offset:.4f} J{seg.j_offset:.4f}"
            f" F{seg.feed_rate:.1f}"
        )
    # G1 linear (default)
    return f"G1 X{seg.x2:.4f} Y{seg.y2:.4f} F{seg.feed_rate:.1f}"


def generate_file(
    segments: list[Segment],
    label: str,
    spindle_speed: float = 12000.0,
    cut_depth: float = -1.0,
    pen_up_z: float = PEN_UP_Z,
    pen_down_z: float = PEN_DOWN_Z,
    y_reference: float | None = None,
    h2_offset_x: float = 0.0,
    mirror_x: bool = False,
) -> str:
    """
    Generate a complete, standalone G-code file for a list of segments.

    The generator:
    1. Emits a safe preamble.
    2. Groups segments into contiguous runs.
    3. For each run: rapid to start → plunge → cut → retract.
    4. Emits postamble.

    Coordinate transforms:
      - ``mirror_x`` mirrors X around the machine origin:
        OUTPUT_X = -INPUT_X.  This also swaps G2/G3 and negates I so arcs
        retain their geometry after reflection.
      - Head 2 additionally uses a local Y reference:
        H2_Y = GLOBAL_Y - y_reference.
        Y translation leaves arc direction and relative I/J offsets unchanged.
    """
    if y_reference is not None:
        working_segments = [
            _transform_for_head2(seg, y_reference, h2_offset_x, mirror_x)
            for seg in segments
        ]
    elif mirror_x:
        working_segments = [_mirror_x(seg) for seg in segments]
    else:
        working_segments = list(segments)

    lines: list[str] = []
    # Count only XY-moving cut segments (plunge-only G1 Z moves have length≈0)
    xy_cut_count = sum(
        1 for s in working_segments
        if s.motion_type == MotionType.CUT and s.length() > 1e-9
    )
    lines.append(f"; ============================================")
    lines.append(f"; DMHC-EM Generated File — {label}")
    lines.append(f"; Segments: {xy_cut_count}")
    lines.append(f"; ============================================")

    if not working_segments:
        lines.append("; (no segments assigned to this zone)")
        lines += build_postamble(pen_up_z)
        return "\n".join(lines)

    lines += build_preamble(spindle_speed, pen_up_z)
    lines.append("")

    # Group into contiguous cut runs (separated by position jumps), then
    # rebalance long runs by machining effort so the final output does not
    # leave one head with a few very long runs while another has many tiny ones.
    runs = _rebalance_runs(_group_into_runs(working_segments))

    for run_idx, run in enumerate(runs):
        # Exclude zero-XY-length segments (plunge moves — G1 Z only).
        # The plunge depth is emitted once by `plunge_to`; these segments have
        # no XY travel and would produce a redundant G1 to the same position.
        cut_segs = [
            s for s in run
            if s.motion_type == MotionType.CUT and s.length() > 1e-9
        ]
        if not cut_segs:
            continue

        first = cut_segs[0]
        lines.append(f"; --- Run {run_idx + 1} ({len(cut_segs)} segments) ---")
        # Rapid to start of this run at safe height
        lines.append(rapid_to(first.x1, first.y1, pen_up_z))
        # Plunge to cutting depth
        lines.append(plunge_to(pen_down_z, first.feed_rate))

        prev_x, prev_y = first.x1, first.y1
        for seg in cut_segs:
            # Handle discontinuity within a run (shouldn't normally happen)
            tol = 1e-4
            if abs(seg.x1 - prev_x) > tol or abs(seg.y1 - prev_y) > tol:
                lines.append(f"G0 Z{pen_up_z:.3f}   ; pen up")
                lines.append(rapid_to(seg.x1, seg.y1, pen_up_z))
                lines.append(plunge_to(pen_down_z, seg.feed_rate))

            lines.append(_cut_line(seg))
            prev_x, prev_y = seg.x2, seg.y2

        # Retract after run
        lines.append(f"G0 Z{pen_up_z:.3f}   ; pen up")
        lines.append("")

    lines += build_postamble(pen_up_z)
    return "\n".join(lines)


def _transform_for_head2(
    seg: Segment,
    h2_offset_y: float,
    h2_offset_x: float = 0.0,
    mirror_x: bool = False,
) -> Segment:
    """
    Map global geometry into Head 2's local coordinate frame.

    The Y transform is a pure translation:
        H2_Y = GLOBAL_Y - H2_OFFSET_Y

    When ``mirror_x`` is enabled, X is reflected around the origin after the
    optional X offset.  Reflection swaps G2/G3 and negates I while preserving
    the arc geometry.
    """
    translated = replace(
        seg,
        x1=seg.x1 - h2_offset_x,
        y1=seg.y1 - h2_offset_y,
        x2=seg.x2 - h2_offset_x,
        y2=seg.y2 - h2_offset_y,
    )
    return _mirror_x(translated) if mirror_x else translated


def _mirror_x(seg: Segment) -> Segment:
    """Reflect a segment across the Y axis while preserving its geometry."""
    mirrored_g_code = {2: 3, 3: 2}.get(seg.g_code, seg.g_code)
    return replace(
        seg,
        x1=-seg.x1,
        x2=-seg.x2,
        g_code=mirrored_g_code,
        i_offset=-seg.i_offset if seg.i_offset else 0.0,
    )


def _group_into_runs(
    segments: list[Segment],
    tol: float = 1e-4,
) -> list[list[Segment]]:
    """
    Group segments into contiguous runs.
    A new run starts when there is a positional break between end of one
    segment and start of the next.
    """
    if not segments:
        return []

    runs: list[list[Segment]] = []
    current_run: list[Segment] = [segments[0]]

    for seg in segments[1:]:
        prev = current_run[-1]
        if (abs(prev.x2 - seg.x1) < tol and abs(prev.y2 - seg.y1) < tol):
            current_run.append(seg)
        else:
            runs.append(current_run)
            current_run = [seg]

    runs.append(current_run)
    return runs


def _segment_effort(seg: Segment) -> float:
    """Use XY path length as a lightweight effort proxy for run balancing."""
    return seg.length()


def _run_effort(run: list[Segment]) -> float:
    return sum(_segment_effort(seg) for seg in run)


def _split_run_by_effort(run: list[Segment], max_effort: float) -> list[list[Segment]]:
    """
    Break a single contiguous run into smaller sub-runs when a long run is
    disproportionately heavy relative to the rest of the file.
    """
    if not run or max_effort <= 0:
        return [run]

    pieces: list[list[Segment]] = []
    current: list[Segment] = []
    current_effort = 0.0

    for seg in run:
        seg_effort = _segment_effort(seg)
        if not current:
            current = [seg]
            current_effort = seg_effort
            continue

        if current_effort + seg_effort > max_effort and len(current) > 1:
            pieces.append(current)
            current = [seg]
            current_effort = seg_effort
        else:
            current.append(seg)
            current_effort += seg_effort

    if current:
        pieces.append(current)

    return pieces


def _rebalance_runs(runs: list[list[Segment]]) -> list[list[Segment]]:
    """
    Rebalance run boundaries by total XY effort instead of raw segment count.

    This preserves the original geometry ordering and split logic but keeps
    very-heavy runs from dominating one head while other heads work on many
    tiny runs.
    """
    if len(runs) < 2:
        return runs

    efforts = [_run_effort(run) for run in runs]
    avg_effort = sum(efforts) / len(efforts)
    max_effort = max(1.0, avg_effort * 1.5)

    balanced: list[list[Segment]] = []
    for run in runs:
        if _run_effort(run) <= max_effort:
            balanced.append(run)
            continue

        balanced.extend(_split_run_by_effort(run, max_effort))

    # Merge tiny fragments back into neighboring runs when they become too small.
    merged: list[list[Segment]] = []
    for run in balanced:
        if not merged:
            merged.append(run)
            continue

        last = merged[-1]
        if _run_effort(run) < max(1.0, 0.3 * avg_effort) and len(last) <= 3:
            merged[-1].extend(run)
        else:
            merged.append(run)

    return merged
