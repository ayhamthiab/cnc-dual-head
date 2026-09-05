"""
G-code Parser (Volume 4 — Geometry Extraction Engine)
Converts raw G-code text into a structured InstructionStream.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class GCodeInstruction:
    """A single parsed G-code instruction."""
    line_number: int
    raw: str
    code: Optional[str]          # G0, G1, G2, G3, M3, etc.
    x: Optional[float] = None
    y: Optional[float] = None
    z: Optional[float] = None
    f: Optional[float] = None    # feed rate
    s: Optional[float] = None    # spindle speed
    i: Optional[float] = None    # arc center X offset from current position
    j: Optional[float] = None    # arc center Y offset from current position
    comment: str = ""

    def is_motion(self) -> bool:
        return self.code in ("G0", "G00", "G1", "G01", "G2", "G02", "G3", "G03")

    def is_rapid(self) -> bool:
        return self.code in ("G0", "G00")

    def is_cut(self) -> bool:
        return self.code in ("G1", "G01", "G2", "G02", "G3", "G03")

    def is_arc(self) -> bool:
        return self.code in ("G2", "G02", "G3", "G03")

    def arc_g_code(self) -> int:
        """Return 2 for G2/G02, 3 for G3/G03, 1 for linear, 0 for rapid."""
        if self.code in ("G2", "G02"):
            return 2
        if self.code in ("G3", "G03"):
            return 3
        if self.code in ("G1", "G01"):
            return 1
        return 0


# Match X Y Z F S I J coordinate letters and their numeric values
_COORD_RE = re.compile(r"([XYZFSIJ])(-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)", re.IGNORECASE)
_CODE_RE  = re.compile(r"([GMT]\d+(?:\.\d+)?)", re.IGNORECASE)
_COMMENT_RE = re.compile(r"\(([^)]*)\)|;(.*)")


def parse_gcode(text: str) -> list[GCodeInstruction]:
    """Parse a G-code text into a list of GCodeInstruction objects."""
    instructions: list[GCodeInstruction] = []
    modal_f: Optional[float] = None

    for lineno, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue

        # Extract comments
        comment = ""
        for m in _COMMENT_RE.finditer(line):
            comment = (m.group(1) or m.group(2) or "").strip()
        line_clean = _COMMENT_RE.sub("", line).strip()

        if not line_clean:
            continue

        # Extract primary motion code
        code_match = _CODE_RE.search(line_clean)
        code = code_match.group(1).upper() if code_match else None

        # Extract coordinates (X, Y, Z, F, S, I, J)
        coords: dict[str, float] = {}
        for m in _COORD_RE.finditer(line_clean):
            key = m.group(1).upper()
            coords[key] = float(m.group(2))

        if "F" in coords:
            modal_f = coords["F"]

        instr = GCodeInstruction(
            line_number=lineno,
            raw=raw_line,
            code=code,
            x=coords.get("X"),
            y=coords.get("Y"),
            z=coords.get("Z"),
            f=coords.get("F", modal_f),
            s=coords.get("S"),
            i=coords.get("I"),
            j=coords.get("J"),
            comment=comment,
        )
        instructions.append(instr)

    return instructions
