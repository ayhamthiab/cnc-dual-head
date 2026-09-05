import React, { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Cable, Move, Ruler, Map, Shield, Home, Maximize, CheckCircle2, ArrowRight, ArrowLeft, RefreshCw, Settings2 } from "lucide-react";

export type WizardHead = {
  id: 1 | 2;
  port: string;
  baud: string;
  connected: boolean;
  setupReady?: boolean;
  firmware?: string;
};

export type WizardSnapshot = {
  state?: string;
  alarm?: string | null;
  machinePosition?: { x?: number | null; y?: number | null; z?: number | null };
  workPosition?: { x?: number | null; y?: number | null; z?: number | null };
  limitPins?: { x?: boolean; x0?: boolean; x1?: boolean; y?: boolean; y0?: boolean; y1?: boolean; z?: boolean; z0?: boolean; z1?: boolean } | null;
};

export type WizardGrblSetting = {
  key: string;
  value: string | number;
};

export type SetupDraft = {
  directionInvertX: boolean;
  directionInvertY: boolean;
  directionInvertZ: boolean;
  stepsX: string;
  stepsY: string;
  stepsZ: string;
  calibrationXCommanded: string;
  calibrationXActual: string;
  calibrationYCommanded: string;
  calibrationYActual: string;
  calibrationZCommanded: string;
  calibrationZActual: string;
  limitXPlus: boolean;
  limitXMinus: boolean;
  limitYPlus: boolean;
  limitYMinus: boolean;
  limitZPlus: boolean;
  limitZMinus: boolean;
  softLimits: boolean;
  hardLimits: boolean;
  hardLimitInvert: boolean;
  homingEnable: boolean;
  homingDirInvertX: boolean;
  homingDirInvertY: boolean;
  homingDirInvertZ: boolean;
  homingFeed: string;
  homingSeek: string;
  homingPullOff: string;
  homingAxisX: boolean;
  homingAxisY: boolean;
  homingAxisZ: boolean;
  travelX: string;
  travelY: string;
  travelZ: string;
};

export interface MachineSetupWizardProps {
  head1: WizardHead;
  head2: WizardHead;
  headIds?: (1 | 2)[];
  snap1: WizardSnapshot;
  snap2: WizardSnapshot;
  
  draft1: SetupDraft;
  draft2: SetupDraft;
  onDraftChange: (headId: 1 | 2, patch: Partial<SetupDraft>) => void;
  
  ports: string[];
  refreshingPorts: boolean;
  agentOnline?: boolean;
  busyHeadId?: 1 | 2 | null;
  onRefreshPorts: () => void;
  
  onPortChange: (headId: 1 | 2, port: string) => void;
  onBaudChange: (headId: 1 | 2, baud: string) => void;
  onToggleConnection: (headId: 1 | 2) => void;
  
  onJog: (headId: 1 | 2, axis: "x" | "y" | "z", distance: number, feedRate: number) => void;
  onApplySettings: (headId: 1 | 2, settings: Record<string, string>, label: string) => void;
  onHome: (headId: 1 | 2) => void;
  
  originalDraft1?: SetupDraft;
  originalDraft2?: SetupDraft;
  
  onFinish?: () => void;
}

const BAUD_RATES = ["115200", "250000", "57600", "38400"];

const STAGES = [
  { id: "connection", label: "Connection", icon: Cable, desc: "Connect controllers" },
  { id: "direction", label: "Direction Tests", icon: Move, desc: "Verify motor polarity" },
  { id: "calibration", label: "Steps / mm", icon: Ruler, desc: "Calibrate axes scale" },
  { id: "limits", label: "Limit Switches", icon: Map, desc: "Test limit positions" },
  { id: "safety", label: "Safety Limits", icon: Shield, desc: "Hard & soft limits" },
  { id: "homing", label: "Homing Setup", icon: Home, desc: "Configure origin cycle" },
  { id: "travel", label: "Max Travel", icon: Maximize, desc: "Set machine volume" },
  { id: "summary", label: "Review & Apply", icon: CheckCircle2, desc: "Save configurations" },
] as const;

export type WizardStage = typeof STAGES[number]["id"];

export const defaultDraft = (): SetupDraft => ({
  directionInvertX: false, directionInvertY: false, directionInvertZ: false,
  stepsX: "250", stepsY: "250", stepsZ: "250",
  calibrationXCommanded: "10", calibrationXActual: "",
  calibrationYCommanded: "10", calibrationYActual: "",
  calibrationZCommanded: "10", calibrationZActual: "",
  limitXPlus: true, limitXMinus: true, limitYPlus: true, limitYMinus: true, limitZPlus: true, limitZMinus: true,
  softLimits: false, hardLimits: false,
  hardLimitInvert: false,
  homingEnable: false,
  homingDirInvertX: false, homingDirInvertY: false, homingDirInvertZ: false,
  homingFeed: "50", homingSeek: "500", homingPullOff: "1.000",
  homingAxisX: true, homingAxisY: true, homingAxisZ: true,
  travelX: "200", travelY: "200", travelZ: "200"
});

export function parseSettingsToDraft(settings: WizardGrblSetting[]): SetupDraft {
  const getS = (k: string, def: string) => settings.find(s => s.key === k || s.key === `$${k}`)?.value?.toString() ?? def;
  const getB = (k: string) => getS(k, "0") === "1";
  const directionInvert = parseInt(getS("3", "0"), 10) || 0;
  const homingInvert = parseInt(getS("23", "0"), 10) || 0;
  const hardLimits = getB("21");
  
  return {
    directionInvertX: (directionInvert & 1) !== 0,
    directionInvertY: (directionInvert & 2) !== 0,
    directionInvertZ: (directionInvert & 4) !== 0,
    stepsX: getS("100", "250"),
    stepsY: getS("101", "250"),
    stepsZ: getS("102", "250"),
    calibrationXCommanded: "10", calibrationXActual: "",
    calibrationYCommanded: "10", calibrationYActual: "",
    calibrationZCommanded: "10", calibrationZActual: "",
    limitXPlus: hardLimits, limitXMinus: hardLimits, limitYPlus: hardLimits, limitYMinus: hardLimits, limitZPlus: hardLimits, limitZMinus: hardLimits,
    softLimits: getB("20"),
    hardLimits,
    hardLimitInvert: getB("5"),
    homingEnable: getB("22"),
    homingDirInvertX: (homingInvert & 1) !== 0,
    homingDirInvertY: (homingInvert & 2) !== 0,
    homingDirInvertZ: (homingInvert & 4) !== 0,
    homingFeed: getS("24", "50"),
    homingSeek: getS("25", "500"),
    homingPullOff: getS("27", "1.000"),
    homingAxisX: true, homingAxisY: true, homingAxisZ: true,
    travelX: getS("130", "200"),
    travelY: getS("131", "200"),
    travelZ: getS("132", "200"),
  };
}

export function diffDraftToSettings(original: SetupDraft, current: SetupDraft): { key: string, old: string | number, new: string | number }[] {
  const diffs: { key: string, old: string | number, new: string | number }[] = [];
  const add = (k: string, o: string | number, n: string | number) => {
    if (String(o) !== String(n)) {
      diffs.push({ key: k, old: o, new: n });
    }
  };
  
  const directionMask = (draft: SetupDraft) => (draft.directionInvertX ? 1 : 0) | (draft.directionInvertY ? 2 : 0) | (draft.directionInvertZ ? 4 : 0);
  add("3", directionMask(original), directionMask(current));
  add("100", original.stepsX, parseFloat(current.stepsX) || 0);
  add("101", original.stepsY, parseFloat(current.stepsY) || 0);
  add("102", original.stepsZ, parseFloat(current.stepsZ) || 0);
  add("20", original.softLimits ? 1 : 0, current.softLimits ? 1 : 0);
  add("21", original.hardLimits ? 1 : 0, current.hardLimits ? 1 : 0);
  add("5", original.hardLimitInvert ? 1 : 0, current.hardLimitInvert ? 1 : 0);
  add("22", original.homingEnable ? 1 : 0, current.homingEnable ? 1 : 0);
  
  const oldMask = (original.homingDirInvertX ? 1 : 0) | (original.homingDirInvertY ? 2 : 0) | (original.homingDirInvertZ ? 4 : 0);
  const newMask = (current.homingDirInvertX ? 1 : 0) | (current.homingDirInvertY ? 2 : 0) | (current.homingDirInvertZ ? 4 : 0);
  add("23", oldMask, newMask);
  
  add("24", original.homingFeed, parseFloat(current.homingFeed) || 0);
  add("25", original.homingSeek, parseFloat(current.homingSeek) || 0);
  add("27", original.homingPullOff, parseFloat(current.homingPullOff) || 0);
  
  add("130", original.travelX, parseFloat(current.travelX) || 0);
  add("131", original.travelY, parseFloat(current.travelY) || 0);
  add("132", original.travelZ, parseFloat(current.travelZ) || 0);
  
  return diffs;
}

function settingsPatch(original: SetupDraft, current: SetupDraft) {
  return Object.fromEntries(diffDraftToSettings(original, current).map((change) => [`$${change.key}`, String(change.new)]));
}

// Subcomponents for each stage

function ConnectionPanel({ head, snap, ports, refreshing, agentOnline, busy, onRefresh, onPort, onBaud, onToggle }: any) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label className="font-mono text-xs text-muted-foreground">Port</Label>
          <Select value={head.port} onValueChange={onPort} disabled={!agentOnline || head.connected || busy}>
            <SelectTrigger data-testid={`setup-select-port-head-${head.id}`} className="font-mono h-11 bg-muted/5"><SelectValue placeholder="Select port" /></SelectTrigger>
            <SelectContent>
              {Array.from(new Set([...ports, head.port])).filter(Boolean).map(p => (
                <SelectItem key={String(p)} value={String(p)}>{String(p)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="font-mono text-xs text-muted-foreground">Baud</Label>
          <Select value={head.baud} onValueChange={onBaud} disabled={!agentOnline || head.connected || busy}>
            <SelectTrigger data-testid={`setup-select-baud-head-${head.id}`} className="font-mono h-11 bg-muted/5"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Array.from(new Set([...BAUD_RATES, head.baud])).filter(Boolean).map(b => (
                <SelectItem key={String(b)} value={String(b)}>{String(b)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
         <Button variant="outline" onClick={onRefresh} disabled={!agentOnline || refreshing || head.connected || busy} data-testid={`setup-button-refresh-ports-head-${head.id}`} className="h-12 w-full shrink-0 sm:w-14">
           <RefreshCw className={cn("w-5 h-5 text-muted-foreground", refreshing && "animate-spin")} />
         </Button>
         <Button onClick={onToggle} disabled={!agentOnline || busy} data-testid={`setup-button-toggle-head-${head.id}`} className="h-12 w-full min-w-0 font-mono text-sm font-bold uppercase tracking-widest shadow-sm sm:flex-1" variant={head.connected ? "outline" : "default"}>
           {busy ? "Working…" : head.connected ? "Disconnect" : "Connect"}
         </Button>
      </div>
      {head.connected && (
        <div className="mt-4 grid grid-cols-1 gap-3 rounded-sm border border-border/50 bg-muted/10 p-4 font-mono text-sm shadow-inner sm:grid-cols-2">
           <span className="flex min-w-0 flex-col gap-0.5 text-muted-foreground">
             <span className="text-[10px] uppercase">Firmware</span>
             <span className="break-words" data-testid={`setup-text-firmware-head-${head.id}`}>{head.firmware || "Unknown"}</span>
           </span>
            <span className="flex min-w-0 flex-col gap-0.5 sm:text-right">
             <span className="text-[10px] uppercase text-muted-foreground">State</span>
             <span className="text-foreground font-bold" data-testid={`setup-text-state-head-${head.id}`}>{snap.state || "Idle"}</span>
           </span>
            <span className="flex flex-col gap-0.5 text-xs"><span className="text-[10px] uppercase text-muted-foreground">Machine position · mm</span><span data-testid={`setup-text-mpos-head-${head.id}`}>X {snap.machinePosition?.x ?? "—"} · Y {snap.machinePosition?.y ?? "—"} · Z {snap.machinePosition?.z ?? "—"}</span></span>
            <span className="flex flex-col gap-0.5 text-xs sm:text-right"><span className="text-[10px] uppercase text-muted-foreground">Work position · mm</span><span data-testid={`setup-text-wpos-head-${head.id}`}>X {snap.workPosition?.x ?? "—"} · Y {snap.workPosition?.y ?? "—"} · Z {snap.workPosition?.z ?? "—"}</span></span>
        </div>
      )}
    </div>
  );
}

function JogPanel({ head, draft, setDraft, jog, step, feed, onStep, onFeed, onApply }: any) {
  if (!head.connected) {
    return <div className="h-64 flex items-center justify-center border border-dashed border-border/50 rounded-sm text-sm font-mono text-muted-foreground uppercase bg-muted/5">Controller offline</div>;
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 rounded-sm border border-border/50 bg-muted/5 p-4 shadow-sm sm:flex-row">
         <div className="flex-1 space-y-2">
           <Label className="font-mono text-xs text-muted-foreground uppercase">Distance (mm)</Label>
           <Input type="number" data-testid={`setup-input-jog-step-head-${head.id}`} value={step} onChange={e => onStep(e.target.value)} className="font-mono h-11 bg-background" />
         </div>
         <div className="flex-1 space-y-2">
           <Label className="font-mono text-xs text-muted-foreground uppercase">Feed (mm/min)</Label>
           <Input type="number" data-testid={`setup-input-jog-feed-head-${head.id}`} value={feed} onChange={e => onFeed(e.target.value)} className="font-mono h-11 bg-background" />
         </div>
       </div>
       <p className="rounded-sm border border-amber-500/30 bg-amber-500/10 p-3 text-sm font-mono text-muted-foreground">Each test movement opens the controller confirmation dialog. Observe the real movement, then select Normal or Inverted. No axis moves automatically.</p>
       
       <div className="flex flex-col items-center justify-center gap-5 rounded-sm border border-border/50 bg-card p-4 shadow-sm sm:flex-row sm:gap-8 sm:p-6">
        {/* XY Pad */}
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <div />
          <Button variant="outline" data-testid={`setup-button-jog-y-plus-head-${head.id}`} className="h-10 w-10 font-mono text-sm font-bold shadow-sm sm:h-16 sm:w-16 sm:text-xl" onPointerDown={() => jog("y", 1)}>Y+</Button>
          <div />
          
          <Button variant="outline" data-testid={`setup-button-jog-x-minus-head-${head.id}`} className="h-10 w-10 font-mono text-sm font-bold shadow-sm sm:h-16 sm:w-16 sm:text-xl" onPointerDown={() => jog("x", -1)}>X-</Button>
          <div className="flex h-10 w-10 items-center justify-center rounded-sm border border-border/30 bg-muted/10 text-muted-foreground sm:h-16 sm:w-16"><Move className="h-5 w-5 opacity-30 sm:h-6 sm:w-6"/></div>
          <Button variant="outline" data-testid={`setup-button-jog-x-plus-head-${head.id}`} className="h-10 w-10 font-mono text-sm font-bold shadow-sm sm:h-16 sm:w-16 sm:text-xl" onPointerDown={() => jog("x", 1)}>X+</Button>
          
          <div />
          <Button variant="outline" data-testid={`setup-button-jog-y-minus-head-${head.id}`} className="h-10 w-10 font-mono text-sm font-bold shadow-sm sm:h-16 sm:w-16 sm:text-xl" onPointerDown={() => jog("y", -1)}>Y-</Button>
          <div />
        </div>
        
        <div className="h-px w-full bg-border/50 sm:h-40 sm:w-px" />
        
        {/* Z Pad */}
        <div className="flex flex-col gap-3">
          <Button variant="outline" data-testid={`setup-button-jog-z-plus-head-${head.id}`} className="h-10 w-10 font-mono text-sm font-bold shadow-sm sm:h-16 sm:w-16 sm:text-xl" onPointerDown={() => jog("z", 1)}>Z+</Button>
          <div className="h-4" />
          <Button variant="outline" data-testid={`setup-button-jog-z-minus-head-${head.id}`} className="h-10 w-10 font-mono text-sm font-bold shadow-sm sm:h-16 sm:w-16 sm:text-xl" onPointerDown={() => jog("z", -1)}>Z-</Button>
        </div>
      </div>
      <div className="space-y-3">
        {(["X", "Y", "Z"] as const).map((axis) => {
          const field = `directionInvert${axis}` as "directionInvertX" | "directionInvertY" | "directionInvertZ";
          return <div key={axis} className="flex items-center justify-between gap-4 rounded-sm border border-border/50 bg-card p-3"><span className="font-mono font-bold">{axis} direction</span><Button variant={draft[field] ? "default" : "outline"} data-testid={`setup-button-invert-${axis.toLowerCase()}-head-${head.id}`} className="font-mono" onClick={() => setDraft({ [field]: !draft[field] })}>{draft[field] ? "Inverted" : "Normal"}</Button></div>;
        })}
      </div>
      <Button className="w-full font-mono" data-testid={`setup-button-apply-direction-head-${head.id}`} onClick={onApply}>Apply motor direction ($3)</Button>
    </div>
  );
}

function CalibrationPanel({ head, draft, setDraft, onTest, onApply }: any) {
  return (
    <div className="space-y-4">
      <div className="space-y-1 mb-6 p-4 border border-border/50 bg-muted/5 rounded-sm">
         <p className="text-sm font-mono text-muted-foreground leading-relaxed">Steps per millimeter defines how many motor pulses equal 1mm of travel. Used to scale all physical motion commands.</p>
      </div>
      <div className="grid grid-cols-[4rem_1fr] items-center gap-4 bg-card p-4 rounded-sm border border-border/50 shadow-sm">
        <Label className="text-2xl font-mono font-bold text-center text-muted-foreground">X</Label>
        <Input type="number" value={draft.stepsX} onChange={e => setDraft({ stepsX: e.target.value })} className="font-mono text-lg h-12 bg-muted/5" />
      </div>
      <div className="grid grid-cols-[4rem_1fr] items-center gap-4 bg-card p-4 rounded-sm border border-border/50 shadow-sm">
        <Label className="text-2xl font-mono font-bold text-center text-muted-foreground">Y</Label>
        <Input type="number" value={draft.stepsY} onChange={e => setDraft({ stepsY: e.target.value })} className="font-mono text-lg h-12 bg-muted/5" />
      </div>
      <div className="grid grid-cols-[4rem_1fr] items-center gap-4 bg-card p-4 rounded-sm border border-border/50 shadow-sm">
        <Label className="text-2xl font-mono font-bold text-center text-muted-foreground">Z</Label>
        <Input type="number" value={draft.stepsZ} onChange={e => setDraft({ stepsZ: e.target.value })} className="font-mono text-lg h-12 bg-muted/5" />
      </div>
       <div className="space-y-3 rounded-sm border border-border/50 bg-card p-4">
         <Label className="font-mono text-sm">Measurement inputs and calculated result</Label>
         {(["X", "Y", "Z"] as const).map((axis) => {
           const commandField = `calibration${axis}Commanded` as "calibrationXCommanded" | "calibrationYCommanded" | "calibrationZCommanded";
           const actualField = `calibration${axis}Actual` as "calibrationXActual" | "calibrationYActual" | "calibrationZActual";
           const stepsField = `steps${axis}` as "stepsX" | "stepsY" | "stepsZ";
           const commanded = Number(draft[commandField]);
           const actual = Number(draft[actualField]);
           const current = Number(draft[stepsField]);
           const calculated = Number.isFinite(current) && commanded > 0 && actual > 0 ? current * commanded / actual : null;
           return <div key={axis} className="grid grid-cols-1 gap-2 rounded-sm border border-border/30 p-3 sm:grid-cols-[2rem_1fr_1fr_auto]"><strong className="font-mono">{axis}</strong><Input type="number" min="0" value={draft[commandField]} onChange={e => setDraft({ [commandField]: e.target.value })} placeholder="Commanded mm" /><Input type="number" min="0" value={draft[actualField]} onChange={e => setDraft({ [actualField]: e.target.value })} placeholder="Actual mm" /><div className="flex gap-2"><Button variant="outline" disabled={!head.connected || !(commanded > 0)} onClick={() => onTest(axis.toLowerCase(), commanded)}>Test</Button><Button variant="outline" disabled={calculated === null} onClick={() => setDraft({ [stepsField]: calculated?.toFixed(3) })}>Calc {calculated === null ? "—" : calculated.toFixed(3)}</Button></div></div>;
         })}
       </div>
       <Button className="w-full font-mono" onClick={onApply}>Apply Steps/mm ($100–$102)</Button>
    </div>
  );
}

function LimitMap({ snap, connected, draft, setDraft }: any) {
  const pins = snap.limitPins;
  const xMinusPin = Boolean(pins?.x0);
  const xPlusPin = Boolean(pins?.x1);
  const yMinusPin = Boolean(pins?.y0);
  const yPlusPin = Boolean(pins?.y1);
  const zMinusPin = Boolean(pins?.z0);
  const zPlusPin = Boolean(pins?.z1);
  const xAxisPin = Boolean(pins?.x);
  const yAxisPin = Boolean(pins?.y);
  const zAxisPin = Boolean(pins?.z);
  const switchState = (specific: string, axis: string) => {
    if (!pins) return { active: false, label: "Telemetry unavailable" };
    const direct = (pins as any)[specific];
    if (typeof direct === "boolean") return { active: direct, label: direct ? "Triggered" : "Not triggered" };
    const aggregate = (pins as any)[axis];
    if (typeof aggregate === "boolean") return { active: aggregate, label: aggregate ? "Axis triggered · switch unspecified" : "Axis clear · switch unspecified" };
    return { active: false, label: "Telemetry unavailable" };
  };
  
  return (
    <div className="space-y-6">
      {!connected && <div className="rounded-sm border border-dashed border-border/50 bg-muted/5 p-4 text-sm font-mono text-muted-foreground">Controller offline — switch telemetry is unavailable until this head is connected. You can still document expected switch positions in the profile.</div>}
      <div className="p-4 bg-muted/10 border border-border/50 rounded-sm">
         <p className="text-sm font-mono text-muted-foreground leading-relaxed">Press physical limit switches on the machine to verify GRBL detects them.</p>
      </div>
      
      <div className="relative aspect-square max-w-[280px] mx-auto bg-card border border-border/50 shadow-sm rounded-sm p-4 flex flex-col items-center justify-center">
        <div className={cn("absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1 text-[10px] font-mono rounded-sm border shadow-sm transition-all duration-75", yPlusPin ? "bg-destructive border-destructive text-destructive-foreground font-bold scale-110" : "bg-muted border-border/50 text-muted-foreground")}>Y+ MAX</div>
        <div className={cn("absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1 text-[10px] font-mono rounded-sm border shadow-sm transition-all duration-75", yMinusPin ? "bg-destructive border-destructive text-destructive-foreground font-bold scale-110" : "bg-muted border-border/50 text-muted-foreground")}>Y- MIN</div>
        
        <div className={cn("absolute left-3 top-1/2 -translate-y-1/2 px-3 py-1 text-[10px] font-mono rounded-sm border shadow-sm origin-center -rotate-90 -translate-x-[18px] transition-all duration-75", xMinusPin ? "bg-destructive border-destructive text-destructive-foreground font-bold scale-110" : "bg-muted border-border/50 text-muted-foreground")}>X- MIN</div>
        <div className={cn("absolute right-3 top-1/2 -translate-y-1/2 px-3 py-1 text-[10px] font-mono rounded-sm border shadow-sm origin-center rotate-90 translate-x-[18px] transition-all duration-75", xPlusPin ? "bg-destructive border-destructive text-destructive-foreground font-bold scale-110" : "bg-muted border-border/50 text-muted-foreground")}>X+ MAX</div>
        
        <div className="w-28 h-28 border-2 border-dashed border-border/80 flex items-center justify-center text-muted-foreground/20 font-mono text-2xl font-bold bg-muted/5 rounded-sm">
          BED
        </div>
      </div>
      
      <div className="flex justify-center mt-4">
        <div className={cn("px-5 py-3 text-xs font-mono rounded-sm border shadow-sm flex items-center gap-3 transition-all duration-75 uppercase tracking-wide", zAxisPin || zMinusPin || zPlusPin ? "bg-destructive border-destructive text-destructive-foreground font-bold scale-105" : "bg-muted border-border/50 text-muted-foreground")}>
          <div className={cn("w-2.5 h-2.5 rounded-full shadow-inner", zAxisPin || zMinusPin || zPlusPin ? "bg-destructive-foreground animate-pulse" : "bg-muted-foreground/30")} />
          Z axis signal {zAxisPin && !zMinusPin && !zPlusPin ? "· switch unspecified" : ""}
        </div>
       </div>
       {(xAxisPin || yAxisPin) && <p className="rounded-sm border border-amber-500/30 bg-amber-500/10 p-3 text-xs font-mono text-muted-foreground">An aggregate GRBL limit pin is active. The diagram does not identify a named min/max switch unless controller telemetry provides it.</p>}
       <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
         {([
           ["X+", "limitXPlus", "x1", "x", "Right / maximum X"],
           ["X−", "limitXMinus", "x0", "x", "Left / minimum X"],
           ["Y+", "limitYPlus", "y1", "y", "Rear / maximum Y"],
           ["Y−", "limitYMinus", "y0", "y", "Front / minimum Y"],
           ["Z+", "limitZPlus", "z1", "z", "Upper / maximum Z"],
           ["Z−", "limitZMinus", "z0", "z", "Lower / minimum Z"],
         ] as const).map(([name, field, pin, axis, physical]) => {
           const status = switchState(pin, axis);
           return <div key={name} className="flex items-center justify-between gap-3 rounded-sm border border-border/50 p-3"><div><div className="font-mono font-bold">{name} limit</div><div className={cn("text-xs text-muted-foreground", status.active && "text-destructive font-bold")}>{physical} · {status.label}</div></div><Switch checked={draft[field]} onCheckedChange={(checked) => setDraft({ [field]: checked })} /></div>;
         })}
       </div>
       <p className="text-xs font-mono text-muted-foreground">Standard GRBL reports active limit signals by axis. Trigger each physical switch individually to verify its location; applying hard limits uses GRBL setting $21 for the controller.</p>
    </div>
  );
}

function SafetyPanel({ draft, setDraft, onApply }: any) {
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-6 p-5 border border-border/50 rounded-sm bg-card shadow-sm hover:border-primary/30 transition-colors">
        <div className="space-y-2">
          <Label className="text-base font-mono uppercase tracking-tight font-bold">Soft Limits</Label>
          <p className="text-sm text-muted-foreground font-mono leading-relaxed max-w-[280px]">Prevents machine from moving beyond max travel. Requires Homing to be enabled. ($20)</p>
        </div>
        <Switch checked={draft.softLimits} onCheckedChange={c => setDraft({ softLimits: c })} />
      </div>
      <div className="flex items-start justify-between gap-6 p-5 border border-border/50 rounded-sm bg-card shadow-sm hover:border-primary/30 transition-colors">
        <div className="space-y-2">
          <Label className="text-base font-mono uppercase tracking-tight font-bold">Hard Limits</Label>
          <p className="text-sm text-muted-foreground font-mono leading-relaxed max-w-[280px]">Immediately halts machine when physical limit switches are triggered. ($21)</p>
        </div>
        <Switch checked={draft.hardLimits} onCheckedChange={c => setDraft({ hardLimits: c })} />
      </div>
      <div className="flex items-start justify-between gap-6 p-5 border border-border/50 rounded-sm bg-card shadow-sm hover:border-primary/30 transition-colors">
        <div className="space-y-2">
          <Label className="text-base font-mono uppercase tracking-tight font-bold">Hard Limit Logic Invert</Label>
          <p className="text-sm text-muted-foreground font-mono leading-relaxed max-w-[280px]">Use only when a verified physical switch reports the opposite electrical state. ($5)</p>
        </div>
        <Switch checked={draft.hardLimitInvert} onCheckedChange={c => setDraft({ hardLimitInvert: c })} />
      </div>
      <Button className="w-full font-mono" onClick={onApply}>Apply safety limits ($20, $21, $5)</Button>
    </div>
  );
}

function HomingPanel({ head, draft, setDraft, onTest, onApply }: any) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 p-5 border border-border/50 rounded-sm bg-card shadow-sm hover:border-primary/30 transition-colors">
        <div className="space-y-1">
          <Label className="text-base font-mono uppercase tracking-tight font-bold">Enable Homing Cycle</Label>
          <p className="text-xs text-muted-foreground font-mono">$22</p>
        </div>
        <Switch checked={draft.homingEnable} onCheckedChange={c => setDraft({ homingEnable: c })} />
      </div>
      
      <div className={cn("space-y-6 transition-all duration-300", !draft.homingEnable && "opacity-50 grayscale-[50%]")}>
         <div className="rounded-sm border border-border/50 bg-muted/5 p-4">
           <Label className="font-mono text-sm">Axes expected to move during homing</Label>
           <div className="mt-3 grid grid-cols-3 gap-2">{(["X", "Y", "Z"] as const).map((axis) => {
             const field = `homingAxis${axis}` as "homingAxisX" | "homingAxisY" | "homingAxisZ";
             return <Button key={axis} variant={draft[field] ? "default" : "outline"} onClick={() => setDraft({ [field]: !draft[field] })} className="font-mono">{axis} {draft[field] ? "moves" : "off"}</Button>;
           })}</div>
           <p className="mt-3 text-xs font-mono text-muted-foreground">GRBL standard firmware determines the physical homing cycle. This checklist documents the expected axes and is stored in the setup profile.</p>
         </div>
        <div className="space-y-4 p-5 border border-border/50 rounded-sm bg-card shadow-sm">
          <Label className="font-mono text-sm uppercase text-muted-foreground">Invert Direction ($23)</Label>
          <div className="grid grid-cols-3 gap-3">
             <Button variant={draft.homingDirInvertX ? "default" : "outline"} className="font-mono text-xs h-12 shadow-sm" onClick={() => setDraft({ homingDirInvertX: !draft.homingDirInvertX })}>
               X {draft.homingDirInvertX ? "INVERT" : "NORM"}
             </Button>
             <Button variant={draft.homingDirInvertY ? "default" : "outline"} className="font-mono text-xs h-12 shadow-sm" onClick={() => setDraft({ homingDirInvertY: !draft.homingDirInvertY })}>
               Y {draft.homingDirInvertY ? "INVERT" : "NORM"}
             </Button>
             <Button variant={draft.homingDirInvertZ ? "default" : "outline"} className="font-mono text-xs h-12 shadow-sm" onClick={() => setDraft({ homingDirInvertZ: !draft.homingDirInvertZ })}>
               Z {draft.homingDirInvertZ ? "INVERT" : "NORM"}
             </Button>
          </div>
        </div>
        
        <div className="grid grid-cols-2 gap-4 p-5 border border-border/50 rounded-sm bg-card shadow-sm">
          <div className="space-y-2">
            <Label className="font-mono text-xs text-muted-foreground uppercase">Homing Feed ($24)</Label>
            <Input type="number" value={draft.homingFeed} onChange={e => setDraft({ homingFeed: e.target.value })} className="font-mono h-11 bg-muted/5" />
          </div>
          <div className="space-y-2">
            <Label className="font-mono text-xs text-muted-foreground uppercase">Homing Seek ($25)</Label>
            <Input type="number" value={draft.homingSeek} onChange={e => setDraft({ homingSeek: e.target.value })} className="font-mono h-11 bg-muted/5" />
          </div>
          <div className="col-span-2 space-y-2 pt-2">
            <Label className="font-mono text-xs text-muted-foreground uppercase">Pull-off mm ($27)</Label>
            <Input type="number" value={draft.homingPullOff} onChange={e => setDraft({ homingPullOff: e.target.value })} className="font-mono h-11 bg-muted/5" />
          </div>
        </div>
       <Button variant="outline" className="w-full font-mono" disabled={!head.connected || !draft.homingEnable} onClick={onTest}>Test homing</Button>
       <Button className="w-full font-mono" onClick={onApply}>Apply homing configuration ($22–$25, $27)</Button>
      </div>
    </div>
  );
}

function TravelPanel({ draft, setDraft, onApply }: any) {
  return (
    <div className="space-y-4">
      <div className="space-y-1 mb-6 p-4 border border-border/50 bg-muted/5 rounded-sm">
         <p className="text-sm font-mono text-muted-foreground leading-relaxed">Max travel distances define the machine's physical volume. Used by soft limits to calculate boundaries relative to origin.</p>
      </div>
      <div className="grid grid-cols-[4rem_1fr] items-center gap-4 bg-card p-4 rounded-sm border border-border/50 shadow-sm">
        <Label className="text-2xl font-mono font-bold text-center text-muted-foreground">X</Label>
        <div className="relative">
          <Input type="number" value={draft.travelX} onChange={e => setDraft({ travelX: e.target.value })} className="font-mono text-lg h-12 bg-muted/5 pr-12" />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-mono text-muted-foreground uppercase">mm</span>
        </div>
      </div>
      <div className="grid grid-cols-[4rem_1fr] items-center gap-4 bg-card p-4 rounded-sm border border-border/50 shadow-sm">
        <Label className="text-2xl font-mono font-bold text-center text-muted-foreground">Y</Label>
        <div className="relative">
          <Input type="number" value={draft.travelY} onChange={e => setDraft({ travelY: e.target.value })} className="font-mono text-lg h-12 bg-muted/5 pr-12" />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-mono text-muted-foreground uppercase">mm</span>
        </div>
      </div>
      <div className="grid grid-cols-[4rem_1fr] items-center gap-4 bg-card p-4 rounded-sm border border-border/50 shadow-sm">
        <Label className="text-2xl font-mono font-bold text-center text-muted-foreground">Z</Label>
        <div className="relative">
          <Input type="number" value={draft.travelZ} onChange={e => setDraft({ travelZ: e.target.value })} className="font-mono text-lg h-12 bg-muted/5 pr-12" />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-mono text-muted-foreground uppercase">mm</span>
        </div>
      </div>
       <Button className="w-full font-mono" onClick={onApply}>Apply maximum travel ($130–$132)</Button>
    </div>
  );
}

function DiffView({ headId, head, original, current, onApply }: any) {
  const diffs = original ? diffDraftToSettings(original, current) : [];
  
  return (
    <div className="space-y-4">
       <div className="space-y-2">
         {diffs.length === 0 ? (
           <div className="h-full flex flex-col items-center justify-center border border-dashed border-border/50 rounded-sm text-sm font-mono text-muted-foreground bg-muted/5">
             <CheckCircle2 className="w-8 h-8 mb-4 opacity-30" />
             <span className="uppercase tracking-widest font-bold opacity-70">No Changes</span>
           </div>
         ) : (
           diffs.map(d => (
             <div key={d.key} className="flex justify-between items-center p-4 border border-border/50 bg-card rounded-sm shadow-sm hover:border-primary/40 transition-colors">
               <span className="font-mono font-bold text-muted-foreground uppercase tracking-wider text-xs bg-muted/20 px-2 py-1 rounded-sm">${d.key}</span>
               <div className="flex items-center font-mono text-sm">
                 <span className="opacity-50 line-through mr-4 decoration-destructive">{d.old}</span>
                 <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
                 <span className="text-primary font-bold ml-4 text-base">{d.new}</span>
               </div>
             </div>
           ))
         )}
       </div>
       <div className="pt-4 border-t border-border/50">
         <Button 
           className="w-full font-mono uppercase tracking-widest h-14 text-sm font-bold shadow-sm" 
            disabled={diffs.length === 0 || !head.connected || !head.setupReady}
            onClick={() => onApply(headId, settingsPatch(original, current), "Apply complete machine setup")}
         >
            {head.connected ? head.setupReady ? `Apply to Head ${headId}` : "Loading controller settings…" : `Head ${headId} Offline`}
         </Button>
       </div>
    </div>
  );
}


export default function MachineSetupWizard(props: MachineSetupWizardProps) {
  const [activeStageIdx, setActiveStageIdx] = useState(0);
  const [jogStep, setJogStep] = useState("10");
  const [jogFeed, setJogFeed] = useState("1000");
  const visibleHeadIds = props.headIds ?? [1, 2];

  const stage = STAGES[activeStageIdx];

  const goNext = () => setActiveStageIdx(i => Math.min(i + 1, STAGES.length - 1));
  const goPrev = () => setActiveStageIdx(i => Math.max(i - 1, 0));

  const renderStageContent = (headId: 1 | 2) => {
    const head = headId === 1 ? props.head1 : props.head2;
    const snap = headId === 1 ? props.snap1 : props.snap2;
    const draft = headId === 1 ? props.draft1 : props.draft2;
    const setDraft = (patch: Partial<SetupDraft>) => props.onDraftChange(headId, patch);
    const origDraft = headId === 1 ? props.originalDraft1 : props.originalDraft2;

    switch (stage.id) {
      case "connection":
        return <ConnectionPanel head={head} snap={snap} ports={props.ports} refreshing={props.refreshingPorts} agentOnline={props.agentOnline ?? true} busy={props.busyHeadId === headId} onRefresh={props.onRefreshPorts} onPort={(v: string) => props.onPortChange(headId, v)} onBaud={(v: string) => props.onBaudChange(headId, v)} onToggle={() => props.onToggleConnection(headId)} />;
      case "direction":
        return <JogPanel head={head} draft={draft} setDraft={setDraft} jog={(a: any, d: number) => props.onJog(headId, a, d * parseFloat(jogStep || "10"), parseFloat(jogFeed || "1000"))} step={jogStep} feed={jogFeed} onStep={setJogStep} onFeed={setJogFeed} onApply={() => props.onApplySettings(headId, { "$3": String((draft.directionInvertX ? 1 : 0) | (draft.directionInvertY ? 2 : 0) | (draft.directionInvertZ ? 4 : 0)) }, "Apply motor direction")} />;
      case "calibration":
        return <CalibrationPanel head={head} draft={draft} setDraft={setDraft} onTest={(axis: "x" | "y" | "z", distance: number) => props.onJog(headId, axis, distance, 200)} onApply={() => props.onApplySettings(headId, { "$100": draft.stepsX, "$101": draft.stepsY, "$102": draft.stepsZ }, "Apply Steps/mm calibration")} />;
      case "limits":
        return <LimitMap snap={snap} connected={head.connected} draft={draft} setDraft={setDraft} />;
      case "safety":
        return <SafetyPanel draft={draft} setDraft={setDraft} onApply={() => props.onApplySettings(headId, { "$20": draft.softLimits ? "1" : "0", "$21": draft.hardLimits ? "1" : "0", "$5": draft.hardLimitInvert ? "1" : "0" }, "Apply hard and soft limits")} />;
      case "homing":
        return <HomingPanel head={head} draft={draft} setDraft={setDraft} onTest={() => props.onHome(headId)} onApply={() => props.onApplySettings(headId, { "$22": draft.homingEnable ? "1" : "0", "$23": String((draft.homingDirInvertX ? 1 : 0) | (draft.homingDirInvertY ? 2 : 0) | (draft.homingDirInvertZ ? 4 : 0)), "$24": draft.homingFeed, "$25": draft.homingSeek, "$27": draft.homingPullOff }, "Apply homing configuration")} />;
      case "travel":
        return <TravelPanel draft={draft} setDraft={setDraft} onApply={() => props.onApplySettings(headId, { "$130": draft.travelX, "$131": draft.travelY, "$132": draft.travelZ }, "Apply maximum machine travel")} />;
      case "summary":
        return <DiffView headId={headId} head={head} original={origDraft} current={draft} onApply={props.onApplySettings} />;
      default:
        return null;
    }
  };

  return (
    <div className="flex w-full flex-col gap-4 bg-background md:flex-row md:gap-6" data-testid="machine-setup-wizard">
      {/* Sidebar Navigation */}
      <nav aria-label="Machine setup stages" className="grid w-full shrink-0 grid-cols-1 gap-2 pb-1 sm:grid-cols-2 md:w-56 md:grid-cols-1 md:pb-0">
        {STAGES.map((s, idx) => {
          const Icon = s.icon;
          const isActive = idx === activeStageIdx;
          
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setActiveStageIdx(idx)}
              aria-current={isActive ? "step" : undefined}
              aria-label={`${s.label}: ${s.desc}`}
              data-testid={`setup-stage-${s.id}`}
              className={cn(
                "flex min-w-0 items-center gap-3 rounded-sm border p-3 text-left transition-colors group",
                isActive 
                  ? "bg-primary/10 border-primary/30 text-primary shadow-sm" 
                  : "bg-card border-border/50 hover:bg-muted/50 hover:border-border text-muted-foreground shadow-sm"
              )}
            >
               <Icon className={cn("h-4 w-4 shrink-0 transition-transform", isActive ? "scale-110 text-primary" : "text-muted-foreground group-hover:scale-110")} />
               <div className="min-w-0">
                 <div className={cn("font-mono text-xs font-bold uppercase tracking-tight", isActive ? "text-primary" : "text-foreground")}>{s.label}</div>
                 <div className="mt-1 hidden truncate font-mono text-[10px] uppercase tracking-wider opacity-70 md:block">{s.desc}</div>
              </div>
            </button>
          )
        })}
      </nav>
      
      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col bg-background md:bg-card border border-border/50 rounded-sm shadow-sm">
        <div className="flex items-center justify-between border-b border-border/50 bg-muted/10 p-4 shadow-inner">
          <div className="min-w-0">
            <h2 className="flex min-w-0 items-center gap-3 break-words font-mono text-lg font-bold uppercase tracking-tight sm:text-xl" aria-live="polite" data-testid="setup-stage-title">
              <stage.icon className="w-5 h-5 text-primary" /> {stage.label}
            </h2>
            <p className="mt-1 break-words font-mono text-[10px] uppercase tracking-normal text-muted-foreground sm:tracking-widest">{stage.desc}</p>
          </div>
        </div>
        
        <div className="p-4 md:p-6">
          <div className="space-y-8">
            {visibleHeadIds.map((headId, index) => {
              const head = headId === 1 ? props.head1 : props.head2;
              return (
                <div key={headId} className={cn("min-w-0", index > 0 && "border-t border-border/60 pt-8")} data-testid={`setup-head-section-${headId}`}>
                  <div className="mb-5 flex min-w-0 flex-wrap items-center gap-3 border-b border-border/50 pb-3">
                    <Badge className={cn("rounded-sm px-3 py-1 font-mono uppercase shadow-sm", headId === 1 ? "bg-chart-1 text-chart-1-foreground hover:bg-chart-1" : "bg-chart-2 text-chart-2-foreground hover:bg-chart-2")}>H{headId}</Badge>
                    <h3 className="font-mono text-lg font-bold uppercase tracking-widest">Head {headId}</h3>
                    {head.connected ? <Badge variant="outline" className="w-full justify-center rounded-sm border-chart-3/50 font-mono text-[10px] uppercase tracking-widest text-chart-3 sm:ml-auto sm:w-auto">Online</Badge> : <Badge variant="outline" className="w-full justify-center rounded-sm border-border/50 font-mono text-[10px] uppercase tracking-widest text-muted-foreground sm:ml-auto sm:w-auto">Offline</Badge>}
                  </div>
                  <div className="min-w-0">
                    {renderStageContent(headId)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        
        {/* Navigation Footer */}
        <div className="flex flex-col items-stretch gap-3 border-t border-border/50 bg-muted/20 p-5 shadow-inner sm:flex-row sm:items-center sm:justify-between">
          <Button variant="outline" onClick={goPrev} disabled={activeStageIdx === 0} className="h-11 w-full font-mono text-xs uppercase tracking-widest sm:w-32">
            <ArrowLeft className="w-4 h-4 mr-2" /> Back
          </Button>
          
          <div className="flex gap-2 hidden sm:flex">
             {STAGES.map((_, i) => (
             <div key={i} aria-hidden="true" className={cn("w-2 h-2 rounded-full transition-all duration-300", i === activeStageIdx ? "bg-primary scale-150" : i < activeStageIdx ? "bg-primary/40" : "bg-border")} />
             ))}
          </div>
          
          {activeStageIdx < STAGES.length - 1 ? (
            <Button onClick={goNext} className="h-11 w-full font-mono text-xs uppercase tracking-widest shadow-sm sm:w-32">
              Next <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          ) : (
            <Button onClick={props.onFinish} className="h-11 w-full bg-chart-3 font-mono text-xs uppercase tracking-widest text-chart-3-foreground shadow-sm hover:bg-chart-3/90 sm:w-32" disabled={!props.onFinish}>
              Done <CheckCircle2 className="w-4 h-4 ml-2" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
