import { Router, type Request, type Response } from "express";
import { spawn, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir, homedir } from "os";
import { join, resolve } from "path";
import { ProcessGcodeBody, GetJobParams, DownloadFileParams, GetVisualizationParams, GenerateImageToGcodeBody } from "@workspace/api-zod";
import { generateImageToGcode, ImageToGcodeError } from "../lib/image-to-gcode";

const router = Router();

router.post("/image-to-gcode", async (req: Request, res: Response) => {
  const parsed = GenerateImageToGcodeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    res.status(200).json(await generateImageToGcode(parsed.data));
  } catch (error) {
    if (error instanceof ImageToGcodeError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    req.log.error({ err: error }, "Image-to-G-code conversion failed");
    res.status(500).json({ error: error instanceof Error && error.message === "ImageMagick is not available" ? error.message : "Unable to convert image to G-code." });
  }
});

// ─── In-memory job store ──────────────────────────────────────────────────────

interface JobConfig {
  numHeads: number;
  gapWidth: number;
  toolRadius: number;
  safetyMargin: number;
  head2ReferenceY: number;
  penUpZ: number;
  penDownZ: number;
  gapStartY: number | null;
}

interface Job {
  id: string;
  status: "pending" | "running" | "success" | "failed";
  filename: string;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  config: JobConfig;
  report: Record<string, unknown> | null;
  outputDir: string | null;
}

const jobStore = new Map<string, Job>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPythonCommand(): string {
  const envPython = process.env.PYTHON;
  if (envPython && envPython.trim()) {
    return envPython.trim();
  }

  const candidateRoots = new Set<string>();
  const cwd = resolve(process.cwd());
  let current = cwd;
  while (true) {
    candidateRoots.add(current);
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }

  const root = getWorkspaceRoot();
  candidateRoots.add(root);
  let currentRoot = root;
  while (true) {
    candidateRoots.add(currentRoot);
    const parent = resolve(currentRoot, "..");
    if (parent === currentRoot) break;
    currentRoot = parent;
  }

  for (const rootPath of candidateRoots) {
    const venvCandidates = process.platform === "win32"
      ? [
          join(rootPath, ".venv", "Scripts", "python.exe"),
          join(rootPath, ".venv", "Scripts", "python"),
          join(rootPath, "venv", "Scripts", "python.exe"),
          join(rootPath, "venv", "Scripts", "python"),
        ]
      : [
          join(rootPath, ".venv", "bin", "python3"),
          join(rootPath, ".venv", "bin", "python"),
          join(rootPath, "venv", "bin", "python3"),
          join(rootPath, "venv", "bin", "python"),
        ];

    for (const candidate of venvCandidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  const commandCandidates = process.platform === "win32"
    ? ["python", "py", "python3"]
    : ["python3", "python"];

  for (const candidate of commandCandidates) {
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }

  return process.platform === "win32" ? "python" : "python3";
}

function getWorkspaceRoot(): string {
  // Walk up from __dirname to find the project root (contains dmhc_em/)
  const parts = resolve(__dirname).split(/[\\/]/);
  for (let i = parts.length; i > 0; i--) {
    const separator = process.platform === "win32" ? "\\" : "/";
    const candidate = parts.slice(0, i).join(separator) || (process.platform === "win32" ? "C:\\" : "/");
    if (existsSync(join(candidate, "dmhc_em"))) {
      return candidate;
    }
  }
  return process.cwd();
}

function runPipeline(job: Job, gcodeText: string): void {
  const workspaceRoot = getWorkspaceRoot();

  // Create temp output dir
  const outDir = mkdtempSync(join(tmpdir(), "dmhc_em_"));
  const inputFile = join(outDir, "input.gcode");
  writeFileSync(inputFile, gcodeText, "utf-8");

  job.outputDir = outDir;
  job.status = "running";

  const args = [
    "-m", "dmhc_em.main",
    "--input",  inputFile,
    "--output", outDir,
    "--heads",  String(job.config.numHeads),
    "--gap",    String(job.config.gapWidth),
    "--radius", "0",
    "--margin", "0",
    "--head2-ref-y", String(job.config.head2ReferenceY),
    "--pen-up-z", String(job.config.penUpZ),
    "--pen-down-z", String(job.config.penDownZ),
  ];

  const proc = spawn(getPythonCommand(), args, {
    cwd: workspaceRoot,
    env: { ...process.env, PYTHONPATH: workspaceRoot },
  });

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d) => { stdout += d.toString(); });
  proc.stderr.on("data", (d) => { stderr += d.toString(); });

  proc.on("close", (code) => {
    job.completedAt = new Date().toISOString();
    if (code === 0) {
      try {
        const result = JSON.parse(stdout.trim());
        if (result.success) {
          job.status = "success";
          job.report = result.report ?? null;
        } else {
          job.status = "failed";
          job.error = result.error ?? "Pipeline returned success=false";
        }
      } catch {
        job.status = "failed";
        job.error = `Failed to parse pipeline output: ${stdout.slice(0, 500)}`;
      }
    } else {
      job.status = "failed";
      job.error = stderr.slice(0, 2000) || `Process exited with code ${code}`;
    }
  });
}

// ─── POST /api/process ───────────────────────────────────────────────────────

router.post("/process", (req: Request, res: Response) => {
  const parsed = ProcessGcodeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const {
    gcodeContent,
    filename = "program.gcode",
    numHeads = 2,
    gapWidth = 80.0,
    toolRadius = 0,
    safetyMargin = 0,
    head2ReferenceY = 620.0,
    penUpZ = 5.0,
    penDownZ = 0.0,
    gapStartY = null,
  } = parsed.data;

  const id = randomUUID();
  const job: Job = {
    id,
    status: "pending",
    filename: filename ?? "program.gcode",
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    config: {
      numHeads: numHeads ?? 2,
      gapWidth: gapWidth ?? 80.0,
      toolRadius: 0,
      safetyMargin: 0,
      head2ReferenceY: head2ReferenceY ?? 620.0,
      penUpZ: penUpZ ?? 5.0,
      penDownZ: penDownZ ?? 0.0,
      gapStartY: gapStartY ?? null,
    },
    report: null,
    outputDir: null,
  };

  jobStore.set(id, job);

  // Run pipeline synchronously in a child process (async internally)
  // We return immediately and let the client poll
  // But since the CLI is fast for typical files, we wait for it here
  // and return the completed job in the response (simpler UX).
  runPipelineSync(job, gcodeContent, (err) => {
    if (err) {
      req.log.error({ err }, "Pipeline error");
    }
  });

  // Wait up to 90s for job to complete before returning
  waitForJob(id, 90000).then(() => {
    const finished = jobStore.get(id)!;
    res.status(200).json(jobToApiShape(finished));
  }).catch(() => {
    res.status(200).json(jobToApiShape(jobStore.get(id)!));
  });
});

function runPipelineSync(
  job: Job,
  gcodeText: string,
  cb: (err?: Error) => void,
): void {
  const workspaceRoot = getWorkspaceRoot();
  const outDir = mkdtempSync(join(tmpdir(), "dmhc_em_"));
  const inputFile = join(outDir, "input.gcode");
  writeFileSync(inputFile, gcodeText, "utf-8");

  job.outputDir = outDir;
  job.status = "running";

  const args = [
    "-m", "dmhc_em.main",
    "--input",  inputFile,
    "--output", outDir,
    "--heads",  String(job.config.numHeads),
    "--gap",    String(job.config.gapWidth),
    "--radius", "0",
    "--margin", "0",
    "--head2-ref-y", String(job.config.head2ReferenceY),
    "--pen-up-z", String(job.config.penUpZ),
    "--pen-down-z", String(job.config.penDownZ),
  ];
  if (job.config.gapStartY !== null && job.config.gapStartY !== undefined) {
    args.push("--gap-start-y", String(job.config.gapStartY));
  }

  const proc = spawn(getPythonCommand(), args, {
    cwd: workspaceRoot,
    env: { ...process.env, PYTHONPATH: workspaceRoot },
  });

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d) => { stdout += d.toString(); });
  proc.stderr.on("data", (d) => { stderr += d.toString(); });

  proc.on("close", (code) => {
    job.completedAt = new Date().toISOString();
    if (code === 0) {
      try {
        const result = JSON.parse(stdout.trim());
        if (result.success) {
          job.status = "success";
          job.report = result.report ?? null;
        } else {
          job.status = "failed";
          // Surface the Python ValueError (unit-mismatch guard) as a clear message
          job.error = result.error ?? "Pipeline returned success=false";
        }
      } catch {
        job.status = "failed";
        job.error = `Failed to parse pipeline output: ${stdout.slice(0, 500)}`;
      }
    } else {
      // Non-zero exit: mark failed immediately so waitForJob resolves.
      job.status = "failed";
      // Parse stderr for a Python ValueError so the UI shows a human-readable
      // message instead of a raw traceback.
      const valueErrorLines = [...stderr.matchAll(/ValueError:\s*(.+)/g)];
      if (valueErrorLines.length > 0) {
        const msg = valueErrorLines[valueErrorLines.length - 1][1].trim();
        job.error = `Configuration error: ${msg}`;
      } else {
        job.error = stderr.slice(0, 2000) || `Process exited with code ${code}`;
      }
    }
    cb();
  });

  proc.on("error", (err) => {
    job.status = "failed";
    job.error = `Failed to start process: ${err.message}`;
    job.completedAt = new Date().toISOString();
    cb(err);
  });
}

function waitForJob(id: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const job = jobStore.get(id);
      if (!job) { reject(new Error("Job not found")); return; }
      if (job.status === "success" || job.status === "failed") {
        resolve(); return;
      }
      if (Date.now() - start > timeoutMs) { reject(new Error("Timeout")); return; }
      setTimeout(check, 200);
    };
    check();
  });
}

function jobToApiShape(job: Job) {
  return {
    id: job.id,
    status: job.status,
    filename: job.filename,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    error: job.error,
    config: job.config,
    report: job.report,
  };
}

// ─── GET /api/jobs ────────────────────────────────────────────────────────────

router.get("/jobs", (_req: Request, res: Response) => {
  const jobs = Array.from(jobStore.values())
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map(jobToApiShape);
  res.json(jobs);
});

// ─── GET /api/jobs/:jobId ─────────────────────────────────────────────────────

router.get("/jobs/:jobId", (req: Request, res: Response) => {
  const parsed = GetJobParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid job ID" }); return; }
  const { jobId } = parsed.data;
  const job = jobStore.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(jobToApiShape(job));
});

// ─── GET /api/jobs/:jobId/download/:fileKey ───────────────────────────────────

router.get("/jobs/:jobId/download/:fileKey", (req: Request, res: Response) => {
  const parsed = DownloadFileParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid parameters" }); return; }
  const { jobId, fileKey } = parsed.data;
  const job = jobStore.get(jobId);
  if (!job || !job.outputDir) {
    res.status(404).json({ error: "Job not found or not complete" });
    return;
  }

  const fileMap: Record<string, string> = {
    head1:   join(job.outputDir, "head1.gcode"),
    head2:   join(job.outputDir, "head2.gcode"),
    gapfill: join(job.outputDir, "gapfill.gcode"),
  };

  const filePath = fileMap[fileKey];
  if (!filePath || !existsSync(filePath)) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Content-Disposition", `attachment; filename="${fileKey}.gcode"`);
  res.send(readFileSync(filePath, "utf-8"));
});

// ─── Axis inversion helper ────────────────────────────────────────────────────

const PARAM_RE = /([A-Za-z])\s*(-?\d+(?:\.\d*)?(?:[Ee][+-]?\d+)?)/g;
const G2_RE = /G0*2\b/gi;
const G3_RE = /G0*3\b/gi;

function invertGcode(gcode: string, invertX: boolean, invertY: boolean): string {
  if (!invertX && !invertY) return gcode;

  // Single-axis mirror → arc winding reverses; both axes → rotation, winding preserved.
  const flipArc = invertX !== invertY;

  return gcode.split("\n").map((raw) => {
    const line = raw.trimEnd();

    const semi = line.indexOf(";");
    if (semi === 0) return line;                     // whole line is a comment

    const codePart    = semi > 0 ? line.slice(0, semi) : line;
    const commentPart = semi > 0 ? line.slice(semi)    : "";

    if (!codePart.trim()) return line;

    const upper = codePart.toUpperCase();
    const isArc = /G0*[23]\b/.test(upper);

    let code = codePart;

    if (isArc && flipArc) {
      if (G2_RE.test(code)) { G2_RE.lastIndex = 0; code = code.replace(G2_RE, "G3"); }
      else                  { G3_RE.lastIndex = 0; code = code.replace(G3_RE, "G2"); }
    }
    G2_RE.lastIndex = 0;
    G3_RE.lastIndex = 0;

    code = code.replace(PARAM_RE, (match, letter: string, numStr: string) => {
      const L = letter.toUpperCase();
      let value = parseFloat(numStr);

      if      (L === "X" && invertX)            value = -value;
      else if (L === "Y" && invertY)            value = -value;
      else if (L === "I" && isArc && invertX)   value = -value;
      else if (L === "J" && isArc && invertY)   value = -value;
      else return match;

      const dotIdx = numStr.indexOf(".");
      if (dotIdx >= 0) {
        const decimals = numStr.length - dotIdx - 1;
        return `${letter}${value.toFixed(decimals)}`;
      }
      return `${letter}${value}`;
    });
    PARAM_RE.lastIndex = 0;

    return code + commentPart;
  }).join("\n");
}

// ─── POST /api/jobs/:jobId/invert ─────────────────────────────────────────────

const VALID_FILE_KEYS = new Set(["head1", "head2", "gapfill"]);

router.post("/jobs/:jobId/invert", (req: Request, res: Response) => {
  const jobId = String(req.params.jobId);
  const job = jobStore.get(jobId);
  if (!job || !job.outputDir) {
    res.status(404).json({ error: "Job not found or not complete" }); return;
  }

  const body = req.body as Record<string, unknown>;
  const files   = body.files;
  const invertX = body.invertX;
  const invertY = body.invertY;

  if (!Array.isArray(files) || files.length === 0 || !files.every((f) => VALID_FILE_KEYS.has(f))) {
    res.status(400).json({ error: "files must be a non-empty array of: head1, head2, gapfill" }); return;
  }
  if (typeof invertX !== "boolean" || typeof invertY !== "boolean") {
    res.status(400).json({ error: "invertX and invertY must be booleans" }); return;
  }
  if (!invertX && !invertY) {
    res.status(400).json({ error: "At least one axis (invertX or invertY) must be true" }); return;
  }

  const safeFiles = files as string[];

  const fileMap: Record<string, string> = {
    head1:   join(job.outputDir, "head1.gcode"),
    head2:   join(job.outputDir, "head2.gcode"),
    gapfill: join(job.outputDir, "gapfill.gcode"),
  };

  const result: Record<string, string> = {};
  for (const key of safeFiles) {
    const filePath = fileMap[key];
    if (!filePath || !existsSync(filePath)) {
      res.status(404).json({ error: `File not found: ${key}` }); return;
    }
    const original = readFileSync(filePath, "utf-8");
    result[key] = invertGcode(original, invertX, invertY);
  }

  res.json(result);
});

// ─── GET /api/jobs/:jobId/visualization ──────────────────────────────────────

router.get("/jobs/:jobId/visualization", (req: Request, res: Response) => {
  const parsed = GetVisualizationParams.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "Invalid job ID" }); return; }
  const { jobId } = parsed.data;
  const job = jobStore.get(jobId);
  if (!job || !job.outputDir) {
    res.status(404).json({ error: "Job not found or not complete" });
    return;
  }

  const reportPath = join(job.outputDir, "report.json");
  if (!existsSync(reportPath)) {
    res.status(404).json({ error: "Report not found" });
    return;
  }

  // Read the G-code files and reconstruct visualization from report
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf-8")) as Record<string, any>;

    // Parse the generated G-code files to extract segment viz data
    const head1Path = join(job.outputDir, "head1.gcode");
    const head2Path = join(job.outputDir, "head2.gcode");
    const gapPath   = join(job.outputDir, "gapfill.gcode");

    const head1Segs = existsSync(head1Path) ? extractSegments(readFileSync(head1Path, "utf-8"), "head1") : [];
    const head2Segs = existsSync(head2Path) ? extractSegments(readFileSync(head2Path, "utf-8"), "head2") : [];
    const gapSegs   = existsSync(gapPath)   ? extractSegments(readFileSync(gapPath, "utf-8"), "gap")    : [];

    const allSegs = [...head1Segs, ...head2Segs, ...gapSegs];

    // Bounds
    const xs = allSegs.flatMap((s) => [s.x1, s.x2]);
    const ys = allSegs.flatMap((s) => [s.y1, s.y2]);
    const bounds = {
      xMin: xs.length ? Math.min(...xs) : 0,
      xMax: xs.length ? Math.max(...xs) : 100,
      yMin: ys.length ? Math.min(...ys) : 0,
      yMax: ys.length ? Math.max(...ys) : 100,
    };

    // Build density map from report partition data
    const partition = (report.partition ?? {}) as Record<string, any>;
    const densityMap = buildDensityMap(allSegs, bounds.xMin, bounds.xMax, 80);

    // Zone info
    const gapXMin = (partition.gap_x_min as number) ?? (bounds.xMin + bounds.xMax) / 2 - 5;
    const gapXMax = (partition.gap_x_max as number) ?? (bounds.xMin + bounds.xMax) / 2 + 5;

    const zoneInfo = {
      head1: {
        xMin: bounds.xMin,
        xMax: gapXMin,
        segmentCount: head1Segs.filter((s) => s.motionType === "cut").length,
      },
      head2: {
        xMin: gapXMax,
        xMax: bounds.xMax,
        segmentCount: head2Segs.filter((s) => s.motionType === "cut").length,
      },
      gap: {
        xMin: gapXMin,
        xMax: gapXMax,
        segmentCount: gapSegs.filter((s) => s.motionType === "cut").length,
      },
    };

    res.json({ segments: allSegs, densityMap, zones: zoneInfo, bounds });
  } catch (err) {
    res.status(500).json({ error: "Failed to build visualization data" });
  }
});

// ─── Helpers for visualization ────────────────────────────────────────────────

interface SegViz {
  x1: number; y1: number; x2: number; y2: number;
  motionType: "cut" | "rapid";
  zone: "head1" | "head2" | "gap" | "unassigned";
}

function extractSegments(gcode: string, zone: "head1" | "head2" | "gap"): SegViz[] {
  const segs: SegViz[] = [];
  let cx = 0, cy = 0;

  for (const line of gcode.split("\n")) {
    const clean = line.split(";")[0].trim().toUpperCase();
    if (!clean) continue;

    const xm = clean.match(/X(-?\d+\.?\d*)/);
    const ym = clean.match(/Y(-?\d+\.?\d*)/);
    if (!xm && !ym) continue;

    const nx = xm ? parseFloat(xm[1]) : cx;
    const ny = ym ? parseFloat(ym[1]) : cy;

    if (clean.startsWith("G1")) {
      segs.push({ x1: cx, y1: cy, x2: nx, y2: ny, motionType: "cut", zone });
    } else if (clean.startsWith("G0")) {
      segs.push({ x1: cx, y1: cy, x2: nx, y2: ny, motionType: "rapid", zone: "unassigned" });
    }

    cx = nx;
    cy = ny;
  }

  return segs;
}

function buildDensityMap(
  segs: SegViz[],
  xMin: number,
  xMax: number,
  bins: number,
): Array<{ x: number; density: number }> {
  const span = xMax - xMin;
  if (span <= 0) return [];

  const buckets = new Array<number>(bins).fill(0);
  for (const seg of segs) {
    if (seg.motionType !== "cut") continue;
    const sXmin = Math.min(seg.x1, seg.x2);
    const sXmax = Math.max(seg.x1, seg.x2);
    const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
    const sSpan = Math.max(sXmax - sXmin, 1e-9);

    for (let i = 0; i < bins; i++) {
      const bXmin = xMin + (i / bins) * span;
      const bXmax = xMin + ((i + 1) / bins) * span;
      const overlap = Math.max(0, Math.min(sXmax, bXmax) - Math.max(sXmin, bXmin));
      if (overlap > 0) {
        buckets[i] += len * (overlap / sSpan);
      }
    }
  }

  return buckets.map((density, i) => ({
    x: xMin + ((i + 0.5) / bins) * span,
    density,
  }));
}

export default router;
