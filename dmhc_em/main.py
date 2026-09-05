"""
DMHC-EM CLI Entry Point (Volume 10)
Usage:
  python3 -m dmhc_em.main --input <file.gcode> --output <dir> [options]

Returns a JSON report to stdout and writes G-code files to the output directory.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .pipeline import PipelineConfig, run_pipeline
from .output.writer import write_gcode_files, write_report


def main() -> None:
    parser = argparse.ArgumentParser(
        description="DMHC-EM: Dynamic Multi-Head CNC Execution Middleware"
    )
    parser.add_argument("--input",   required=True, help="Input G-code file path")
    parser.add_argument("--output",  required=True, help="Output directory")
    parser.add_argument("--heads",   type=int,   default=2,     help="Number of heads (default: 2)")
    parser.add_argument("--gap",     type=float, default=10.0,  help="Gap width in mm (default: 10)")
    parser.add_argument("--radius",  type=float, default=0.0,   help="Deprecated; ignored for pen machine")
    parser.add_argument("--margin",  type=float, default=0.0,   help="Deprecated; ignored for pen machine")
    parser.add_argument("--head2-ref-y", type=float, default=620.0, help="Head 2 local Y reference (default: 620)")
    parser.add_argument("--pen-up-z", type=float, default=5.0, help="Pen-up Z position")
    parser.add_argument("--pen-down-z", type=float, default=-1.0, help="Pen-down Z position")
    parser.add_argument("--spindle", type=float, default=12000, help="Spindle speed RPM (default: 12000)")
    parser.add_argument("--depth",   type=float, default=-1.0,  help="Cut depth in mm (default: -1.0)")
    parser.add_argument(
        "--gap-start-y", type=float, default=None,
        help="Fix the gap lower boundary at exactly this Y coordinate instead of auto-selecting"
    )
    args = parser.parse_args()

    # Read input
    input_path = Path(args.input)
    if not input_path.exists():
        print(json.dumps({"success": False, "error": f"File not found: {args.input}"}))
        sys.exit(1)

    gcode_text = input_path.read_text(encoding="utf-8", errors="replace")
    filename   = input_path.name

    config = PipelineConfig(
        num_heads=args.heads,
        gap_width=args.gap,
        tool_radius=args.radius,
        safety_margin=args.margin,
        head2_reference_y=args.head2_ref_y,
        pen_up_z=args.pen_up_z,
        pen_down_z=args.pen_down_z,
        spindle_speed=args.spindle,
        cut_depth=args.depth,
        gap_start_y=args.gap_start_y,
    )

    # Run pipeline
    result = run_pipeline(gcode_text, filename, config)

    if not result.success:
        output = {"success": False, "error": result.error}
        print(json.dumps(output))
        sys.exit(1)

    # Write outputs
    file_paths = write_gcode_files(
        args.output,
        result.head1_code,
        result.head2_code,
        result.gap_code,
    )
    report_path = write_report(args.output, result.report)

    output = {
        "success": True,
        "files": file_paths,
        "report_path": report_path,
        "report": result.report,
    }
    print(json.dumps(output))
    sys.exit(0)


if __name__ == "__main__":
    main()
