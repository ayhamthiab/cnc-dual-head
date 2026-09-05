import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link } from "wouter";
import { useGetJob, getGetJobQueryKey, downloadFile } from "@workspace/api-client-react";
import {
  AlertTriangle, CheckCircle2, Loader2, Play, Pause, Square, Power, ArrowLeft, Terminal, Unlock
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

const DEFAULT_AGENT_URL = "http://127.0.0.1:18888/api/v1";
const URL_STORAGE_KEY = "dmhc.machine.agentUrl";
const TOKEN_STORAGE_KEY = "dmhc.machine.agentToken";
const BAUD_RATES = ["115200", "250000", "57600", "38400"];

type AutomationStatus = "IDLE" | "RUNNING" | "PAUSED" | "ABORTING" | "COMPLETED" | "FAILED" | "CANCELED";
type AgentStatus = "checking" | "online" | "offline";
type LogEntry = { time: string; message: string; level?: string; event?: string };

type AutomationSnapshot = {
  runId?: string;
  jobId?: string;
  filename?: string;
  status?: AutomationStatus;
  stage?: string;
  message?: string;
  error?: string;
  paused?: boolean;
  startedAt?: string;
  completedAt?: string;
  head1?: any;
  head2?: any;
  log?: Array<{ timestamp: string; stage: string; level: string; message: string }>;
};

class AgentRequestError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = "AgentRequestError";
  }
}

function normalizeUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function agentUrlError(value: string) {
  const normalized = normalizeUrl(value);
  if (!normalized) return "Enter a local Agent API URL.";
  try {
    const url = new URL(normalized);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(hostname)) {
      return "Agent API must use http on 127.0.0.1, localhost, or [::1].";
    }
    if (url.pathname !== "/api/v1" || url.search || url.hash) {
      return "Agent API URL must end exactly with /api/v1.";
    }
  } catch {
    return "Enter a valid local Agent API URL ending in /api/v1.";
  }
  return null;
}

function formatAxis(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 100_000) return value.toExponential(3);
  if (Math.abs(value) >= 10_000) return value.toFixed(1);
  return value.toFixed(3);
}

export default function AutomatedDrawing() {
  const params = useParams();
  const jobId = params.id as string;

  const { data: job, isLoading: isJobLoading, error: jobError } = useGetJob(jobId, {
    query: {
      enabled: !!jobId,
      queryKey: getGetJobQueryKey(jobId),
    }
  });

  const [agentUrl, setAgentUrl] = useState(DEFAULT_AGENT_URL);
  const [token, setToken] = useState("");
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("checking");
  const [agentAuthorized, setAgentAuthorized] = useState(false);
  const [ports, setPorts] = useState<string[]>([]);
  
  const FIXED_HEAD1_PORT = "COM9";
  const FIXED_HEAD2_PORT = "COM6";

  const [head1Port, setHead1Port] = useState(FIXED_HEAD1_PORT);
  const [head2Port, setHead2Port] = useState(FIXED_HEAD2_PORT);
  const [baudRate, setBaudRate] = useState("115200");
  const [head1OffsetX, setHead1OffsetX] = useState("-41");
  const [head1OffsetZ, setHead1OffsetZ] = useState("-196");
  const [head2OffsetX, setHead2OffsetX] = useState("-60");
  const [head2OffsetZ, setHead2OffsetZ] = useState("-201");

  const [gcodeHead1, setGcodeHead1] = useState<string | null>(null);
  const [gcodeHead2, setGcodeHead2] = useState<string | null>(null);
  const [gcodeGapfill, setGcodeGapfill] = useState<string | null>(null);
  const [gcodeLoading, setGcodeLoading] = useState(false);
  const [gcodeError, setGcodeError] = useState<string | null>(null);

  const [automationSnapshot, setAutomationSnapshot] = useState<AutomationSnapshot | null>(null);
  const [events, setEvents] = useState<LogEntry[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [abortConfirmOpen, setAbortConfirmOpen] = useState(false);
  const [manualUnlockHead, setManualUnlockHead] = useState<1 | 2 | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const eventSource = useRef<EventSource | null>(null);

  useEffect(() => {
    setAgentUrl(localStorage.getItem(URL_STORAGE_KEY) || DEFAULT_AGENT_URL);
    setToken(localStorage.getItem(TOKEN_STORAGE_KEY) || "");
  }, []);

  const request = useCallback(async (path: string, init?: RequestInit) => {
    const baseUrl = normalizeUrl(agentUrl);
    const validationError = agentUrlError(baseUrl);
    if (validationError) throw new AgentRequestError(validationError);
    const headers = new Headers(init?.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    const contentType = response.headers.get("content-type") ?? "";
    const data = contentType.includes("application/json") ? await response.json() : null;
    if (!response.ok) {
      const detail = typeof data?.error === "string" && data.error.trim() ? data.error.trim() : `Agent returned HTTP ${response.status}`;
      throw new AgentRequestError(detail, response.status);
    }
    return data;
  }, [agentUrl, token]);

  const appendEvent = useCallback((message: string, level = "info", event?: string) => {
    const entry = { time: new Date().toLocaleTimeString(), message, level, event };
    setEvents((current) => [entry, ...current].slice(0, 200));
  }, []);

  const fetchPorts = useCallback(async () => {
    try {
      const data = await request("/serial-ports");
      const rawPorts = Array.isArray(data) ? data : data?.ports;
      if (Array.isArray(rawPorts)) {
        const details = rawPorts.map((port: any) => {
          if (typeof port === "string") return port.trim();
          if (typeof port === "object" && port) return String(port.path ?? port.address ?? port.name ?? "").trim();
          return "";
        }).filter(Boolean);
        setPorts(details);
        setAgentAuthorized(true);
      }
    } catch (err) {
      setAgentAuthorized(false);
      console.error("Port fetch failed", err);
    }
  }, [request]);

  useEffect(() => {
    if (!ports.length) return;
    setHead1Port((current) => (ports.includes(current) ? current : FIXED_HEAD1_PORT));
    setHead2Port((current) => (ports.includes(current) ? current : FIXED_HEAD2_PORT));
  }, [ports]);

  const checkAgent = useCallback(async () => {
    if (!agentUrl) return;
    setAgentStatus("checking");
    try {
      await request("/health");
      setAgentStatus("online");
      await fetchPorts();
    } catch (error) {
      setAgentStatus("offline");
      setAgentAuthorized(false);
    }
  }, [agentUrl, request, fetchPorts]);

  useEffect(() => {
    void checkAgent();
  }, [checkAgent]);

  const fetchAutomationStatus = useCallback(async () => {
    if (agentStatus !== "online") return;
    try {
      const data = await request("/automation/status");
      if (data && data.status && data.status !== "IDLE") {
        setAutomationSnapshot(data);
      }
    } catch (err) {
      console.error("Automation status fetch failed", err);
    }
  }, [agentStatus, request]);

  useEffect(() => {
    void fetchAutomationStatus();
    const interval = setInterval(fetchAutomationStatus, 2000);
    return () => clearInterval(interval);
  }, [fetchAutomationStatus]);

  useEffect(() => {
    if (agentStatus !== "online" || !agentUrl) return;
    
    const url = new URL(`${normalizeUrl(agentUrl)}/events`);
    if (token) url.searchParams.set("token", token);
    const source = new EventSource(url.toString());
    eventSource.current = source;
    
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const envelope = data.data && typeof data.data === "object" ? data.data : data;
        
        if (data.event === "automation.status" || envelope.status) {
          setAutomationSnapshot(prev => ({ ...prev, ...envelope }));
        }
        
        if (data.message) {
          appendEvent(data.message, data.level, data.event);
        }
      } catch {}
    };
    
    return () => source.close();
  }, [agentStatus, agentUrl, token, appendEvent]);

  // Load G-codes
  useEffect(() => {
    if (!jobId || job?.status !== "success") return;
    let active = true;
    setGcodeLoading(true);
    setGcodeError(null);
    
    Promise.all([
      downloadFile(jobId, "head1"),
      downloadFile(jobId, "head2"),
      downloadFile(jobId, "gapfill"),
    ]).then(([h1, h2, gf]) => {
      if (active) {
        setGcodeHead1(h1);
        setGcodeHead2(h2);
        setGcodeGapfill(gf);
        setGcodeLoading(false);
      }
    }).catch(err => {
      if (active) {
        setGcodeError(String(err));
        setGcodeLoading(false);
      }
    });
    
    return () => { active = false; };
  }, [jobId, job?.status]);

  const handleStart = async () => {
    setActionBusy(true);
    try {
      await request("/automation/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirm: true,
          jobId: job?.id,
          filename: job?.filename,
          head1Port,
          head2Port,
          baudRate: Number(baudRate),
          head1Gcode: gcodeHead1,
          head2Gcode: gcodeHead2,
          gapFillGcode: gcodeGapfill,
          head1OffsetX: Number(head1OffsetX),
          head1OffsetZ: Number(head1OffsetZ),
          head2OffsetX: Number(head2OffsetX),
          head2OffsetZ: Number(head2OffsetZ)
        }),
      });
      appendEvent("Automation run started", "info");
      setConfirmOpen(false);
      await fetchAutomationStatus();
    } catch (err: any) {
      appendEvent(err.message || "Failed to start automation", "error");
    } finally {
      setActionBusy(false);
    }
  };

  const handlePauseResume = async (action: "pause" | "resume") => {
    setActionBusy(true);
    try {
      await request(`/automation/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      appendEvent(`Automation ${action} requested`, "info");
      await fetchAutomationStatus();
    } catch (err: any) {
      appendEvent(err.message || `Failed to ${action} automation`, "error");
    } finally {
      setActionBusy(false);
    }
  };

  const handleAbort = async () => {
    setActionBusy(true);
    try {
      await request(`/automation/abort`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      appendEvent("Automation abort requested", "warning");
      setAbortConfirmOpen(false);
      await fetchAutomationStatus();
    } catch (err: any) {
      appendEvent(err.message || "Failed to abort automation", "error");
    } finally {
      setActionBusy(false);
    }
  };

  const handleManualUnlock = async () => {
    if (manualUnlockHead === null) return;
    const head = manualUnlockHead;
    setActionBusy(true);
    try {
      await request(`/controllers/head-${head}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      appendEvent(`Manual unlock ($X) sent to Head ${head}`, "warning");
      setManualUnlockHead(null);
      await fetchAutomationStatus();
    } catch (err: any) {
      appendEvent(err.message || `Failed to unlock Head ${head}`, "error");
    } finally {
      setActionBusy(false);
    }
  };

  const isReady = Boolean(
    agentStatus === "online" && 
    agentAuthorized &&
    job?.status === "success" && 
    !gcodeLoading && 
    !gcodeError && 
    gcodeHead1 && gcodeHead2 && gcodeGapfill &&
    head1Port === FIXED_HEAD1_PORT &&
    head2Port === FIXED_HEAD2_PORT &&
    ports.includes(FIXED_HEAD1_PORT) &&
    ports.includes(FIXED_HEAD2_PORT) &&
    [head1OffsetX, head1OffsetZ, head2OffsetX, head2OffsetZ].every(value => value.trim() !== "" && Number.isFinite(Number(value))) &&
    (!automationSnapshot || automationSnapshot.status === "IDLE" || automationSnapshot.status === "COMPLETED" || automationSnapshot.status === "FAILED" || automationSnapshot.status === "CANCELED")
  );

  const runActive = Boolean(automationSnapshot && 
    (automationSnapshot.status === "RUNNING" || automationSnapshot.status === "PAUSED" || automationSnapshot.status === "ABORTING"));

  const isOwnJob = automationSnapshot?.jobId === jobId;
  const timelineEvents: LogEntry[] = automationSnapshot?.log?.length
    ? automationSnapshot.log.map((entry) => ({
        time: new Date(entry.timestamp).toLocaleTimeString(),
        message: `[${entry.stage}] ${entry.message}`,
        level: entry.level,
        event: "automation.status",
      })).reverse()
    : events;

  if (isJobLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center p-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (jobError || !job) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <div className="bg-destructive/10 border border-destructive/30 p-6 rounded-sm text-destructive flex items-start gap-4">
          <AlertTriangle className="w-6 h-6 mt-1" />
          <div>
            <h2 className="text-lg font-bold font-mono">Failed to load job</h2>
            <Link href="/automated-drawing" className={cn(buttonVariants({ variant: "outline" }), "mt-4 border-destructive/50 text-destructive hover:bg-destructive/20")}>
              <ArrowLeft className="w-4 h-4 mr-2" />
              Return
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 sm:space-y-8 sm:p-6 lg:p-8">
      {/* Header */}
      <div className="flex items-center gap-4 border-b border-border pb-6">
        <Link href="/automated-drawing" data-testid="link-back" className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "hover:bg-accent hover:text-accent-foreground shrink-0")}>
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-mono tracking-tight font-bold text-foreground flex items-center gap-3">
              <span data-testid="text-job-filename">{job.filename}</span>
              <Badge variant="outline" className="font-mono bg-primary/10 text-primary border-primary/30">AUTOMATED RUN</Badge>
            </h1>
          </div>
          <p className="text-muted-foreground font-mono text-sm mt-1" data-testid="text-job-id">Job ID: {job.id}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Setup / Status */}
        <div className="lg:col-span-4 space-y-6">
          {automationSnapshot && isOwnJob && !runActive && automationSnapshot.status !== "IDLE" && (
            <Card className={cn(
              "border-2",
              automationSnapshot.status === "COMPLETED"
                ? "border-chart-3/50"
                : "border-destructive/50"
            )} data-testid="status-terminal-run">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 font-mono">
                  {automationSnapshot.status === "COMPLETED"
                    ? <CheckCircle2 className="h-5 w-5 text-chart-3" />
                    : <AlertTriangle className="h-5 w-5 text-destructive" />}
                  Run {automationSnapshot.status}
                </CardTitle>
                <CardDescription>{automationSnapshot.message}</CardDescription>
              </CardHeader>
              {automationSnapshot.error && (
                <CardContent>
                  <p className="rounded-sm border border-destructive/30 bg-destructive/10 p-3 font-mono text-xs text-destructive" data-testid="text-terminal-error">
                    {automationSnapshot.error}
                  </p>
                </CardContent>
              )}
            </Card>
          )}
          {!runActive && agentAuthorized && (
            <Card className="border-amber-500/40">
              <CardHeader className="bg-amber-500/5 pb-4">
                <CardTitle className="flex items-center gap-2 font-mono text-amber-500">
                  <Unlock className="h-5 w-5" /> Manual Unlock
                </CardTitle>
                <CardDescription>
                  Sends the explicit GRBL <span className="font-mono">$X</span> unlock command to one head.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-2 pt-4 sm:grid-cols-2">
                {[1, 2].map((head) => (
                  <Button
                    key={head}
                    variant="outline"
                    disabled={actionBusy}
                    onClick={() => setManualUnlockHead(head as 1 | 2)}
                    className="justify-start border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-500"
                    data-testid={`btn-manual-unlock-head-${head}`}
                  >
                    <Unlock className="mr-2 h-4 w-4" />
                    Unlock Head {head}
                  </Button>
                ))}
              </CardContent>
            </Card>
          )}
          {runActive && isOwnJob ? (
            <Card className="border-primary/50 shadow-sm border-2">
              <CardHeader className="bg-primary/5 pb-4">
                <CardTitle className="flex items-center gap-2">
                  <Play className="w-5 h-5 text-primary" /> Active Run
                </CardTitle>
                <CardDescription>
                  Status: <Badge variant="secondary" className="font-mono ml-2 animate-pulse">{automationSnapshot.status}</Badge>
                  {automationSnapshot.paused && <Badge variant="outline" className="font-mono ml-2 border-amber-500/50 text-amber-500">PAUSED</Badge>}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-6 space-y-4 font-mono text-sm">
                <div>
                  <p className="text-muted-foreground mb-1">Current Stage</p>
                  <p className="font-bold text-lg bg-muted/50 p-2 rounded-sm border border-border/50">
                    {automationSnapshot.stage || "INITIALIZING"}
                  </p>
                </div>
                
                {automationSnapshot.message && (
                  <div>
                    <p className="text-muted-foreground mb-1">Message</p>
                    <p className="text-foreground">{automationSnapshot.message}</p>
                  </div>
                )}
                
                {automationSnapshot.error && (
                  <div className="bg-destructive/10 text-destructive p-3 rounded-sm border border-destructive/20 mt-4">
                    <p className="font-bold flex items-center gap-2 mb-1"><AlertTriangle className="w-4 h-4"/> Error</p>
                    <p className="text-xs">{automationSnapshot.error}</p>
                  </div>
                )}

                <div className="flex flex-col gap-2 pt-4 mt-2 border-t border-border/50">
                  {automationSnapshot.status === "RUNNING" && automationSnapshot.stage?.startsWith("STREAMING") && (
                    <Button variant="outline" onClick={() => handlePauseResume("pause")} disabled={actionBusy} className="w-full justify-start" data-testid="btn-pause">
                      {actionBusy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Pause className="w-4 h-4 mr-2" />}
                      Pause Execution
                    </Button>
                  )}
                  {automationSnapshot.status === "PAUSED" && (
                    <Button variant="default" onClick={() => handlePauseResume("resume")} disabled={actionBusy} className="w-full justify-start" data-testid="btn-resume">
                      {actionBusy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                      Resume Execution
                    </Button>
                  )}
                  <Button variant="destructive" onClick={() => setAbortConfirmOpen(true)} disabled={actionBusy || automationSnapshot.status === "ABORTING"} className="w-full justify-start" data-testid="btn-abort">
                    <Square className="w-4 h-4 mr-2" />
                    Abort Run
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : runActive && !isOwnJob ? (
            <Card className="border-amber-500/50">
              <CardHeader className="bg-amber-500/10">
                <CardTitle className="text-amber-500 flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5" /> Agent Busy
                </CardTitle>
                <CardDescription className="text-amber-500/80">
                  The machine agent is currently operating another job.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-4 font-mono text-sm">
                <p>Active Job ID: <span className="text-foreground">{automationSnapshot?.jobId}</span></p>
                <p>Status: <span className="text-foreground">{automationSnapshot?.status}</span></p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Preparation</CardTitle>
                <CardDescription>Configure machine connection for automated run.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="flex items-center justify-between p-3 rounded-sm border border-border/50 bg-muted/20">
                  <span className="font-mono text-sm">Agent Link</span>
                  {agentStatus === "checking" ? <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /> :
                   agentStatus === "online" ? <CheckCircle2 className="w-4 h-4 text-chart-3" /> :
                   <AlertTriangle className="w-4 h-4 text-destructive" />}
                </div>
                {!agentAuthorized && agentStatus === "online" && (
                  <div className="rounded-sm border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
                    <p className="font-mono">The Agent is reachable, but its token or serial-port discovery is not ready.</p>
                    <Link href="/machine" className="mt-2 inline-block font-mono underline underline-offset-4" data-testid="link-configure-agent">
                      Configure the local Agent
                    </Link>
                  </div>
                )}

                <div className="flex items-center justify-between p-3 rounded-sm border border-border/50 bg-muted/20">
                  <span className="font-mono text-sm">G-Code Payload</span>
                  {gcodeLoading ? <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /> :
                   (gcodeHead1 && gcodeHead2 && gcodeGapfill) ? <CheckCircle2 className="w-4 h-4 text-chart-3" /> :
                   <AlertTriangle className="w-4 h-4 text-destructive" />}
                </div>

                <div className="space-y-4 pt-4 border-t border-border/50">
                  <div className="space-y-2">
                    <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Baud Rate</Label>
                    <Select value={baudRate} onValueChange={setBaudRate} disabled={runActive}>
                      <SelectTrigger className="font-mono" data-testid="select-baud-rate"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {BAUD_RATES.map((rate) => (
                          <SelectItem key={rate} value={rate} className="font-mono">{rate}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                        <div className="w-2 h-2 rounded-sm bg-chart-1" /> Head 1 Port
                      </Label>
                      {ports.length > 0 ? (
                        <Select value={head1Port} onValueChange={setHead1Port} disabled={runActive}>
                          <SelectTrigger className="font-mono text-xs" data-testid="select-head1-port"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {ports.map((port) => (
                              <SelectItem key={port} value={port} className="font-mono text-xs">{port}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input value={head1Port} onChange={e => setHead1Port(e.target.value)} className="font-mono text-xs" disabled={runActive} data-testid="input-head1-port" />
                      )}
                    </div>
                    
                    <div className="space-y-2">
                      <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                        <div className="w-2 h-2 rounded-sm bg-chart-2" /> Head 2 Port
                      </Label>
                      {ports.length > 0 ? (
                        <Select value={head2Port} onValueChange={setHead2Port} disabled={runActive}>
                          <SelectTrigger className="font-mono text-xs" data-testid="select-head2-port"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {ports.map((port) => (
                              <SelectItem key={port} value={port} className="font-mono text-xs">{port}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input value={head2Port} onChange={e => setHead2Port(e.target.value)} className="font-mono text-xs" disabled={runActive} data-testid="input-head2-port" />
                      )}
                    </div>
                  </div>
                  {head1Port === head2Port && head1Port !== "" && (
                    <p className="text-xs text-destructive font-mono flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" /> Ports must be distinct.
                    </p>
                  )}

                  <div className="space-y-3 pt-4 border-t border-border/50">
                    <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Setup offsets (mm)</Label>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label className="font-mono text-xs flex items-center gap-2"><div className="w-2 h-2 rounded-sm bg-chart-1" /> Head 1</Label>
                        <div className="grid grid-cols-2 gap-2">
                          <Input type="number" step="any" value={head1OffsetX} onChange={e => setHead1OffsetX(e.target.value)} disabled={runActive} aria-label="Head 1 X offset" data-testid="input-head1-offset-x" className="font-mono" placeholder="X" />
                          <Input type="number" step="any" value={head1OffsetZ} onChange={e => setHead1OffsetZ(e.target.value)} disabled={runActive} aria-label="Head 1 Z offset" data-testid="input-head1-offset-z" className="font-mono" placeholder="Z" />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label className="font-mono text-xs flex items-center gap-2"><div className="w-2 h-2 rounded-sm bg-chart-2" /> Head 2</Label>
                        <div className="grid grid-cols-2 gap-2">
                          <Input type="number" step="any" value={head2OffsetX} onChange={e => setHead2OffsetX(e.target.value)} disabled={runActive} aria-label="Head 2 X offset" data-testid="input-head2-offset-x" className="font-mono" placeholder="X" />
                          <Input type="number" step="any" value={head2OffsetZ} onChange={e => setHead2OffsetZ(e.target.value)} disabled={runActive} aria-label="Head 2 Z offset" data-testid="input-head2-offset-z" className="font-mono" placeholder="Z" />
                        </div>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground font-mono">Enter any valid X and Z values. These movements run after homing and before work zero.</p>
                  </div>
                </div>

                <Button 
                  className="w-full mt-4 font-mono font-bold tracking-widest text-primary-foreground shadow-md disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
                  size="lg"
                  disabled={!isReady}
                  onClick={() => setConfirmOpen(true)}
                  data-testid="btn-prepare-draw"
                >
                  <Play className="w-5 h-5 mr-2" />
                  {isReady ? "INITIATE RUN" : "NOT READY"}
                </Button>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right Column: Telemetry & Logs */}
        <div className="lg:col-span-8 space-y-6 flex flex-col min-h-0">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 flex-shrink-0">
            {/* Head 1 Status */}
            <Card>
              <CardHeader className="py-3 px-4 border-b border-border/50 bg-muted/10">
                <CardTitle className="text-sm font-mono flex justify-between items-center">
                  <span className="flex items-center gap-2"><div className="w-2 h-2 rounded-sm bg-chart-1" /> Head 1</span>
                  {automationSnapshot?.head1?.connected ? <Badge variant="outline" className="text-chart-3 border-chart-3/50">ON</Badge> : <Badge variant="outline" className="text-muted-foreground">OFF</Badge>}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 font-mono text-xs space-y-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">State</span>
                  <span className="font-bold">{automationSnapshot?.head1?.state || "Unknown"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">WPos</span>
                  <span>X:{formatAxis(automationSnapshot?.head1?.workPosition?.x)} Y:{formatAxis(automationSnapshot?.head1?.workPosition?.y)} Z:{formatAxis(automationSnapshot?.head1?.workPosition?.z)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">MPos</span>
                  <span>X:{formatAxis(automationSnapshot?.head1?.machinePosition?.x)} Y:{formatAxis(automationSnapshot?.head1?.machinePosition?.y)} Z:{formatAxis(automationSnapshot?.head1?.machinePosition?.z)}</span>
                </div>
                <div className="flex justify-between border-t border-border/50 pt-2 mt-2">
                  <span className="text-muted-foreground">Progress</span>
                  <span>{automationSnapshot?.head1?.rowsCompleted || 0} / {(automationSnapshot?.head1?.rowsCompleted || 0) + (automationSnapshot?.head1?.rowsRemaining || 0)}</span>
                </div>
              </CardContent>
            </Card>

            {/* Head 2 Status */}
            <Card>
              <CardHeader className="py-3 px-4 border-b border-border/50 bg-muted/10">
                <CardTitle className="text-sm font-mono flex justify-between items-center">
                  <span className="flex items-center gap-2"><div className="w-2 h-2 rounded-sm bg-chart-2" /> Head 2</span>
                  {automationSnapshot?.head2?.connected ? <Badge variant="outline" className="text-chart-3 border-chart-3/50">ON</Badge> : <Badge variant="outline" className="text-muted-foreground">OFF</Badge>}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 font-mono text-xs space-y-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">State</span>
                  <span className="font-bold">{automationSnapshot?.head2?.state || "Unknown"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">WPos</span>
                  <span>X:{formatAxis(automationSnapshot?.head2?.workPosition?.x)} Y:{formatAxis(automationSnapshot?.head2?.workPosition?.y)} Z:{formatAxis(automationSnapshot?.head2?.workPosition?.z)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">MPos</span>
                  <span>X:{formatAxis(automationSnapshot?.head2?.machinePosition?.x)} Y:{formatAxis(automationSnapshot?.head2?.machinePosition?.y)} Z:{formatAxis(automationSnapshot?.head2?.machinePosition?.z)}</span>
                </div>
                <div className="flex justify-between border-t border-border/50 pt-2 mt-2">
                  <span className="text-muted-foreground">Progress</span>
                  <span>{automationSnapshot?.head2?.rowsCompleted || 0} / {(automationSnapshot?.head2?.rowsCompleted || 0) + (automationSnapshot?.head2?.rowsRemaining || 0)}</span>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="font-mono text-sm">Generated File Review</CardTitle>
              <CardDescription>Inspect all three payloads before enabling physical motion.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-3">
              {([
                ["Head 1", gcodeHead1, "head1"],
                ["Head 2", gcodeHead2, "head2"],
                ["Gap Fill · Head 1", gcodeGapfill, "gapfill"],
              ] as const).map(([label, content, key]) => (
                <details key={key} className="rounded-sm border border-border bg-muted/10" data-testid={`review-${key}`}>
                  <summary className="cursor-pointer px-3 py-2 font-mono text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {label}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {content ? `${content.split(/\r?\n/).length} lines` : "not loaded"}
                    </span>
                  </summary>
                  <pre className="max-h-64 overflow-auto border-t border-border bg-background p-3 text-[11px] leading-relaxed">
                    {content || "No generated content available."}
                  </pre>
                </details>
              ))}
            </CardContent>
          </Card>

          {/* Event Timeline */}
          <Card className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <CardHeader className="py-3 border-b border-border/50 flex-shrink-0 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-mono flex items-center gap-2">
                <Terminal className="w-4 h-4 text-muted-foreground" /> Automation Timeline
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 flex-1 overflow-y-auto bg-black text-white/90">
              <div className="font-mono text-xs leading-relaxed p-4 space-y-1">
                {timelineEvents.length === 0 ? (
                  <p className="text-white/30 italic">Waiting for events...</p>
                ) : (
                  timelineEvents.map((evt, idx) => (
                    <div key={idx} className="flex gap-3 hover:bg-white/5 px-1 py-0.5 rounded-sm transition-colors">
                      <span className="text-white/40 shrink-0 w-20">{evt.time}</span>
                      <span className={cn(
                        "break-words flex-1",
                        evt.level === "error" ? "text-red-400 font-bold" :
                        evt.level === "warning" ? "text-amber-400" :
                        evt.level === "success" ? "text-green-400 font-bold" : ""
                      )}>
                        {evt.message}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Confirmation Dialog for Start */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="max-w-2xl border-primary/20">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono text-xl flex items-center gap-2 text-primary">
              <AlertTriangle className="w-5 h-5" /> Confirm Automated Run Sequence
            </AlertDialogTitle>
            <AlertDialogDescription className="text-foreground">
              You are about to initiate an automated, multi-head physical drawing sequence.
              <br/><br/>
              <strong>Connections:</strong>
              <ul className="list-disc ml-5 mt-1 text-sm font-mono text-muted-foreground">
                <li>Head 1: {head1Port} @ {baudRate}</li>
                <li>Head 2: {head2Port} @ {baudRate}</li>
              </ul>
              <br/>
              <strong>Exact Execution Sequence:</strong>
              <ol className="list-decimal ml-5 mt-1 text-sm font-mono text-muted-foreground space-y-1">
                <li>Connect to controllers on {head1Port} and {head2Port}.</li>
                <li>Homing ($H) executed on both heads.</li>
                <li>Move Head 1 to X{head1OffsetX}, Z{head1OffsetZ} and Head 2 to X{head2OffsetX}, Z{head2OffsetZ} at 1000 mm/min.</li>
                <li>Set Work Coordinates to X0 Y0 Z0 with G10 L20 on both heads.</li>
                <li>Stream primary partitioned toolpaths concurrently.</li>
                <li>Homing ($H) executed on both heads.</li>
                <li>Stream Gap Fill exclusively on Head 1 from its current position.</li>
                <li>Final Homing ($H) executed on both heads.</li>
              </ol>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="bg-destructive/10 text-destructive p-4 border border-destructive/20 rounded-sm font-mono text-sm my-4 flex items-start gap-3">
            <AlertTriangle className="w-6 h-6 flex-shrink-0 mt-0.5" />
            <p>Ensure the machine bed is clear and hands are outside the envelope. Abort is available during streaming but immediate stops may lose position.</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel className="font-mono">Cancel</AlertDialogCancel>
            <Button onClick={handleStart} disabled={actionBusy} className="font-mono bg-primary text-primary-foreground hover:bg-primary/90">
              {actionBusy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
              CONFIRM & RUN
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirmation Dialog for Abort */}
      <AlertDialog open={abortConfirmOpen} onOpenChange={setAbortConfirmOpen}>
        <AlertDialogContent className="border-destructive/20">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono text-xl flex items-center gap-2 text-destructive">
              <Square className="w-5 h-5" /> Confirm Abort
            </AlertDialogTitle>
            <AlertDialogDescription className="text-foreground">
              Aborting a run cancels any active stream and sends a soft reset to both controllers. The machine position may be lost and the drawing will be incomplete.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="font-mono">Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={handleAbort} disabled={actionBusy} className="font-mono">
              {actionBusy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Power className="w-4 h-4 mr-2" />}
              ABORT IMMEDIATELY
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={manualUnlockHead !== null}
        onOpenChange={(open) => { if (!open && !actionBusy) setManualUnlockHead(null); }}
      >
        <AlertDialogContent className="border-amber-500/30">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono text-xl flex items-center gap-2 text-amber-500">
              <Unlock className="h-5 w-5" /> Confirm Manual Unlock
            </AlertDialogTitle>
            <AlertDialogDescription className="text-foreground">
              Send <span className="font-mono font-bold">$X</span> to Head {manualUnlockHead}.
              This only clears the GRBL alarm lock; it does not move the machine.
              Verify the machine area is safe before continuing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="font-mono" disabled={actionBusy}>Cancel</AlertDialogCancel>
            <Button onClick={handleManualUnlock} disabled={actionBusy} className="font-mono bg-amber-500 text-black hover:bg-amber-400">
              {actionBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Unlock className="mr-2 h-4 w-4" />}
              SEND $X
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
