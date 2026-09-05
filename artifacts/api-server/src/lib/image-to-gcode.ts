import { execFile as execFileCallback } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const IMAGE_TO_GCODE_LIMITS = {
  maxX: 300,
  maxY: 615,
  maxUploadBytes: 10 * 1024 * 1024,
  maxInputPixels: 20_000_000,
  maxRasterDimension: 1000,
  maxPaths: 5_000,
  maxFeedRate: 50_000,
} as const;

const DATA_URL_RE = /^data:(image\/(png|jpeg|webp|bmp|x-ms-bmp));base64,([\s\S]*)$/i;
const SUPPORTED_FORMATS = new Set(["PNG", "JPEG", "WEBP", "BMP"]);
const MIME_TO_FORMAT: Record<string, string> = { "image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP", "image/bmp": "BMP", "image/x-ms-bmp": "BMP" };

export type DetailLevel = "low" | "medium" | "high";
export type RenderingMode = "line-art" | "realistic";
export interface ImageToGcodeOptions { imageData: string; maxX: number; maxY: number; penDownZ: number; penUpZ: number; threshold: number; feedRate: number; detail?: DetailLevel; adaptiveThreshold?: boolean; mode?: RenderingMode; xOffset?: number; yOffset?: number; }
export interface BoundingBox { xMin: number; xMax: number; yMin: number; yMax: number; }
export interface ImageToGcodeResult {
  gcode: string; width: number; height: number; penDownZ: number; penUpZ: number; threshold: number; feedRate: number;
  sourceWidth: number; sourceHeight: number; pathCount: number; commandCount: number; bounds: BoundingBox; detail: DetailLevel;
}
interface RasterPoint { x: number; y: number; }
interface VectorPath { points: RasterPoint[]; closed: boolean; }

export class ImageToGcodeError extends Error {
  constructor(message: string, public readonly statusCode: 400 | 413 = 400) { super(message); this.name = "ImageToGcodeError"; }
}

function finite(value: number, label: string) { if (!Number.isFinite(value)) throw new ImageToGcodeError(`${label} must be a finite number.`); }
export function validateOptions(options: ImageToGcodeOptions): void {
  finite(options.maxX, "X dimension"); finite(options.maxY, "Y dimension"); finite(options.penDownZ, "Pen down Z"); finite(options.penUpZ, "Pen up Z"); finite(options.threshold, "Threshold"); finite(options.feedRate, "Drawing feed rate");
  if (options.maxX <= 0 || options.maxX > IMAGE_TO_GCODE_LIMITS.maxX) throw new ImageToGcodeError("X dimension must be greater than 0 and no greater than 300 mm.");
  if (options.maxY <= 0 || options.maxY > IMAGE_TO_GCODE_LIMITS.maxY) throw new ImageToGcodeError("Y dimension must be greater than 0 and no greater than 615 mm.");
  if (!Number.isInteger(options.threshold) || options.threshold < 0 || options.threshold > 255) throw new ImageToGcodeError("Threshold must be an integer from 0 to 255.");
  if (options.feedRate <= 0 || options.feedRate > IMAGE_TO_GCODE_LIMITS.maxFeedRate) throw new ImageToGcodeError(`Drawing feed rate must be greater than 0 and no greater than ${IMAGE_TO_GCODE_LIMITS.maxFeedRate} mm/min.`);
  if (options.detail !== undefined && !["low", "medium", "high"].includes(options.detail)) throw new ImageToGcodeError("Detail must be low, medium, or high.");
  if (options.mode !== undefined && !["line-art", "realistic"].includes(options.mode)) throw new ImageToGcodeError("Mode must be line-art or realistic.");
  finite(options.xOffset ?? 0, "X offset"); finite(options.yOffset ?? 0, "Y offset");
  if ((options.xOffset ?? 0) < 0 || (options.yOffset ?? 0) < 0 || (options.xOffset ?? 0) + options.maxX > 300 || (options.yOffset ?? 0) + options.maxY > 615) throw new ImageToGcodeError("Drawing area exceeds the 300 x 615 mm machine workspace.");
}

export function decodeImageData(imageData: string): { mimeType: string; bytes: Buffer } {
  const match = typeof imageData === "string" ? imageData.match(DATA_URL_RE) : null;
  if (!match) throw new ImageToGcodeError("A PNG, JPEG, WEBP, or BMP image Data URL is required.");
  const bytes = Buffer.from(match[3].replace(/\s/g, ""), "base64");
  if (!bytes.length) throw new ImageToGcodeError("Image data is empty.");
  if (bytes.length > IMAGE_TO_GCODE_LIMITS.maxUploadBytes) throw new ImageToGcodeError("Image upload exceeds the 10 MiB limit.", 413);
  return { mimeType: match[1].toLowerCase(), bytes };
}

async function runImageMagick(args: string[], maxBuffer = 2 * 1024 * 1024): Promise<string> {
  const command = process.env.IMAGE_MAGICK_COMMAND?.trim() || "magick";
  try {
    const result = await execFile(command, ["-limit", "memory", "128MiB", "-limit", "map", "256MiB", "-limit", "disk", "256MiB", ...args], { maxBuffer });
    return String(result.stdout).trim();
  } catch (error: any) {
    if (error?.code === "ENOENT") throw new Error("ImageMagick is not available");
    throw new ImageToGcodeError("Unable to read image.");
  }
}

async function readImageMetadata(inputPath: string): Promise<{ format: string; width: number; height: number }> {
  const fields = (await runImageMagick([inputPath, "-format", "%m %w %h", "info:"])).trim().split(/\s+/);
  const [format, widthText, heightText] = fields;
  const width = Number(widthText), height = Number(heightText);
  if (!SUPPORTED_FORMATS.has(format) || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new ImageToGcodeError("Unable to read image.");
  if (width * height > IMAGE_TO_GCODE_LIMITS.maxInputPixels) throw new ImageToGcodeError("Image dimensions are too large to process safely.", 413);
  return { format, width, height };
}

export function getRasterSize(width: number, height: number) {
  const scale = Math.min(1, IMAGE_TO_GCODE_LIMITS.maxRasterDimension / width, IMAGE_TO_GCODE_LIMITS.maxRasterDimension / height);
  return { width: Math.max(2, Math.round(width * scale)), height: Math.max(2, Math.round(height * scale)) };
}

/** Separable Gaussian used by XDoG itself (never as the denoising stage). */
function gaussianBlur(pixels: Uint8Array, width: number, height: number, sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3)), kernel = new Float32Array(radius * 2 + 1);
  let total = 0;
  for (let i = -radius; i <= radius; i++) { const value = Math.exp(-(i * i) / (2 * sigma * sigma)); kernel[i + radius] = value; total += value; }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= total;
  const horizontal = new Float32Array(width * height), output = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let value = 0; for (let k = -radius; k <= radius; k++) value += pixels[y * width + Math.max(0, Math.min(width - 1, x + k))] * kernel[k + radius]; horizontal[y * width + x] = value;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let value = 0; for (let k = -radius; k <= radius; k++) value += horizontal[Math.max(0, Math.min(height - 1, y + k)) * width + x] * kernel[k + radius]; output[y * width + x] = value;
  }
  return output;
}

/** eXtended Difference of Gaussians: continuous tonal transitions become connected ink lines. */
export function buildXdogMask(pixels: Uint8Array, width: number, height: number, threshold: number, detail: DetailLevel = "medium"): Uint8Array {
  const sigma = detail === "low" ? 1.25 : detail === "high" ? .72 : .95;
  const narrow = gaussianBlur(pixels, width, height, sigma), wide = gaussianBlur(pixels, width, height, sigma * 1.6);
  const output = new Uint8Array(width * height), tau = .985;
  // Threshold remains an intuitive sensitivity control. At 128 this selects the
  // negative DoG lobe; higher values retain progressively softer line detail.
  const cutoff = (threshold - 128) * .055;
  for (let i = 0; i < output.length; i++) {
    const dog = narrow[i] - tau * wide[i];
    const xdog = dog < 0 ? 1 : 1 + Math.tanh(10 * dog / 255);
    output[i] = (dog <= cutoff && xdog < 1.02) ? 1 : 0;
  }
  return morphologicalCleanup(output, width, height);
}

function pathLength(path: VectorPath): number {
  let length = 0; for (let i = 1; i < path.points.length; i++) length += Math.hypot(path.points[i].x-path.points[i-1].x,path.points[i].y-path.points[i-1].y);
  if (path.closed) length += Math.hypot(path.points[0].x-path.points.at(-1)!.x,path.points[0].y-path.points.at(-1)!.y); return length;
}

/**
 * Tone pass for a pen plotter.
 *
 * A photo cannot be represented by a single outline.  We therefore encode
 * luminance as line density: light pixels get few/no strokes, while dark
 * pixels receive several passes at different angles.  The thresholds are
 * intentionally soft so mid-tones survive instead of collapsing to black.
 */
export function buildHatchingPaths(pixels: Uint8Array, width: number, height: number, detail: DetailLevel = "medium"): VectorPath[] {
  const settings = {
    low:    { spacing: 11, levels: [0.30, 0.55] },
    medium: { spacing: 8,  levels: [0.18, 0.38, 0.58] },
    high:   { spacing: 5,  levels: [0.10, 0.27, 0.44, 0.61, 0.76] },
  }[detail];

  const paths: VectorPath[] = [];

  // Four directions are used progressively. This avoids the old two-pass
  // diagonal look and gives much better tonal coverage in photographs.
  const addPass = (slope: 1 | -1, level: number, phase: number) => {
    for (let intercept = -height - settings.spacing + phase; intercept < width + height; intercept += settings.spacing) {
      let run: RasterPoint[] = [];
      for (let y = 0; y < height; y++) {
        const x = Math.round(intercept + (slope === 1 ? y : height - 1 - y));
        const dark = x >= 0 && x < width && (255 - pixels[y * width + x]) / 255 >= level;
        if (dark) run.push({ x, y });
        if ((!dark || y === height - 1) && run.length) {
          // Very short runs mostly represent noise and waste machine time.
          if (run.length >= 2) paths.push({ points: [run[0], run.at(-1)!], closed: false });
          run = [];
        }
      }
    }
  };

  // Light/mid tones use one diagonal family. Darker tones add perpendicular
  // and then orthogonal passes, creating a controllable pen-density gradient.
  for (let i = 0; i < settings.levels.length; i++) {
    const level = settings.levels[i];
    addPass(i % 2 === 0 ? 1 : -1, level, (i * Math.floor(settings.spacing / 2)) % settings.spacing);
  }

  // At high detail, add sparse horizontal/vertical micro-strokes for fine
  // texture. They are gated by a stronger darkness threshold so they don't
  // overfill the entire image.
  if (detail === "high") {
    const addOrthogonal = (horizontal: boolean) => {
      const spacing = 7;
      for (let line = 0; line < (horizontal ? height : width); line += spacing) {
        let run: RasterPoint[] = [];
        const limit = horizontal ? width : height;
        for (let p = 0; p < limit; p++) {
          const x = horizontal ? p : line;
          const y = horizontal ? line : p;
          const dark = (255 - pixels[y * width + x]) / 255 >= 0.72;
          if (dark) run.push({ x, y });
          if ((!dark || p === limit - 1) && run.length) {
            if (run.length >= 2) paths.push({ points: [run[0], run.at(-1)!], closed: false });
            run = [];
          }
        }
      }
    };
    addOrthogonal(true);
    addOrthogonal(false);
  }

  return paths;
}

/**
 * High-fidelity halftone pass.
 *
 * A Bayer dither converts continuous grayscale into deterministic pen/no-pen
 * cells.  Unlike a binary threshold this preserves faces, shadows and subtle
 * gradients.  Each active cell is a tiny stroke rather than a filled bitmap,
 * keeping the generated G-code compatible with a simple pen/Z controller.
 */
export function buildHalftonePaths(
  pixels: Uint8Array,
  width: number,
  height: number,
  detail: DetailLevel = "medium",
): VectorPath[] {
  const matrix = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];
  const step = detail === "high" ? 4 : detail === "medium" ? 6 : 9;
  const dot = detail === "high" ? 1.35 : detail === "medium" ? 1.0 : 0.8;
  const paths: VectorPath[] = [];

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      // Average a small cell instead of sampling one pixel. This suppresses
      // JPEG noise and makes the tone stable after resizing.
      let sum = 0, count = 0;
      const yEnd = Math.min(height, y + step);
      const xEnd = Math.min(width, x + step);
      for (let yy = y; yy < yEnd; yy++) {
        for (let xx = x; xx < xEnd; xx++) {
          sum += pixels[yy * width + xx];
          count++;
        }
      }
      const darkness = 1 - sum / Math.max(1, count) / 255;
      const threshold = (matrix[Math.floor(y / step) % 4][Math.floor(x / step) % 4] + 0.5) / 16;

      if (darkness <= threshold) continue;

      const cx = Math.min(width - 1, x + Math.floor((xEnd - x) / 2));
      const cy = Math.min(height - 1, y + Math.floor((yEnd - y) / 2));
      const radius = dot * (0.35 + 0.65 * darkness);
      // Short cross strokes read as dots at machine scale and are much cheaper
      // than circles while still retaining photographic tone.
      paths.push({
        points: [
          { x: cx - radius, y: cy },
          { x: cx + radius, y: cy },
        ],
        closed: false,
      });
    }
  }
  return paths;
}

function neighborIndexes(mask: Uint8Array, index: number, width: number, height: number): number[] {
  const x = index % width, y = Math.floor(index / width); const result: number[] = [];
  for (const [dx, dy] of [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]]) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || nx >= width || ny < 0 || ny >= height || !mask[ny * width + nx]) continue;
    // Either orthogonal pixel is already a two-edge bridge to this diagonal.
    // Keeping the diagonal as well creates triangular corner graphs and
    // produces duplicate short traces around otherwise rectangular loops.
    if (dx && dy && (mask[y * width + nx] || mask[ny * width + x])) continue;
    result.push(ny * width + nx);
  }
  return result;
}

export function buildBinaryMask(pixels: Buffer, width: number, height: number, threshold: number): Uint8Array {
  const mask = new Uint8Array(width * height); for (let i = 0; i < mask.length; i++) mask[i] = pixels[i] <= threshold ? 1 : 0; return mask;
}
export function buildAdaptiveBinaryMask(pixels: Buffer, width: number, height: number, threshold: number): Uint8Array {
  // Integral-image local means compensate for uneven illumination. The user
  // threshold remains a bias, so the existing control continues to be useful.
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) { row += pixels[y * width + x]; integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1] + row; }
  }
  const radius = Math.max(4, Math.round(Math.min(width, height) / 32)), bias = (threshold - 128) * 0.45 - 7;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const x0=Math.max(0,x-radius), x1=Math.min(width-1,x+radius), y0=Math.max(0,y-radius), y1=Math.min(height-1,y+radius), stride=width+1;
    const sum=integral[(y1+1)*stride+x1+1]-integral[y0*stride+x1+1]-integral[(y1+1)*stride+x0]+integral[y0*stride+x0];
    mask[y*width+x] = pixels[y*width+x] <= sum / ((x1-x0+1)*(y1-y0+1)) + bias ? 1 : 0;
  }
  return mask;
}

export function morphologicalCleanup(mask: Uint8Array, width: number, height: number): Uint8Array {
  const output = mask.slice();
  // Remove only truly isolated pixels, then bridge one-pixel orthogonal gaps.
  for (let y=1;y<height-1;y++) for (let x=1;x<width-1;x++) {
    const i=y*width+x; if (!mask[i]) continue; let count=0;
    for (let dy=-1;dy<=1;dy++) for (let dx=-1;dx<=1;dx++) if ((dx||dy) && mask[(y+dy)*width+x+dx]) count++;
    if (!count) output[i]=0;
  }
  const bridged=output.slice();
  for (let y=1;y<height-1;y++) for (let x=1;x<width-1;x++) {
    const i=y*width+x; if (output[i]) continue;
    if ((output[i-1]&&output[i+1]) || (output[i-width]&&output[i+width])) bridged[i]=1;
  }
  return bridged;
}
export function removeSmallComponents(mask: Uint8Array, width: number, height: number): Uint8Array {
  const output = new Uint8Array(mask.length), seen = new Uint8Array(mask.length); const minimum = Math.max(2, Math.min(12, Math.floor((width * height) / 50_000)));
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const component: number[] = [start]; seen[start] = 1;
    for (let i = 0; i < component.length; i++) for (const next of neighborIndexes(mask, component[i], width, height)) if (!seen[next]) { seen[next] = 1; component.push(next); }
    if (component.length >= minimum) for (const pixel of component) output[pixel] = 1;
  }
  return output;
}

function thinningNeighbors(mask: Uint8Array, x: number, y: number, width: number) { return [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]].map(([dx,dy]) => mask[(y + dy) * width + x + dx]); }
export function skeletonize(mask: Uint8Array, width: number, height: number): Uint8Array {
  const output = mask.slice();
  for (let iteration = 0; iteration < 200; iteration++) {
    let changed = false;
    for (let pass = 0; pass < 2; pass++) {
      const remove: number[] = [];
      for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
        const index = y * width + x; if (!output[index]) continue; const p = thinningNeighbors(output, x, y, width);
        const count = p.reduce((a, b) => a + b, 0); const transitions = p.reduce((sum, value, i) => sum + (!value && p[(i + 1) % 8] ? 1 : 0), 0);
        if (count < 2 || count > 6 || transitions !== 1) continue;
        const condition = pass === 0 ? p[0] * p[2] * p[4] === 0 && p[2] * p[4] * p[6] === 0 : p[0] * p[2] * p[6] === 0 && p[0] * p[4] * p[6] === 0;
        if (condition) remove.push(index);
      }
      if (remove.length) { changed = true; for (const index of remove) output[index] = 0; }
    }
    if (!changed) break;
  }
  return output;
}

const edgeKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
export function traceSkeletonPaths(skeleton: Uint8Array, width: number, height: number): VectorPath[] {
  const neighbors = new Map<number, number[]>(); for (let i = 0; i < skeleton.length; i++) if (skeleton[i]) neighbors.set(i, neighborIndexes(skeleton, i, width, height));
  const visited = new Set<string>(); const paths: VectorPath[] = [];
  const trace = (start: number, next: number) => {
    const points = [start]; let previous = start, current = next; visited.add(edgeKey(start, next));
    while (true) { points.push(current); const candidates = (neighbors.get(current) ?? []).filter((candidate) => candidate !== previous && !visited.has(edgeKey(current, candidate)));
      if (current === start) break;
      if ((neighbors.get(current)?.length ?? 0) !== 2 || !candidates.length) break;
      const following = candidates[0]; visited.add(edgeKey(current, following)); previous = current; current = following;
    }
    const closed = points.length > 2 && points[points.length - 1] === start; if (closed) points.pop();
    paths.push({ points: points.map((point) => ({ x: point % width, y: Math.floor(point / width) })), closed });
  };
  for (const [node, list] of neighbors) if (list.length !== 2) for (const next of list) if (!visited.has(edgeKey(node, next))) trace(node, next);
  for (const [node, list] of neighbors) for (const next of list) if (!visited.has(edgeKey(node, next))) trace(node, next);
  return paths;
}

export function dedupePoints(points: RasterPoint[]) { return points.filter((point, index) => !index || point.x !== points[index - 1].x || point.y !== points[index - 1].y); }
export function perpendicularDistance(point: RasterPoint, start: RasterPoint, end: RasterPoint) { const dx = end.x - start.x, dy = end.y - start.y; if (!dx && !dy) return Math.hypot(point.x - start.x, point.y - start.y); return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / Math.hypot(dx, dy); }
export function simplifyPolyline(points: RasterPoint[], tolerance = 1.25): RasterPoint[] {
  if (points.length < 3) return points; let index = -1, maxDistance = tolerance;
  for (let i = 1; i < points.length - 1; i++) { const distance = perpendicularDistance(points[i], points[0], points[points.length - 1]); if (distance > maxDistance) { index = i; maxDistance = distance; } }
  return index < 0 ? [points[0], points[points.length - 1]] : [...simplifyPolyline(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplifyPolyline(points.slice(index), tolerance)];
}
export function snapAxisAlignedRectangle(points: RasterPoint[]): RasterPoint[] {
  if (points.length < 4 || points.length > 6) return points;
  const xMin = Math.min(...points.map(p => p.x)), xMax = Math.max(...points.map(p => p.x)), yMin = Math.min(...points.map(p => p.y)), yMax = Math.max(...points.map(p => p.y));
  const corners = [{x:xMin,y:yMin},{x:xMax,y:yMin},{x:xMax,y:yMax},{x:xMin,y:yMax}]; const mapped = points.map(point => corners.reduce((best, corner) => Math.hypot(point.x-corner.x, point.y-corner.y) < Math.hypot(point.x-best.x, point.y-best.y) ? corner : best, corners[0]));
  if (mapped.some((point, index) => Math.hypot(point.x - points[index].x, point.y - points[index].y) > 2.5) || new Set(mapped.map(p => `${p.x}:${p.y}`)).size !== 4) return points;
  for (let i = 0; i < mapped.length; i++) { const a = mapped[i], b = mapped[(i + 1) % mapped.length]; if (a.x !== b.x && a.y !== b.y) return points; }
  const ordered: RasterPoint[] = [];
  for (const point of mapped) if (!ordered.length || point.x !== ordered[ordered.length - 1].x || point.y !== ordered[ordered.length - 1].y) ordered.push(point);
  if (ordered.length > 1 && ordered[0].x === ordered[ordered.length - 1].x && ordered[0].y === ordered[ordered.length - 1].y) ordered.pop();
  return ordered.length === 4 ? ordered : points;
}
export function cleanVectorPath(path: VectorPath, tolerance = 1.25): VectorPath | null {
  let points = dedupePoints(path.points); if (path.closed && points.length > 1 && points[0].x === points[points.length-1].x && points[0].y === points[points.length-1].y) points = points.slice(0, -1);
  points = dedupePoints(simplifyPolyline(points, tolerance)); if (points.length < 2 || (path.closed && points.length < 3)) return null;
  return { points: path.closed ? snapAxisAlignedRectangle(points) : points, closed: path.closed };
}

/**
 * Trace the outside boundary of every meaningful dark connected component.
 *
 * The important distinction here is that we want the *shape* of each object,
 * not the pixels inside it. A large filled component (such as an eagle,
 * silhouette, filled leaf, icon, etc.) is represented by one external contour.
 * Thin line components fall back to skeleton tracing so an already-outline
 * drawing does not turn into two parallel pen paths.
 */
function connectedComponents(mask: Uint8Array, width: number, height: number): number[][] {
  const seen = new Uint8Array(mask.length);
  const components: number[][] = [];
  const dirs = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]] as const;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const component: number[] = [start];
    seen[start] = 1;
    for (let i = 0; i < component.length; i++) {
      const index = component[i];
      const x = index % width;
      const y = Math.floor(index / width);
      for (const [dx, dy] of dirs) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (!mask[next] || seen[next]) continue;
        seen[next] = 1;
        component.push(next);
      }
    }
    components.push(component);
  }
  return components;
}

function componentMask(component: number[], size: number): Uint8Array {
  const result = new Uint8Array(size);
  for (const index of component) result[index] = 1;
  return result;
}

function componentStats(component: number[], width: number, height: number) {
  let xMin = width, xMax = -1, yMin = height, yMax = -1;
  for (const index of component) {
    const x = index % width, y = Math.floor(index / width);
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  const bboxArea = Math.max(1, (xMax - xMin + 1) * (yMax - yMin + 1));
  return { xMin, xMax, yMin, yMax, area: component.length, fillRatio: component.length / bboxArea };
}

/** Moore-neighborhood boundary follower for a single connected component. */
function traceExternalContour(mask: Uint8Array, width: number, height: number): RasterPoint[] {
  const dirs: Array<[number, number]> = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
  const sign = (value: number) => value === 0 ? 0 : value > 0 ? 1 : -1;
  let start = -1;

  for (let y = 0; y < height && start < 0; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    if (!mask[index]) continue;
    let boundary = false;
    for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height || !mask[ny * width + nx]) { boundary = true; break; }
    }
    if (boundary) { start = index; break; }
  }
  if (start < 0) return [];

  const startPoint = { x: start % width, y: Math.floor(start / width) };
  let current = startPoint;
  let backtrack = { x: startPoint.x - 1, y: startPoint.y };
  const points: RasterPoint[] = [];
  const visitedStates = new Set<string>();
  const maxSteps = Math.max(1000, width * height * 2);
  const stateKey = (point: RasterPoint, back: RasterPoint) => `${point.x}:${point.y}|${back.x}:${back.y}`;

  for (let step = 0; step < maxSteps; step++) {
    points.push({ ...current });
    const key = stateKey(current, backtrack);
    if (visitedStates.has(key) && points.length > 2) break;
    visitedStates.add(key);

    const backDx = sign(backtrack.x - current.x), backDy = sign(backtrack.y - current.y);
    let backDir = dirs.findIndex(([dx, dy]) => dx === backDx && dy === backDy);
    if (backDir < 0) backDir = 4;

    let found = false;
    for (let k = 1; k <= 8; k++) {
      const dir = (backDir + k) % 8;
      const nx = current.x + dirs[dir][0], ny = current.y + dirs[dir][1];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height || !mask[ny * width + nx]) continue;
      const previousDir = (dir + 7) % 8;
      backtrack = { x: current.x + dirs[previousDir][0], y: current.y + dirs[previousDir][1] };
      current = { x: nx, y: ny };
      found = true;
      break;
    }
    if (!found) break;
    if (current.x === startPoint.x && current.y === startPoint.y && points.length > 8) break;
  }

  const result = dedupePoints(points);
  return result.length >= 3 ? result : [];
}

/**
 * Generic image contour extraction.
 *
 * Every significant connected ink object contributes its outer contour.
 * Thin components (typical already-vector-looking strokes) use a skeleton
 * centerline instead, avoiding the unwanted double-outline effect.
 */
export function buildWholeDrawingOutlinePaths(
  pixels: Buffer,
  width: number,
  height: number,
  threshold: number,
  detail: DetailLevel = "medium",
  adaptive = false,
  mmPerPixel = 1,
): VectorPath[] {
  const binary = adaptive ? buildAdaptiveBinaryMask(pixels, width, height, threshold) : buildBinaryMask(pixels, width, height, threshold);
  const cleaned = morphologicalCleanup(binary, width, height);
  const components = connectedComponents(cleaned, width, height)
    .map(component => ({ component, stats: componentStats(component, width, height) }))
    .filter(({ stats }) => {
      const minArea = detail === "high" ? 3 : detail === "low" ? 10 : 5;
      return stats.area >= minArea;
    })
    .sort((a, b) => b.stats.area - a.stats.area);

  const tolerance = detail === "high" ? 0.30 : detail === "low" ? 1.0 : 0.55;
  const minLength = detail === "high" ? 0.15 : detail === "low" ? 0.8 : 0.4;
  const paths: VectorPath[] = [];

  // Components with enough area relative to their bounding box are treated as
  // filled shapes and traced around their exterior. Sparse/long components are
  // treated as line art and traced through their center.
  for (const { component, stats } of components) {
    const isFilledShape = stats.fillRatio >= (detail === "high" ? 0.11 : 0.15)
      && stats.area >= (detail === "high" ? 25 : 40);
    const localMask = componentMask(component, width * height);

    if (isFilledShape) {
      const contour = traceExternalContour(localMask, width, height);
      if (contour.length < 3) continue;
      const path = cleanVectorPath({ points: contour, closed: true }, tolerance);
      if (path && pathLength(path) * mmPerPixel >= minLength) paths.push(path);
    } else {
      const skeleton = skeletonize(localMask, width, height);
      const thinPaths = traceSkeletonPaths(skeleton, width, height)
        .map(path => cleanVectorPath(path, tolerance))
        .filter((path): path is VectorPath => Boolean(path))
        .filter(path => pathLength(path) * mmPerPixel >= minLength);
      paths.push(...thinPaths);
    }

    if (paths.length >= IMAGE_TO_GCODE_LIMITS.maxPaths) break;
  }

  const ordered = paths
    .sort((a, b) => pathLength(b) - pathLength(a))
    .slice(0, IMAGE_TO_GCODE_LIMITS.maxPaths);
  if (!ordered.length) throw new ImageToGcodeError("No drawable content was detected in the image.");
  return ordered;
}

export function extractVectorPaths(pixels: Buffer, width: number, height: number, threshold: number, detail: DetailLevel = "medium", adaptive = false, mmPerPixel = 1): VectorPath[] {
  const settings = { low: { tolerance: 2, minLength: 1.2 }, medium: { tolerance: 1.1, minLength: .55 }, high: { tolerance: .55, minLength: .2 } }[detail];
  const binary = adaptive ? buildAdaptiveBinaryMask(pixels,width,height,threshold) : buildBinaryMask(pixels,width,height,threshold);
  const paths = traceSkeletonPaths(skeletonize(removeSmallComponents(morphologicalCleanup(binary,width,height), width, height), width, height), width, height)
    .map(path => cleanVectorPath(path,settings.tolerance)).filter((path): path is VectorPath => Boolean(path))
    .filter(path => { let length=0; for(let i=1;i<path.points.length;i++) length+=Math.hypot(path.points[i].x-path.points[i-1].x,path.points[i].y-path.points[i-1].y); if(path.closed) length+=Math.hypot(path.points[0].x-path.points.at(-1)!.x,path.points[0].y-path.points.at(-1)!.y); return length*mmPerPixel>=settings.minLength; })
    .slice(0, IMAGE_TO_GCODE_LIMITS.maxPaths);
  if (!paths.length) throw new ImageToGcodeError("No drawable content was detected in the image."); return paths;
}

function smoothPath(path: VectorPath, detail: DetailLevel): VectorPath {
  if (path.points.length < 3) return path;

  // Work on a clean copy first. The tracer produces 1-pixel stair-steps;
  // simplifying those before interpolation gives much smoother circles
  // without allowing the curve fitter to chase raster noise.
  let points = dedupePoints(path.points);
  if (path.closed && points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first.x === last.x && first.y === last.y) points = points.slice(0, -1);
  }
  if (points.length < (path.closed ? 3 : 2)) return path;

  const simplifyTolerance = detail === "high" ? 0.42 : detail === "medium" ? 0.65 : 0.95;
  points = simplifyPolyline(points, simplifyTolerance);
  if (points.length < (path.closed ? 3 : 2)) return path;

  // Corner-aware quadratic smoothing.
  // Gentle turns (circles/curves) get dense interpolation. Strong corners are
  // converted into a small fillet instead of being rounded away completely.
  const samplesPerSegment = detail === "high" ? 4 : detail === "medium" ? 3 : 2;
  const cornerAngle = detail === "high" ? 105 : detail === "medium" ? 112 : 120;
  const radiusFactor = detail === "high" ? 0.22 : detail === "medium" ? 0.20 : 0.17;
  const minRadius = detail === "high" ? 0.75 : detail === "medium" ? 0.9 : 1.0;

  const distance = (a: RasterPoint, b: RasterPoint) => Math.hypot(b.x - a.x, b.y - a.y);
  const lerp = (a: RasterPoint, b: RasterPoint, t: number): RasterPoint => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });
  const quadratic = (a: RasterPoint, control: RasterPoint, b: RasterPoint, t: number): RasterPoint => {
    const u = 1 - t;
    return {
      x: u * u * a.x + 2 * u * t * control.x + t * t * b.x,
      y: u * u * a.y + 2 * u * t * control.y + t * t * b.y,
    };
  };

  const turningAngle = (prev: RasterPoint, current: RasterPoint, next: RasterPoint) => {
    const ax = prev.x - current.x;
    const ay = prev.y - current.y;
    const bx = next.x - current.x;
    const by = next.y - current.y;
    const al = Math.hypot(ax, ay);
    const bl = Math.hypot(bx, by);
    if (!al || !bl) return 180;
    const cosine = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (al * bl)));
    return Math.acos(cosine) * 180 / Math.PI;
  };

  // For closed curves, rotate the point list only conceptually through modulo
  // indexing. The output remains a proper closed path with no duplicate end.
  const count = points.length;
  const get = (index: number) => points[(index + count) % count];

  if (path.closed) {
    const output: RasterPoint[] = [];
    for (let i = 0; i < count; i++) {
      const prev = get(i - 1);
      const current = get(i);
      const next = get(i + 1);
      const prevPrev = get(i - 2);
      const nextNext = get(i + 2);
      const angle = turningAngle(prev, current, next);
      const prevLen = distance(prev, current);
      const nextLen = distance(current, next);

      if (angle < cornerAngle && prevLen > 1 && nextLen > 1) {
        // Small fillet for genuine corners. Limit the radius so tiny shapes
        // and short segments are not distorted.
        const radius = Math.min(
          Math.max(minRadius, Math.min(prevLen, nextLen) * radiusFactor),
          Math.min(prevLen, nextLen) * 0.35,
        );
        const before = lerp(current, prev, radius / Math.max(prevLen, 1e-6));
        const after = lerp(current, next, radius / Math.max(nextLen, 1e-6));
        if (!output.length) output.push(before);
        else output.push(before);
        const cornerSamples = detail === "high" ? 4 : 3;
        for (let k = 1; k <= cornerSamples; k++) {
          output.push(quadratic(before, current, after, k / (cornerSamples + 1)));
        }
        output.push(after);
      } else {
        // Smooth curves use a local quadratic blend around the vertex. This
        // avoids the overshoot that Catmull-Rom can create near sharp corners.
        const left = lerp(current, prev, 0.5);
        const right = lerp(current, next, 0.5);
        if (!output.length) output.push(left);
        const samples = Math.max(2, samplesPerSegment);
        for (let k = 1; k <= samples; k++) {
          output.push(quadratic(left, current, right, k / (samples + 1)));
        }
        output.push(right);
      }
    }
    return { points: dedupePoints(output), closed: true };
  }

  // Open paths: keep the exact endpoints, smooth only the interior.
  if (points.length < 3) return { points, closed: false };
  const output: RasterPoint[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const current = points[i];
    const next = points[i + 1];
    const angle = turningAngle(prev, current, next);
    const prevLen = distance(prev, current);
    const nextLen = distance(current, next);

    if (angle < cornerAngle && prevLen > 1 && nextLen > 1) {
      const radius = Math.min(
        Math.max(minRadius, Math.min(prevLen, nextLen) * radiusFactor),
        Math.min(prevLen, nextLen) * 0.35,
      );
      const before = lerp(current, prev, radius / Math.max(prevLen, 1e-6));
      const after = lerp(current, next, radius / Math.max(nextLen, 1e-6));
      output.push(before);
      const cornerSamples = detail === "high" ? 4 : 3;
      for (let k = 1; k <= cornerSamples; k++) {
        output.push(quadratic(before, current, after, k / (cornerSamples + 1)));
      }
      output.push(after);
    } else {
      const left = lerp(current, prev, 0.5);
      const right = lerp(current, next, 0.5);
      output.push(left);
      for (let k = 1; k <= samplesPerSegment; k++) {
        output.push(quadratic(left, current, right, k / (samplesPerSegment + 1)));
      }
      output.push(right);
    }
  }
  output.push(points[points.length - 1]);

  return { points: dedupePoints(output), closed: false };
}

export function mergeNearbyPaths(paths: VectorPath[], tolerance = 1.5): VectorPath[] {
  const remaining=paths.map(path=>({...path,points:[...path.points]})), merged: VectorPath[]=[];
  while (remaining.length) {
    const current=remaining.shift()!; if(current.closed){merged.push(current);continue;} let changed=true;
    while(changed){ changed=false; const end=current.points.at(-1)!;
      for(let i=0;i<remaining.length;i++){const candidate=remaining[i];if(candidate.closed)continue;const first=candidate.points[0],last=candidate.points.at(-1)!;
        if(Math.hypot(end.x-first.x,end.y-first.y)<=tolerance){current.points.push(...candidate.points.slice(1));remaining.splice(i,1);changed=true;break;}
        if(Math.hypot(end.x-last.x,end.y-last.y)<=tolerance){current.points.push(...candidate.points.slice(0,-1).reverse());remaining.splice(i,1);changed=true;break;}
      }
    } merged.push(current);
  } return merged;
}

export function extractArtisticPaths(pixels: Buffer, width: number, height: number, threshold: number, detail: DetailLevel, mode: RenderingMode, mmPerPixel: number): VectorPath[] {
  const edgeMask=buildXdogMask(pixels,width,height,threshold,detail);
  const settings={low:{tolerance:1.4,minLength:1.2},medium:{tolerance:.75,minLength:.55},high:{tolerance:.38,minLength:.2}}[detail];
  let paths=traceSkeletonPaths(skeletonize(removeSmallComponents(edgeMask,width,height),width,height),width,height)
    .map(path=>cleanVectorPath(path, settings.tolerance))
    .filter((path):path is VectorPath=>Boolean(path))
    .map(path=>smoothPath(path,detail))
    .map(path=>cleanVectorPath(path, detail === "high" ? 0.08 : detail === "medium" ? 0.12 : 0.18))
    .filter((path):path is VectorPath=>Boolean(path));
  if (mode === "realistic") {
    // Preserve both structure (edges/hatching) and continuous tone.
    paths.push(...buildHatchingPaths(pixels, width, height, detail));
    if (detail !== "low") paths.push(...buildHalftonePaths(pixels, width, height, detail));
  }
  paths=mergeNearbyPaths(paths,detail==="high"?.9:1.5)
    .filter(path=>pathLength(path)*mmPerPixel>=settings.minLength)
    .slice(0,IMAGE_TO_GCODE_LIMITS.maxPaths);
  if(!paths.length) throw new ImageToGcodeError("No drawable content was detected in the image."); return paths;
}
export function formatNumber(value: number) { if (!Number.isFinite(value)) throw new ImageToGcodeError("Generated coordinate is not finite."); return value.toFixed(3).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1"); }
export function orderPaths(paths: VectorPath[]): VectorPath[] { const remaining = paths.map(path => ({ ...path, points: [...path.points] })); const ordered: VectorPath[] = []; let current = { x: 0, y: 0 }; while (remaining.length) { let bestIndex = 0, bestPoint = 0, reverse = false, bestDistance = Infinity; remaining.forEach((path, index) => { const candidates = path.closed ? path.points.map((point,i)=>({point,i,reverse:false})) : [{point:path.points[0],i:0,reverse:false},{point:path.points[path.points.length-1],i:path.points.length-1,reverse:true}]; for(const candidate of candidates){ const distance=(candidate.point.x-current.x)**2+(candidate.point.y-current.y)**2; if(distance<bestDistance){bestDistance=distance;bestIndex=index;bestPoint=candidate.i;reverse=candidate.reverse;} } }); const next = remaining.splice(bestIndex,1)[0]; if(next.closed && bestPoint) next.points=[...next.points.slice(bestPoint),...next.points.slice(0,bestPoint)]; else if (reverse) next.points.reverse(); ordered.push(next); current=next.closed?next.points[0]:next.points[next.points.length-1]; } return ordered; }
export function validateGeneratedGcode(gcode: string, maxX: number, maxY: number, penDownZ: number, penUpZ: number): BoundingBox {
  const tolerance = .0005; let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const raw of gcode.split("\n")) { const line = raw.split(";", 1)[0]; const values = [...line.matchAll(/([XYZ])\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/gi)]; for (const [, coordinate, value] of values) { const number = Number(value); if (!Number.isFinite(number)) throw new ImageToGcodeError("Generated G-code contains a non-finite coordinate."); if (coordinate.toUpperCase() === "X") { if (number < -tolerance || number > maxX + tolerance) throw new ImageToGcodeError("Generated G-code exceeds X bounds."); xMin=Math.min(xMin,number); xMax=Math.max(xMax,number); } if (coordinate.toUpperCase() === "Y") { if (number < -tolerance || number > maxY + tolerance) throw new ImageToGcodeError("Generated G-code exceeds Y bounds."); yMin=Math.min(yMin,number); yMax=Math.max(yMax,number); } if (coordinate.toUpperCase() === "Z" && Math.abs(number-penDownZ)>tolerance && Math.abs(number-penUpZ)>tolerance) throw new ImageToGcodeError("Generated G-code contains an unexpected Z value."); } }
  return { xMin: Number.isFinite(xMin) ? xMin : 0, xMax: Number.isFinite(xMax) ? xMax : 0, yMin: Number.isFinite(yMin) ? yMin : 0, yMax: Number.isFinite(yMax) ? yMax : 0 };
}
export function buildGcode(paths: VectorPath[], rasterWidth: number, rasterHeight: number, options: ImageToGcodeOptions, sourceWidth: number, sourceHeight: number): ImageToGcodeResult {
  const scale = Math.min(options.maxX / sourceWidth, options.maxY / sourceHeight), width = sourceWidth * scale, height = sourceHeight * scale, areaX=options.xOffset??0, areaY=options.yOffset??0, offsetX = areaX+(options.maxX-width)/2, offsetY=areaY+(options.maxY-height)/2;
  const machinePoint = (point: RasterPoint) => ({ x: Math.max(areaX, Math.min(areaX+options.maxX, (offsetX + width) - (point.x / Math.max(1,rasterWidth-1) * width))), y: Math.max(areaY, Math.min(areaY+options.maxY, offsetY + (rasterHeight-1-point.y) / Math.max(1,rasterHeight-1) * height)) });
  const lines = ["; DMHC image-to-gcode vector paths", "G21", "G90", `G0 Z${formatNumber(options.penUpZ)}`];
  const optimizedPaths=orderPaths(mergeNearbyPaths(paths));
  for (const path of optimizedPaths) { const points=path.points.map(machinePoint), first=points[0], drawingPoints=path.closed ? [...points, first] : points; lines.push(`G0 X${formatNumber(first.x)} Y${formatNumber(first.y)}`, `G1 Z${formatNumber(options.penDownZ)} F1000`); for (let index = 0; index < drawingPoints.length - 1; index++) { const point = drawingPoints[index + 1]; lines.push(`G1 X${formatNumber(point.x)} Y${formatNumber(point.y)} F${formatNumber(options.feedRate)}`); } lines.push(`G0 Z${formatNumber(options.penUpZ)}`); }
  lines.push("; End vector drawing", `G0 Z${formatNumber(options.penUpZ)}`); const gcode = `${lines.join("\n")}\n`; return { gcode, width, height, penDownZ: options.penDownZ, penUpZ: options.penUpZ, threshold: options.threshold, feedRate: options.feedRate, sourceWidth, sourceHeight, pathCount: optimizedPaths.length, commandCount: lines.length, bounds: validateGeneratedGcode(gcode, areaX+options.maxX, areaY+options.maxY, options.penDownZ, options.penUpZ), detail: options.detail??"medium" };
}
export async function generateImageToGcode(options: ImageToGcodeOptions): Promise<ImageToGcodeResult> {
  validateOptions(options); const { mimeType, bytes } = decodeImageData(options.imageData); const tempPath = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "dmhc-image-to-gcode-")));
  try {
    const sourcePath=join(tempPath,"source-image"), orientedPath=join(tempPath,"oriented.png"), rawPath=join(tempPath,"grayscale.raw");
    await writeFile(sourcePath,bytes);
    const sourceMetadata=await readImageMetadata(sourcePath);
    if (MIME_TO_FORMAT[mimeType] !== sourceMetadata.format) throw new ImageToGcodeError("Image content does not match the selected file format.");
    await runImageMagick([sourcePath,"-auto-orient",orientedPath]);
    const metadata=await readImageMetadata(orientedPath), raster=getRasterSize(metadata.width,metadata.height);
    const preprocess = [orientedPath,"-background","white","-alpha","remove","-alpha","off","-colorspace","Gray","-filter","Lanczos","-resize",`${raster.width}x${raster.height}!`];
    // Line-art contour extraction must see the original edge. Keep the old
    // blur/CLAHE preprocessing for realistic mode only.
    if ((options.mode??"line-art") === "realistic") {
      // Do not blur high-detail photographs: fine facial/hair texture is
      // valuable information for the tone encoder. Keep only a mild denoise
      // at lower detail levels where compression noise is more noticeable.
      if ((options.detail??"medium") !== "high") preprocess.push("-bilateral-blur","3x3+1+8");
      if(options.adaptiveThreshold??true) preprocess.push("-clahe","8x8+128+2");
    }
    preprocess.push("-depth","8",`gray:${rawPath}`); await runImageMagick(preprocess);
    const pixels=await readFile(rawPath); if (pixels.length !== raster.width*raster.height) throw new ImageToGcodeError("Unable to read image.");
    const physicalScale=Math.min(options.maxX/metadata.width,options.maxY/metadata.height), mmPerPixel=Math.min(metadata.width*physicalScale/Math.max(1,raster.width-1),metadata.height*physicalScale/Math.max(1,raster.height-1));
    const detail=options.detail??"medium", mode=options.mode??"line-art";
    const paths = mode === "line-art"
      ? buildWholeDrawingOutlinePaths(
          pixels,
          raster.width,
          raster.height,
          options.threshold,
          detail,
          options.adaptiveThreshold ?? false,
          mmPerPixel,
        )
      : extractArtisticPaths(pixels,raster.width,raster.height,options.threshold,detail,mode,mmPerPixel);
    return buildGcode(paths,raster.width,raster.height,options,metadata.width,metadata.height);
  } finally { await rm(tempPath,{recursive:true,force:true}); }
}
