import { useParams } from "wouter";
import { useGetJob, useGetVisualization, getGetJobQueryKey, getGetVisualizationQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Loader2, AlertTriangle, Download, ArrowLeft, CheckCircle2, XCircle, Copy, Check, RotateCcw, Play } from "lucide-react";
import { Link } from "wouter";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceArea } from "recharts";
import { useMemo, useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";

// Colors for zones
const ZONE_COLORS = {
  head1: "#3B82F6",
  head2: "#F97316",
  gap: "#22C55E",
  rapid: "#6B7280",
  unassigned: "#9CA3AF"
};

// Fetch G-code content from the download endpoint
function useGcodeContent(jobId: string | undefined, fileKey: string, enabled: boolean) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !jobId) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/jobs/${jobId}/download/${fileKey}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => { setContent(text); setLoading(false); })
      .catch((err) => {
        if (err.name === "AbortError") return;
        setError(err.message ?? "Failed to load");
        setLoading(false);
      });
    return () => controller.abort();
  }, [jobId, fileKey, enabled]);

  return { content, loading, error };
}

// Copy-to-clipboard button
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // Fallback for insecure contexts or denied permissions
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch { /* silent */ }
    });
  }, [text]);

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={handleCopy}
      className="font-mono text-xs h-7 px-2 gap-1"
    >
      {copied ? <Check className="w-3 h-3 text-chart-3" /> : <Copy className="w-3 h-3" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

// ─── Axis Inversion Panel ────────────────────────────────────────────────────

const FILE_KEYS = ["head1", "head2", "gapfill"] as const;
type FileKey = typeof FILE_KEYS[number];
const FILE_LABELS: Record<FileKey, string> = {
  head1: "Head 1",
  head2: "Head 2",
  gapfill: "Gap Fill",
};

function AxisInversionPanel({ jobId }: { jobId: string }) {
  const [selFiles, setSelFiles]     = useState<Set<FileKey>>(new Set());
  const [invertX, setInvertX]       = useState(false);
  const [invertY, setInvertY]       = useState(false);
  const [loading, setLoading]       = useState(false);
  // original API results (for Reset)
  const [results, setResults]       = useState<Record<string, string> | null>(null);
  // editable copies — user can modify these
  const [editedResults, setEditedResults] = useState<Record<string, string>>({});
  const [error, setError]           = useState<string | null>(null);

  const allSelected = FILE_KEYS.every((k) => selFiles.has(k));

  const toggleFile = (key: FileKey) =>
    setSelFiles((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const toggleAll = () =>
    setSelFiles(allSelected ? new Set() : new Set<FileKey>(FILE_KEYS));

  const canApply = selFiles.size > 0 && (invertX || invertY);

  const apply = async () => {
    if (!canApply) return;
    setLoading(true);
    setError(null);
    setResults(null);
    setEditedResults({});
    try {
      const res = await fetch(`/api/jobs/${jobId}/invert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: Array.from(selFiles), invertX, invertY }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error ?? `HTTP ${res.status}`);
      }
      const data: Record<string, string> = await res.json();
      setResults(data);
      setEditedResults({ ...data });        // seed editable copies
    } catch (e: any) {
      setError(e.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const updateEdited = (key: string, value: string) =>
    setEditedResults((prev) => ({ ...prev, [key]: value }));

  const resetFile = (key: string) =>
    setEditedResults((prev) => ({ ...prev, [key]: results?.[key] ?? prev[key] }));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-mono flex items-center gap-2">
          <RotateCcw className="w-4 h-4" />
          Axis Inversion
          <span className="text-muted-foreground text-xs font-normal font-sans">
            — post-processing
          </span>
        </CardTitle>
        <CardDescription>
          Negate X and/or Y coordinates in selected output files.
          Arc direction and I/J offsets are adjusted automatically.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {/* File selection */}
          <div>
            <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-3">
              Files
            </p>
            <div className="space-y-2">
              {FILE_KEYS.map((key) => (
                <label key={key} className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={selFiles.has(key)}
                    onChange={() => toggleFile(key)}
                    className="accent-primary w-3.5 h-3.5"
                  />
                  <span className="font-mono text-sm">{FILE_LABELS[key]}</span>
                </label>
              ))}
              <label className="flex items-center gap-2 cursor-pointer select-none pt-2 mt-1 border-t border-border/30">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="accent-primary w-3.5 h-3.5"
                />
                <span className="font-mono text-sm text-muted-foreground">Select All</span>
              </label>
            </div>
          </div>

          {/* Axis selection */}
          <div>
            <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-3">
              Axes
            </p>
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={invertX}
                  onChange={(e) => setInvertX(e.target.checked)}
                  className="accent-primary w-3.5 h-3.5"
                />
                <span className="font-mono text-sm">Invert X</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={invertY}
                  onChange={(e) => setInvertY(e.target.checked)}
                  className="accent-primary w-3.5 h-3.5"
                />
                <span className="font-mono text-sm">Invert Y</span>
              </label>
            </div>
          </div>
        </div>

        {/* Apply button */}
        <div className="mt-5 flex items-center gap-3 flex-wrap">
          <Button
            onClick={apply}
            disabled={loading || !canApply}
            className="font-mono"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
            {loading ? "Applying…" : "Apply Inversion"}
          </Button>
          {!canApply && !loading && (
            <span className="text-xs text-muted-foreground font-mono">
              {selFiles.size === 0 ? "Select at least one file" : "Select at least one axis"}
            </span>
          )}
          {error && (
            <span className="text-xs text-destructive font-mono flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> {error}
            </span>
          )}
        </div>

        {/* Editable preview + download results */}
        {results && (
          <div className="mt-5 pt-4 border-t border-border/30 space-y-4">
            <p className="text-xs font-mono text-muted-foreground">
              Inverted files — edit, then download:
            </p>
            {(Object.keys(results) as string[]).map((key) => {
              const original   = results[key];
              const current    = editedResults[key] ?? original;
              const isModified = current !== original;
              const label      = FILE_LABELS[key as FileKey] ?? key;
              return (
                <div key={key} className="border border-border/30 rounded-sm">
                  {/* Panel header */}
                  <div className="flex items-center justify-between px-3 py-2 border-b border-border/30 bg-muted/10 flex-wrap gap-2">
                    <span className="font-mono text-sm font-medium flex items-center gap-2">
                      <span
                        className="inline-block w-2 h-2 rounded-sm"
                        style={{ background: ZONE_COLORS[key as keyof typeof ZONE_COLORS] ?? "#6B7280" }}
                      />
                      {label}
                      <span className="text-muted-foreground text-xs font-normal">
                        ({current.split("\n").length} lines)
                      </span>
                      {isModified && (
                        <span className="text-xs text-amber-400 font-mono">edited</span>
                      )}
                    </span>
                    <div className="flex items-center gap-2">
                      <CopyButton text={current} />
                      {isModified && (
                        <Button
                          size="sm" variant="ghost"
                          onClick={() => resetFile(key)}
                          className="font-mono text-xs h-7 px-2 text-muted-foreground"
                        >
                          Reset
                        </Button>
                      )}
                      <Button
                        variant="outline" size="sm"
                        onClick={() => downloadBlob(`${key}_inverted.gcode`, current)}
                        className="font-mono text-xs h-7 px-2 gap-1"
                      >
                        <Download className="w-3 h-3" />
                        {key}_inverted.gcode
                      </Button>
                    </div>
                  </div>
                  {/* Editable textarea */}
                  <textarea
                    value={current}
                    onChange={(e) => updateEdited(key, e.target.value)}
                    spellCheck={false}
                    className="w-full text-xs font-mono bg-muted/20 p-3 min-h-[14rem] resize-y leading-relaxed text-foreground/80 focus:outline-none focus:bg-muted/30 transition-colors"
                  />
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Single G-code panel ──────────────────────────────────────────────────────

// ─── Blob download helper ─────────────────────────────────────────────────────

function downloadBlob(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ─── Single G-code panel (editable) ──────────────────────────────────────────

function GcodePanel({
  label,
  fileKey,
  jobId,
  color,
  downloadFilename,
  enabled,
}: {
  label: string;
  fileKey: string;
  jobId: string;
  color: string;
  downloadFilename: string;
  enabled: boolean;
}) {
  const { content, loading, error } = useGcodeContent(jobId, fileKey, enabled);
  const [edited, setEdited] = useState<string | null>(null);

  // Seed editable state once the fetch resolves
  useEffect(() => {
    if (content !== null && edited === null) setEdited(content);
  }, [content]); // eslint-disable-line react-hooks/exhaustive-deps

  const current    = edited ?? content ?? "";
  const isModified = content !== null && edited !== null && edited !== content;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base font-mono flex items-center gap-2">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: color }} />
            {label}
            {current && (
              <span className="text-muted-foreground text-xs font-normal ml-1">
                ({current.split("\n").length} lines)
              </span>
            )}
            {isModified && (
              <span className="text-xs text-amber-400 font-mono font-normal">edited</span>
            )}
          </CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            {current && <CopyButton text={current} />}
            {isModified && (
              <Button
                size="sm" variant="ghost"
                onClick={() => setEdited(content)}
                className="font-mono text-xs h-7 px-2 text-muted-foreground"
              >
                Reset
              </Button>
            )}
            {current && (
              <Button
                size="sm" variant="outline"
                onClick={() => downloadBlob(downloadFilename, current)}
                className="font-mono text-xs h-7 px-2 gap-1"
              >
                <Download className="w-3 h-3" /> Download
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center h-32 border border-border/30 rounded-sm bg-muted/10">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-32 border border-dashed border-destructive/40 text-destructive font-mono text-xs gap-2">
            <AlertTriangle className="w-4 h-4" /> {error}
          </div>
        ) : content !== null ? (
          <textarea
            value={current}
            onChange={(e) => setEdited(e.target.value)}
            spellCheck={false}
            className="w-full text-xs font-mono bg-muted/20 border border-border/30 rounded-sm p-3 min-h-[16rem] resize-y leading-relaxed text-foreground/80 focus:outline-none focus:border-primary/50 focus:bg-muted/30 transition-colors"
          />
        ) : (
          <div className="flex items-center justify-center h-32 border border-dashed border-border text-muted-foreground font-mono text-xs">
            No content
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Viz() {
  const params = useParams();
  const jobId = params.id as string;

  // Poll every 2 seconds while the job is still running
  const { data: job, isLoading: isJobLoading, error: jobError } = useGetJob(jobId, {
    query: {
      enabled: !!jobId,
      queryKey: getGetJobQueryKey(jobId),
      refetchInterval: (query) => {
        const status = (query.state.data as any)?.status;
        return status === "success" || status === "failed" ? false : 2000;
      },
    }
  });

  const isRunning = job?.status === "running" || job?.status === "pending";
  const isSuccess = job?.status === "success";

  const { data: vizData, isLoading: isVizLoading } = useGetVisualization(jobId, {
    query: {
      enabled: !!jobId && isSuccess,
      queryKey: getGetVisualizationQueryKey(jobId),
    }
  });

  const report = job?.report as any;
  const isLoading = isJobLoading || (isSuccess && isVizLoading);

  // Compute scale for the SVG toolpath
  const svgProps = useMemo(() => {
    if (!vizData?.bounds) return null;
    const { xMin, xMax, yMin, yMax } = vizData.bounds;
    const width = xMax - xMin || 1;
    const height = yMax - yMin || 1;
    const padX = width * 0.05;
    const padY = height * 0.05;
    return {
      viewBox: `${xMin - padX} ${yMin - padY} ${width + padX * 2} ${height + padY * 2}`,
      width, height, xMin, xMax, yMin, yMax
    };
  }, [vizData]);

  // ── Loading state (initial fetch) ──────────────────────────────────────────
  if (isLoading && !isRunning) {
    return (
      <div className="flex h-full w-full items-center justify-center p-12">
        <div className="flex flex-col items-center gap-4 text-primary">
          <Loader2 className="w-12 h-12 animate-spin" />
          <span className="font-mono text-sm tracking-wider uppercase">Loading…</span>
        </div>
      </div>
    );
  }

  // ── Error state ────────────────────────────────────────────────────────────
  if (jobError || !job) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <div className="bg-destructive/10 border border-destructive/30 p-6 rounded-sm text-destructive flex items-start gap-4">
          <AlertTriangle className="w-6 h-6 mt-1" />
          <div>
            <h2 className="text-lg font-bold font-mono">Failed to load job</h2>
            <p className="font-mono text-sm mt-1">{(jobError as any)?.data?.error ?? "Unknown error"}</p>
            <Link href="/" className={cn(buttonVariants({ variant: "outline" }), "mt-4 border-destructive/50 text-destructive hover:bg-destructive/20")}>
              <ArrowLeft className="w-4 h-4 mr-2" />
              Return to Workspace
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const isFailed = job.status === "failed";
  const validation = report?.validation;
  const partition = report?.partition;

  return (
    <div className="p-8 max-w-[1400px] mx-auto space-y-8">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/jobs" data-testid="link-back-to-jobs" className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "hover:bg-accent hover:text-accent-foreground")}>
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="text-3xl font-mono tracking-tight font-bold text-foreground flex items-center gap-3">
              <span data-testid="text-job-filename">{job.filename}</span>
              {isFailed ? (
                <Badge variant="destructive" data-testid="badge-job-status">FAILED</Badge>
              ) : isRunning ? (
                <Badge variant="secondary" className="animate-pulse" data-testid="badge-job-status">PROCESSING</Badge>
              ) : (
                <Badge variant="default" className="bg-chart-3 text-chart-3-foreground" data-testid="badge-job-status">PASS</Badge>
              )}
            </h1>
            <p className="text-muted-foreground font-mono text-sm mt-1" data-testid="text-job-id">ID: {job.id}</p>
          </div>
        </div>

        {/* Download buttons — only when job succeeded and files exist */}
        {isSuccess && (
          <div className="flex items-center gap-2">
            <Link href={`/automated-drawing/${job.id}`} data-testid="link-auto-run" className={cn(buttonVariants({ variant: "default" }), "font-mono shadow-md mr-2")}>
              <Play className="w-4 h-4 mr-2" /> Automated Run
            </Link>
            <a href={`/api/jobs/${job.id}/download/head1`} download="head1.gcode" data-testid="link-download-head1" className={cn(buttonVariants({ variant: "outline" }), "border-chart-1/30 text-chart-1 hover:bg-chart-1/10 hover:text-chart-1 font-mono")}>
              <Download className="w-4 h-4 mr-2" /> Head 1
            </a>
            <a href={`/api/jobs/${job.id}/download/head2`} download="head2.gcode" data-testid="link-download-head2" className={cn(buttonVariants({ variant: "outline" }), "border-chart-2/30 text-chart-2 hover:bg-chart-2/10 hover:text-chart-2 font-mono")}>
              <Download className="w-4 h-4 mr-2" /> Head 2
            </a>
            <a href={`/api/jobs/${job.id}/download/gapfill`} download="gapfill.gcode" data-testid="link-download-gapfill" className={cn(buttonVariants({ variant: "outline" }), "border-chart-3/30 text-chart-3 hover:bg-chart-3/10 hover:text-chart-3 font-mono")}>
              <Download className="w-4 h-4 mr-2" /> Gap Fill
            </a>
          </div>
        )}
      </div>

      {/* ── Processing banner ───────────────────────────────────────────────── */}
      {isRunning && (
        <Card className="border-primary/30 bg-primary/5" data-testid="card-processing-banner">
          <CardContent className="py-8 flex flex-col items-center gap-4">
            <Loader2 className="w-10 h-10 animate-spin text-primary" />
            <div className="text-center">
              <p className="font-mono font-bold text-primary">Processing toolpath…</p>
              <p className="font-mono text-sm text-muted-foreground mt-1">
                The compiler is partitioning your G-code. This page will update automatically when done.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Error card ──────────────────────────────────────────────────────── */}
      {isFailed && (
        <Card className="border-destructive/50 bg-destructive/5" data-testid="card-error-banner">
          <CardHeader>
            <CardTitle className="text-destructive flex items-center gap-2">
              <XCircle className="w-5 h-5" /> Pipeline Error
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-sm whitespace-pre-wrap" data-testid="text-error-message">{job.error}</p>
          </CardContent>
        </Card>
      )}

      {/* ── Results (only when success) ─────────────────────────────────────── */}
      {isSuccess && report && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            {/* ── Toolpath + Density ──────────────────────────────────────────── */}
            <Card className="md:col-span-3">
              <CardHeader className="pb-4">
                <CardTitle>Toolpath Visualization</CardTitle>
                <CardDescription>
                  Top-down view of partitioned toolpath segments.
                  <span className="inline-flex items-center gap-3 ml-2">
                    <span className="inline-block w-2 h-2 rounded-full bg-chart-1" /> Head 1
                    <span className="inline-block w-2 h-2 rounded-full bg-chart-2" /> Head 2
                    <span className="inline-block w-2 h-2 rounded-full bg-chart-3" /> Gap Fill
                    <span className="inline-block w-2 h-2 rounded-full bg-muted-foreground/50" /> Rapids
                  </span>
                </CardDescription>
              </CardHeader>
              <CardContent>
                {isVizLoading ? (
                  <div className="flex h-[400px] items-center justify-center">
                    <Loader2 className="w-8 h-8 animate-spin text-primary" />
                  </div>
                ) : vizData && svgProps ? (
                  <div className="border border-border/50 bg-muted/10 rounded-sm overflow-hidden flex items-center justify-center min-h-[400px] p-4 relative">
                    <svg
                      viewBox={svgProps.viewBox}
                      className="w-full h-full max-h-[600px]"
                      style={{ transform: "scaleY(-1)" }}
                    >
                      {/* Bounding box outline */}
                      <rect
                        x={svgProps.xMin}
                        y={svgProps.yMin}
                        width={svgProps.width}
                        height={svgProps.height}
                        fill="none"
                        stroke="rgba(255,255,255,0.05)"
                        strokeWidth={svgProps.width * 0.001}
                      />

                      {/* Gap zone highlight */}
                      {vizData.zones?.gap && (
                        <rect
                          x={vizData.zones.gap.xMin}
                          y={svgProps.yMin - (svgProps.height * 0.05)}
                          width={vizData.zones.gap.xMax - vizData.zones.gap.xMin}
                          height={svgProps.height * 1.1}
                          fill="rgba(34, 197, 94, 0.05)"
                          stroke={ZONE_COLORS.gap}
                          strokeWidth={svgProps.width * 0.002}
                          strokeDasharray={`${svgProps.width * 0.01},${svgProps.width * 0.01}`}
                        />
                      )}

                      {/* Toolpath segments */}
                      {vizData.segments.map((seg, i) => {
                        const color = seg.motionType === "rapid"
                          ? ZONE_COLORS.rapid
                          : ZONE_COLORS[seg.zone] || ZONE_COLORS.unassigned;
                        const strokeWidth = seg.motionType === "rapid"
                          ? svgProps.width * 0.001
                          : svgProps.width * 0.003;
                        const opacity = seg.motionType === "rapid" ? 0.3 : 0.9;
                        return (
                          <line
                            key={i}
                            x1={seg.x1} y1={seg.y1}
                            x2={seg.x2} y2={seg.y2}
                            stroke={color}
                            strokeWidth={strokeWidth}
                            strokeLinecap="round"
                            strokeOpacity={opacity}
                          />
                        );
                      })}
                    </svg>

                    {/* Legend */}
                    <div className="absolute top-4 right-4 bg-card/90 backdrop-blur border border-border rounded-sm p-3 font-mono text-xs shadow-lg">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2"><div className="w-3 h-3 bg-chart-1 rounded-sm" /> Head 1</div>
                        <div className="flex items-center gap-2"><div className="w-3 h-3 bg-chart-2 rounded-sm" /> Head 2</div>
                        <div className="flex items-center gap-2"><div className="w-3 h-3 bg-chart-3 rounded-sm" /> Gap Fill</div>
                        <div className="flex items-center gap-2"><div className="w-3 h-3 bg-chart-4/50 rounded-sm" /> Rapids</div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex h-[400px] items-center justify-center border border-dashed border-border text-muted-foreground font-mono text-sm flex-col gap-2">
                    <AlertTriangle className="w-6 h-6 opacity-40" />
                    <span>Visualization data unavailable</span>
                  </div>
                )}

                {/* Density map */}
                {vizData?.densityMap && vizData.densityMap.length > 0 && (
                  <div className="mt-8 h-48">
                    <h4 className="font-mono text-sm text-muted-foreground mb-4">Density Distribution D(x)</h4>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={vizData.densityMap} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
                        <XAxis dataKey="x" type="number" domain={["dataMin", "dataMax"]} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" />
                        <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" />
                        <Tooltip
                          contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "2px", fontFamily: "var(--font-mono)" }}
                          labelFormatter={(v) => `X: ${Number(v).toFixed(2)} mm`}
                        />
                        {vizData.zones?.gap && (
                          <ReferenceArea x1={vizData.zones.gap.xMin} x2={vizData.zones.gap.xMax} fill="hsl(var(--chart-3))" fillOpacity={0.1} />
                        )}
                        <Area type="monotone" dataKey="density" stroke="hsl(var(--primary))" fill="hsl(var(--primary))" fillOpacity={0.2} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ── Side panel ──────────────────────────────────────────────────── */}
            <div className="space-y-6">
              {/* Schedule */}
              <Card>
                <CardHeader>
                  <CardTitle>Schedule</CardTitle>
                  <CardDescription>Estimated timing</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 font-mono text-sm">
                  <div className="flex justify-between items-center py-2 border-b border-border/50">
                    <span className="text-muted-foreground">Serial Time</span>
                    <span>{report.schedule?.estimated_serial_time_s?.toFixed(1)}s</span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-border/50">
                    <span className="text-muted-foreground">Phase 1 (Parallel)</span>
                    <span>{report.schedule?.estimated_phase1_time_s?.toFixed(1)}s</span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-border/50">
                    <span className="text-muted-foreground">Phase 2 (Gap Fill)</span>
                    <span>{report.schedule?.estimated_phase2_time_s?.toFixed(1)}s</span>
                  </div>
                  <div className="flex justify-between items-center py-2 bg-primary/10 -mx-6 px-6 border-b border-primary/20">
                    <span className="font-bold text-primary">Total Time</span>
                    <span className="font-bold text-primary">{report.schedule?.estimated_total_time_s?.toFixed(1)}s</span>
                  </div>
                  <div className="flex justify-between items-center pt-2">
                    <span className="text-muted-foreground">Speedup Factor</span>
                    <Badge variant="secondary" className="text-lg bg-accent text-accent-foreground">{report.schedule?.speedup_factor?.toFixed(2)}x</Badge>
                  </div>
                </CardContent>
              </Card>

              {/* Partition stats */}
              <Card>
                <CardHeader>
                  <CardTitle>Partition Stats</CardTitle>
                  <CardDescription>Load balancing &amp; gap</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 font-mono text-sm">
                  {/* Gap width — prominently shown so there's no ambiguity */}
                  <div className="bg-chart-3/10 border border-chart-3/20 rounded-sm px-3 py-2 -mx-1">
                    <div className="flex justify-between items-center">
                      <span className="text-chart-3 font-bold">Y Gap Width</span>
                      <span className="text-chart-3 font-bold">
                        {partition?.gap_width_nominal?.toFixed(1)} mm
                      </span>
                    </div>
                    <div className="flex justify-between items-center mt-1 text-xs text-muted-foreground">
                      <span>Zone Y</span>
                      <span>
                        {(partition?.gap_y_min ?? partition?.gap_x_min)?.toFixed(1)} → {(partition?.gap_y_max ?? partition?.gap_x_max)?.toFixed(1)} mm
                      </span>
                    </div>
                    <div className="flex justify-between items-center mt-0.5 text-xs text-muted-foreground">
                      <span>Center</span>
                      <span>{partition?.gap_center?.toFixed(1)} mm Y</span>
                    </div>
                  </div>

                  <div className="flex justify-between items-center border-b border-border/30 pb-2">
                    <div className="flex items-center gap-2"><div className="w-2 h-2 bg-chart-1 rounded-full" /> Head 1</div>
                    <span>{partition?.head1_segment_count} seg</span>
                  </div>
                  <div className="flex justify-between items-center border-b border-border/30 pb-2">
                    <div className="flex items-center gap-2"><div className="w-2 h-2 bg-chart-2 rounded-full" /> Head 2</div>
                    <span>{partition?.head2_segment_count} seg</span>
                  </div>
                  <div className="flex justify-between items-center border-b border-border/30 pb-2">
                    <div className="flex items-center gap-2"><div className="w-2 h-2 bg-chart-3 rounded-full" /> Gap Fill</div>
                    <span>{partition?.gap_segment_count} seg</span>
                  </div>

                  <div className="pt-2">
                    <div className="flex justify-between items-center text-muted-foreground mb-1">
                      <span>Balance Score</span>
                      <span>{(partition?.balance_score * 100)?.toFixed(1)}%</span>
                    </div>
                    <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden flex">
                      <div
                        className="bg-chart-1 h-full"
                        style={{ width: `${(partition?.head1_effort / (partition?.head1_effort + partition?.head2_effort)) * 100}%` }}
                      />
                      <div
                        className="bg-chart-2 h-full"
                        style={{ width: `${(partition?.head2_effort / (partition?.head1_effort + partition?.head2_effort)) * 100}%` }}
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Validation */}
              {validation && (
                <Card className={validation.approved ? "" : "border-destructive"}>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      Validation
                      {validation.approved ? (
                        <CheckCircle2 className="w-4 h-4 text-chart-3 ml-auto" />
                      ) : (
                        <XCircle className="w-4 h-4 text-destructive ml-auto" />
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 font-mono text-xs">
                    {Object.entries(validation.steps || {}).map(([step, result]: [string, any]) => (
                      <div key={step} className="flex justify-between items-center border-b border-border/30 pb-2 last:border-0">
                        <span className="text-muted-foreground capitalize">{step.replace(/_/g, " ")}</span>
                        <span className={result === "PASS" || result === "APPROVED" ? "text-chart-3" : "text-destructive"}>
                          {result}
                        </span>
                      </div>
                    ))}
                    {validation.messages && validation.messages.length > 0 && (
                      <div className="pt-2">
                        {validation.messages.map((msg: string, i: number) => (
                          <p key={i} className="text-destructive mt-1 flex items-start gap-1">
                            <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                            <span>{msg}</span>
                          </p>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          </div>

          {/* ── Generated G-code panels ──────────────────────────────────────── */}
          <div>
            <h2 className="text-xl font-mono font-bold text-foreground mb-4">Generated G-code</h2>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <GcodePanel
                label="Head 1"
                fileKey="head1"
                jobId={job.id}
                color={ZONE_COLORS.head1}
                downloadFilename="head1.gcode"
                enabled={isSuccess}
              />
              <GcodePanel
                label="Head 2"
                fileKey="head2"
                jobId={job.id}
                color={ZONE_COLORS.head2}
                downloadFilename="head2.gcode"
                enabled={isSuccess}
              />
              <GcodePanel
                label="Gap Fill"
                fileKey="gapfill"
                jobId={job.id}
                color={ZONE_COLORS.gap}
                downloadFilename="gapfill.gcode"
                enabled={isSuccess}
              />
            </div>
          </div>

          {/* ── Axis Inversion ───────────────────────────────────────────────── */}
          <AxisInversionPanel jobId={job.id} />
        </>
      )}
    </div>
  );
}
