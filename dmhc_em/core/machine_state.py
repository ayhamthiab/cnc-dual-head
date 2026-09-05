"""
Machine State Tracker (Volume 4)
Maintains the CNC controller modal state as instructions are executed.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .parser import GCodeInstruction


@dataclass
class MachineState:
    """Current modal state of a CNC machine."""
    x: float = 0.0
    y: float = 0.0
    z: float = 0.0
    feed_rate: float = 100.0
    spindle_speed: float = 0.0
    spindle_on: bool = False
    absolute_mode: bool = True   # G90
    units_mm: bool = True        # G21
    plane_xy: bool = True        # G17
    motion_mode: str = "G0"      # current motion code


class MachineStateTracker:
    """
    Tracks machine state across instructions.
    Returns (prev_state, new_state) for each instruction so callers
    can build segments from the transition.
    """

    def __init__(self) -> None:
        self._state = MachineState()

    @property
    def state(self) -> MachineState:
        return self._state

    def apply(self, instr: GCodeInstruction) -> tuple[MachineState, MachineState]:
        """Apply instruction and return (before, after) machine states."""
        import copy
        prev = copy.deepcopy(self._state)

        code = instr.code
        if code in ("G90",):
            self._state.absolute_mode = True
        elif code in ("G91",):
            self._state.absolute_mode = False
        elif code in ("G21",):
            self._state.units_mm = True
        elif code in ("G20",):
            self._state.units_mm = False
        elif code in ("G17",):
            self._state.plane_xy = True
        elif code in ("M3", "M03"):
            self._state.spindle_on = True
            if instr.s is not None:
                self._state.spindle_speed = instr.s
        elif code in ("M5", "M05"):
            self._state.spindle_on = False
        elif code in ("G0", "G00", "G1", "G01", "G2", "G02", "G3", "G03"):
            # All motion commands: G0 rapid, G1 linear cut, G2/G3 arc cut.
            # For arcs (G2/G3), X and Y are the ARC ENDPOINT, not the center.
            # The I, J parameters (center offsets) are local to the instruction
            # and do not affect modal position state — only X, Y, Z update.
            self._state.motion_mode = code
            if instr.f is not None:
                self._state.feed_rate = instr.f
            # Apply endpoint position
            if self._state.absolute_mode:
                if instr.x is not None:
                    self._state.x = instr.x
                if instr.y is not None:
                    self._state.y = instr.y
                if instr.z is not None:
                    self._state.z = instr.z
            else:
                if instr.x is not None:
                    self._state.x += instr.x
                if instr.y is not None:
                    self._state.y += instr.y
                if instr.z is not None:
                    self._state.z += instr.z

        return prev, copy.deepcopy(self._state)
