"""
Output Writer (Volume 10)
Writes generated G-code files and the JSON report to the output directory.
"""
from __future__ import annotations

import json
import os
from pathlib import Path


def write_gcode_files(
    output_dir: str,
    head1_code: str,
    head2_code: str,
    gap_code: str,
) -> dict[str, str]:
    """Write the three G-code files to output_dir. Returns a map of key → path."""
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    files = {
        "head1":   out / "head1.gcode",
        "head2":   out / "head2.gcode",
        "gapfill": out / "gapfill.gcode",
    }
    contents = {
        "head1":   head1_code,
        "head2":   head2_code,
        "gapfill": gap_code,
    }

    paths = {}
    for key, path in files.items():
        path.write_text(contents[key], encoding="utf-8")
        paths[key] = str(path)

    return paths


def write_report(output_dir: str, report: dict) -> str:
    """Write JSON report to output_dir/report.json. Returns path."""
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    report_path = out / "report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return str(report_path)
