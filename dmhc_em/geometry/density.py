"""
Work Density Model (Volume 5 / Chapter 9 — Density Model Construction)

D(x) = machining effort per X interval.

High D(x) → dense machining region
Low D(x)  → sparse / empty region

This module builds the spatial density map and finds the optimal gap centre
using a workload-balance optimisation that correctly accounts for the gap width.
"""
from __future__ import annotations

from dataclasses import dataclass

from .projection import XProjection


@dataclass
class DensityBin:
    x_min: float
    x_max: float
    density: float    # total effort in this bin
    segment_ids: list[int]

    @property
    def x_mid(self) -> float:
        return (self.x_min + self.x_max) / 2.0


def build_density_map(
    projections: list[XProjection],
    x_min: float,
    x_max: float,
    num_bins: int = 100,
) -> list[DensityBin]:
    """
    Discretise the X range into num_bins equal-width bins and accumulate
    machining effort from segment projections into each bin.

    Each projection contributes effort proportionally to the fraction of its
    X span that overlaps each bin.
    """
    if x_max <= x_min or num_bins <= 0:
        return []

    bin_width = (x_max - x_min) / num_bins
    bins: list[DensityBin] = [
        DensityBin(
            x_min=x_min + i * bin_width,
            x_max=x_min + (i + 1) * bin_width,
            density=0.0,
            segment_ids=[],
        )
        for i in range(num_bins)
    ]

    for proj in projections:
        seg_span = max(proj.x_max - proj.x_min, 1e-9)
        for b in bins:
            overlap = max(0.0, min(proj.x_max, b.x_max) - max(proj.x_min, b.x_min))
            if overlap > 0:
                fraction = overlap / seg_span
                b.density += proj.effort * fraction
                if proj.segment_id not in b.segment_ids:
                    b.segment_ids.append(proj.segment_id)

    return bins


def _cum_at_x(
    bins: list[DensityBin],
    prefix: list[float],
    x: float,
) -> float:
    """
    Interpolated cumulative effort at position x.

    prefix[i] = total effort in bins[0..i-1]  (prefix[0] = 0, prefix[N] = total)

    For x before all bins → 0.
    For x after all bins  → total.
    For x inside bin i    → prefix[i] + density[i] * fractional_overlap.
    """
    if not bins:
        return 0.0
    if x <= bins[0].x_min:
        return 0.0
    if x >= bins[-1].x_max:
        return prefix[-1]

    for i, b in enumerate(bins):
        if b.x_min <= x <= b.x_max:
            frac = (x - b.x_min) / max(b.x_max - b.x_min, 1e-9)
            return prefix[i] + b.density * frac

    return prefix[-1]


def find_optimal_split(
    bins: list[DensityBin],
    x_global_min: float,
    x_global_max: float,
    gap_width: float = 0.0,
    penalty_weight: float = 0.1,
    margin: float = 0.05,
) -> float:
    """
    Find the gap centre X that optimally balances machining effort between the
    two heads, given a fixed gap of width ``gap_width``.

    Algorithm
    ---------
    Every bin boundary in the workpiece interior is treated as the LEFT EDGE
    of the gap (i.e. the nominal HEAD1 / gap boundary).  For each candidate:

        gap_left   = left_edge
        gap_right  = left_edge + gap_width
        gap_centre = (gap_left + gap_right) / 2

    The two sub-scores are:

    balance_score  = |left_effort − right_effort| / total_effort     ∈ [0, 1]
        left_effort  = cumulative effort strictly left  of gap_left
        right_effort = cumulative effort strictly right of gap_right
        0  → both heads share equal work   (perfect)
        1  → all work falls on one side    (worst)

    risk_penalty   = mean local density at gap_left and gap_right     ∈ [0, 1]
        Penalises splits that land inside dense geometry, where tool
        separation becomes physically tight.
        0  → both gap edges fall in empty space
        1  → both edges cut through the densest region

    Combined objective:
        score = balance_score + penalty_weight × risk_penalty
                + 1e-6 × |gap_centre − geometric_centre| / x_span

    The tiny centering bias (1e-6) acts as a tiebreaker: among all candidates
    that achieve the same balance and risk score, it prefers the one closest to
    the geometric midpoint, maximising physical headroom on both sides.

    Parameters
    ----------
    bins          : density map from build_density_map()
    x_global_min  : leftmost X of the workpiece
    x_global_max  : rightmost X of the workpiece
    gap_width     : fixed gap width in the same units as the G-code (e.g. mm)
    penalty_weight: weight for the geometric-risk term  (default 0.1)
    margin        : fraction of workpiece to exclude at each edge (default 5 %)

    Returns
    -------
    Optimal gap centre X coordinate.
    """
    geometric_center = (x_global_min + x_global_max) / 2.0

    if not bins:
        return geometric_center

    x_span = x_global_max - x_global_min
    if x_span <= 0.0:
        return geometric_center

    total_effort = sum(b.density for b in bins)
    if total_effort < 1e-9:
        return geometric_center

    # Build prefix-sum array: prefix[i] = effort in bins[0..i-1]
    prefix: list[float] = [0.0]
    for b in bins:
        prefix.append(prefix[-1] + b.density)

    max_density = max(b.density for b in bins) or 1.0

    # Interior margin: the gap centre must stay away from the very edges
    lo_center = x_global_min + margin * x_span
    hi_center = x_global_max - margin * x_span

    best_score = float("inf")
    best_center = geometric_center

    for i, b in enumerate(bins):
        # This bin's right edge is a candidate LEFT nominal gap boundary
        left_edge = b.x_max
        right_edge = left_edge + gap_width
        gap_center = left_edge + gap_width / 2.0

        # Gap must be entirely within the workpiece
        if right_edge > x_global_max:
            continue

        # Gap centre must be within the allowed interior
        if gap_center < lo_center or gap_center > hi_center:
            continue

        # ── Effort on each side ───────────────────────────────────────────────
        # HEAD1 cuts everything to the left  of left_edge  (nominal gap left)
        # HEAD2 cuts everything to the right of right_edge (nominal gap right)
        # Any geometry between left_edge and right_edge → gap fill (not counted
        # as head load for the balance calculation, since it runs in its own
        # separate pass after both heads finish).
        left_effort  = _cum_at_x(bins, prefix, left_edge)
        right_effort = total_effort - _cum_at_x(bins, prefix, right_edge)

        # ── Balance term ──────────────────────────────────────────────────────
        head_total = left_effort + right_effort
        if head_total < 1e-9:
            balance_score = 0.0
        else:
            balance_score = abs(left_effort - right_effort) / head_total

        # ── Risk penalty ──────────────────────────────────────────────────────
        # Average local density at the two gap edges.
        left_density  = b.density                                   # bin ending at left_edge
        right_bin_idx = min(
            range(len(bins)),
            key=lambda j: abs(bins[j].x_min - right_edge),
        )
        right_density = bins[right_bin_idx].density
        risk_penalty  = (left_density + right_density) / 2.0 / max_density

        # ── Centering tiebreaker ──────────────────────────────────────────────
        centering_bias = 1e-6 * abs(gap_center - geometric_center) / x_span

        score = balance_score + penalty_weight * risk_penalty + centering_bias

        if score < best_score:
            best_score = score
            best_center = gap_center

    return best_center


def cumulative_effort(bins: list[DensityBin]) -> list[float]:
    """Return cumulative effort across bins (prefix sum)."""
    result: list[float] = []
    total = 0.0
    for b in bins:
        total += b.density
        result.append(total)
    return result
