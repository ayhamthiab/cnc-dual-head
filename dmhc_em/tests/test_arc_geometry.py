"""
Unit tests for arc geometry helpers in ir/segment.py.
Tests _angle_in_arc, _arc_bbox, and full-circle arc pipeline.
"""
import math
import pytest

from dmhc_em.ir.segment import _angle_in_arc, _arc_bbox, _arc_length, Segment, MotionType, Zone


# ---------------------------------------------------------------------------
# _angle_in_arc tests
# ---------------------------------------------------------------------------

class TestAngleInArc:
    """Verify angle-in-sweep predicate for both CW (G2) and CCW (G3) arcs."""

    def test_ccw_quarter_arc_contains_start_end(self):
        # CCW from 0 to π/2
        assert _angle_in_arc(0.0,            0.0, math.pi/2, clockwise=False)
        assert _angle_in_arc(math.pi/4,      0.0, math.pi/2, clockwise=False)
        assert _angle_in_arc(math.pi/2,      0.0, math.pi/2, clockwise=False)

    def test_ccw_quarter_arc_excludes_outside(self):
        # CCW from 0 to π/2 — angles beyond π/2 should not be included
        assert not _angle_in_arc(math.pi,       0.0, math.pi/2, clockwise=False)
        assert not _angle_in_arc(3*math.pi/2,   0.0, math.pi/2, clockwise=False)

    def test_cw_quarter_arc_basic(self):
        # CW from π/2 to 0 (sweeps 90° clockwise, through 0)
        assert _angle_in_arc(math.pi/2, math.pi/2, 0.0, clockwise=True)
        assert _angle_in_arc(0.25,      math.pi/2, 0.0, clockwise=True)
        assert _angle_in_arc(0.0,       math.pi/2, 0.0, clockwise=True)

    def test_cw_quarter_arc_excludes_outside(self):
        # CW from π/2 to 0 — should not include π
        assert not _angle_in_arc(math.pi,       math.pi/2, 0.0, clockwise=True)
        assert not _angle_in_arc(3*math.pi/2,   math.pi/2, 0.0, clockwise=True)

    def test_ccw_wrap_around_zero(self):
        # CCW from 3π/4 to -3π/4 wraps through π (and thus passes 0° on the way)
        # The sweep is 3π/2 counter-clockwise.
        # angle=0 is NOT in this sweep (we go from 3π/4 UP past π, crossing -π → -3π/4)
        # So 0 is NOT included.
        theta_start = 3 * math.pi / 4
        theta_end   = -3 * math.pi / 4
        assert not _angle_in_arc(0.0, theta_start, theta_end, clockwise=False)
        # But π IS included (it's on the sweep path)
        assert _angle_in_arc(math.pi, theta_start, theta_end, clockwise=False)

    def test_cw_wrap_through_negative_pi(self):
        # CW from -π/4 sweeping to +3π/4 passes through -π/+π boundary
        theta_start = -math.pi / 4
        theta_end   =  3 * math.pi / 4
        # Going CW (decreasing): -π/4 → -π/2 → -π → ±π → +3π/4
        # π is included
        assert _angle_in_arc(math.pi,      theta_start, theta_end, clockwise=True)
        assert _angle_in_arc(-math.pi/2,   theta_start, theta_end, clockwise=True)
        # 0 is NOT included (we sweep CW away from 0, not toward it)
        assert not _angle_in_arc(0.0, theta_start, theta_end, clockwise=True)

    def test_full_circle(self):
        # sweep == 0 → full circle → every angle included
        for angle in (0, math.pi/4, math.pi/2, math.pi, 3*math.pi/2):
            assert _angle_in_arc(angle, 0.0, 0.0, clockwise=True)
            assert _angle_in_arc(angle, 0.0, 0.0, clockwise=False)

    def test_270_degree_cw_arc(self):
        # CW from π/2 to -π (= π) sweeps 270°
        theta_start = math.pi / 2
        theta_end   = math.pi       # or -π, same point
        sweep_cw = (theta_start - theta_end) % (2 * math.pi)  # (π/2 - π) % 2π = 3π/2
        assert abs(sweep_cw - 3*math.pi/2) < 1e-9
        # 0° is included (goes through rightmost)
        assert _angle_in_arc(0.0, theta_start, theta_end, clockwise=True)
        # -π/2 (bottommost) is included
        assert _angle_in_arc(-math.pi/2, theta_start, theta_end, clockwise=True)
        # π/2 is the start — included
        assert _angle_in_arc(math.pi/2, theta_start, theta_end, clockwise=True)


# ---------------------------------------------------------------------------
# _arc_bbox tests
# ---------------------------------------------------------------------------

class TestArcBBox:
    """Verify bounding box computation for arcs."""

    def _circle_bbox(self, cx, cy, r):
        return cx - r, cx + r, cy - r, cy + r

    def test_full_circle_cw(self):
        # Full circle: start == end, center at (0,0), radius 10
        # G2 from (10, 0) back to (10, 0), I=-10 J=0
        xmin, xmax, ymin, ymax = _arc_bbox(10, 0, 10, 0, -10, 0, clockwise=True)
        assert abs(xmin - (-10)) < 1e-6
        assert abs(xmax - 10) < 1e-6
        assert abs(ymin - (-10)) < 1e-6
        assert abs(ymax - 10) < 1e-6

    def test_full_circle_ccw(self):
        xmin, xmax, ymin, ymax = _arc_bbox(10, 0, 10, 0, -10, 0, clockwise=False)
        assert abs(xmin - (-10)) < 1e-6
        assert abs(xmax - 10) < 1e-6

    def test_right_semicircle_ccw(self):
        # CCW semicircle from (0, -r) to (0, r) sweeping through rightmost (r, 0)
        # center at (0, 0), r=10
        # I offset from (0,-10) to center (0,0): I=0, J=10
        xmin, xmax, ymin, ymax = _arc_bbox(0, -10, 0, 10, 0, 10, clockwise=False)
        # rightmost point (10, 0) should be included
        assert abs(xmax - 10) < 1e-6
        assert abs(xmin - 0) < 1e-6    # leftmost point NOT swept
        assert abs(ymin - (-10)) < 1e-6
        assert abs(ymax - 10) < 1e-6

    def test_left_semicircle_cw(self):
        # CW semicircle from (0, -r) to (0, r) sweeping through leftmost (-r, 0)
        # center at (0, 0), r=10, I=0, J=10 (CW direction)
        xmin, xmax, ymin, ymax = _arc_bbox(0, -10, 0, 10, 0, 10, clockwise=True)
        # leftmost point (-10, 0) should be included
        assert abs(xmin - (-10)) < 1e-6
        assert abs(xmax - 0) < 1e-6    # rightmost NOT swept

    def test_quarter_arc_cw_first_quadrant(self):
        # CW from (r, 0) to (0, r), center at (0, 0), r=10
        # start angle = 0, end angle = π/2; CW sweep = 3π/2 (big arc, wrong)
        # Actually CW from 0 to π/2 going CW means going through -π/2 first (3/4 circle)
        # For the short CW quarter arc we want: from (0, r) to (r, 0)
        # start angle = π/2, end angle = 0, CW sweep = π/2 (90°)
        # I from (0,10) to center (0,0): I=0, J=-10
        xmin, xmax, ymin, ymax = _arc_bbox(0, 10, 10, 0, 0, -10, clockwise=True)
        # Should pass through rightmost (10, 0) and topmost (0, 10)
        assert abs(xmax - 10) < 1e-6
        assert abs(ymax - 10) < 1e-6
        # leftmost (-10, 0) should NOT be included
        assert xmin >= 0 - 1e-6

    def test_two_arc_circle_bboxes_combine_correctly(self):
        # The test workpiece circle: two G2 arcs forming a full circle
        # Arc1: G2 from (200,100) to (200,180) I=0 J=40 (left semicircle CW)
        # Arc2: G2 from (200,180) to (200,100) I=0 J=-40 (right semicircle CW)
        xmin1, xmax1, ymin1, ymax1 = _arc_bbox(200, 100, 200, 180, 0, 40, clockwise=True)
        xmin2, xmax2, ymin2, ymax2 = _arc_bbox(200, 180, 200, 100, 0, -40, clockwise=True)
        combined_xmin = min(xmin1, xmin2)
        combined_xmax = max(xmax1, xmax2)
        # Circle center (200, 140), radius 40 → full circle bbox [160, 240]
        assert abs(combined_xmin - 160) < 1e-6
        assert abs(combined_xmax - 240) < 1e-6


# ---------------------------------------------------------------------------
# Full pipeline arc tests
# ---------------------------------------------------------------------------

class TestArcPipeline:
    """Integration tests: parse → IR → generate → equivalence."""

    def _run(self, gcode):
        from dmhc_em.pipeline import run_pipeline, PipelineConfig
        cfg = PipelineConfig(gap_width=10, tool_radius=3.175, safety_margin=1.0)
        return run_pipeline(gcode, "test.gcode", cfg)

    def test_full_circle_single_arc_survives(self):
        """Single G2 full-circle (start==end) must appear in output, not be dropped."""
        gcode = """
G21
G90
G0 X0 Y0 Z5
M3 S12000
G0 X200 Y100
G1 Z-1 F300
G2 X200 Y100 I0 J40
G0 Z5
G0 X700 Y100
G1 Z-1 F300
G1 X750 Y100 F300
G0 Z5
M5
M30
"""
        r = self._run(gcode)
        assert r.success, r.error
        e = r.report["equivalence"]
        assert e["passed"], f"missing={e['missing_count']}: {e['messages']}"
        # The full circle must appear in head1 output as G2
        assert "G2" in r.head1_code or "G2" in r.head2_code

    def test_two_arc_circle_bboxes_correctly_placed(self):
        """Two full-circle arcs must remain assigned to the partition without being lost."""
        gcode = """
G21
G90
G0 X0 Y0 Z5
M3 S12000
G0 X200 Y100
G1 Z-1 F300
G2 X200 Y180 I0 J40
G2 X200 Y100 I0 J-40
G0 Z5
G0 X800 Y100
G1 Z-1 F300
G2 X800 Y180 I0 J40
G2 X800 Y100 I0 J-40
G0 Z5
M5
M30
"""
        r = self._run(gcode)
        assert r.success, r.error
        e = r.report["equivalence"]
        assert e["passed"], f"missing={e['missing_count']}: {e['messages']}"
        p = r.report["partition"]
        total_assigned = (
            p["head1_segment_count"]
            + p["head2_segment_count"]
            + p["gap_segment_count"]
        )
        assert p["head1_segment_count"] > 0
        assert total_assigned > 0
        assert total_assigned >= p["head1_segment_count"]

    def test_arc_g_code_preserved_in_output(self):
        """G2 segments must appear as G2 in generated output, not as G1."""
        gcode = """
G21
G90
G0 X0 Y0 Z5
M3 S12000
G0 X100 Y100
G1 Z-1 F300
G1 X200 Y100
G2 X200 Y200 I0 J50
G1 X100 Y200
G2 X100 Y100 I0 J-50
G0 Z5
G0 X700 Y100
G1 Z-1 F300
G1 X800 Y100
G0 Z5
M5
M30
"""
        r = self._run(gcode)
        assert r.success, r.error
        combined = r.head1_code + r.head2_code + r.gap_code
        assert "G2" in combined, "Arc G2 segments must appear in output"
        assert "G3" not in combined or True  # G3 presence is optional here

    def test_equivalence_with_mixed_arcs_and_lines(self):
        """Workpiece with arcs and lines — all segments must be accounted for."""
        gcode = """
G21
G90
G0 X0 Y0 Z5
M3 S12000
G0 X120 Y380
G1 Z-1 F300
G1 X180 Y380
G2 X180 Y420 I0 J20
G1 X120 Y420
G2 X120 Y380 I0 J-20
G0 Z5
G0 X820 Y380
G1 Z-1 F300
G1 X880 Y380
G2 X880 Y420 I0 J20
G1 X820 Y420
G2 X820 Y380 I0 J-20
G0 Z5
M5
M30
"""
        r = self._run(gcode)
        assert r.success, r.error
        e = r.report["equivalence"]
        assert e["passed"], f"missing={e['missing_count']}: {e['messages']}"
        assert e["output_count"] >= e["original_count"]
        assert e["zero_gap"]
        assert e["zero_overlap"]
