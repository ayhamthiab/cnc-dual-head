"""Regression tests for Head 2 local-coordinate generation."""
import re

from dmhc_em.generation.generator import generate_file
from dmhc_em.ir.segment import Segment
from dmhc_em.pipeline import PipelineConfig, run_pipeline


def _axis_values(gcode: str, axis: str) -> list[float]:
    """Extract every coordinate word for an axis from generated G-code."""
    return [
        float(value)
        for value in re.findall(rf"\b{axis}(-?\d+(?:\.\d+)?)", gcode)
    ]


def _head2_y_values(gcode: str) -> list[float]:
    """Extract every Y word emitted in a generated Head 2 file."""
    return _axis_values(gcode, "Y")


def test_pipeline_translates_head2_linear_and_rapid_coordinates():
    """Head 2 output uses the configured reference for all generated Y words."""
    gcode = """
G21
G90
G0 X0 Y0 Z5
M3 S12000
G0 X100 Y20
G1 Z-1 F300
G1 X200 Y20 F300
G0 Z5
G0 X300 Y150
G1 Z-1 F300
G1 X350 Y200 F300
G0 Z5
M5
M30
"""

    result = run_pipeline(
        gcode,
        "head2-reference.gcode",
        PipelineConfig(gap_width=10, gap_start_y=100, head2_reference_y=240),
    )

    assert result.success, result.error
    assert result.report["config"]["head2ReferenceY"] == 240
    assert "G0 X-300.0000 Y-90.0000 Z5.0000" in result.head2_code
    assert "G1 X-350.0000 Y-40.0000" in result.head2_code
    assert all(value <= 0 for value in _head2_y_values(result.head2_code))
    assert "G0 X-100.0000 Y20.0000 Z5.0000" in result.head1_code
    assert all(value <= 0 for value in _axis_values(result.head1_code, "X"))


def test_pipeline_translates_head2_arc_endpoints_but_preserves_ij():
    """Head 2 arc endpoints move with the frame while I/J remain relative."""
    gcode = """
G21
G90
G0 X0 Y0 Z5
M3 S12000
G0 X100 Y20
G1 Z-1 F300
G1 X200 Y20 F300
G0 Z5
G0 X300 Y150
G1 Z-1 F300
G1 X350 Y200 F300
G2 X350 Y240 I0 J20 F300
G0 Z5
M5
M30
"""

    result = run_pipeline(
        gcode,
        "head2-arc-reference.gcode",
        PipelineConfig(gap_width=10, gap_start_y=100, head2_reference_y=240),
    )

    assert result.success, result.error
    assert "G3 X-350.0000 Y0.0000 I0.0000 J20.0000 F300.0" in result.head2_code
    assert "G3" in result.head2_code
    assert all(value <= 0 for value in _head2_y_values(result.head2_code))
    assert all(value <= 0 for value in _axis_values(result.head2_code, "X"))
    assert result.report["equivalence"]["passed"]


def test_pipeline_mirrors_x_in_gap_fill_as_well():
    """A segment crossing the gap is emitted with a negative X coordinate."""
    gcode = """
G21
G90
G0 X100 Y20 Z5
G1 Z-1 F300
G1 X200 Y20 F300
G0 Z5
G0 X500 Y20
G1 Z-1 F300
G1 X500 Y200 F300
G0 Z5
G0 X700 Y150
G1 Z-1 F300
G1 X750 Y150 F300
G0 Z5
M5
M30
"""

    result = run_pipeline(
        gcode,
        "all-output-x-negative.gcode",
        PipelineConfig(gap_width=10, gap_start_y=100, head2_reference_y=240),
    )

    assert result.success, result.error
    assert result.report["partition"]["gap_segment_count"] > 0
    for output in (result.head1_code, result.head2_code, result.gap_code):
        assert all(value <= 0 for value in _axis_values(output, "X"))


def test_x_mirror_preserves_arc_geometry():
    """Mirroring an arc negates X/I and reverses its winding direction."""
    segment = Segment(
        id=1,
        x1=105,
        y1=10,
        x2=115,
        y2=20,
        feed_rate=1000,
        g_code=2,
        i_offset=10,
        j_offset=5,
    )

    output = generate_file([segment], "mirrored-arc.gcode", mirror_x=True)

    assert "G0 X-105.0000 Y10.0000 Z5.0000" in output
    assert "G3 X-115.0000 Y20.0000 I-10.0000 J5.0000 F1000.0" in output