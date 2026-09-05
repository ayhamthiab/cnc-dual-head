import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { GenerateImageToGcodeBody, generateImageToGcodeBodyFeedRateDefault } from "@workspace/api-zod";
import {
  buildGcode, buildHatchingPaths, buildXdogMask, decodeImageData, extractVectorPaths, generateImageToGcode, ImageToGcodeError, mergeNearbyPaths, orderPaths,
  validateGeneratedGcode, validateOptions,
} from "./image-to-gcode";

const options = { imageData: "data:image/png;base64,AA==", maxX: 300, maxY: 615, penDownZ: 0, penUpZ: 5, threshold: 128, feedRate: 1000 };
const execFileAsync = promisify(execFile);
const pixels = (width: number, height: number, draw: (set: (x: number, y: number, value?: number) => void) => void) => {
  const image = Buffer.alloc(width * height, 255);
  draw((x, y, value = 0) => { image[y * width + x] = value; });
  return image;
};
const rectangle = (set: (x: number, y: number) => void, left: number, top: number, right: number, bottom: number) => {
  for (let x = left; x <= right; x++) { set(x, top); set(x, bottom); }
  for (let y = top; y <= bottom; y++) { set(left, y); set(right, y); }
};

test("one rectangle produces one compact closed vector path rather than scanlines", () => {
  const image = pixels(80, 60, set => rectangle(set, 5, 5, 74, 54));
  const paths = extractVectorPaths(image, 80, 60, 128);
  assert.equal(paths.length, 1);
  const result = buildGcode(paths, 80, 60, options, 80, 60);
  assert.match(result.gcode, /DMHC image-to-gcode vector paths/);
  assert.equal((result.gcode.match(/G1 X.*F1000/g) ?? []).length, 4);
  assert.equal(result.width, 300); assert.equal(result.height, 225);
});

test("nested and disconnected rectangles retain pen-up-separated paths", () => {
  const image = pixels(80, 60, set => { rectangle(set, 4, 4, 35, 28); rectangle(set, 45, 30, 75, 55); });
  const result = buildGcode(extractVectorPaths(image, 80, 60, 128), 80, 60, options, 80, 60);
  assert.equal(result.pathCount, 2);
  assert.equal((result.gcode.match(/G0 Z5/g) ?? []).length, 4);
});

test("a horizontal stroke becomes a single centerline cut", () => {
  const image = pixels(80, 60, set => { for (let x = 5; x < 75; x++) set(x, 30); });
  const result = buildGcode(extractVectorPaths(image, 80, 60, 128), 80, 60, options, 80, 60);
  assert.equal(result.pathCount, 1); assert.equal((result.gcode.match(/G1 X.*F1000/g) ?? []).length, 1);
});

test("isolated noise is removed", () => {
  const line = pixels(80, 60, set => { for (let x = 5; x < 75; x++) set(x, 30); });
  const noisy = Buffer.from(line); noisy[2 * 80 + 2] = 0; noisy[55 * 80 + 70] = 0;
  assert.equal(extractVectorPaths(noisy, 80, 60, 128).length, extractVectorPaths(line, 80, 60, 128).length);
});

test("threshold endpoints and inclusive polarity are applied", () => {
  const image = pixels(80, 60, set => { for (let x = 5; x < 75; x++) { set(x, 20, 0); set(x, 40, 128); } });
  assert.equal(extractVectorPaths(image, 80, 60, 0).length, 1);
  assert.equal(extractVectorPaths(image, 80, 60, 128).length, 2);
  assert.doesNotThrow(() => extractVectorPaths(image, 80, 60, 255));
});

test("invalid dimensions and thresholds are rejected", () => {
  for (const threshold of [-1, 256, 12.5]) assert.throws(() => validateOptions({ ...options, threshold }), ImageToGcodeError);
  assert.throws(() => validateOptions({ ...options, maxX: 301 }), ImageToGcodeError);
  assert.throws(() => validateOptions({ ...options, maxY: 616 }), ImageToGcodeError);
  assert.throws(() => validateOptions({ ...options, maxX: 0 }), ImageToGcodeError);
  assert.throws(() => validateOptions({ ...options, maxY: 0 }), ImageToGcodeError);
});

test("drawing feed rate defaults to 1000 in the API schema", () => {
  const parsed = GenerateImageToGcodeBody.parse({ imageData: options.imageData });
  assert.equal(generateImageToGcodeBodyFeedRateDefault, 1000);
  assert.equal(parsed.feedRate, 1000);
});

test("a custom drawing feed is used unchanged by every XY drawing movement", () => {
  const cornerPath = [{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 11, y: 10 }], closed: false }];
  const customOptions = GenerateImageToGcodeBody.parse({ imageData: options.imageData, feedRate: 600 });
  const result = buildGcode(cornerPath, 12, 12, customOptions, 12, 12);
  const drawingLines = result.gcode.split("\n").filter(line => /^G1 X/.test(line));
  assert.equal(drawingLines.length, 3);
  assert.ok(drawingLines.every(line => / F600$/.test(line)), drawingLines.join("\n"));
  assert.equal(result.feedRate, 600);
});

test("corners, short segments, and closed paths never alter the drawing feed", () => {
  const paths = [
    { points: [{ x: 0, y: 0 }, { x: 0.01, y: 0 }, { x: 0.01, y: 10 }, { x: 11, y: 10 }], closed: false },
    { points: [{ x: 2, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 3 }], closed: true },
  ];
  const result = buildGcode(paths, 12, 12, { ...options, feedRate: 886 }, 12, 12);
  const drawingFeeds = result.gcode.split("\n")
    .filter(line => /^G1 X/.test(line))
    .map(line => Number(line.match(/ F([^\s]+)$/)?.[1]));
  assert.ok(drawingFeeds.length > 0);
  assert.deepEqual([...new Set(drawingFeeds)], [886]);
});

test("invalid drawing feed rates are rejected", () => {
  for (const feedRate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 50_001]) {
    assert.throws(() => validateOptions({ ...options, feedRate }), ImageToGcodeError);
  }
});

test("final G-code validation protects X/Y bounds and pen Z values", () => {
  assert.throws(() => validateGeneratedGcode("G0 X301 Y0\n", 300, 615, 0, 5), ImageToGcodeError);
  assert.throws(() => validateGeneratedGcode("G1 Z1\n", 300, 615, 0, 5), ImageToGcodeError);
});

test("PNG, JPEG, WEBP, and BMP Data URLs are accepted while invalid image input is rejected", () => {
  for (const mime of ["image/png", "image/jpeg", "image/webp", "image/bmp"]) {
    assert.equal(decodeImageData(`data:${mime};base64,AA==`).mimeType, mime);
  }
  assert.throws(() => decodeImageData("data:text/plain;base64,AA=="), ImageToGcodeError);
});

test("real PNG, JPEG, WEBP, and BMP files load and produce vector G-code", async () => {
  const directory=await mkdtemp(join(tmpdir(),"dmhc-image-formats-"));
  try {
    for (const [extension,mime] of [["png","image/png"],["jpg","image/jpeg"],["webp","image/webp"],["bmp","image/bmp"]] as const) {
      const file=join(directory,`drawing.${extension}`);
      await execFileAsync(process.env.IMAGE_MAGICK_COMMAND?.trim()||"magick",["-size","40x30","xc:white","-stroke","black","-strokewidth","2","-fill","none","-draw","rectangle 5,5 34,24",file]);
      const imageData=`data:${mime};base64,${(await readFile(file)).toString("base64")}`;
      const result=await generateImageToGcode({...options,imageData,maxX:250,xOffset:20,detail:"high"});
      assert.ok(result.pathCount>0); assert.ok(result.bounds.xMin>=20&&result.bounds.xMax<=270);
    }
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test("physical fit preserves aspect ratio and honors the machine X offset", () => {
  const path = [{ points: [{ x: 0, y: 0 }, { x: 99, y: 79 }], closed: false }];
  const result = buildGcode(path, 100, 80, { ...options, maxX: 250, xOffset: 20 }, 1000, 800);
  assert.equal(result.width, 250); assert.equal(result.height, 200);
  assert.equal(result.width / result.height, 1000 / 800);
  assert.ok(result.bounds.xMin >= 20 && result.bounds.xMax <= 270);
  assert.ok(result.bounds.yMin >= 0 && result.bounds.yMax <= 615);
  assert.match(result.gcode, /G0 Z5/); assert.match(result.gcode, /G1 Z0 F1000/);
});

test("detail level controls simplification without losing a continuous path", () => {
  const image = pixels(120, 80, set => { for (let x=5;x<115;x++) set(x,40+Math.round(8*Math.sin(x/5))); });
  const low = extractVectorPaths(image,120,80,128,"low");
  const high = extractVectorPaths(image,120,80,128,"high");
  assert.ok(low.length > 0 && high.length > 0);
  assert.ok(high.reduce((n,p)=>n+p.points.length,0) >= low.reduce((n,p)=>n+p.points.length,0));
});

test("path ordering chooses the nearest orientation and rotates closed paths", () => {
  const ordered = orderPaths([
    { points: [{x:50,y:0},{x:40,y:0}], closed:false },
    { points: [{x:10,y:10},{x:10,y:1},{x:1,y:1},{x:1,y:10}], closed:true },
  ]);
  assert.deepEqual(ordered[0].points[0], {x:1,y:1});
  assert.deepEqual(ordered[1].points[0], {x:40,y:0});
});

test("XDoG extracts a continuous response around a dark stroke", () => {
  const image = pixels(80, 60, set => { for (let x=5;x<75;x++) set(x,30); });
  const mask = buildXdogMask(image,80,60,128);
  assert.ok(mask.some(Boolean));
  assert.ok(mask.slice(29*80,32*80).some(Boolean));
});

test("realistic tone hatching increases with darkness", () => {
  const light=Buffer.alloc(80*60,220), dark=Buffer.alloc(80*60,40);
  assert.ok(buildHatchingPaths(dark,80,60).length > buildHatchingPaths(light,80,60).length);
});

test("nearby open paths merge without merging closed whole shapes", () => {
  const optimized=mergeNearbyPaths([
    {points:[{x:0,y:0},{x:5,y:0}],closed:false},
    {points:[{x:5.5,y:0},{x:10,y:0}],closed:false},
    {points:[{x:20,y:20},{x:25,y:20},{x:25,y:25}],closed:true},
  ],1);
  assert.equal(optimized.length,2);
  assert.equal(optimized.filter(path=>path.closed).length,1);
});

test("rendering mode is validated and defaults in the API schema", () => {
  assert.equal(GenerateImageToGcodeBody.parse({imageData:options.imageData}).mode,"line-art");
  assert.throws(()=>validateOptions({...options,mode:"photo" as any}),ImageToGcodeError);
});
