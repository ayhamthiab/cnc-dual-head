"""
Spatial Projection (Volume 5 / Chapter 8)
Projects segment geometry onto the X-axis for density analysis and partitioning.

WARNING: Projection is used ONLY for analysis — it must never modify geometry.
"""
from __future__ import annotations

from dataclasses import dataclass

from dmhc_em.ir.segment import Segment, MotionType


@dataclass
class XProjection:
    """X-axis projection of a single segment."""
    segment_id: int
    x_min: float
    x_max: float
    effort: float       # machining effort (length × weight)

    @property
    def x_span(self) -> float:
        return self.x_max - self.x_min

    @property
    def x_mid(self) -> float:
        return (self.x_min + self.x_max) / 2.0


@dataclass
class YProjection:
    """Y-axis projection used by the Y partitioner.

    The compatibility ``x_min``/``x_max`` properties let the existing density
    map operate on either axis without duplicating its binning algorithm.
    """
    segment_id: int
    y_min: float
    y_max: float
    effort: float

    @property
    def x_min(self) -> float:
        return self.y_min

    @property
    def x_max(self) -> float:
        return self.y_max

    @property
    def x_span(self) -> float:
        return self.y_max - self.y_min

    @property
    def x_mid(self) -> float:
        return (self.y_min + self.y_max) / 2.0


def project_segments(segments: list[Segment]) -> list[XProjection]:
    """
    Project each segment onto the X-axis.
    Only cut segments contribute meaningful work density.
    Rapid moves are included with low effort weight.
    """
    projections: list[XProjection] = []
    for seg in segments:
        projections.append(XProjection(
            segment_id=seg.id,
            x_min=seg.x_min(),
            x_max=seg.x_max(),
            effort=seg.machining_effort(),
        ))
    return projections


def compute_x_bounds(projections: list[XProjection]) -> tuple[float, float]:
    """Return (global_x_min, global_x_max) across all projections."""
    if not projections:
        return (0.0, 0.0)
    return (
        min(p.x_min for p in projections),
        max(p.x_max for p in projections),
    )


def project_segments_y(segments: list[Segment]) -> list[YProjection]:
    """Project each segment onto the Y axis for density analysis."""
    return [
        YProjection(
            segment_id=seg.id,
            y_min=seg.y_min(),
            y_max=seg.y_max(),
            effort=seg.machining_effort(),
        )
        for seg in segments
    ]


def compute_y_bounds(projections: list[YProjection]) -> tuple[float, float]:
    """Return the global Y bounds across all projections."""
    if not projections:
        return (0.0, 0.0)
    return (
        min(p.y_min for p in projections),
        max(p.y_max for p in projections),
    )
