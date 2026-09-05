"""
G-code Axis Inversion Post-processor
=====================================
Inverts X and/or Y coordinates in G-code text.

Linear moves (G0 / G1): X and/or Y endpoints are negated.
Arc moves (G2 / G3):
  - X / Y endpoints negated as requested.
  - I offset negated when X is inverted (I is the relative X distance from
    segment start to arc centre; negating X negates that too).
  - J offset negated when Y is inverted (same reasoning).
  - Arc winding (G2 ↔ G3) is flipped when exactly ONE axis is inverted
    (mirror operation reverses CW/CCW handedness). When BOTH axes are
    inverted (180° rotation) the winding is preserved.

All other G-code structure — commands, Z moves, feed rates, spindle,
comments — is passed through unchanged.
"""
from __future__ import annotations

import re

# Matches any word-address parameter: letter immediately followed by a number.
# Examples: X-100.0000  Y0  I3.5  G1  F1000  S12000
_PARAM_RE = re.compile(r'([A-Za-z])\s*(-?\d+(?:\.\d*)?(?:[Ee][+-]?\d+)?)')

# Matches G2 or G02 / G3 or G03
_G2_RE = re.compile(r'G0*2\b', re.IGNORECASE)
_G3_RE = re.compile(r'G0*3\b', re.IGNORECASE)


def invert_gcode(gcode: str, invert_x: bool, invert_y: bool) -> str:
    """
    Return a copy of *gcode* with X and/or Y coordinates negated.

    Parameters
    ----------
    gcode:    Raw G-code text (multi-line).
    invert_x: Negate all X coordinate values.
    invert_y: Negate all Y coordinate values.
    """
    if not invert_x and not invert_y:
        return gcode

    # Mirror on exactly one axis → arc winding reverses.
    flip_arc = invert_x != invert_y

    out: list[str] = []
    for raw_line in gcode.splitlines():
        line = raw_line.rstrip()

        # Locate inline comment (semicolon)
        semi = line.find(';')
        if semi == 0:
            # Whole line is a comment → pass through unchanged.
            out.append(line)
            continue

        code_part = line[:semi] if semi > 0 else line
        comment_part = line[semi:] if semi > 0 else ''

        if not code_part.strip():
            out.append(line)
            continue

        upper = code_part.upper()
        is_arc = bool(_G2_RE.search(upper) or _G3_RE.search(upper))

        # Flip arc direction for single-axis mirror
        if is_arc and flip_arc:
            if _G2_RE.search(code_part):
                code_part = _G2_RE.sub('G3', code_part)
            else:
                code_part = _G3_RE.sub('G2', code_part)

        # Negate targeted coordinate parameters
        def _replace(m: re.Match) -> str:
            letter = m.group(1).upper()
            raw_num = m.group(2)
            value = float(raw_num)

            if   letter == 'X' and invert_x:              value = -value
            elif letter == 'Y' and invert_y:              value = -value
            elif letter == 'I' and is_arc and invert_x:   value = -value
            elif letter == 'J' and is_arc and invert_y:   value = -value
            else:
                return m.group(0)   # unchanged

            # Preserve original decimal precision
            if '.' in raw_num:
                decimals = len(raw_num.split('.')[1])
                return f"{m.group(1)}{value:.{decimals}f}"
            return f"{m.group(1)}{int(value)}"

        new_code = _PARAM_RE.sub(_replace, code_part)
        out.append(new_code + comment_part)

    return '\n'.join(out)
