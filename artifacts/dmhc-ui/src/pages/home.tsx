import { useEffect, useState, useRef } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGenerateImageToGcode, useProcessGcode, getListJobsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Upload, Play, FileText, AlertCircle, Image, Loader2, X } from "lucide-react";

export default function Home() {
  const [gcodeContent, setGcodeContent] = useState("");
  const [filename, setFilename] = useState("pasted_code.gcode");
  const [numHeads, setNumHeads] = useState(2);
  const [gapWidth, setGapWidth] = useState(80);
  const [gapStartYEnabled, setGapStartYEnabled] = useState(false);
  const [gapStartY, setGapStartY] = useState<number>(400);
  const [head2ReferenceY, setHead2ReferenceY] = useState(620);
  const [penUpZ, setPenUpZ] = useState(5);
  const [penDownZ, setPenDownZ] = useState(0);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [imgMaxX, setImgMaxX] = useState("250");
  const [imgMaxY, setImgMaxY] = useState("615");
  const [imgXOffset, setImgXOffset] = useState("0");
  const [imgYOffset, setImgYOffset] = useState("0");
  const [imgDetail, setImgDetail] = useState<"low" | "medium" | "high">("medium");
  const [imgMode, setImgMode] = useState<"line-art" | "realistic">("line-art");
  const [imgPenDownZ, setImgPenDownZ] = useState("0");
  const [imgPenUpZ, setImgPenUpZ] = useState("5");
  const [imgThreshold, setImgThreshold] = useState("128");
  const [imgFeedRate, setImgFeedRate] = useState("1000");
  const [imageGenerated, setImageGenerated] = useState(false);
  // Images use the same 80 mm gap as uploaded/manual G-code.
  const IMAGE_GAP_WIDTH_MM = 80;
  const [conversionStatus, setConversionStatus] = useState<"idle" | "reading-image" | "processing" | "loading-workspace" | "success" | "error">("idle");
  const [conversionError, setConversionError] = useState("");
  
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const gcodeInputRef = useRef<HTMLDivElement>(null);

  const processGcode = useProcessGcode();
  const generateGcode = useGenerateImageToGcode();

  useEffect(() => () => { if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl); }, [imagePreviewUrl]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFilename(file.name);
    setImageGenerated(false);
    const reader = new FileReader();
    reader.onload = (event) => {
      if (event.target?.result) {
        setGcodeContent(event.target.result as string);
      }
    };
    reader.readAsText(file);
  };

  const lineCount = gcodeContent ? gcodeContent.split('\n').length : 0;
  const imgMaxXNum = Number(imgMaxX), imgMaxYNum = Number(imgMaxY), imgXOffsetNum = Number(imgXOffset), imgYOffsetNum = Number(imgYOffset), imgPenDownZNum = Number(imgPenDownZ), imgPenUpZNum = Number(imgPenUpZ), imgThresholdNum = Number(imgThreshold), imgFeedRateNum = Number(imgFeedRate);
  const imageSettingsValid = Boolean(imgMaxX) && Boolean(imgMaxY) && Boolean(imgXOffset) && Boolean(imgYOffset) && Boolean(imgPenDownZ) && Boolean(imgPenUpZ) && Boolean(imgThreshold)
    && Number.isFinite(imgMaxXNum) && imgMaxXNum > 0 && imgMaxXNum <= 250
    && Number.isFinite(imgMaxYNum) && imgMaxYNum > 0 && imgMaxYNum <= 615
    && Number.isFinite(imgPenDownZNum) && Number.isFinite(imgPenUpZNum)
    && Number.isInteger(imgThresholdNum) && imgThresholdNum >= 0 && imgThresholdNum <= 255
    && Number.isFinite(imgFeedRateNum) && imgFeedRateNum > 0 && imgFeedRateNum <= 50_000;
  const feedRateError = !imgFeedRate || !Number.isFinite(imgFeedRateNum) || imgFeedRateNum <= 0 || imgFeedRateNum > 50_000
    ? "Drawing feed rate must be a finite number greater than 0 and no greater than 50,000 mm/min."
    : "";

  const handleImageSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!(["image/png", "image/jpeg", "image/webp", "image/bmp", "image/x-ms-bmp"] as string[]).includes(file.type) || file.size > 10 * 1024 * 1024) {
      toast({ title: "Unsupported image", description: "Choose a PNG, JPEG, WEBP, or BMP image no larger than 10 MB.", variant: "destructive" });
      event.target.value = "";
      return;
    }
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImageFile(file); setImageGenerated(false); setImagePreviewUrl(URL.createObjectURL(file)); setConversionStatus("idle"); setConversionError("");
  };
  const removeImage = () => {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImageFile(null); setImagePreviewUrl(null); setConversionStatus("idle"); setConversionError(""); generateGcode.reset();
    if (imageInputRef.current) imageInputRef.current.value = "";
  };
  const handleGenerateGcode = () => {
    if (!imageFile || !imageSettingsValid || generateGcode.isPending) return;
    const currentFile = imageFile;
    setConversionError(""); setConversionStatus("reading-image");
    const reader = new FileReader();
    reader.onerror = () => { setConversionError("Unable to read the selected image."); setConversionStatus("error"); };
    reader.onload = () => {
      if (typeof reader.result !== "string") { setConversionError("Unable to read the selected image."); setConversionStatus("error"); return; }
      setConversionStatus("processing");
      generateGcode.mutate({ data: { imageData: reader.result, maxX: imgMaxXNum, maxY: imgMaxYNum, xOffset: imgXOffsetNum, yOffset: imgYOffsetNum, penDownZ: imgPenDownZNum, penUpZ: imgPenUpZNum, threshold: imgThresholdNum, feedRate: imgFeedRateNum, detail: imgDetail, mode: imgMode, adaptiveThreshold: true } }, {
        onSuccess: (result) => {
          setConversionStatus("loading-workspace");
          window.setTimeout(() => {
            setGcodeContent(result.gcode); setFilename(currentFile.name.replace(/\.[^.]+$/, "") + ".gcode"); setImageGenerated(true); setConversionStatus("success");
            toast({ title: "Image converted", description: `Generated ${result.pathCount} paths.` });
            gcodeInputRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
          }, 300);
        },
        onError: (error: any) => { const detail = error?.data?.error ?? error?.message ?? "Unable to convert image."; setConversionError(detail); setConversionStatus("error"); },
      });
    };
    reader.readAsDataURL(currentFile);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!gcodeContent.trim()) {
      toast({
        title: "No G-code",
        description: "Please upload a file or paste G-code directly.",
        variant: "destructive",
      });
      return;
    }

    processGcode.mutate({
      data: {
        gcodeContent,
        filename,
        numHeads,
        gapWidth: imageGenerated ? IMAGE_GAP_WIDTH_MM : gapWidth,
        gapStartY: gapStartYEnabled ? gapStartY : undefined,
        head2ReferenceY,
        penUpZ,
        penDownZ,
      }
    }, {
      onSuccess: (job) => {
        toast({
          title: "Job processing started",
          description: `Job ID: ${job.id}`,
        });
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
        setLocation(`/viz/${job.id}`);
      },
      onError: (err) => {
        const detail = (err as any)?.data?.error ?? (err as any)?.message ?? "Unknown error occurred";
        toast({
          title: "Processing failed",
          description: detail,
          variant: "destructive",
        });
      }
    });
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:space-y-8 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-2">
        <p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-primary">Job preparation</p>
        <h1 className="text-3xl font-mono font-bold tracking-tight text-foreground sm:text-4xl">Workspace</h1>
        <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">Upload G-code and split the pen path by Y between the two heads.</p>
      </div>

      <form onSubmit={handleSubmit} className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="col-span-1 lg:col-span-2 space-y-6">
          <Card className="border-border">
            <CardHeader>
              <CardTitle>Image to G-code</CardTitle>
              <CardDescription>Convert a PNG, JPEG, WEBP, or BMP image into compact vector-like pen paths.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button type="button" variant="outline" onClick={() => imageInputRef.current?.click()} data-testid="button-upload-image" className="w-full h-20 border-dashed border-2">
                <Image className="w-5 h-5 mr-2" /> Select Image
              </Button>
              <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/bmp,.bmp" onChange={handleImageSelect} data-testid="input-file-image" className="hidden" />
              {imageFile && <div className="flex items-center gap-3 rounded border p-2"><img src={imagePreviewUrl ?? ""} alt="Selected image preview" className="h-16 w-16 rounded object-contain bg-muted" /><span className="min-w-0 flex-1 truncate text-sm">{imageFile.name}</span><Button type="button" variant="ghost" size="icon" onClick={removeImage} data-testid="button-remove-image"><X className="h-4 w-4" /></Button></div>}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1"><Label htmlFor="imgMaxX">X Size / Width (mm)</Label><Input id="imgMaxX" type="number" min="0.0001" max="300" step="any" value={imgMaxX} onChange={e => setImgMaxX(e.target.value)} data-testid="input-image-max-x" aria-invalid={!imageSettingsValid} /></div>
                <div className="space-y-1"><Label htmlFor="imgMaxY">Y Size / Height (mm)</Label><Input id="imgMaxY" type="number" min="0.0001" max="615" step="any" value={imgMaxY} onChange={e => setImgMaxY(e.target.value)} data-testid="input-image-max-y" aria-invalid={!imageSettingsValid} /></div>
                <div className="space-y-1"><Label htmlFor="imgXOffset">X Position / Offset (mm)</Label><Input id="imgXOffset" type="number" min="0" max="300" step="any" value={imgXOffset} onChange={e => setImgXOffset(e.target.value)} data-testid="input-image-x-offset" aria-invalid={!imageSettingsValid} /></div>
                <div className="space-y-1"><Label htmlFor="imgYOffset">Y Position / Offset (mm)</Label><Input id="imgYOffset" type="number" min="0" max="615" step="any" value={imgYOffset} onChange={e => setImgYOffset(e.target.value)} data-testid="input-image-y-offset" aria-invalid={!imageSettingsValid} /></div>
                <div className="space-y-1"><Label htmlFor="imgPenUpZ">Pen up Z</Label><Input id="imgPenUpZ" value={imgPenUpZ} onChange={e => setImgPenUpZ(e.target.value)} data-testid="input-image-pen-up-z" aria-invalid={!imageSettingsValid} /></div>
                <div className="space-y-1"><Label htmlFor="imgPenDownZ">Pen down Z</Label><Input id="imgPenDownZ" value={imgPenDownZ} onChange={e => setImgPenDownZ(e.target.value)} data-testid="input-image-pen-down-z" aria-invalid={!imageSettingsValid} /></div>
                <div className="space-y-1 col-span-2"><Label htmlFor="imgThreshold">Threshold (0–255)</Label><Input id="imgThreshold" value={imgThreshold} onChange={e => setImgThreshold(e.target.value)} data-testid="input-image-threshold" aria-invalid={!imageSettingsValid} /></div>
                <div className="space-y-1 col-span-2"><Label>Detail</Label><Select value={imgDetail} onValueChange={(value: "low" | "medium" | "high") => setImgDetail(value)}><SelectTrigger data-testid="select-image-detail"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="low">Low</SelectItem><SelectItem value="medium">Medium</SelectItem><SelectItem value="high">High</SelectItem></SelectContent></Select></div>
                <div className="space-y-1 col-span-2"><Label>Rendering mode</Label><Select value={imgMode} onValueChange={(value: "line-art" | "realistic") => setImgMode(value)}><SelectTrigger data-testid="select-image-mode"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="line-art">Line art (outlines)</SelectItem><SelectItem value="realistic">Realistic (outlines + crosshatching)</SelectItem></SelectContent></Select></div>
                <div className="space-y-1 col-span-2"><Label htmlFor="imgFeedRate">Drawing Feed Rate (mm/min)</Label><Input id="imgFeedRate" type="number" min="1" max="50000" step="any" value={imgFeedRate} onChange={e => setImgFeedRate(e.target.value)} data-testid="input-image-feed-rate" aria-invalid={!imageSettingsValid} /></div>
                {(Number.isFinite(imgMaxXNum) && (imgMaxXNum <= 0 || imgMaxXNum > 300)) && <p className="col-span-2 text-sm text-destructive" role="alert">X size must be greater than 0 and no greater than 300 mm.</p>}
                 {(Number.isFinite(imgMaxYNum) && (imgMaxYNum <= 0 || imgMaxYNum > 615)) && <p className="col-span-2 text-sm text-destructive" role="alert">Y size must be greater than 0 and no greater than 615 mm.</p>}
                 {(Number.isFinite(imgXOffsetNum) && Number.isFinite(imgMaxXNum) && imgXOffsetNum + imgMaxXNum > 300) && <p className="col-span-2 text-sm text-destructive" role="alert">X offset + X size must stay within 300 mm.</p>}
                 {(Number.isFinite(imgYOffsetNum) && Number.isFinite(imgMaxYNum) && imgYOffsetNum + imgMaxYNum > 615) && <p className="col-span-2 text-sm text-destructive" role="alert">Y offset + Y size must stay within 615 mm.</p>}
                 {feedRateError && <p className="col-span-2 text-sm text-destructive" role="alert">{feedRateError}</p>}
              </div>
              <Button type="button" onClick={handleGenerateGcode} disabled={!imageFile || !imageSettingsValid || generateGcode.isPending} data-testid="button-generate-gcode" className="w-full">
                {generateGcode.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Generate G-code
              </Button>
              {conversionStatus === "reading-image" && <p className="text-sm text-muted-foreground">Reading image data...</p>}
              {conversionStatus === "processing" && <p className="text-sm text-muted-foreground">Generating G-code toolpaths...</p>}
              {conversionStatus === "loading-workspace" && <p className="text-sm text-muted-foreground">Loading into workspace...</p>}
              {conversionStatus === "success" && <p className="text-sm text-green-700">Image converted successfully. The G-code is ready for review below.</p>}
              {conversionStatus === "error" && <p className="text-sm text-destructive">Conversion failed: {conversionError}</p>}
            </CardContent>
          </Card>
          <Card className="border-border" ref={gcodeInputRef}>
            <CardHeader>
              <CardTitle id="gcode-input-title">G-code Input</CardTitle>
              <CardDescription>Upload a .gcode or .nc file, or paste text below.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-4">
                <Button 
                  type="button" 
                  variant="outline" 
                  onClick={() => fileInputRef.current?.click()}
                  data-testid="button-upload-gcode"
                  className="w-full h-24 border-dashed border-2 hover:bg-muted/50 transition-colors flex flex-col gap-2 text-muted-foreground hover:text-foreground"
                >
                  <Upload className="w-6 h-6" />
                  <span>Select File</span>
                </Button>
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  accept=".gcode,.nc,.txt" 
                  onChange={handleFileUpload}
                  data-testid="input-file-gcode"
                  className="hidden" 
                />
              </div>

              {gcodeContent && (
                <div className="flex items-center text-xs font-mono text-muted-foreground bg-muted/20 p-2 rounded border border-border/50" data-testid="text-filename">
                  <FileText className="w-4 h-4 mr-2 text-primary" />
                  <span className="flex-1 truncate">{filename}</span>
                  <span data-testid="text-line-count">{lineCount.toLocaleString()} lines</span>
                </div>
              )}

              <Textarea 
                placeholder="Or paste G-code here..." 
                aria-labelledby="gcode-input-title"
                className="font-mono text-xs h-64 whitespace-pre font-normal bg-card"
                value={gcodeContent}
                data-testid="textarea-gcode"
                onChange={(e) => {
                  setGcodeContent(e.target.value);
                  if (filename === "pasted_code.gcode" && e.target.value.trim() === "") {
                    setFilename("pasted_code.gcode");
                  }
                }}
              />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle id="compiler-parameters-title">Parameters</CardTitle>
              <CardDescription>Configure the Y gap, Head 2 reference, and pen positions.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="numHeads">Number of Heads</Label>
                 <Input
                  id="numHeads" 
                  type="number" 
                  min={2} 
                  max={3} 
                  value={numHeads} 
                  data-testid="input-num-heads"
                  onChange={(e) => setNumHeads(Number(e.target.value))} 
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="gapWidth">Y Gap Width (mm)</Label>
                <Input 
                  id="gapWidth" 
                  type="number" 
                  step="0.1" 
                  min={0} 
                  value={gapWidth} 
                  data-testid="input-gap-width"
                  onChange={(e) => setGapWidth(Number(e.target.value))} 
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="gapStartY">Gap Start Y (mm)</Label>
                  <button
                    type="button"
                    data-testid="button-toggle-gap-start"
                    onClick={() => setGapStartYEnabled(!gapStartYEnabled)}
                    className={`text-xs px-2 py-0.5 rounded-sm border font-mono transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      gapStartYEnabled
                        ? "bg-primary text-primary-foreground border-primary"
                        : "text-muted-foreground border-border hover:border-primary/50"
                    }`}
                  >
                    {gapStartYEnabled ? "Manual" : "Auto"}
                  </button>
                </div>
                <Input
                  id="gapStartY"
                  type="number"
                  step="0.1"
                  value={gapStartY}
                  disabled={!gapStartYEnabled}
                  data-testid="input-gap-start-y"
                  onChange={(e) => setGapStartY(Number(e.target.value))}
                  className={!gapStartYEnabled ? "opacity-40" : ""}
                />
                <p className="text-xs text-muted-foreground font-mono">
                  {gapStartYEnabled
                    ? `Gap: Y=${gapStartY} → Y=${(gapStartY + gapWidth).toFixed(1)}`
                    : "Optimizer selects the optimal position"}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="head2ReferenceY">Head 2 Reference Y (mm)</Label>
                <Input
                  id="head2ReferenceY"
                  type="number" 
                  step="0.1" 
                  min={0} 
                  value={head2ReferenceY}
                  data-testid="input-head2-reference-y"
                  onChange={(e) => setHead2ReferenceY(Number(e.target.value))}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="penUpZ">Pen Up Z</Label>
                  <Input
                    id="penUpZ"
                    type="number"
                    step="0.1"
                    value={penUpZ}
                    data-testid="input-pen-up-z"
                    onChange={(e) => setPenUpZ(Number(e.target.value))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="penDownZ">Pen Down Z</Label>
                  <Input
                    id="penDownZ"
                    type="number"
                    step="0.1"
                    value={penDownZ}
                    data-testid="input-pen-down-z"
                    onChange={(e) => setPenDownZ(Number(e.target.value))}
                  />
                </div>
              </div>
               <div className="text-xs text-muted-foreground font-mono border border-border/50 rounded-sm p-3 bg-muted/10" role="note">
                Partition axis: <strong>Y</strong>. Tool radius and safety margin are disabled for pen mode.
                Head 2 outputs mirrored local Y coordinates around the reference above.
              </div>
            </CardContent>
            <CardFooter className="pt-6">
              <Button type="submit" data-testid="button-run-compiler" aria-busy={processGcode.isPending} className="w-full h-12 text-base font-bold tracking-widest uppercase" disabled={processGcode.isPending || !gcodeContent.trim()}>
                {processGcode.isPending ? (
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                ) : (
                  <Play className="w-5 h-5 mr-2" />
                )}
                Run Compiler
              </Button>
            </CardFooter>
          </Card>

          {!gcodeContent && (
            <div className="flex items-start gap-3 p-4 rounded-sm border border-chart-2/20 bg-chart-2/10 text-chart-2 text-sm font-mono" role="status" data-testid="status-no-gcode">
              <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <p>No G-code loaded. Please drop a file or paste content to begin processing.</p>
            </div>
          )}
        </div>
      </form>
    </div>
  );
}
