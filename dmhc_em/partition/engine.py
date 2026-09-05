"""Y-axis partition engine for the two-head pen machine.

Head 1 receives geometry below the gap, Head 2 receives geometry above the
gap, and Gap Fill receives geometry inside the user-specified Y band.
Linear and circular segments are split at every crossing of both Y boundaries.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable

from dmhc_em.ir.graph import ToolpathGraph
from dmhc_em.ir.segment import Segment, Zone, MotionType
from dmhc_em.geometry.density import build_density_map, find_optimal_split
from dmhc_em.geometry.projection import YProjection, project_segments_y, compute_y_bounds
from .gap import GapRegion


@dataclass
class PartitionPlan:
    head1_segments: list[Segment] = field(default_factory=list)
    head2_segments: list[Segment] = field(default_factory=list)
    gap_segments: list[Segment] = field(default_factory=list)
    gap: GapRegion = field(default_factory=lambda: GapRegion(y_center=0, width=10))
    head1_effort: float = 0.0
    head2_effort: float = 0.0

    @property
    def balance_score(self) -> float:
        total = self.head1_effort + self.head2_effort
        if total < 1e-9:
            return 0.0
        return abs(self.head1_effort - self.head2_effort) / total

    def all_assigned_segments(self) -> list[Segment]:
        return self.head1_segments + self.head2_segments + self.gap_segments


def partition(
    graph: ToolpathGraph,
    gap_width: float = 80.0,
    tool_radius: float = 0.0,
    safety_margin: float = 0.0,
    num_bins: int = 200,
    gap_start_y: float | None = None,
) -> PartitionPlan:
    """Partition all cutting geometry by Y.

    ``tool_radius`` and ``safety_margin`` remain accepted for compatibility
    with older callers, but are intentionally ignored for this pen machine.

    ``gap_start_y``: when provided, the gap lower boundary is placed exactly at
    this Y coordinate.  The gap then spans [gap_start_y, gap_start_y +
    gap_width].  When omitted (None) the density optimizer auto-selects the
    optimal center position.
    """
    all_segments = graph.toolpath.all_segments() if graph.toolpath else graph.segments
    cut_segments = [s for s in all_segments if s.motion_type == MotionType.CUT]
    if not cut_segments:
        return PartitionPlan()

    projections = project_segments_y(cut_segments)
    y_min, y_max = compute_y_bounds(projections)
    y_span = y_max - y_min
    if y_span < 1e-6:
        raise ValueError(
            "Cannot split by Y because the cutting geometry has no Y span."
        )
    if gap_width <= 0:
        raise ValueError("Gap width must be greater than zero.")
    if gap_width >= y_span:
        raise ValueError(
            f"Gap configuration is wider than the workpiece.\n"
            f"  gap_width={gap_width:.2f} mm\n"
            f"  workpiece Y span={y_span:.2f} mm\n"
            f"Reduce gap_width."
        )

    if gap_start_y is not None:
        # Manual gap placement: user specifies the lower boundary exactly.
        gap_center = gap_start_y + gap_width / 2.0
        # Clamp so the gap stays within the workpiece Y range.
        half_gap = gap_width / 2.0
        gap_center = max(y_min + half_gap, min(y_max - half_gap, gap_center))
    else:
        # Density still uses x_min/x_max-named bins internally; here those
        # values are Y coordinates by construction.
        bins = build_density_map(projections, y_min, y_max, num_bins)
        gap_center = find_optimal_split(
            bins,
            x_global_min=y_min,
            x_global_max=y_max,
            gap_width=gap_width,
            penalty_weight=0.1,
            margin=0.05,
        )
        half_gap = gap_width / 2.0
        gap_center = max(y_min + half_gap, min(y_max - half_gap, gap_center))

    gap = GapRegion(y_center=gap_center, width=gap_width)

    plan = PartitionPlan(gap=gap)
    _assign_all(all_segments, gap, plan)

    if not plan.head1_segments or not plan.head2_segments:
        plan.head1_segments.clear()
        plan.head2_segments.clear()
        plan.gap_segments.clear()
        plan.head1_effort = 0.0
        plan.head2_effort = 0.0
        gap = GapRegion(y_center=(y_min + y_max) / 2.0, width=gap_width)
        plan.gap = gap
        _assign_all(all_segments, gap, plan)

    return plan


def _assign_all(
    all_segments: list[Segment],
    gap: GapRegion,
    plan: PartitionPlan,
) -> None:
    counter = [0]
    for seg in all_segments:
        if seg.motion_type == MotionType.RAPID:
            # Rapids are not emitted as source geometry; the generator creates
            # safe rapid moves for every output cutting run.
            seg.zone = Zone.HEAD1
            continue
        _split_and_assign(seg, gap, plan, counter)


def _split_and_assign(
    seg: Segment,
    gap: GapRegion,
    plan: PartitionPlan,
    counter: list[int],
) -> None:
    y_lo = gap.y_min_effective
    y_hi = gap.y_max_effective

    point_at, split_parameters = _segment_parameterization(seg, (y_lo, y_hi))
    all_t = [0.0, *split_parameters, 1.0]
    # Calculate every boundary point once.  Neighbouring pieces then receive
    # the very same tuple, eliminating independently-rounded intersections.
    points = [point_at(t) for t in all_t]

    for index, (t0, t1) in enumerate(zip(all_t, all_t[1:])):
        px1, py1 = points[index]
        px2, py2 = points[index + 1]
        if t0 == t1:
            continue

        counter[0] += 1
        piece = Segment(
            id=seg.id * 10_000 + counter[0],
            x1=px1,
            y1=py1,
            x2=px2,
            y2=py2,
            z_start=seg.z_start,
            z_end=seg.z_end,
            feed_rate=seg.feed_rate,
            motion_type=seg.motion_type,
            g_code=seg.g_code,
            i_offset=(seg.x1 + seg.i_offset) - px1 if seg.is_arc() else 0.0,
            j_offset=(seg.y1 + seg.j_offset) - py1 if seg.is_arc() else 0.0,
            contour_id=seg.contour_id,
            source_id=seg.id,
            source_t_start=t0,
            source_t_end=t1,
        )
        _, y_mid = point_at((t0 + t1) / 2.0)
        if y_mid <= y_lo:
            _place(piece, Zone.HEAD1, plan)
        elif y_mid >= y_hi:
            _place(piece, Zone.HEAD2, plan)
        else:
            _place(piece, Zone.GAP, plan)


def _segment_parameterization(
    seg: Segment,
    boundaries: tuple[float, float],
) -> tuple[Callable[[float], tuple[float, float]], list[float]]:
    """Return point(t) and every interior crossing, computed from geometry."""
    if not seg.is_arc():
        dx, dy = seg.x2 - seg.x1, seg.y2 - seg.y1

        def point_at(t: float) -> tuple[float, float]:
            return seg.x1 + t * dx, seg.y1 + t * dy

        if dy == 0.0:
            return point_at, []
        crossings = [(boundary - seg.y1) / dy for boundary in boundaries]
        return point_at, sorted({t for t in crossings if 0.0 < t < 1.0})

    cx, cy = seg.x1 + seg.i_offset, seg.y1 + seg.j_offset
    radius = math.hypot(seg.i_offset, seg.j_offset)
    start_angle = math.atan2(seg.y1 - cy, seg.x1 - cx)
    end_angle = math.atan2(seg.y2 - cy, seg.x2 - cx)
    full_circle = seg.x1 == seg.x2 and seg.y1 == seg.y2
    if seg.g_code == 2:
        sweep = (start_angle - end_angle) % (2.0 * math.pi)
        direction = -1.0
    else:
        sweep = (end_angle - start_angle) % (2.0 * math.pi)
        direction = 1.0
    if full_circle:
        sweep = 2.0 * math.pi

    def point_at(t: float) -> tuple[float, float]:
        if t == 0.0:
            return seg.x1, seg.y1
        if t == 1.0:
            return seg.x2, seg.y2
        angle = start_angle + direction * sweep * t
        return cx + radius * math.cos(angle), cy + radius * math.sin(angle)

    crossings: set[float] = set()
    if radius != 0.0 and sweep != 0.0:
        for boundary in boundaries:
            ratio = (boundary - cy) / radius
            if ratio < -1.0 or ratio > 1.0:
                continue
            angle = math.asin(ratio)
            for candidate in (angle, math.pi - angle):
                travelled = ((start_angle - candidate) if seg.g_code == 2
                             else (candidate - start_angle)) % (2.0 * math.pi)
                t = travelled / sweep
                if 0.0 < t < 1.0:
                    crossings.add(t)
    return point_at, sorted(crossings)


def _place(seg: Segment, zone: Zone, plan: PartitionPlan) -> None:
    if seg.source_id is None:
        seg.source_id = seg.id
    seg.zone = zone
    if zone == Zone.HEAD1:
        plan.head1_segments.append(seg)
        plan.head1_effort += seg.machining_effort()
    elif zone == Zone.HEAD2:
        plan.head2_segments.append(seg)
        plan.head2_effort += seg.machining_effort()
    else:
        plan.gap_segments.append(seg)
