"""
Toolpath Graph (Volume 4 / Chapter 7 — Volume 3)
Represents the machining program as G = (V, E) where nodes are
coordinate points and edges are motion segments.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .segment import Segment
from .toolpath import Contour, Toolpath


@dataclass
class ToolpathGraph:
    """
    Graph-based IR for the full machining program.
    nodes: coordinate points (x, y) indexed by id
    edges: Segment objects (directed edges)
    contours: detected connected paths
    toolpath: high-level grouping
    """
    segments: list[Segment] = field(default_factory=list)
    contours: list[Contour] = field(default_factory=list)
    toolpath: Optional[Toolpath] = None

    def segment_by_id(self, sid: int) -> Optional[Segment]:
        for s in self.segments:
            if s.id == sid:
                return s
        return None

    def build_from_resolved(self, resolved_instructions) -> None:
        """
        Build the graph from a list of ResolvedInstruction objects.
        Also performs basic contour detection (connected runs of cut moves).
        """
        from dmhc_em.core.instruction_stream import ResolvedInstruction
        from .segment import MotionType

        self.segments = []
        for i, ri in enumerate(resolved_instructions):
            seg = Segment(
                id=i,
                x1=ri.x0,
                y1=ri.y0,
                x2=ri.x1,
                y2=ri.y1,
                z_start=ri.z0,
                z_end=ri.z1,
                feed_rate=ri.feed_rate,
                motion_type=MotionType.CUT if ri.is_cut else MotionType.RAPID,
                g_code=ri.g_code,
                i_offset=ri.i_offset,
                j_offset=ri.j_offset,
            )
            self.segments.append(seg)

        self._detect_contours()
        self.toolpath = Toolpath(contours=self.contours)

    def _detect_contours(self, tol: float = 1e-4) -> None:
        """
        Group consecutive cut segments into contours.
        A new contour starts when:
          - a rapid move occurs (tool lift / reposition)
          - connectivity breaks (gap between end of prev and start of next)
        """
        from .segment import MotionType

        self.contours = []
        current_contour_segs: list[Segment] = []
        contour_id = 0

        def flush():
            nonlocal contour_id
            if current_contour_segs:
                c = Contour(id=contour_id, segments=list(current_contour_segs))
                for s in c.segments:
                    s.contour_id = contour_id
                self.contours.append(c)
                contour_id += 1
                current_contour_segs.clear()

        for seg in self.segments:
            if seg.motion_type == MotionType.RAPID:
                flush()
            else:
                # Cut segment — check connectivity with previous cut
                if current_contour_segs:
                    prev = current_contour_segs[-1]
                    if (abs(prev.x2 - seg.x1) > tol or
                            abs(prev.y2 - seg.y1) > tol):
                        flush()
                current_contour_segs.append(seg)

        flush()
