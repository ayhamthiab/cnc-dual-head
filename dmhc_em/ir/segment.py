"""
Segment — the fundamental unit of the Intermediate Representation (Volume 4).
A segment is a directed move from (x1,y1) to (x2,y2) with motion metadata.
Supports linear moves (G0/G1) and circular arcs (G2 clockwise, G3 counter-clockwise).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class MotionType(str, Enum):
    CUT   = "cut"
    RAPID = "rapid"


class Zone(str, Enum):
    HEAD1      = "head1"
    HEAD2      = "head2"
    GAP        = "gap"
    UNASSIGNED = "unassigned"


# ---------------------------------------------------------------------------
# Arc geometry helpers
# ---------------------------------------------------------------------------

def _angle_in_arc(angle: float, theta_start: float, theta_end: float, clockwise: bool) -> bool:
    """
    Return True if *angle* is swept by a circular arc.

    For G2 (clockwise), the sweep goes from theta_start DECREASING to theta_end.
    For G3 (counter-clockwise), the sweep goes from theta_start INCREASING to theta_end.
    Uses the modulo trick to handle wrap-around cleanly.
    """
    TWO_PI = 2.0 * math.pi
    if clockwise:  # G2: CW — angular distance decreasing
        sweep = (theta_start - theta_end) % TWO_PI
        dist  = (theta_start - angle) % TWO_PI
    else:          # G3: CCW — angular distance increasing
        sweep = (theta_end - theta_start) % TWO_PI
        dist  = (angle - theta_start) % TWO_PI
    if sweep == 0.0:       # full circle passes every angle
        return True
    return dist <= sweep + 1e-9   # small tolerance for floating-point edges


def _arc_bbox(
    x1: float, y1: float,
    x2: float, y2: float,
    i_offset: float, j_offset: float,
    clockwise: bool,
) -> tuple[float, float, float, float]:
    """
    Compute the tight axis-aligned bounding box (x_min, x_max, y_min, y_max)
    of a circular arc defined by:
        start = (x1, y1)
        end   = (x2, y2)
        center = (x1 + i_offset, y1 + j_offset)
        direction: clockwise (G2) or counter-clockwise (G3)

    The algorithm:
    1. Seed the box with the two endpoints.
    2. Test whether each of the four cardinal extreme points on the circle
       (rightmost, topmost, leftmost, bottommost) is inside the arc's sweep.
       If so, expand the box to include it.
    """
    cx = x1 + i_offset
    cy = y1 + j_offset
    r  = math.hypot(i_offset, j_offset)

    if r < 1e-9:
        return min(x1, x2), max(x1, x2), min(y1, y2), max(y1, y2)

    # Full circle: start == end within tolerance
    if abs(x1 - x2) < 1e-6 and abs(y1 - y2) < 1e-6:
        return cx - r, cx + r, cy - r, cy + r

    theta_start = math.atan2(y1 - cy, x1 - cx)
    theta_end   = math.atan2(y2 - cy, x2 - cx)

    xmin, xmax = min(x1, x2), max(x1, x2)
    ymin, ymax = min(y1, y2), max(y1, y2)

    for angle, ex, ey in (
        (0.0,                  cx + r, cy    ),   # rightmost
        (math.pi / 2.0,        cx,     cy + r),   # topmost
        (math.pi,              cx - r, cy    ),   # leftmost
        (3.0 * math.pi / 2.0,  cx,     cy - r),   # bottommost
    ):
        if _angle_in_arc(angle, theta_start, theta_end, clockwise):
            xmin = min(xmin, ex)
            xmax = max(xmax, ex)
            ymin = min(ymin, ey)
            ymax = max(ymax, ey)

    return xmin, xmax, ymin, ymax


def _arc_length(
    x1: float, y1: float,
    x2: float, y2: float,
    i_offset: float, j_offset: float,
    clockwise: bool,
) -> float:
    """Compute the arc length of a circular arc segment."""
    r = math.hypot(i_offset, j_offset)
    if r < 1e-9:
        return 0.0

    # Full circle
    if abs(x1 - x2) < 1e-6 and abs(y1 - y2) < 1e-6:
        return 2.0 * math.pi * r

    cx = x1 + i_offset
    cy = y1 + j_offset
    theta_start = math.atan2(y1 - cy, x1 - cx)
    theta_end   = math.atan2(y2 - cy, x2 - cx)
    TWO_PI = 2.0 * math.pi

    if clockwise:
        sweep = (theta_start - theta_end) % TWO_PI
    else:
        sweep = (theta_end - theta_start) % TWO_PI

    if sweep == 0.0:
        sweep = TWO_PI   # full circle

    return r * sweep


# ---------------------------------------------------------------------------
# Segment dataclass
# ---------------------------------------------------------------------------

@dataclass
class Segment:
    """
    A motion segment in the IR.

    Attributes:
        id:          Unique identifier within the toolpath graph.
        x1, y1:      Start point.
        x2, y2:      End point.
        z_start:     Z level at start (for rapid / plunge detection).
        z_end:       Z level at end.
        feed_rate:   Feed rate in mm/min.
        motion_type: CUT (G1/G2/G3) or RAPID (G0).
        g_code:      Original G-code number: 0, 1, 2, or 3.
        i_offset:    Arc center X offset from (x1, y1) — zero for linear moves.
        j_offset:    Arc center Y offset from (x1, y1) — zero for linear moves.
        zone:        Assigned machining zone (set by partition engine).
        contour_id:  Owning contour id (set by contour detector).
    """
    id: int
    x1: float
    y1: float
    x2: float
    y2: float
    z_start: float = 0.0
    z_end: float = 0.0
    feed_rate: float = 100.0
    motion_type: MotionType = MotionType.CUT
    g_code: int = 1             # 0=rapid, 1=linear, 2=CW arc, 3=CCW arc
    i_offset: float = 0.0      # arc center X offset (0 for linear)
    j_offset: float = 0.0      # arc center Y offset (0 for linear)
    zone: Zone = Zone.UNASSIGNED
    contour_id: Optional[int] = None
    # ID of the original segment this piece was split from.
    # None = this segment was not split (it IS the original).
    # Set by the partition engine for all split sub-pieces.
    source_id: Optional[int] = None
    # Exact interval of the original segment represented by this piece.
    # Partition boundaries are stored once as parameter values and adjacent
    # pieces reuse the same value and Point object-derived coordinates.
    source_t_start: float = 0.0
    source_t_end: float = 1.0

    # --- Geometry helpers ---

    def is_arc(self) -> bool:
        return self.g_code in (2, 3)

    def length(self) -> float:
        if self.is_arc():
            return _arc_length(
                self.x1, self.y1, self.x2, self.y2,
                self.i_offset, self.j_offset,
                clockwise=(self.g_code == 2),
            )
        return math.hypot(self.x2 - self.x1, self.y2 - self.y1)

    def _bbox(self) -> tuple[float, float, float, float]:
        """Return (x_min, x_max, y_min, y_max) accounting for arc geometry."""
        if self.is_arc():
            return _arc_bbox(
                self.x1, self.y1, self.x2, self.y2,
                self.i_offset, self.j_offset,
                clockwise=(self.g_code == 2),
            )
        return min(self.x1, self.x2), max(self.x1, self.x2), min(self.y1, self.y2), max(self.y1, self.y2)

    def x_min(self) -> float:
        return self._bbox()[0]

    def x_max(self) -> float:
        return self._bbox()[1]

    def y_min(self) -> float:
        return self._bbox()[2]

    def y_max(self) -> float:
        return self._bbox()[3]

    def x_mid(self) -> float:
        return (self.x_min() + self.x_max()) / 2.0

    def x_projection(self) -> tuple[float, float]:
        """Return [x_min, x_max] projection onto X-axis (for partitioning)."""
        return (self.x_min(), self.x_max())

    def canonical_hash(self) -> tuple:
        """
        Canonical hash for equivalence checking.
        For linear segments: direction-invariant (sorted endpoints).
        For arcs: direction-sensitive (i_offset, j_offset, g_code included).
        """
        if self.is_arc():
            return (
                round(self.x1, 4), round(self.y1, 4),
                round(self.x2, 4), round(self.y2, 4),
                self.g_code,
                round(self.i_offset, 4), round(self.j_offset, 4),
            )
        pts = sorted([(self.x1, self.y1), (self.x2, self.y2)])
        return (pts[0][0], pts[0][1], pts[1][0], pts[1][1])

    def machining_effort(self) -> float:
        """Machining effort proxy = length × (2 if cut, 0.1 if rapid)."""
        factor = 2.0 if self.motion_type == MotionType.CUT else 0.1
        return self.length() * factor
