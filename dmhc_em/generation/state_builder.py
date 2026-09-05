"""
Machine State Builder (Volume 7 / Chapter 4)
Generates the safe preamble for each G-code output file.

Each head file must begin with a known modal state:
  G21 — mm units
  G90 — absolute positioning
  G17 — XY plane
  M3 S... — spindle on
"""
from __future__ import annotations

PEN_UP_Z = 5.0
PEN_DOWN_Z = -1.0


def build_preamble(
    spindle_speed: float = 12000.0,
    pen_up_z: float = PEN_UP_Z,
) -> list[str]:
    """Return G-code lines for a safe, deterministic machine start."""
    return [
        "G21        ; units: millimeters",
        "G90        ; absolute positioning",
        "G17        ; XY plane",
        f"G0 Z{pen_up_z:.3f} ; pen up",
        f"M3 S{int(spindle_speed)} ; spindle on",
    ]


def build_postamble(pen_up_z: float = PEN_UP_Z) -> list[str]:
    """Return G-code lines for a safe machine shutdown."""
    return [
        f"G0 Z{pen_up_z:.3f} ; pen up",
        "M5         ; spindle off",
        "M30        ; end of program",
    ]


def rapid_to(x: float, y: float, z: float = PEN_UP_Z) -> str:
    return f"G0 X{x:.4f} Y{y:.4f} Z{z:.4f}   ; rapid move"


def plunge_to(z: float, feed_rate: float) -> str:
    return f"G1 Z{z:.4f} F{feed_rate:.1f}   ; pen down"
