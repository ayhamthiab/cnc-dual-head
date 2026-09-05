import math

import pytest

from dmhc_em.ir.segment import MotionType, Segment
from dmhc_em.partition.engine import PartitionPlan, _split_and_assign
from dmhc_em.partition.gap import GapRegion
from dmhc_em.verification.equivalence import verify_equivalence


@pytest.mark.parametrize(
    "start,end",
    [
        ((-1_000_000.25, -900.5), (2_000_000.75, 1100.5)),
        ((7.0, 1100.5), (7.0, -900.5)),
        ((-0.00003, -0.00002), (0.00007, 0.00008)),
        ((-50.0, 0.0), (75.0, 0.0)),
    ],
)
def test_linear_pieces_reuse_exact_shared_points(start, end):
    original = Segment(1, *start, *end, motion_type=MotionType.CUT)
    plan = PartitionPlan(gap=GapRegion(y_center=0.0, width=0.00004))
    _split_and_assign(original, plan.gap, plan, [0])
    pieces = sorted(plan.all_assigned_segments(), key=lambda item: item.source_t_start)

    for left, right in zip(pieces, pieces[1:]):
        assert (left.x2, left.y2) == (right.x1, right.y1)
        assert left.source_t_end == right.source_t_start

    result = verify_equivalence([original], plan.head1_segments, plan.head2_segments, plan.gap_segments)
    assert result.passed
    assert result.zero_gap
    assert result.zero_overlap


def test_arc_crossing_each_boundary_twice_is_exactly_continuous():
    original = Segment(
        2, 10.0, 0.0, 10.0, 0.0,
        motion_type=MotionType.CUT, g_code=3, i_offset=-10.0, j_offset=0.0,
    )
    plan = PartitionPlan(gap=GapRegion(y_center=0.0, width=10.0))
    _split_and_assign(original, plan.gap, plan, [0])
    pieces = sorted(plan.all_assigned_segments(), key=lambda item: item.source_t_start)

    assert len(pieces) == 5
    for left, right in zip(pieces, pieces[1:]):
        assert (left.x2, left.y2) == (right.x1, right.y1)
        assert left.source_t_end == right.source_t_start
    assert math.isclose(sum(piece.length() for piece in pieces), original.length())
    assert verify_equivalence(
        [original], plan.head1_segments, plan.head2_segments, plan.gap_segments
    ).passed
