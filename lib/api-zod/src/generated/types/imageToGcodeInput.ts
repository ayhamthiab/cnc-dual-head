/** Generated request shape for POST /api/image-to-gcode. */
export interface ImageToGcodeInput {
  imageData: string;
  maxX?: number;
  maxY?: number;
  penDownZ?: number;
  penUpZ?: number;
  threshold?: number;
  feedRate?: number;
  detail?: "low" | "medium" | "high";
  adaptiveThreshold?: boolean;
  mode?: "line-art" | "realistic";
  xOffset?: number;
  yOffset?: number;
}
