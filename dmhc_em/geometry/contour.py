"""
Contour Analysis (Volume 5 / Chapter 5-6)
Provides utilities for analysing contour properties:
closed vs open, cross-zone detection, and zone classification.

Important: zone membership uses NOMINAL gap boundaries.
Effective boundaries (which include tool_radius + safety_margin) are for the
collision validator only — using them here causes over-aggressive GAP routing.
"""
from __future__ import annotations

from dmhc_em.ir.toolpath import Contour
from dmhc_em.ir.segment import Zone


def contour_crosses_x(contour: Contour, x: float) -> bool:
    """Return True if any segment in the contour straddles the given X position."""
    for seg in contour.segments:
        if seg.x_min() < x < seg.x_max():
            return True
    return False


def contour_is_splittable(contour: Contour, gap_x_min: float, gap_x_max: float) -> bool:
    """
    Return True if the contour does NOT cross the gap region.

    CALLER NOTE: pass gap.x_min_nominal / gap.x_max_nominal here, not the
    effective boundaries.  Effective boundaries include tool_radius + margin
    and will incorrectly classify distant geometry as gap-crossing.

    A contour crosses the gap when its X extent overlaps [gap_x_min, gap_x_max]:
        contour.x_max() > gap_x_min  AND  contour.x_min() < gap_x_max
    Using the contour extent (not per-segment) is correct because contour
    integrity is preserved: either the whole contour is outside the gap or
    it is deferred.
    """
    c_x_min = contour.x_min()
    c_x_max = contour.x_max()
    crosses = c_x_min < gap_x_max and c_x_max > gap_x_min
    return not crosses


def contour_dominant_zone(contour: Contour, gap_x_min: float, gap_x_max: float) -> Zone:
    """
    Return the zone that dominates the contour by machining effort.
    Used when a contour does not cross the gap.

    CALLER NOTE: pass gap.x_min_nominal / gap.x_max_nominal.
    """
    effort: dict[Zone, float] = {Zone.HEAD1: 0.0, Zone.HEAD2: 0.0, Zone.GAP: 0.0}
    for seg in contour.segments:
        x_mid = seg.x_mid()
        if x_mid < gap_x_min:
            effort[Zone.HEAD1] += seg.machining_effort()
        elif x_mid > gap_x_max:
            effort[Zone.HEAD2] += seg.machining_effort()
        else:
            effort[Zone.GAP] += seg.machining_effort()
    return max(effort, key=lambda z: effort[z])
