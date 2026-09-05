"""
Verification Engine — Geometric Equivalence (Volume 9)
Proves that:
    Original Toolpath ≡ (Head1 ∪ Head2 ∪ GapFill)

After segment-level boundary splitting (Volume 6 engine), output segments are
sub-pieces of original segments, so exact canonical-hash matching no longer
applies.  The updated check is *per-original-segment coverage*:

    For every original cut segment S with id X:
      1. Collect all output segments whose source_id == X.
      2. Verify their total cut length equals S.length() within tolerance.

This is both necessary and sufficient for lossless coverage when the splitting
algorithm is structurally correct (pieces are non-overlapping and ordered).
It catches:
  - Missing segments (no piece found → covered_length = 0 ≠ orig_length)
  - Partial coverage (pieces shorter than original)
  - Duplication of a source segment across zones (total length > original)
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from dmhc_em.ir.segment import Segment, MotionType


@dataclass
class EquivalenceResult:
    passed: bool
    coverage_ok: bool
    no_duplicates: bool
    no_missing: bool
    original_count: int
    output_count: int
    missing_hashes: list[tuple]
    duplicate_hashes: list[tuple]
    zero_gap: bool = True
    zero_overlap: bool = True
    messages: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "coverage_ok": self.coverage_ok,
            "no_duplicates": self.no_duplicates,
            "no_missing": self.no_missing,
            "original_count": self.original_count,
            "output_count": self.output_count,
            "missing_count": len(self.missing_hashes),
            "duplicate_count": len(self.duplicate_hashes),
            "zero_gap": self.zero_gap,
            "zero_overlap": self.zero_overlap,
            "messages": self.messages,
        }


def verify_equivalence(
    original_segments: list[Segment],
    head1_segs: list[Segment],
    head2_segs: list[Segment],
    gap_segs:   list[Segment],
) -> EquivalenceResult:
    """
    Verify that the partition is a lossless, non-duplicating coverage of the
    original geometry using per-original-segment source tracking.

    Each output segment carries a source_id set by the partition engine:
      - Whole (unsplit) segments: source_id == seg.id
      - Split sub-pieces:         source_id == id of the parent original segment

    Check every source parameter interval and shared endpoint exactly.  Numeric
    tolerance is used only to compare total path length; it never changes any
    coordinate or interval.
    """
    orig_cuts = [s for s in original_segments if s.motion_type == MotionType.CUT]
    h1_cuts   = [s for s in head1_segs        if s.motion_type == MotionType.CUT]
    h2_cuts   = [s for s in head2_segs        if s.motion_type == MotionType.CUT]
    gap_cuts  = [s for s in gap_segs          if s.motion_type == MotionType.CUT]
    output_cuts = h1_cuts + h2_cuts + gap_cuts

    # Build: source_id → [output segment pieces]
    pieces_by_source: dict[int, list[Segment]] = defaultdict(list)
    for seg in output_cuts:
        src = seg.source_id if seg.source_id is not None else seg.id
        pieces_by_source[src].append(seg)

    missing_ids: list[int] = []
    over_covered: list[int] = []
    gap_ids: list[int] = []
    overlap_ids: list[int] = []
    messages: list[str] = []

    for orig in orig_cuts:
        pieces = sorted(
            pieces_by_source.get(orig.id, []), key=lambda piece: piece.source_t_start
        )
        if not pieces:
            missing_ids.append(orig.id)
            gap_ids.append(orig.id)
            continue

        has_gap = pieces[0].source_t_start != 0.0 or pieces[-1].source_t_end != 1.0
        has_overlap = False
        for left, right in zip(pieces, pieces[1:]):
            if left.source_t_end < right.source_t_start:
                has_gap = True
            elif left.source_t_end > right.source_t_start:
                has_overlap = True
            if left.x2 != right.x1 or left.y2 != right.y1:
                has_gap = True
        if has_gap:
            gap_ids.append(orig.id)
            missing_ids.append(orig.id)
        if has_overlap:
            overlap_ids.append(orig.id)
            over_covered.append(orig.id)
        if has_gap or has_overlap:
            continue

        orig_len  = orig.length()
        piece_len = sum(p.length() for p in pieces)
        tol = max(0.01, orig_len * 1e-6)

        if piece_len > orig_len + tol:
            over_covered.append(orig.id)
        elif piece_len < orig_len - tol:
            missing_ids.append(orig.id)   # partially covered = effectively missing

    no_missing    = len(missing_ids)   == 0
    no_duplicates = len(over_covered)  == 0
    zero_gap = len(gap_ids) == 0
    zero_overlap = len(overlap_ids) == 0
    coverage_ok   = no_missing and no_duplicates
    passed        = coverage_ok

    if missing_ids:
        messages.append(
            f"{len(missing_ids)} original segment(s) not fully covered "
            f"in output — ids: {missing_ids[:10]}"
        )
    if over_covered:
        messages.append(
            f"{len(over_covered)} original segment(s) over-covered (duplication?) "
            f"— ids: {over_covered[:10]}"
        )
    if passed:
        messages.append(
            "PASS: Multi-head execution is geometrically equivalent to single-head execution"
        )

    return EquivalenceResult(
        passed=passed,
        coverage_ok=coverage_ok,
        no_duplicates=no_duplicates,
        no_missing=no_missing,
        original_count=len(orig_cuts),
        output_count=len(output_cuts),
        missing_hashes=[(i,) for i in missing_ids],
        duplicate_hashes=[(i,) for i in over_covered],
        zero_gap=zero_gap,
        zero_overlap=zero_overlap,
        messages=messages,
    )
