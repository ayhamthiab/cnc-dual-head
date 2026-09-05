"""
Instruction Stream (Volume 4)
Orchestrates parsing + state tracking into a clean instruction stream
with resolved positions for every motion command.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .parser import GCodeInstruction, parse_gcode
from .machine_state import MachineStateTracker


@dataclass
class ResolvedInstruction:
    """A G-code instruction with fully resolved start/end positions."""
    original: GCodeInstruction
    x0: float          # start X
    y0: float          # start Y
    z0: float          # start Z
    x1: float          # end X
    y1: float          # end Y
    z1: float          # end Z
    feed_rate: float
    is_cut: bool       # True = cutting move (G1/G2/G3), False = G0 rapid
    # Arc parameters — zero for linear moves
    g_code: int = 1    # 0=rapid, 1=linear, 2=CW arc, 3=CCW arc
    i_offset: float = 0.0   # arc center X offset from start position
    j_offset: float = 0.0   # arc center Y offset from start position


_INCHES_TO_MM = 25.4


def build_instruction_stream(gcode_text: str) -> list[ResolvedInstruction]:
    """
    Parse G-code and resolve each motion instruction's start/end positions.

    Unit normalisation
    ------------------
    G-code files may declare inches (G20) or millimetres (G21).  The pipeline
    works exclusively in millimetres, so any file that contains G20 has all of
    its coordinates automatically multiplied by 25.4 here.  This is done at
    the resolved-position level so the rest of the pipeline never sees inches.
    Feed rates are also converted (in/min → mm/min).
    """
    instructions = parse_gcode(gcode_text)
    tracker = MachineStateTracker()
    resolved: list[ResolvedInstruction] = []

    for instr in instructions:
        prev_state, new_state = tracker.apply(instr)
        if not instr.is_motion():
            continue

        # For arcs, the endpoint may equal the start (full circle).
        # We must NOT skip these — they are real geometry.
        # Only skip truly zero-movement non-arc instructions.
        if not instr.is_arc():
            if (abs(new_state.x - prev_state.x) < 1e-9 and
                    abs(new_state.y - prev_state.y) < 1e-9 and
                    abs(new_state.z - prev_state.z) < 1e-9):
                continue

        # Convert inches → mm when the file uses G20.
        # new_state.units_mm reflects the mode at the time of this instruction.
        scale = 1.0 if new_state.units_mm else _INCHES_TO_MM

        resolved.append(ResolvedInstruction(
            original=instr,
            x0=prev_state.x * scale,
            y0=prev_state.y * scale,
            z0=prev_state.z * scale,
            x1=new_state.x * scale,
            y1=new_state.y * scale,
            z1=new_state.z * scale,
            feed_rate=new_state.feed_rate * scale,   # in/min → mm/min
            is_cut=instr.is_cut(),
            g_code=instr.arc_g_code(),
            i_offset=(instr.i or 0.0) * scale,
            j_offset=(instr.j or 0.0) * scale,
        ))

    return resolved
