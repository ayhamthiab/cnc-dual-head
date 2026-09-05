import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle, Cable, CircleDot, Cpu, Loader2, Plug,
  RefreshCw, ShieldAlert, Terminal, Wifi, WifiOff, Home, Move, Pause,
  Play, RotateCcw, Send, Square, Unlock, SlidersHorizontal, Crosshair,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import MachineSetupWizard, { defaultDraft, parseSettingsToDraft, type SetupDraft, type WizardHead, type WizardSnapshot } from "@/components/machine-setup-wizard";
import { cn } from "@/lib/utils";

const DEFAULT_AGENT_URL = "http://127.0.0.1:18888/api/v1";
const URL_STORAGE_KEY = "dmhc.machine.agentUrl";
const TOKEN_STORAGE_KEY = "dmhc.machine.agentToken";
const BAUD_RATES = ["115200", "250000", "57600", "38400"];

type AgentStatus = "checking" | "online" | "offline";
type PortDiscoveryStatus = "idle" | "checking" | "ready" | "unauthorized" | "error";
type TelemetryStatus = "idle" | "connecting" | "connected" | "reconnecting";
type Head = { id: 1 | 2; port: string; baud: string; connected: boolean; firmware?: string };
type SerialPortInfo = { path: string; description?: string | null; manufacturer?: string | null; inUseBy?: string | null };
type Position = { x?: number | null; y?: number | null; z?: number | null };
type MachineSnapshot = {
  connected?: boolean;
  connection?: string;
  state?: string;
  firmware?: string;
  alarm?: string | null;
  error?: string | null;
  machinePosition?: Position;
  workPosition?: Position;
  limitPins?: { x?: boolean; x0?: boolean; x1?: boolean; y?: boolean; y0?: boolean; y1?: boolean; z?: boolean; z0?: boolean; z1?: boolean } | null;
  feedRate?: number | null;
  rowsSent?: number;
  rowsCompleted?: number;
  rowsRemaining?: number;
  activeCommand?: string | null;
};
type LogEntry = { time: string; message: string; level?: string; event?: string };
type PendingAction = { headId: 1 | 2; label: string; detail: string; path: string; body?: Record<string, unknown>; onSuccess?: () => void };
type MachineProfile = {
  id: string;
  name: string;
  head1: { port: string; baudRate: number };
  head2: { port: string; baudRate: number };
  head1Setup?: SetupDraft;
  head2Setup?: SetupDraft;
};
type GrblSetting = { key: string; value: string | number; units?: string; description?: string; shortDescription?: string };
type WorkOffsetDraft = { x: string; y: string; z: string };
type OperatorState = { jogStep: string; jogFeedRate: string; consoleCommand: string; gcode: string; settingsSearch: string; settingValue: string };

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

function headIdFromEvent(controllerId: unknown, data: Record<string, unknown>): 1 | 2 | undefined {
  const candidate = String(controllerId ?? data.controllerId ?? data.head ?? data.id ?? "").trim().toLowerCase();
  if (candidate === "1" || candidate === "head1" || candidate === "head-1") return 1;
  if (candidate === "2" || candidate === "head2" || candidate === "head-2") return 2;
  return undefined;
}

export default function Machine() {
  const [agentUrl, setAgentUrl] = useState(DEFAULT_AGENT_URL);
  const [token, setToken] = useState("");
  const [apiStatus, setApiStatus] = useState<AgentStatus>("checking");
  const [apiStatusMessage, setApiStatusMessage] = useState("Checking application API…");
  const [status, setStatus] = useState<AgentStatus>("checking");
  const [statusMessage, setStatusMessage] = useState("Checking local agent…");
  const [connectionSettingsLoaded, setConnectionSettingsLoaded] = useState(false);
  const [ports, setPorts] = useState<string[]>([]);
  const [portDetails, setPortDetails] = useState<SerialPortInfo[]>([]);
  const [portDiscoveryStatus, setPortDiscoveryStatus] = useState<PortDiscoveryStatus>("idle");
  const [portDiscoveryError, setPortDiscoveryError] = useState<string | null>(null);
  const [telemetryStatus, setTelemetryStatus] = useState<TelemetryStatus>("idle");
  const [refreshingPorts, setRefreshingPorts] = useState(false);
  const [heads, setHeads] = useState<Head[]>([
    { id: 1, port: "", baud: "115200", connected: false },
    { id: 2, port: "", baud: "115200", connected: false },
  ]);
  const [headSnapshots, setHeadSnapshots] = useState<Partial<Record<1 | 2, MachineSnapshot>>>({});
  const [agentUrlErrorMessage, setAgentUrlErrorMessage] = useState<string | null>(null);
  const [events, setEvents] = useState<LogEntry[]>([]);
  const [consoleEvents, setConsoleEvents] = useState<Record<1 | 2, LogEntry[]>>({ 1: [], 2: [] });
  const [busyHead, setBusyHead] = useState<number | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [controlBusy, setControlBusy] = useState(false);
  const [operatorState, setOperatorState] = useState<Record<1 | 2, OperatorState>>({
    1: { jogStep: "1", jogFeedRate: "1000", consoleCommand: "", gcode: "", settingsSearch: "", settingValue: "" },
    2: { jogStep: "1", jogFeedRate: "1000", consoleCommand: "", gcode: "", settingsSearch: "", settingValue: "" },
  });
  const [profiles, setProfiles] = useState<MachineProfile[]>([]);
  const [profileName, setProfileName] = useState("");
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [settingsByHead, setSettingsByHead] = useState<Partial<Record<1 | 2, GrblSetting[]>>>({});
  const [settingsLoading, setSettingsLoading] = useState<Partial<Record<1 | 2, boolean>>>({});
  const [settingsError, setSettingsError] = useState<Partial<Record<1 | 2, string>>>({});
  const [setupDrafts, setSetupDrafts] = useState<Record<1 | 2, SetupDraft>>({ 1: defaultDraft(), 2: defaultDraft() });
  const [setupOriginals, setSetupOriginals] = useState<Record<1 | 2, SetupDraft>>({ 1: defaultDraft(), 2: defaultDraft() });
  const [setupInitialized, setSetupInitialized] = useState<Record<1 | 2, boolean>>({ 1: false, 2: false });
  const [profileSetupDrafts, setProfileSetupDrafts] = useState<Partial<Record<1 | 2, SetupDraft>>>({});
  const [editingSetting, setEditingSetting] = useState<Partial<Record<1 | 2, GrblSetting>>>({});
  const [workOffsetDrafts, setWorkOffsetDrafts] = useState<Record<1 | 2, WorkOffsetDraft>>({
    1: { x: "", y: "", z: "" }, 2: { x: "", y: "", z: "" },
  });
  const eventSource = useRef<EventSource | null>(null);
  const checkedStoredConnection = useRef(false);
  const headsRef = useRef(heads);
  headsRef.current = heads;
  const connectedHeadsKey = heads.map((head) => `${head.id}:${head.connected ? "connected" : "offline"}`).join("|");

  const request = useCallback(async (path: string, init?: RequestInit) => {
    const invalidUrl = agentUrlError(agentUrl);
    if (invalidUrl) {
      setAgentUrlErrorMessage(invalidUrl);
      throw new Error(invalidUrl);
    }
    const baseUrl = normalizeUrl(agentUrl);
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

  const appendEvent = useCallback((message: string, level = "info", headId?: 1 | 2, event?: string) => {
    const entry = { time: new Date().toLocaleTimeString(), message, level, event };
    setEvents((current) => [entry, ...current].slice(0, 200));
    if (headId && (event !== "controller.status" || level !== "info")) {
      setConsoleEvents((current) => ({
        ...current,
        [headId]: [...current[headId], entry].slice(-200),
      }));
    }
  }, []);

  const applySnapshot = useCallback((data: Record<string, unknown>) => {
    const reportedHeads = data.heads;
    if (Array.isArray(reportedHeads)) {
      setHeadSnapshots((current) => {
        const next = { ...current };
        reportedHeads.forEach((reported: any) => {
          const id = Number(reported?.head ?? reported?.controllerId ?? reported?.id);
          if (id === 1 || id === 2) next[id] = { ...next[id], ...reported };
        });
        return next;
      });
      setHeads((current) => current.map((head) => {
        const reported = reportedHeads.find((item: any) => Number(item?.head ?? item?.controllerId ?? item?.id) === head.id) as any;
        return reported
          ? { ...head, connected: Boolean(reported.connected), firmware: reported.firmware ?? head.firmware }
          : { ...head, connected: false };
      }));
    }
    const nestedStatus = data.status && typeof data.status === "object" ? data.status : undefined;
    const snapshot = (data.machine ?? nestedStatus ?? data) as Record<string, unknown>;
    const id = Number(snapshot.head ?? snapshot.controllerId ?? snapshot.id);
    if (id === 1 || id === 2) {
      setHeadSnapshots((current) => ({ ...current, [id]: { ...current[id], ...snapshot } }));
      if (typeof snapshot.connected === "boolean") {
        setHeads((current) => current.map((head) => head.id === id
          ? { ...head, connected: snapshot.connected as boolean, firmware: (snapshot.firmware as string | undefined) ?? head.firmware }
          : head));
      }
    }
  }, []);

  const refreshPorts = useCallback(async () => {
    if (status !== "online") return;
    setRefreshingPorts(true);
    setPortDiscoveryStatus("checking");
    setPortDiscoveryError(null);
    try {
      const data = await request("/serial-ports");
      const rawPorts = Array.isArray(data) ? data : data?.ports;
      if (!Array.isArray(rawPorts)) throw new AgentRequestError("Agent returned an invalid serial-port list");
      const details = rawPorts.map((port: unknown): SerialPortInfo | null => {
        if (typeof port === "string") return port.trim() ? { path: port.trim() } : null;
        if (!port || typeof port !== "object") return null;
        const item = port as Record<string, unknown>;
        const path = String(item.path ?? item.address ?? item.name ?? "").trim();
        if (!path) return null;
        return {
          path,
          description: typeof item.description === "string" ? item.description : null,
          manufacturer: typeof item.manufacturer === "string" ? item.manufacturer : null,
          inUseBy: typeof item.inUseBy === "string" ? item.inUseBy : null,
        };
      }).filter((port): port is SerialPortInfo => port !== null);
      setPortDetails(details);
      setPorts(details.map((port) => port.path));
      setPortDiscoveryStatus("ready");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to retrieve serial ports";
      setPorts([]);
      setPortDetails([]);
      setPortDiscoveryStatus(error instanceof AgentRequestError && error.statusCode === 401 ? "unauthorized" : "error");
      setPortDiscoveryError(message);
      appendEvent(`Port discovery failed: ${message}`, "error");
    } finally {
      setRefreshingPorts(false);
    }
  }, [appendEvent, request, status]);

  const loadProfiles = useCallback(async () => {
    if (status !== "online" || portDiscoveryStatus !== "ready") return;
    setProfilesLoading(true);
    setProfileError(null);
    try {
      const data = await request("/profiles");
      if (!Array.isArray(data?.profiles)) throw new Error("Agent returned an invalid profile list");
      setProfiles(data.profiles);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Unable to load profiles");
    } finally {
      setProfilesLoading(false);
    }
  }, [portDiscoveryStatus, request, status]);

  const checkAgent = useCallback(async () => {
    const invalidUrl = agentUrlError(agentUrl);
    if (invalidUrl) {
      setAgentUrlErrorMessage(invalidUrl);
      setStatus("offline");
      setStatusMessage(invalidUrl);
      setPortDiscoveryStatus("idle");
      setPortDiscoveryError(null);
      return;
    }
    setAgentUrlErrorMessage(null);
    setStatus("checking");
    setStatusMessage("Checking local agent…");
    try {
      const data = await request("/health");
      setStatus("online");
      setStatusMessage("Local Agent reachable; controller access still requires authenticated discovery");
      if (data && typeof data === "object") applySnapshot(data as Record<string, unknown>);
    } catch (error) {
      setStatus("offline");
      setStatusMessage(error instanceof Error ? error.message : "Unable to reach local agent");
      setPortDiscoveryStatus("idle");
      setPortDiscoveryError(null);
      setPorts([]);
      setPortDetails([]);
      setHeads((current) => current.map((head) => ({ ...head, connected: false })));
    }
  }, [applySnapshot, request]);

  useEffect(() => {
    let active = true;
    setApiStatus("checking");
    setApiStatusMessage("Checking application API…");
    void fetch("/api/healthz", { headers: { Accept: "application/json" } }).then(async (response) => {
      if (!response.ok) throw new Error(`Application API returned HTTP ${response.status}`);
      const data = await response.json();
      if (data?.status !== "ok") throw new Error("Application API returned an invalid health response");
      if (active) {
        setApiStatus("online");
        setApiStatusMessage("Application API reachable");
      }
    }).catch((error) => {
      if (active) {
        setApiStatus("offline");
        setApiStatusMessage(error instanceof Error ? error.message : "Application API unavailable");
      }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setAgentUrl(localStorage.getItem(URL_STORAGE_KEY) || DEFAULT_AGENT_URL);
    setToken(localStorage.getItem(TOKEN_STORAGE_KEY) || "");
    setConnectionSettingsLoaded(true);
  }, []);

  useEffect(() => {
    if (!connectionSettingsLoaded || checkedStoredConnection.current) return;
    checkedStoredConnection.current = true;
    void checkAgent();
  }, [checkAgent, connectionSettingsLoaded]);

  useEffect(() => {
    if (status === "online") void refreshPorts();
  }, [refreshPorts, status]);

  useEffect(() => {
    if (status !== "online" || portDiscoveryStatus !== "ready" || agentUrlError(agentUrl)) {
      eventSource.current?.close();
      eventSource.current = null;
      setTelemetryStatus("idle");
      return;
    }
    setTelemetryStatus("connecting");
    const url = new URL(`${normalizeUrl(agentUrl)}/events`);
    if (token) url.searchParams.set("token", token);
    const source = new EventSource(url.toString());
    eventSource.current = source;
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const envelope = data.data && typeof data.data === "object" ? data.data : data;
        const headId = headIdFromEvent(data.controllerId, envelope);
        setTelemetryStatus("connected");
        if (data.event === "agent.ready" || headId) applySnapshot(envelope);
        appendEvent(data.message ?? data.event ?? "Agent state update", data.level, headId, data.event);
      } catch {
        appendEvent(event.data);
      }
    };
    source.onerror = () => {
      setTelemetryStatus("reconnecting");
      appendEvent("Live event stream disconnected; reconnecting…", "warning");
    };
    return () => source.close();
  }, [agentUrl, appendEvent, applySnapshot, portDiscoveryStatus, status, token]);

  useEffect(() => {
    if (status !== "online" || portDiscoveryStatus !== "ready") return;
    let active = true;
    ([1, 2] as const).forEach((headId) => {
      void request(`/heads/${headId}/status`).then((data) => {
        if (!active || !data) return;
        const snapshot = (data.machine ?? data.status ?? data) as MachineSnapshot;
        applySnapshot({ ...snapshot, head: headId });
      }).catch((error) => {
        if (active) {
          setHeads((current) => current.map((head) => head.id === headId ? { ...head, connected: false } : head));
          appendEvent(error instanceof Error ? `Head ${headId} status unavailable: ${error.message}` : `Head ${headId} status unavailable`, "warning");
        }
      });
    });
    return () => { active = false; };
  }, [appendEvent, applySnapshot, portDiscoveryStatus, request, status]);

  const loadSettings = useCallback(async (headId: 1 | 2, refresh = false) => {
    const connected = headsRef.current.find((head) => head.id === headId)?.connected;
    if (status !== "online" || portDiscoveryStatus !== "ready" || !connected) {
      setSettingsLoading((current) => ({ ...current, [headId]: false }));
      setSettingsByHead((current) => ({ ...current, [headId]: [] }));
      setSettingsError((current) => ({ ...current, [headId]: undefined }));
      return;
    }
    setSettingsLoading((current) => ({ ...current, [headId]: true }));
    setSettingsError((current) => ({ ...current, [headId]: undefined }));
    try {
      const data = await request(`/heads/${headId}/settings${refresh ? "?refresh=true" : ""}`);
      if (!Array.isArray(data?.settings)) throw new Error("Agent returned invalid GRBL settings");
      setSettingsByHead((current) => ({ ...current, [headId]: data.settings }));
    } catch (error) {
      setSettingsError((current) => ({ ...current, [headId]: error instanceof Error ? error.message : "Unable to load GRBL settings" }));
    } finally {
      setSettingsLoading((current) => ({ ...current, [headId]: false }));
    }
  }, [portDiscoveryStatus, request, status]);

  useEffect(() => {
    ([1, 2] as const).forEach((headId) => { void loadSettings(headId); });
  }, [connectedHeadsKey, loadSettings]);

  useEffect(() => {
    ([1, 2] as const).forEach((headId) => {
      const settings = settingsByHead[headId];
      if (setupInitialized[headId] || !settings?.length) return;
      const baseline = parseSettingsToDraft(settings);
      setSetupDrafts((current) => ({ ...current, [headId]: profileSetupDrafts[headId] ?? baseline }));
      setSetupOriginals((current) => ({ ...current, [headId]: baseline }));
      setSetupInitialized((current) => ({ ...current, [headId]: true }));
      setProfileSetupDrafts((current) => ({ ...current, [headId]: undefined }));
    });
  }, [profileSetupDrafts, settingsByHead, setupInitialized]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const saveConnectionSettings = () => {
    const normalized = normalizeUrl(agentUrl);
    const invalidUrl = agentUrlError(normalized);
    if (invalidUrl) {
      setAgentUrlErrorMessage(invalidUrl);
      return;
    }
    setAgentUrl(normalized);
    setAgentUrlErrorMessage(null);
    localStorage.setItem(URL_STORAGE_KEY, normalized);
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
    void checkAgent();
  };

  const resetSetupForHead = (id: 1 | 2, keepProfileDraft = false) => {
    setSettingsByHead((current) => ({ ...current, [id]: [] }));
    setSettingsError((current) => ({ ...current, [id]: undefined }));
    setSettingsLoading((current) => ({ ...current, [id]: false }));
    setSetupInitialized((current) => ({ ...current, [id]: false }));
    setSetupOriginals((current) => ({ ...current, [id]: defaultDraft() }));
    setSetupDrafts((current) => ({ ...current, [id]: keepProfileDraft ? profileSetupDrafts[id] ?? defaultDraft() : defaultDraft() }));
  };

  const changeHead = (id: 1 | 2, patch: Partial<Head>) => {
    if ("port" in patch || "baud" in patch) resetSetupForHead(id);
    setHeads((current) => current.map((head) => head.id === id ? { ...head, ...patch } : head));
  };

  const applyProfile = (profile: MachineProfile) => {
    changeHead(1, { port: profile.head1.port, baud: String(profile.head1.baudRate) });
    changeHead(2, { port: profile.head2.port, baud: String(profile.head2.baudRate) });
    if (profile.head1Setup && profile.head2Setup) {
      setProfileSetupDrafts({ 1: profile.head1Setup, 2: profile.head2Setup });
      setSetupDrafts({ 1: profile.head1Setup, 2: profile.head2Setup });
      setSetupOriginals({ 1: defaultDraft(), 2: defaultDraft() });
      setSetupInitialized({ 1: false, 2: false });
    }
    appendEvent(`Applied profile “${profile.name}” to connection inputs. Controllers remain disconnected.`);
  };

  const saveProfile = async () => {
    const name = profileName.trim();
    if (!name) {
      setProfileError("Enter a profile name before saving.");
      return;
    }
    setProfileSaving(true);
    setProfileError(null);
    try {
      const data = await request("/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          head1: { port: heads[0].port, baudRate: Number(heads[0].baud) },
          head2: { port: heads[1].port, baudRate: Number(heads[1].baud) },
            head1Setup: setupDrafts[1],
            head2Setup: setupDrafts[2],
        }),
      });
      const profile = (data?.profile ?? data) as MachineProfile;
      if (!profile?.id || !profile?.name) throw new Error("Agent returned an invalid saved profile");
      setProfiles((current) => [profile, ...current.filter((item) => item.id !== profile.id)]);
      setProfileName("");
      appendEvent(`Saved machine profile “${profile.name}”`);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Unable to save profile");
    } finally {
      setProfileSaving(false);
    }
  };

  const deleteProfile = async (profile: MachineProfile) => {
    setProfileError(null);
    try {
      await request(`/profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
      setProfiles((current) => current.filter((item) => item.id !== profile.id));
      appendEvent(`Deleted machine profile “${profile.name}”`);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Unable to delete profile");
    }
  };

  const toggleHead = async (head: Head) => {
    setBusyHead(head.id);
    try {
      if (head.connected) {
        await request(`/heads/${head.id}/disconnect`, { method: "POST" });
        changeHead(head.id, { connected: false });
        resetSetupForHead(head.id);
        appendEvent("Disconnected", "info", head.id, "ui.disconnect");
      } else {
        if (!head.port) throw new Error("Select a serial port first");
        resetSetupForHead(head.id, true);
        const data = await request(`/heads/${head.id}/connect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ port: head.port, baudRate: Number(head.baud) }),
        });
        const snapshot = data?.status && typeof data.status === "object" ? data.status as MachineSnapshot : undefined;
        const connected = snapshot?.connected === true || data?.connected === true;
        if (!connected) throw new Error("Agent did not report this controller ready after the connection attempt");
        changeHead(head.id, { connected, firmware: snapshot?.firmware ?? data?.firmware });
        if (snapshot) applySnapshot(snapshot as Record<string, unknown>);
        appendEvent(`Connected on ${head.port} at ${head.baud} baud`, "info", head.id, "ui.connect");
      }
    } catch (error) {
      appendEvent(error instanceof Error ? `Connection failed: ${error.message}` : "Connection failed", "error", head.id, "ui.connect.error");
    } finally {
      setBusyHead(null);
    }
  };

  const requestAction = (headId: 1 | 2, label: string, detail: string, path: string, body?: Record<string, unknown>, onSuccess?: () => void) => {
    setPendingAction({ headId, label, detail, path, body, onSuccess });
  };

  const confirmAction = async () => {
    if (!pendingAction) return;
    setControlBusy(true);
    try {
      await request(pendingAction.path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, ...pendingAction.body }),
      });
      appendEvent(`${pendingAction.label} requested`, "info", pendingAction.headId, "ui.action");
      pendingAction.onSuccess?.();
      setPendingAction(null);
      if (pendingAction.label === "Stream G-code") setOperatorState((current) => ({ ...current, [pendingAction.headId]: { ...current[pendingAction.headId], gcode: "" } }));
    } catch (error) {
      appendEvent(error instanceof Error ? `${pendingAction.label} failed: ${error.message}` : `${pendingAction.label} failed`, "error", pendingAction.headId, "ui.action.error");
      setPendingAction(null);
    } finally {
      setControlBusy(false);
    }
  };

  const queueJog = (headId: 1 | 2, axis: "x" | "y" | "z", direction: 1 | -1) => {
    const step = Number(operatorState[headId].jogStep);
    const feedRate = Number(operatorState[headId].jogFeedRate);
    if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(feedRate) || feedRate <= 0) {
      appendEvent("Jog step and feed rate must be positive numbers", "error");
      return;
    }
    requestAction(headId, `Jog ${axis.toUpperCase()} ${direction > 0 ? "+" : "−"}`, `Move Head ${headId} ${axis.toUpperCase()} by ${(step * direction).toFixed(3)} mm at ${feedRate} mm/min. Verify the work area is clear.`, `/heads/${headId}/jog`, { [axis]: step * direction, feedRate });
  };

  const saveWorkOffset = (headId: 1 | 2) => {
    const draft = workOffsetDrafts[headId];
    const body: Record<string, number> = {};
    (["x", "y", "z"] as const).forEach((axis) => {
      if (draft[axis].trim()) {
        const value = Number(draft[axis]);
        if (Number.isFinite(value)) body[axis] = value;
      }
    });
    if (!Object.keys(body).length) {
      appendEvent("Enter at least one valid work offset value.", "error");
      return;
    }
    requestAction(headId, "Set work offset", `Set the selected work-coordinate offset for Head ${headId}. This changes WCS only and does not physically move the machine.`, `/heads/${headId}/work-offset`, body);
  };

  const updateSetupDraft = (headId: 1 | 2, patch: Partial<SetupDraft>) => {
    setSetupDrafts((current) => ({ ...current, [headId]: { ...current[headId], ...patch } }));
  };

  const queueSetupJog = (headId: 1 | 2, axis: "x" | "y" | "z", distance: number, feedRate: number) => {
    if (!Number.isFinite(distance) || distance === 0 || !Number.isFinite(feedRate) || feedRate <= 0) {
      appendEvent("Setup test distance and feed rate must be valid numbers.", "error");
      return;
    }
    requestAction(headId, `Test ${axis.toUpperCase()} movement`, `Move Head ${headId} ${axis.toUpperCase()} by ${distance.toFixed(3)} mm at ${feedRate} mm/min for setup verification. Confirm only after the area is clear.`, `/heads/${headId}/jog`, { [axis]: distance, feedRate });
  };

  const applySetupSettings = (headId: 1 | 2, settings: Record<string, string>, label: string) => {
    if (!setupInitialized[headId]) {
      appendEvent(`Head ${headId} setup is not ready. Connect the controller and wait for its current GRBL settings to load before applying changes.`, "error");
      return;
    }
    const entries = Object.entries(settings).filter(([, value]) => value.trim() !== "");
    if (!entries.length || entries.some(([, value]) => !Number.isFinite(Number(value)))) {
      appendEvent("Setup settings must contain valid numeric values.", "error");
      return;
    }
    requestAction(headId, label, `Apply ${entries.length} GRBL setting${entries.length === 1 ? "" : "s"} to Head ${headId}: ${entries.map(([key, value]) => `${key}=${value}`).join(", ")}. This writes controller configuration but does not move the machine.`, `/heads/${headId}/setup`, { settings: Object.fromEntries(entries) }, () => {
      setSettingsByHead((current) => ({
        ...current,
        [headId]: (current[headId] ?? []).map((setting) => {
          const found = entries.find(([key]) => key === setting.key || key.slice(1) === setting.key);
          return found ? { ...setting, value: found[1] } : setting;
        }),
      }));
      setSetupOriginals((current) => {
        const baseline = { ...current[headId] };
        const draft = setupDrafts[headId];
        Object.keys(settings).forEach((key) => {
          switch (key) {
            case "$3":
              baseline.directionInvertX = draft.directionInvertX; baseline.directionInvertY = draft.directionInvertY; baseline.directionInvertZ = draft.directionInvertZ; break;
            case "$5": baseline.hardLimitInvert = draft.hardLimitInvert; break;
            case "$20": baseline.softLimits = draft.softLimits; break;
            case "$21": baseline.hardLimits = draft.hardLimits; break;
            case "$22": baseline.homingEnable = draft.homingEnable; break;
            case "$23":
              baseline.homingDirInvertX = draft.homingDirInvertX; baseline.homingDirInvertY = draft.homingDirInvertY; baseline.homingDirInvertZ = draft.homingDirInvertZ; break;
            case "$24": baseline.homingFeed = draft.homingFeed; break;
            case "$25": baseline.homingSeek = draft.homingSeek; break;
            case "$27": baseline.homingPullOff = draft.homingPullOff; break;
            case "$100": baseline.stepsX = draft.stepsX; break;
            case "$101": baseline.stepsY = draft.stepsY; break;
            case "$102": baseline.stepsZ = draft.stepsZ; break;
            case "$130": baseline.travelX = draft.travelX; break;
            case "$131": baseline.travelY = draft.travelY; break;
            case "$132": baseline.travelZ = draft.travelZ; break;
          }
        });
        return { ...current, [headId]: baseline };
      });
      appendEvent(`${label} applied to Head ${headId}`);
    });
  };

  const queueSetupHome = (headId: 1 | 2) => {
    requestAction(headId, "Test homing", `Run the configured homing cycle on Head ${headId}. The selected axes may move toward their physical limit switches.`, `/heads/${headId}/home`);
  };

  const agentReady = status === "online" && portDiscoveryStatus === "ready";
  const discoveryLabel = portDiscoveryStatus === "ready"
    ? `${ports.length} port${ports.length === 1 ? "" : "s"} found`
    : portDiscoveryStatus === "unauthorized"
      ? "Token rejected"
      : portDiscoveryStatus === "error"
        ? "Discovery failed"
        : portDiscoveryStatus === "checking"
          ? "Checking ports"
          : "Not checked";

  return (
    <div className="machine-controller-page mx-auto min-h-full w-full max-w-[1800px] space-y-6 overflow-visible p-4 pb-16 sm:space-y-8 sm:p-6 sm:pb-24 lg:p-8 lg:pb-28">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
           <p className="machine-technical mb-2 text-xs font-semibold uppercase tracking-[0.22em] text-primary">Operator console / dual-head control</p>
           <h1 className="text-3xl font-bold tracking-tight sm:text-5xl">Machine Controller</h1>
           <p className="mt-2 max-w-3xl text-base text-muted-foreground sm:text-lg">Local-agent connection, controller status, and machine telemetry.</p>
        </div>
         <div className="grid w-full min-w-0 gap-2 text-sm lg:w-auto lg:min-w-[28rem]" aria-live="polite">
           <div data-testid="status-api" className={cn("flex min-w-0 items-center gap-2 rounded-sm border px-3 py-2", apiStatus === "online" ? "border-chart-3/30 bg-chart-3/5" : "border-destructive/30 bg-destructive/5")}>
             {apiStatus === "checking" ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : apiStatus === "online" ? <Wifi className="h-4 w-4 shrink-0 text-chart-3" /> : <WifiOff className="h-4 w-4 shrink-0 text-destructive" />}
             <span className="font-semibold">Application API</span><span className="min-w-0 break-words text-muted-foreground">· {apiStatusMessage}</span>
           </div>
           <div data-testid="status-agent" className={cn("flex min-w-0 items-center gap-2 rounded-sm border px-3 py-2", status === "online" ? "border-chart-3/30 bg-chart-3/5" : "border-destructive/30 bg-destructive/5")}>
             {status === "checking" ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : status === "online" ? <Wifi className="h-4 w-4 shrink-0 text-chart-3" /> : <WifiOff className="h-4 w-4 shrink-0 text-destructive" />}
             <span className="font-semibold">Local Agent</span><span className="min-w-0 break-words text-muted-foreground">· {statusMessage}</span>
           </div>
           <div data-testid="status-port-discovery" className={cn("flex min-w-0 items-center gap-2 rounded-sm border px-3 py-2", portDiscoveryStatus === "ready" ? "border-chart-3/30 bg-chart-3/5" : portDiscoveryStatus === "checking" || portDiscoveryStatus === "idle" ? "border-border" : "border-destructive/30 bg-destructive/5")}>
             {portDiscoveryStatus === "checking" ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <Cable className={cn("h-4 w-4 shrink-0", portDiscoveryStatus === "ready" ? "text-chart-3" : portDiscoveryStatus === "error" || portDiscoveryStatus === "unauthorized" ? "text-destructive" : "text-muted-foreground")} />}
             <span className="font-semibold">Serial discovery</span><span className="min-w-0 break-words text-muted-foreground">· {discoveryLabel}</span>
           </div>
           <div data-testid="status-telemetry" className="flex min-w-0 items-center gap-2 rounded-sm border border-border px-3 py-2">
             {telemetryStatus === "connecting" || telemetryStatus === "reconnecting" ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <CircleDot className={cn("h-4 w-4 shrink-0", telemetryStatus === "connected" ? "text-chart-3" : "text-muted-foreground")} />}
             <span className="font-semibold">Live telemetry</span><span className="text-muted-foreground">· {telemetryStatus}</span>
           </div>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-4">
           <CardTitle className="text-xl flex items-center gap-3"><Cable className="w-5 h-5" /> Local Agent</CardTitle>
          <CardDescription className="text-base leading-relaxed">Connection settings stay in this browser only. The token is never sent to the application server.</CardDescription>
        </CardHeader>
         <form onSubmit={(event) => { event.preventDefault(); saveConnectionSettings(); }} className="grid grid-cols-1 items-end gap-5 px-6 pb-6 lg:grid-cols-[1fr_1fr_auto]">
          <div className="space-y-2"><Label htmlFor="agent-url" className="text-base">Agent API URL</Label><Input id="agent-url" value={agentUrl} onChange={(event) => setAgentUrl(event.target.value)} data-testid="input-agent-url" className="h-12 font-mono text-sm" /></div>
          <div className="space-y-2"><Label htmlFor="agent-token" className="text-base">Agent token</Label><Input id="agent-token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} data-testid="input-agent-token" placeholder="Stored in localStorage only" className="h-12 text-base" /></div>
            <Button type="submit" data-testid="button-save-connection" className="h-12 px-6 text-base"><RefreshCw className="mr-2 h-5 w-5" />Save & check</Button>
         </form>
         {agentUrlErrorMessage && <div className="mx-6 mb-5 rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{agentUrlErrorMessage}</div>}
          <div className="mx-6 mb-6 space-y-3 rounded-sm border border-border/60 bg-muted/10 p-3 text-sm">
            <div className="font-medium">Available COM ports</div>
            {portDiscoveryStatus === "ready" ? portDetails.length ? (
              <div className="grid gap-2 sm:grid-cols-2" data-testid="serial-port-list">
                {portDetails.map((port) => <div key={port.path} className="min-w-0 rounded-sm border border-border/50 bg-background/60 px-3 py-2">
                  <div className="machine-technical font-semibold">{port.path}{port.inUseBy ? ` · in use by ${port.inUseBy}` : ""}</div>
                  <div className="truncate text-muted-foreground">{port.description || port.manufacturer || "Serial device"}</div>
                </div>)}
              </div>
            ) : <div className="text-muted-foreground" data-testid="empty-serial-ports">Authenticated discovery succeeded, but Windows reported no serial ports.</div> : (
              <div className={cn("text-muted-foreground", (portDiscoveryStatus === "error" || portDiscoveryStatus === "unauthorized") && "text-destructive")}>
                {portDiscoveryError ?? "Save the local Agent URL and token to run authenticated serial-port discovery."}
              </div>
            )}
            <div className="border-t border-border/50 pt-3 text-muted-foreground">
              This browser contacts the loopback Agent directly. A Replit/cloud page does not make the cloud server able to access your Windows COM ports; browser HTTPS-to-local-HTTP, private-network, or CORS policy may still block the request.
            </div>
          </div>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
             <div className="min-w-0"><CardTitle className="flex items-center gap-2 text-lg"><Cpu className="h-4 w-4 shrink-0" />Machine Profiles</CardTitle><CardDescription className="mt-1">Store Head 1/2 connection selections in the local agent. Applying a profile never connects a controller.</CardDescription></div>
             <Button variant="outline" className="h-10 w-full shrink-0 px-4 sm:w-auto" onClick={() => void loadProfiles()} disabled={!agentReady || profilesLoading}><RefreshCw className={`w-4 h-4 mr-2 ${profilesLoading ? "animate-spin" : ""}`} />Refresh</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-2">
             <Input data-testid="input-profile-name" value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="Profile name, e.g. Production table" disabled={!agentReady || profileSaving} />
             <Button data-testid="button-save-profile" onClick={() => void saveProfile()} disabled={!agentReady || profileSaving}>{profileSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Save current setup</Button>
          </div>
           {profileError && <div className="text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded-sm p-2">{profileError}</div>}
           {profilesLoading && profiles.length === 0 ? <div className="text-base text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading profiles…</div> : profiles.length ? (
            <div className="space-y-2">
              {profiles.map((profile) => <div key={profile.id} className="flex flex-col md:flex-row md:items-center gap-3 border border-border/60 rounded-sm p-3">
                 <div className="flex-1 min-w-0"><div className="text-base font-medium truncate">{profile.name}</div><div className="font-mono text-sm text-muted-foreground mt-1">H1 {profile.head1.port || "—"} · {profile.head1.baudRate} &nbsp; | &nbsp; H2 {profile.head2.port || "—"} · {profile.head2.baudRate}</div></div>
                 <div className="flex gap-2"><Button variant="outline" className="h-10 px-4" onClick={() => applyProfile(profile)} disabled={!agentReady}>Apply inputs</Button><Button variant="ghost" className="h-10 px-4 text-destructive hover:text-destructive" onClick={() => void deleteProfile(profile)} disabled={!agentReady}>Delete</Button></div>
              </div>)}
            </div>
            ) : !profileError ? <div className="text-base text-muted-foreground border border-dashed border-border rounded-sm p-4" data-testid="empty-profiles">No saved profiles. Save the current Head 1 and Head 2 connection settings to reuse them.</div> : null}
        </CardContent>
      </Card>

      <div className="space-y-10">
        {heads.map((head, index) => (
          <div key={head.id} className="space-y-6">
            {index > 0 && (
              <div className="flex items-center gap-4 px-1 pt-2" aria-hidden="true">
                <div className="h-px flex-1 bg-border" />
                <span className="machine-technical text-[10px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">Head {head.id} / independent controller</span>
                <div className="h-px flex-1 bg-border" />
              </div>
            )}
            <OperatorPanel
              head={head}
              snapshot={headSnapshots[head.id]}
              consoleEntries={consoleEvents[head.id]}
              agentOnline={agentReady}
              agentStatus={status}
              ports={ports}
              portDiscoveryStatus={portDiscoveryStatus}
              portDiscoveryError={portDiscoveryError}
              refreshingPorts={refreshingPorts}
              busyHead={busyHead}
              onRefreshPorts={() => void refreshPorts()}
              onPortChange={(port) => changeHead(head.id, { port })}
              onBaudChange={(baud) => changeHead(head.id, { baud })}
              onToggleConnection={() => void toggleHead(head)}
              setupHead1={{ ...heads[0], setupReady: setupInitialized[1] }}
              setupHead2={{ ...heads[1], setupReady: setupInitialized[2] }}
              setupSnap1={headSnapshots[1] ?? {}}
              setupSnap2={headSnapshots[2] ?? {}}
              setupDraft1={setupDrafts[1]}
              setupDraft2={setupDrafts[2]}
              originalSetupDraft1={setupOriginals[1]}
              originalSetupDraft2={setupOriginals[2]}
              onSetupDraftChange={updateSetupDraft}
              onSetupJog={queueSetupJog}
              onApplySetupSettings={applySetupSettings}
              onSetupHome={queueSetupHome}
              onSetupFinish={() => appendEvent(`Machine setup wizard review completed for Head ${head.id}. Save a profile to retain this independent draft.`)}
              state={operatorState[head.id]}
              settings={settingsByHead[head.id] ?? []}
              settingsLoading={settingsLoading[head.id]}
              settingsError={settingsError[head.id]}
              editingSetting={editingSetting[head.id]}
              workOffsetDraft={workOffsetDrafts[head.id]}
              onStateChange={(patch) => setOperatorState((current) => ({ ...current, [head.id]: { ...current[head.id], ...patch } }))}
              onEditSetting={(setting) => { setEditingSetting((current) => ({ ...current, [head.id]: setting })); setOperatorState((current) => ({ ...current, [head.id]: { ...current[head.id], settingValue: String(setting.value) } })); }}
              onCancelEdit={() => setEditingSetting((current) => ({ ...current, [head.id]: undefined }))}
              onDraftChange={(axis, value) => setWorkOffsetDrafts((current) => ({ ...current, [head.id]: { ...current[head.id], [axis]: value } }))}
              requestAction={requestAction}
              queueJog={queueJog}
              saveWorkOffset={saveWorkOffset}
              onRefreshSettings={() => void loadSettings(head.id, true)}
              onSettingSuccess={(setting, value) => { setSettingsByHead((current) => ({ ...current, [head.id]: (current[head.id] ?? []).map((item) => item.key === setting.key ? { ...item, value } : item) })); setEditingSetting((current) => ({ ...current, [head.id]: undefined })); }}
            />
          </div>
        ))}
      </div>

       <Card>
         <CardHeader className="pb-3"><CardTitle className="text-lg flex gap-2"><Terminal className="w-4 h-4" /> Event log <span className="machine-technical text-sm text-muted-foreground font-normal">SSE</span></CardTitle></CardHeader>
      <CardContent><div className="machine-technical border border-border/50 rounded-sm bg-muted/20 text-sm" aria-live="polite" data-testid="event-log">{events.length ? events.map((entry, index) => <div key={`${entry.time}-${index}`} className={`flex flex-col gap-1 border-b border-border/30 px-3 py-2 last:border-0 sm:flex-row sm:gap-3 ${entry.level === "error" ? "text-destructive" : entry.level === "warning" ? "text-amber-500" : ""}`}><span className="shrink-0 text-muted-foreground">{entry.time}</span><span className="min-w-0 break-words">{entry.message}</span></div>) : <div className="p-4 text-muted-foreground">No agent events yet. Connect the local agent to receive live telemetry.</div>}</div></CardContent>
      </Card>
      <AlertDialog open={!!pendingAction} onOpenChange={(open) => { if (!open && !controlBusy) setPendingAction(null); }}>
        <AlertDialogContent>
         <AlertDialogHeader><AlertDialogTitle className="flex gap-2"><AlertTriangle className="w-5 h-5 text-amber-500" />Confirm: {pendingAction?.label}</AlertDialogTitle><AlertDialogDescription>{pendingAction?.detail}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel disabled={controlBusy}>Cancel</AlertDialogCancel><AlertDialogAction disabled={controlBusy} onClick={(event) => { event.preventDefault(); void confirmAction(); }} className="bg-amber-600 hover:bg-amber-700">{controlBusy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Confirm action</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PositionCard({ title, position }: { title: string; position?: Position }) {
  return <Card className="min-w-0"><CardHeader className="pb-4"><CardTitle className="text-xl flex gap-3"><CircleDot className="h-5 w-5 shrink-0" />{title}</CardTitle><CardDescription className="text-base">Units: mm</CardDescription></CardHeader><CardContent><div className="grid grid-cols-3 gap-2 sm:gap-3">{(["x", "y", "z"] as const).map((axis) => {
    const rawValue = position?.[axis];
    const value = formatAxis(rawValue);
     return <div key={axis} className="min-w-0 overflow-hidden bg-muted/30 border border-border/50 rounded-sm p-3 sm:p-4"><div className="text-sm font-mono font-semibold text-muted-foreground uppercase tracking-wider">{axis}</div><div title={typeof rawValue === "number" ? String(rawValue) : undefined} data-testid={`text-position-${title.toLowerCase().replace(/[^a-z]/g, '')}-${axis}`} className="machine-technical mt-1 truncate text-2xl font-bold tabular-nums tracking-tight sm:text-3xl">{value}</div></div>;
  })}</div></CardContent></Card>;
}

function HeadConnectionCard({ head, agentStatus, ports, portDiscoveryStatus, portDiscoveryError, refreshingPorts, busyHead, onRefreshPorts, onPortChange, onBaudChange, onToggleConnection }: {
  head: Head; agentStatus: AgentStatus; ports: string[]; portDiscoveryStatus: PortDiscoveryStatus; portDiscoveryError: string | null; refreshingPorts: boolean; busyHead: number | null;
  onRefreshPorts: () => void; onPortChange: (port: string) => void; onBaudChange: (baud: string) => void; onToggleConnection: () => void;
}) {
  const agentOnline = agentStatus === "online";
  const discoveryReady = portDiscoveryStatus === "ready";
  const canToggle = agentOnline && (head.connected || discoveryReady);
  return (
    <Card data-testid={`card-head-connection-${head.id}`} className={cn("overflow-hidden", head.connected ? "border-chart-3/50" : head.id === 1 ? "border-chart-1/25" : "border-chart-2/25")}>
      <CardHeader className="pb-4">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className={cn("h-2.5 w-2.5 rounded-full", head.id === 1 ? "bg-chart-1" : "bg-chart-2", head.connected && "shadow-[0_0_10px_currentColor]")} />
            <CardTitle className="text-xl">Connection</CardTitle>
          </div>
          <Badge data-testid={`badge-connection-head-${head.id}`} className="px-3 py-1 text-sm font-semibold" variant={head.connected ? "success" : "secondary"}>
            {head.connected ? "Connected" : "Offline"}
          </Badge>
        </div>
        <CardDescription className="text-sm">{head.firmware ? `Firmware: ${head.firmware}` : "Independent serial controller"} · Agent {agentStatus} · Discovery {portDiscoveryStatus}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`port-head-${head.id}`}>Serial port</Label>
            <Select value={head.port} onValueChange={onPortChange} disabled={!discoveryReady || head.connected || busyHead === head.id}>
              <SelectTrigger id={`port-head-${head.id}`} data-testid={`select-port-head-${head.id}`} className="h-11"><SelectValue placeholder="Select port" /></SelectTrigger>
              <SelectContent>{Array.from(new Set([...ports, head.port])).filter(Boolean).map((port) => <SelectItem key={port} value={port}>{port}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`baud-head-${head.id}`}>Baud rate</Label>
            <Select value={head.baud} onValueChange={onBaudChange} disabled={!discoveryReady || head.connected || busyHead === head.id}>
              <SelectTrigger id={`baud-head-${head.id}`} data-testid={`select-baud-head-${head.id}`} className="h-11"><SelectValue /></SelectTrigger>
              <SelectContent>{Array.from(new Set([...BAUD_RATES, head.baud])).filter(Boolean).map((baud) => <SelectItem key={baud} value={baud}>{baud}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button variant="outline" onClick={onRefreshPorts} disabled={!agentOnline || refreshingPorts || busyHead === head.id} data-testid={`button-refresh-ports-head-${head.id}`} className="h-11 px-5">
            <RefreshCw className={cn("mr-2 h-4 w-4", refreshingPorts && "animate-spin")} />Ports
          </Button>
          <Button onClick={onToggleConnection} disabled={!canToggle || busyHead === head.id} data-testid={`button-toggle-head-${head.id}`} className="h-11 flex-1">
            {busyHead === head.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Plug className="mr-2 h-4 w-4" />{head.connected ? "Disconnect" : "Connect"}</>}
          </Button>
        </div>
        {!head.connected && portDiscoveryStatus !== "ready" && <div className="rounded-sm border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">{portDiscoveryError ?? "Authenticated serial-port discovery must succeed before connecting this head."}</div>}
      </CardContent>
    </Card>
  );
}

function OperatorPanel({ head, snapshot, consoleEntries, agentOnline, agentStatus, ports, portDiscoveryStatus, portDiscoveryError, refreshingPorts, busyHead, onRefreshPorts, onPortChange, onBaudChange, onToggleConnection, setupHead1, setupHead2, setupSnap1, setupSnap2, setupDraft1, setupDraft2, originalSetupDraft1, originalSetupDraft2, onSetupDraftChange, onSetupJog, onApplySetupSettings, onSetupHome, onSetupFinish, state, settings, settingsLoading, settingsError, editingSetting, workOffsetDraft, onStateChange, onEditSetting, onCancelEdit, onDraftChange, requestAction, queueJog, saveWorkOffset, onRefreshSettings, onSettingSuccess }: {
  head: Head; snapshot?: MachineSnapshot; consoleEntries: LogEntry[]; agentOnline: boolean; agentStatus: AgentStatus; ports: string[]; portDiscoveryStatus: PortDiscoveryStatus; portDiscoveryError: string | null; refreshingPorts: boolean; busyHead: number | null;
  onRefreshPorts: () => void; onPortChange: (port: string) => void; onBaudChange: (baud: string) => void; onToggleConnection: () => void;
  setupHead1: WizardHead; setupHead2: WizardHead; setupSnap1: WizardSnapshot; setupSnap2: WizardSnapshot; setupDraft1: SetupDraft; setupDraft2: SetupDraft; originalSetupDraft1: SetupDraft; originalSetupDraft2: SetupDraft;
  onSetupDraftChange: (headId: 1 | 2, patch: Partial<SetupDraft>) => void; onSetupJog: (headId: 1 | 2, axis: "x" | "y" | "z", distance: number, feedRate: number) => void; onApplySetupSettings: (headId: 1 | 2, settings: Record<string, string>, label: string) => void; onSetupHome: (headId: 1 | 2) => void; onSetupFinish: () => void;
  state: OperatorState; settings: GrblSetting[]; settingsLoading?: boolean; settingsError?: string; editingSetting?: GrblSetting; workOffsetDraft: WorkOffsetDraft;
  onStateChange: (patch: Partial<OperatorState>) => void; onEditSetting: (setting: GrblSetting) => void; onCancelEdit: () => void; onDraftChange: (axis: keyof WorkOffsetDraft, value: string) => void;
  requestAction: (headId: 1 | 2, label: string, detail: string, path: string, body?: Record<string, unknown>, onSuccess?: () => void) => void;
  queueJog: (headId: 1 | 2, axis: "x" | "y" | "z", direction: 1 | -1) => void; saveWorkOffset: (headId: 1 | 2) => void; onRefreshSettings: () => void; onSettingSuccess: (setting: GrblSetting, value: string) => void;
}) {
  const enabled = agentOnline && head.connected;
  const machineState = (snapshot?.state ?? (head.connected ? "IDLE" : "DISCONNECTED")).toUpperCase();
  const stateVariant = machineState.includes("ALARM") ? "destructive" : head.connected ? "success" : "secondary";
  const visibleSettings = settings.filter((setting) => !state.settingsSearch.trim() || `${setting.key} ${setting.shortDescription ?? ""} ${setting.description ?? ""}`.toLowerCase().includes(state.settingsSearch.trim().toLowerCase()));
  const consoleOutputRef = useRef<HTMLDivElement>(null);
  const consoleAtBottomRef = useRef(true);
  useEffect(() => {
    const output = consoleOutputRef.current;
    if (!output || !consoleAtBottomRef.current) return;
    output.scrollTop = output.scrollHeight;
  }, [consoleEntries]);
  const handleConsoleScroll = () => {
    const output = consoleOutputRef.current;
    if (!output) return;
    consoleAtBottomRef.current = output.scrollHeight - output.scrollTop - output.clientHeight <= 8;
  };
  const action = (label: string, detail: string, endpoint: string, body?: Record<string, unknown>, onSuccess?: () => void) => requestAction(head.id, label, detail, `/heads/${head.id}${endpoint}`, body, onSuccess);
   return <section className={cn("machine-operator-panel space-y-6 rounded-sm border p-4 sm:p-6", head.id === 1 ? "border-chart-1/40" : "border-chart-2/40")} data-testid={`head-section-${head.id}`} aria-labelledby={`head-section-title-${head.id}`}>
     <div className="flex flex-col items-start justify-between gap-2 border-b border-border/60 pb-4 sm:flex-row sm:items-center">
       <div><p className="machine-technical text-[10px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">Independent controller</p><h2 id={`head-section-title-${head.id}`} className="text-2xl font-bold tracking-tight sm:text-3xl">Head {head.id} operator</h2></div>
       <Badge className="px-3 py-1 text-sm font-semibold" variant={head.connected ? "success" : "secondary"}>{head.connected ? "Connected" : "Offline"}</Badge>
     </div>
     <HeadConnectionCard head={head} agentStatus={agentStatus} ports={ports} portDiscoveryStatus={portDiscoveryStatus} portDiscoveryError={portDiscoveryError} refreshingPorts={refreshingPorts} busyHead={busyHead} onRefreshPorts={onRefreshPorts} onPortChange={onPortChange} onBaudChange={onBaudChange} onToggleConnection={onToggleConnection} />
     <Card className="border-primary/20">
       <CardHeader className="pb-4"><CardTitle className="text-xl flex items-center gap-3"><SlidersHorizontal className="h-5 w-5" />Machine Setup Wizard</CardTitle><CardDescription>Configure this head independently. Test movements, homing, and controller writes require explicit confirmation.</CardDescription></CardHeader>
       <CardContent className="p-3 sm:p-4">
         <MachineSetupWizard
           head1={setupHead1}
           head2={setupHead2}
           headIds={[head.id]}
           snap1={setupSnap1}
           snap2={setupSnap2}
           draft1={setupDraft1}
           draft2={setupDraft2}
           originalDraft1={originalSetupDraft1}
           originalDraft2={originalSetupDraft2}
           onDraftChange={onSetupDraftChange}
           ports={ports}
           refreshingPorts={refreshingPorts}
           agentOnline={agentOnline}
           busyHeadId={busyHead === 1 || busyHead === 2 ? busyHead : null}
           onRefreshPorts={onRefreshPorts}
           onPortChange={(headId, port) => { if (headId === head.id) onPortChange(port); }}
           onBaudChange={(headId, baud) => { if (headId === head.id) onBaudChange(baud); }}
           onToggleConnection={(headId) => { if (headId === head.id) onToggleConnection(); }}
           onJog={onSetupJog}
           onApplySettings={onApplySetupSettings}
           onHome={onSetupHome}
           onFinish={onSetupFinish}
         />
       </CardContent>
     </Card>
    <div className="space-y-6">
       <Card><CardHeader className="pb-5"><CardTitle className="text-xl flex gap-3"><Cpu className="h-5 w-5" />Machine Status</CardTitle></CardHeader><CardContent className="space-y-4 text-base"><div className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between"><span className="font-medium">State</span><Badge className="max-w-full px-3 py-1.5 text-sm font-semibold" variant={stateVariant} data-testid={`badge-machine-state-head-${head.id}`}>{machineState}</Badge></div><div className="flex min-w-0 flex-col items-start gap-2 text-base sm:flex-row sm:items-center sm:justify-between"><span className="font-medium">Firmware</span><span className="max-w-full break-all font-mono tabular-nums" data-testid={`text-firmware-head-${head.id}`}>{snapshot?.firmware ?? head.firmware ?? "—"}</span></div><div className="flex min-w-0 flex-col items-start gap-2 text-sm sm:flex-row sm:items-center sm:justify-between"><span className="font-medium">Stream</span><span className="max-w-full break-words font-mono tabular-nums">{snapshot?.rowsSent ?? 0} sent · {snapshot?.rowsCompleted ?? 0} done · {snapshot?.rowsRemaining ?? 0} left</span></div><div className="break-words text-sm text-muted-foreground">{snapshot?.alarm ? <span className="font-mono text-destructive" data-testid={`text-alarm-head-${head.id}`}>ALARM: {snapshot.alarm}</span> : snapshot?.error ? <span className="font-mono text-destructive" data-testid={`text-error-head-${head.id}`}>{snapshot.error}</span> : "No active alarm reported"}</div></CardContent></Card>
       <div className="grid grid-cols-1 gap-6 sm:grid-cols-2"><PositionCard title="Machine coordinates (MPos)" position={snapshot?.machinePosition} /><PositionCard title="Work coordinates (WPos)" position={snapshot?.workPosition} /></div>
    </div>
    <Card>
      <CardHeader className="pb-5">
         <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
           <CardTitle className="text-xl flex gap-3"><SlidersHorizontal className="h-5 w-5" />GRBL Settings</CardTitle>
          <Button className="h-10 w-full px-4 text-base font-bold sm:w-auto" variant="outline" data-testid={`button-refresh-settings-head-${head.id}`} disabled={!enabled || settingsLoading} onClick={onRefreshSettings}><RefreshCw className={`mr-2 h-4 w-4 ${settingsLoading ? "animate-spin" : ""}`} />Refresh</Button>
        </div>
        <CardDescription>Refresh requests the current <span className="font-mono">$$</span> settings through UGS Core for this head only.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Input className="h-12 text-base" data-testid={`input-search-settings-head-${head.id}`} value={state.settingsSearch} onChange={(event) => onStateChange({ settingsSearch: event.target.value })} disabled={!enabled} placeholder="Search key or description…" />
        {settingsError && <div className="text-sm text-destructive" data-testid={`text-settings-error-head-${head.id}`}>{settingsError}</div>}
        {settingsLoading ? <div className="text-base text-muted-foreground">Reading settings…</div> : !head.connected ? <div className="text-base text-muted-foreground">Connect Head {head.id} to read its GRBL settings.</div> : visibleSettings.length ? (
          <ScrollArea className="h-[22rem] max-h-[22rem] rounded-sm border border-border/50 bg-muted/5">
            <div className="space-y-2 p-2" data-testid={`list-settings-head-${head.id}`}>
              {visibleSettings.map((setting) => <div key={setting.key} className="flex items-start justify-between gap-4 rounded-sm border border-border/50 px-4 py-3 text-base">
                <div className="min-w-0"><div className="font-mono">{setting.key} = <span className="font-bold">{setting.value}</span>{setting.units ? ` ${setting.units}` : ""}</div>{(setting.shortDescription || setting.description) && <div className="mt-1 text-sm text-muted-foreground">{setting.shortDescription || setting.description}</div>}</div>
                <Button className="h-10 shrink-0 px-4 text-base font-bold" variant="outline" data-testid={`button-edit-setting-${setting.key.replace('$', '')}-head-${head.id}`} onClick={() => onEditSetting(setting)}>Edit</Button>
              </div>)}
            </div>
          </ScrollArea>
        ) : <div className="text-base text-muted-foreground">No settings match this search.</div>}
        {editingSetting && <div className="flex flex-col gap-3 rounded-sm border border-primary/30 bg-primary/5 p-4 sm:flex-row"><Input className="h-12 text-base font-mono font-bold" data-testid={`input-edit-setting-value-head-${head.id}`} value={state.settingValue} onChange={(event) => onStateChange({ settingValue: event.target.value })} /><Button className="h-11 px-5 text-base font-bold" variant="outline" data-testid={`button-cancel-setting-head-${head.id}`} onClick={onCancelEdit}>Cancel</Button><Button className="h-11 px-5 text-base font-bold uppercase tracking-wide" data-testid={`button-confirm-setting-head-${head.id}`} disabled={!enabled || !state.settingValue.trim()} onClick={() => action(`Update ${editingSetting.key}`, `Update GRBL setting ${editingSetting.key} on Head ${head.id} to “${state.settingValue}”. This sends a controller command; verify the value before continuing.`, "/settings", { key: editingSetting.key, value: state.settingValue.trim() }, () => onSettingSuccess(editingSetting, state.settingValue.trim()))}>Confirm edit</Button></div>}
      </CardContent>
    </Card>
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
       <Card><CardHeader className="pb-5"><CardTitle className="text-xl flex gap-3"><Crosshair className="mr-3 inline h-5 w-5" />Work Coordinates</CardTitle></CardHeader><CardContent className="space-y-4"><div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{(["X", "Y", "Z", "ALL"] as const).map((axis) => <Button key={axis} className="h-12 text-base font-bold" disabled={!enabled} data-testid={`button-zero-${axis.toLowerCase()}-head-${head.id}`} onClick={() => action(`Set ${axis} work zero`, `Set the ${axis === "ALL" ? "X, Y, and Z" : axis} work coordinate zero for Head ${head.id}. This changes WCS and does not move the machine.`, "/work-zero", { axis })}>{axis}</Button>)}</div><div className="grid grid-cols-1 gap-3 sm:grid-cols-3">{(["x", "y", "z"] as const).map((axis) => <Input key={axis} className="h-12 text-base tabular-nums" data-testid={`input-offset-${axis}-head-${head.id}`} value={workOffsetDraft[axis]} onChange={(event) => onDraftChange(axis, event.target.value)} placeholder={axis.toUpperCase()} />)}</div><Button className="h-12 w-full text-base font-bold" disabled={!enabled} data-testid={`button-set-offset-head-${head.id}`} onClick={() => saveWorkOffset(head.id)}>Set work offset</Button></CardContent></Card>
       <Card className="border-destructive/30"><CardHeader className="pb-5"><CardTitle className="text-xl text-destructive">Safety-confirmed controls</CardTitle></CardHeader><CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">{([["Home", Home, "/home"], ["Unlock alarm", Unlock, "/unlock"], ["Reset controller", RotateCcw, "/reset"], ["Stop", Square, "/stop"]] as const).map(([label, Icon, endpoint]) => <Button key={label} variant={label === "Stop" ? "destructive" : "outline"} data-testid={`button-action-${label.toLowerCase().replace(/\s+/g, '-')}-head-${head.id}`} className={cn("h-12 text-base font-bold", label !== "Stop" && "hover:border-destructive/50 hover:bg-destructive/10 hover:text-destructive")} disabled={!enabled} onClick={() => action(label, `${label} Head ${head.id}. Verify the machine area is clear before continuing.`, endpoint)}><Icon className="mr-2 h-5 w-5" />{label}</Button>)}</CardContent></Card>
    </div>
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card><CardHeader className="pb-5"><CardTitle className="text-xl"><Terminal className="mr-3 inline h-5 w-5" />Head {head.id} Console</CardTitle><CardDescription>Persistent UGS/GRBL output for Head {head.id} only.</CardDescription></CardHeader><CardContent className="space-y-4"><div ref={consoleOutputRef} onScroll={handleConsoleScroll} tabIndex={0} className="machine-technical h-56 min-h-0 overflow-y-auto overscroll-contain rounded-sm border border-border/50 bg-muted/20 p-3 font-mono text-sm" aria-live="polite" data-testid={`console-output-head-${head.id}`}>{consoleEntries.length ? consoleEntries.map((entry, index) => <div key={`${entry.time}-${index}`} className={`border-b border-border/20 py-1.5 last:border-0 ${entry.level === "error" ? "text-destructive" : entry.level === "warning" ? "text-amber-500" : ""}`}><span className="mr-2 text-muted-foreground">{entry.time}</span><span>{entry.message}</span></div>) : <div className="text-muted-foreground">No Head {head.id} messages yet.</div>}</div><Input className="h-12 font-mono text-base" data-testid={`input-console-command-head-${head.id}`} value={state.consoleCommand} onChange={(event) => onStateChange({ consoleCommand: event.target.value })} placeholder="e.g. $H or M114" /><Button className="h-12 w-full text-base font-bold uppercase tracking-widest" data-testid={`button-send-command-head-${head.id}`} disabled={!enabled || !state.consoleCommand.trim()} onClick={() => action("Send console command", `Send this command to Head ${head.id}: ${state.consoleCommand.trim()}`, "/command", { command: state.consoleCommand.trim() })}><Send className="mr-2 h-5 w-5" />Send command</Button></CardContent></Card>
       <Card><CardHeader className="pb-5"><CardTitle className="text-xl">Stream lifecycle</CardTitle></CardHeader><CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">{([["Pause", Pause, "/pause"], ["Resume", Play, "/resume"], ["Stop", Square, "/stop"]] as const).map(([label, Icon, endpoint]) => <Button key={label} className="h-12 text-base font-bold" disabled={!enabled} data-testid={`button-stream-${label.toLowerCase()}-head-${head.id}`} onClick={() => action(label, `${label} the active stream on Head ${head.id}.`, endpoint)}><Icon className="mr-2 h-5 w-5" />{label}</Button>)}</CardContent></Card>
    </div>
    <Card><CardHeader className="pb-5"><CardTitle className="text-xl"><Play className="h-5 w-5 inline mr-3" />G-code streaming</CardTitle></CardHeader><CardContent className="space-y-4"><Textarea value={state.gcode} data-testid={`textarea-gcode-head-${head.id}`} onChange={(event) => onStateChange({ gcode: event.target.value })} spellCheck={false} placeholder={"G21\nG90\nG0 X0 Y0"} className="machine-technical min-h-56 font-mono text-base leading-relaxed" /><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><span className="machine-technical text-sm text-muted-foreground" data-testid={`text-gcode-lines-head-${head.id}`}>{state.gcode.trim() ? `${state.gcode.split("\n").length} lines ready` : "No G-code loaded"}</span><Button className="h-12 px-6 text-base font-bold uppercase tracking-widest" data-testid={`button-stream-gcode-head-${head.id}`} disabled={!enabled || !state.gcode.trim()} onClick={() => action("Stream G-code", `Start streaming ${state.gcode.split("\n").length} lines to Head ${head.id}. The controller may begin physical motion immediately.`, "/stream", { gcode: state.gcode })}><Play className="mr-2 h-5 w-5" />Confirm & stream</Button></div></CardContent></Card>
  </section>;
}