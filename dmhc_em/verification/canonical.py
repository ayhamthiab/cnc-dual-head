"""
Canonical Form (Volume 9 / Chapter 3)
Converts segments into a direction-invariant, normalized canonical form
for geometric equivalence checking.
"""
from __future__ import annotations

from dataclasses import dataclass

from dmhc_em.ir.segment import Segment


PRECISION = 4   # decimal places for coordinate normalization


@dataclass(frozen=True)
class CanonicalSegment:
    """
    Direction-normalized, precision-normalized segment representation.

    For linear segments (G0/G1): endpoints are lexicographically sorted so
    A→B and B→A produce the same hash (direction-invariant).

    For arc segments (G2/G3): endpoints are NOT reordered because the arc
    geometry (center, direction) is direction-sensitive.  The i_offset and
    j_offset are kept as-is so that two arcs with the same endpoints but
    different sweep directions are correctly distinguished.
    """
    x1: float
    y1: float
    x2: float
    y2: float
    g_code: int = 1
    i_offset: float = 0.0
    j_offset: float = 0.0

    @classmethod
    def from_segment(cls, seg: Segment) -> "CanonicalSegment":
        p1 = (round(seg.x1, PRECISION), round(seg.y1, PRECISION))
        p2 = (round(seg.x2, PRECISION), round(seg.y2, PRECISION))
        g  = seg.g_code
        i  = round(seg.i_offset, PRECISION)
        j  = round(seg.j_offset, PRECISION)

        # Arcs: preserve direction — do not swap endpoints
        if g in (2, 3):
            return cls(x1=p1[0], y1=p1[1], x2=p2[0], y2=p2[1],
                       g_code=g, i_offset=i, j_offset=j)

        # Linear segments: direction-invariant
        if p1 > p2:
            p1, p2 = p2, p1
        return cls(x1=p1[0], y1=p1[1], x2=p2[0], y2=p2[1],
                   g_code=g, i_offset=0.0, j_offset=0.0)


def to_canonical_set(segments: list[Segment]) -> set[CanonicalSegment]:
    """Convert a segment list to its canonical set representation."""
    return {CanonicalSegment.from_segment(s) for s in segments}


def segment_hash(seg: Segment) -> tuple:
    """Return a canonical hash for deduplication checks."""
    cs = CanonicalSegment.from_segment(seg)
    return (cs.x1, cs.y1, cs.x2, cs.y2, cs.g_code, cs.i_offset, cs.j_offset)
