"""
Toolpath and Contour (Volume 4 / Volume 5)
A Contour is an ordered list of segments that form a connected path.
A Toolpath groups contours belonging to the same machining operation.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .segment import Segment, Zone


@dataclass
class Contour:
    """
    An ordered sequence of connected Segments.
    May be open (engraving path) or closed (pocket/profile loop).
    """
    id: int
    segments: list[Segment] = field(default_factory=list)

    def is_closed(self, tol: float = 1e-4) -> bool:
        if len(self.segments) < 2:
            return False
        first = self.segments[0]
        last  = self.segments[-1]
        return (abs(first.x1 - last.x2) < tol and
                abs(first.y1 - last.y2) < tol)

    def x_min(self) -> float:
        return min(s.x_min() for s in self.segments)

    def x_max(self) -> float:
        return max(s.x_max() for s in self.segments)

    def x_mid(self) -> float:
        return (self.x_min() + self.x_max()) / 2.0

    def total_effort(self) -> float:
        return sum(s.machining_effort() for s in self.segments)

    def zone(self) -> Optional[Zone]:
        """Return zone if all segments share the same zone, else None."""
        zones = {s.zone for s in self.segments}
        if len(zones) == 1:
            return next(iter(zones))
        return None

    def assign_zone(self, zone: Zone) -> None:
        for s in self.segments:
            s.zone = zone

    def all_segment_ids(self) -> list[int]:
        return [s.id for s in self.segments]


@dataclass
class Toolpath:
    """
    A collection of contours that together form a complete machining strategy.
    """
    contours: list[Contour] = field(default_factory=list)

    def all_segments(self) -> list[Segment]:
        segs: list[Segment] = []
        for c in self.contours:
            segs.extend(c.segments)
        return segs

    def x_min(self) -> float:
        all_segs = self.all_segments()
        if not all_segs:
            return 0.0
        return min(s.x_min() for s in all_segs)

    def x_max(self) -> float:
        all_segs = self.all_segments()
        if not all_segs:
            return 0.0
        return max(s.x_max() for s in all_segs)

    def total_effort(self) -> float:
        return sum(c.total_effort() for c in self.contours)
