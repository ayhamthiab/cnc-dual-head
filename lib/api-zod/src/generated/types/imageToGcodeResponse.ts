import type { BoundingBox } from "./boundingBox";

/** Generated response shape for POST /api/image-to-gcode. */
export interface ImageToGcodeResponse {
  gcode: string; width: number; height: number; penDownZ: number; penUpZ: number;
  threshold: number; feedRate: number; sourceWidth: number; sourceHeight: number; pathCount: number;
  commandCount: number; bounds: BoundingBox;
  detail: "low" | "medium" | "high";
}
