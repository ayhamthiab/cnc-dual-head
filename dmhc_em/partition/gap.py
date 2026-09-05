"""Y-axis gap model for the two-head pen machine."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class GapRegion:
    """
    Represents the physical no-cut gap between CNC heads on the Y axis.

    There is no tool-radius or safety-margin expansion.  The two boundaries
    are exactly the user-supplied physical gap boundaries.
    """
    y_center: float
    width: float            # nominal gap width

    @property
    def half_nominal(self) -> float:
        return self.width / 2.0

    @property
    def half_effective(self) -> float:
        # Kept as a compatibility name for existing reports.
        return self.half_nominal

    @property
    def y_min_nominal(self) -> float:
        return self.y_center - self.half_nominal

    @property
    def y_max_nominal(self) -> float:
        return self.y_center + self.half_nominal

    @property
    def y_min_effective(self) -> float:
        return self.y_center - self.half_effective

    @property
    def y_max_effective(self) -> float:
        return self.y_center + self.half_effective

    def contains(self, x: float, effective: bool = True) -> bool:
        if effective:
            return self.y_min_effective <= x <= self.y_max_effective
        return self.y_min_nominal <= x <= self.y_max_nominal

    def segment_in_gap(
        self,
        y_min: float,
        y_max: float,
        effective: bool = True,
        tol: float = 1e-9,
    ) -> bool:
        """
        Return True if a segment's X extent meaningfully overlaps the gap region.

        tol (default 1e-9 mm) prevents false positives from floating-point
        rounding when a split piece ends exactly on the boundary — those pieces
        are legitimate zone assignments, not gap violations.
        """
        gap_lo = self.y_min_effective if effective else self.y_min_nominal
        gap_hi = self.y_max_effective if effective else self.y_max_nominal
        return y_min < gap_hi - tol and y_max > gap_lo + tol
