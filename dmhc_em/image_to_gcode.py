"""Convert raster images to pen-plotter G-code with OpenCV, Potrace, and vpype."""

from __future__ import annotations

from contextlib import contextmanager
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
from collections.abc import Iterator
import uuid


class ImageToGcodeError(RuntimeError):
    """Raised when image conversion cannot be completed."""


@contextmanager
def _working_directory(parent: Path) -> Iterator[Path]:
    path = parent / f".image-to-gcode-{uuid.uuid4().hex}"
    path.mkdir()
    try:
        yield path
    finally:
        shutil.rmtree(path)


def _require_executable(name: str) -> str:
    executable = shutil.which(name)
    if executable is None:
        raise ImageToGcodeError(
            f"Required executable '{name}' was not found on PATH. "
            f"Install it before converting images."
        )
    return executable


def _run(command: list[str], stage: str, cwd: Path) -> None:
    try:
        subprocess.run(
            command,
            cwd=cwd,
            check=True,
            capture_output=True,
            text=True,
        )
    except OSError as exc:
        raise ImageToGcodeError(f"Unable to start {stage}: {exc}") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "No diagnostic output.").strip()
        raise ImageToGcodeError(
            f"{stage} failed with exit code {exc.returncode}: {detail}"
        ) from exc


def _finite_number(name: str, value: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number.")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{name} must be finite.")
    return result


def _positive_feedrate(name: str, value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive integer.")
    return value


def _format_number(value: float) -> str:
    return f"{value:g}"


def _write_vpype_config(
    path: Path,
    *,
    pen_up_z: float,
    pen_down_z: float,
    draw_feedrate: int,
    travel_z_feedrate: int,
) -> None:
    values = {
        "document_start": "G21 ; mm\nG90 ; absolute positioning\n",
        "segment_first": (
            f"G0 Z{_format_number(pen_up_z)} ; pen up\n"
            "G0 X{x:.3f} Y{y:.3f} ; travel\n"
            f"G1 Z{_format_number(pen_down_z)} F{travel_z_feedrate} ; pen down\n"
        ),
        "segment": (
            f"G1 X{{x:.3f}} Y{{y:.3f}} F{draw_feedrate} ; draw\n"
        ),
        "document_end": (
            f"G0 Z{_format_number(pen_up_z)} ; pen up\n"
            "G0 X0 Y0 ; return to origin\n"
            "M2 ; end program\n"
        ),
        "unit": "mm",
    }
    lines = ["[gwrite.twinix]"]
    lines.extend(f"{key} = {json.dumps(value)}" for key, value in values.items())
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def image_to_gcode(
    input_image_path: str,
    output_gcode_path: str,
    threshold: int = 155,
    target_width_mm: float = 150,
    target_height_mm: float = 150,
    pen_up_z: float = 5.0,
    pen_down_z: float = 0.0,
    draw_feedrate: int = 3000,
    travel_z_feedrate: int = 1000,
    keep_intermediates: bool = False,
) -> str:
    """Convert an image to G-code and return the generated file's path.

    When ``keep_intermediates`` is true, ``binary.pbm`` and ``output.svg`` are
    copied beside the G-code file using the G-code filename as a prefix.
    """
    if isinstance(threshold, bool) or not isinstance(threshold, int):
        raise ValueError("threshold must be an integer from 0 to 255.")
    if not 0 <= threshold <= 255:
        raise ValueError("threshold must be an integer from 0 to 255.")

    target_width_mm = _finite_number("target_width_mm", target_width_mm)
    target_height_mm = _finite_number("target_height_mm", target_height_mm)
    if target_width_mm <= 0 or target_height_mm <= 0:
        raise ValueError("target dimensions must be greater than zero.")
    pen_up_z = _finite_number("pen_up_z", pen_up_z)
    pen_down_z = _finite_number("pen_down_z", pen_down_z)
    draw_feedrate = _positive_feedrate("draw_feedrate", draw_feedrate)
    travel_z_feedrate = _positive_feedrate(
        "travel_z_feedrate", travel_z_feedrate
    )
    if not isinstance(keep_intermediates, bool):
        raise ValueError("keep_intermediates must be a boolean.")

    input_path = Path(input_image_path).expanduser().resolve()
    output_path = Path(output_gcode_path).expanduser().resolve()
    if not input_path.is_file():
        raise FileNotFoundError(f"Input image does not exist: {input_path}")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        import cv2
        import numpy  # noqa: F401 - explicitly verify the required dependency
    except ImportError as exc:
        raise ImageToGcodeError(
            "OpenCV and NumPy are required. Install opencv-python-headless and numpy."
        ) from exc

    potrace = _require_executable("potrace")
    vpype = _require_executable("vpype")

    # Keep staging on the destination filesystem so final replacement is atomic.
    with _working_directory(output_path.parent) as work_dir:
        binary_path = work_dir / "binary.pbm"
        svg_path = work_dir / "output.svg"
        config_path = work_dir / ".vpype.toml"
        staged_gcode_path = work_dir / "final_output.gcode"

        image = cv2.imread(os.fspath(input_path))
        if image is None:
            raise ImageToGcodeError(f"OpenCV could not read the image: {input_path}")
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        filtered = cv2.bilateralFilter(gray, d=9, sigmaColor=75, sigmaSpace=75)
        _, binary = cv2.threshold(filtered, threshold, 255, cv2.THRESH_BINARY)
        if not cv2.imwrite(os.fspath(binary_path), binary):
            raise ImageToGcodeError(f"OpenCV could not write {binary_path}.")

        _run(
            [
                potrace,
                os.fspath(binary_path),
                "-s",
                "-o",
                os.fspath(svg_path),
                "--turdsize",
                "2",
                "--opttolerance",
                "0.2",
            ],
            "Potrace vectorization",
            work_dir,
        )

        _write_vpype_config(
            config_path,
            pen_up_z=pen_up_z,
            pen_down_z=pen_down_z,
            draw_feedrate=draw_feedrate,
            travel_z_feedrate=travel_z_feedrate,
        )
        dimensions = (
            f"{_format_number(target_width_mm)}x"
            f"{_format_number(target_height_mm)}mm"
        )
        _run(
            [
                vpype,
                "--config",
                os.fspath(config_path),
                "read",
                os.fspath(svg_path),
                "linemerge",
                "--tolerance",
                "0.5mm",
                "linesort",
                "linesimplify",
                "--tolerance",
                "0.1mm",
                "layout",
                "--fit-to-margins",
                "5mm",
                "--landscape",
                dimensions,
                "gwrite",
                "-p",
                "twinix",
                os.fspath(staged_gcode_path),
            ],
            "vpype optimization and G-code export",
            work_dir,
        )
        if not staged_gcode_path.is_file():
            raise ImageToGcodeError("vpype completed without producing G-code.")

        if keep_intermediates:
            shutil.copy2(binary_path, output_path.with_suffix(".binary.pbm"))
            shutil.copy2(svg_path, output_path.with_suffix(".svg"))
        os.replace(staged_gcode_path, output_path)

    return os.fspath(output_path)


__all__ = ["ImageToGcodeError", "image_to_gcode"]
