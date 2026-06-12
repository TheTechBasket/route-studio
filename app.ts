#!/usr/bin/env node

import { createReadStream, existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  deserializePoint,
  distanceKm,
  finalizePoints,
  parseGeoJson,
  parseGpx,
  parseGpsLine,
  serializePoint,
  type Point,
  type VideoAnchor,
} from "./src/core.ts";

type SourceState = {
  size: number;
  mtimeMs: number;
  ino: number;
  offset: number;
  carry: string;
  type: string;
};

type Manifest = {
  version: 2;
  updatedAt: string;
  sources: Record<string, SourceState>;
  days: Record<string, { count: number; minTime: number; maxTime: number }>;
  videoAnchors: Record<string, VideoAnchor>;
};

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const INPUT_DIR = join(ROOT, "data", "input");
const DATA_DIR = join(ROOT, "data", "cache");
const DAYS_DIR = join(DATA_DIR, "days");
const MANIFEST_PATH = join(DATA_DIR, "manifest.json");
const PUBLIC_DIR = join(ROOT, "public");
const PORT = Number(process.env.PORT || 4173);
const MAX_MAP_POINTS = 25_000;
const SUPPORTED_EXTENSIONS = new Set([".txt", ".gpx", ".geojson", ".json"]);

function emptyManifest(): Manifest {
  return { version: 2, updatedAt: new Date().toISOString(), sources: {}, days: {}, videoAnchors: {} };
}

async function loadManifest(): Promise<Manifest> {
  try {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as Manifest;
    return manifest.version === 2 ? manifest : emptyManifest();
  } catch {
    return emptyManifest();
  }
}

function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function rebuildIndex(): Promise<Manifest> {
  await mkdir(DAYS_DIR, { recursive: true });
  for (const file of await readdir(DAYS_DIR)) await writeFile(join(DAYS_DIR, file), "");
  const manifest = emptyManifest();
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  return manifest;
}

async function walk(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(path);
  }
  return files;
}

async function sourceFiles(): Promise<string[]> {
  await mkdir(INPUT_DIR, { recursive: true });
  return (await walk(INPUT_DIR)).sort();
}

function updateDay(manifest: Manifest, point: Point): void {
  const day = dayKey(point.timestamp);
  const meta = manifest.days[day] ?? {
    count: 0,
    minTime: point.timestamp,
    maxTime: point.timestamp,
  };
  meta.count += 1;
  meta.minTime = Math.min(meta.minTime, point.timestamp);
  meta.maxTime = Math.max(meta.maxTime, point.timestamp);
  manifest.days[day] = meta;
}

async function appendPoints(manifest: Manifest, points: Point[]): Promise<number> {
  const chunks = new Map<string, string[]>();
  for (const point of points) {
    const day = dayKey(point.timestamp);
    const rows = chunks.get(day) ?? [];
    rows.push(serializePoint(point));
    chunks.set(day, rows);
    updateDay(manifest, point);
  }
  for (const [day, rows] of chunks) {
    await appendFile(join(DAYS_DIR, `${day}.tsv`), `${rows.join("\n")}\n`);
  }
  return points.length;
}

async function importText(
  path: string,
  name: string,
  info: Awaited<ReturnType<typeof stat>>,
  previous: SourceState | undefined,
  manifest: Manifest,
): Promise<number> {
  const offset = previous?.offset ?? 0;
  const anchors = new Map<string, VideoAnchor>(Object.entries(manifest.videoAnchors));
  const stream = createReadStream(path, { start: offset, encoding: "utf8" });
  let carry = previous?.carry ?? "";
  let bytesRead = 0;
  let previousPoint: Point | null = null;
  const batch: Point[] = [];
  let imported = 0;

  for await (const chunk of stream) {
    bytesRead += Buffer.byteLength(chunk);
    const lines = (carry + chunk).split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) {
      const point = parseGpsLine(line, anchors, name);
      if (!point) continue;
      finalizePoints([point], previousPoint);
      previousPoint = point;
      batch.push(point);
      if (batch.length >= 25_000) imported += await appendPoints(manifest, batch.splice(0));
    }
  }
  imported += await appendPoints(manifest, batch);
  manifest.sources[name] = {
    size: info.size,
    mtimeMs: info.mtimeMs,
    ino: info.ino,
    offset: offset + bytesRead,
    carry,
    type: "txt",
  };
  manifest.videoAnchors = Object.fromEntries(anchors);
  return imported;
}

async function importStructured(
  path: string,
  name: string,
  info: Awaited<ReturnType<typeof stat>>,
  manifest: Manifest,
): Promise<number> {
  const content = await readFile(path, "utf8");
  const extension = extname(path).toLowerCase();
  const points = extension === ".gpx"
    ? parseGpx(content, name, info.mtimeMs)
    : parseGeoJson(content, name, info.mtimeMs);
  finalizePoints(points);
  const imported = await appendPoints(manifest, points);
  manifest.sources[name] = {
    size: info.size,
    mtimeMs: info.mtimeMs,
    ino: info.ino,
    offset: info.size,
    carry: "",
    type: extension.slice(1),
  };
  return imported;
}

async function importData(force = false): Promise<void> {
  await mkdir(DAYS_DIR, { recursive: true });
  let manifest = force ? await rebuildIndex() : await loadManifest();
  const files = await sourceFiles();
  const names = files.map((path) => relative(INPUT_DIR, path));
  const removed = Object.keys(manifest.sources).some((name) => !names.includes(name));
  let needsRebuild = removed || manifest.version !== 2;

  for (const path of files) {
    const name = relative(INPUT_DIR, path);
    const info = await stat(path);
    const previous = manifest.sources[name];
    const extension = extname(path).toLowerCase();
    if (!previous) continue;
    if (extension !== ".txt" && (info.size !== previous.size || info.mtimeMs !== previous.mtimeMs)) {
      needsRebuild = true;
    }
    if (
      extension === ".txt"
      && (info.size < previous.offset || (previous.ino && previous.ino !== info.ino))
    ) needsRebuild = true;
  }
  if (needsRebuild && !force) {
    console.log("Input files changed or were removed; rebuilding the index.");
    manifest = await rebuildIndex();
  }

  for (const path of files) {
    const name = relative(INPUT_DIR, path);
    const info = await stat(path);
    const previous = manifest.sources[name];
    if (previous && info.size === previous.offset && info.mtimeMs === previous.mtimeMs) {
      console.log(`${name}: unchanged`);
      continue;
    }
    const extension = extname(path).toLowerCase();
    const imported = extension === ".txt"
      ? await importText(path, name, info, previous, manifest)
      : await importStructured(path, name, info, manifest);
    console.log(`${name}: imported ${imported.toLocaleString()} valid points`);
  }

  manifest.updatedAt = new Date().toISOString();
  const temporary = `${MANIFEST_PATH}.tmp`;
  await writeFile(temporary, JSON.stringify(manifest, null, 2));
  await rename(temporary, MANIFEST_PATH);
  console.log(`Index ready: ${Object.values(manifest.days).reduce((sum, day) => sum + day.count, 0).toLocaleString()} points`);
}

function selectedDays(start: number, end: number): string[] {
  const days: string[] = [];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  while (cursor.getTime() <= end) {
    days.push(dayKey(cursor.getTime()));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

export async function queryPoints(start: number, end: number): Promise<Point[]> {
  const points: Point[] = [];
  for (const day of selectedDays(start, end)) {
    const path = join(DAYS_DIR, `${day}.tsv`);
    if (!existsSync(path)) continue;
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of lines) {
      const point = deserializePoint(line);
      if (point && point.timestamp >= start && point.timestamp <= end) points.push(point);
    }
  }
  points.sort((a, b) => a.timestamp - b.timestamp);
  return points;
}

export function downsample(points: Point[], limit = MAX_MAP_POINTS): Point[] {
  if (points.length <= limit) return points;
  const result = [points[0]];
  const step = (points.length - 2) / (limit - 2);
  for (let index = 1; index < limit - 1; index += 1) result.push(points[Math.round(index * step)]);
  result.push(points.at(-1)!);
  return result;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  })[char]!);
}

export function toGeoJson(points: Point[]) {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {
        name: "Dashcam route",
        start: points[0]?.timestamp ?? null,
        end: points.at(-1)?.timestamp ?? null,
        pointCount: points.length,
        timestamps: points.map((point) => point.timestamp),
        speeds: points.map((point) => point.speed),
        rawSpeeds: points.map((point) => point.rawSpeed),
        calculatedSpeeds: points.map((point) => point.calculatedSpeed),
        headings: points.map((point) => point.heading),
        altitudes: points.map((point) => point.altitude),
        sensorX: points.map((point) => point.sensorX),
        sensorY: points.map((point) => point.sensorY),
        sensorZ: points.map((point) => point.sensorZ),
        sources: points.map((point) => point.source),
        videos: points.map((point) => point.video),
      },
      geometry: {
        type: "LineString",
        coordinates: points.map((point) => [
          point.longitude,
          point.latitude,
          ...(point.altitude === null ? [] : [point.altitude]),
        ]),
      },
    }],
  };
}

export function summarizePoints(points: Point[], start: number, end: number) {
  let distance = 0;
  for (let index = 1; index < points.length; index += 1) {
    distance += distanceKm(points[index - 1], points[index]);
  }
  return {
    pointCount: points.length,
    distanceKm: distance,
    peakSpeed: points.length ? Math.max(...points.map((point) => point.speed)) : 0,
    selectedDurationMs: end - start,
    dataDurationMs: points.length > 1 ? points.at(-1)!.timestamp - points[0].timestamp : 0,
    sourceCount: new Set(points.map((point) => point.source)).size,
  };
}

export function toGpx(points: Point[]): string {
  const track = points.map((point) =>
    `    <trkpt lat="${point.latitude}" lon="${point.longitude}">${point.altitude === null ? "" : `<ele>${point.altitude}</ele>`}<time>${new Date(point.timestamp).toISOString()}</time><speed>${(point.speed / 3.6).toFixed(3)}</speed><course>${point.heading.toFixed(1)}</course><name>${escapeXml(point.video || point.source)}</name></trkpt>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Car Camera Route Studio" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk><name>Dashcam route</name><trkseg>\n${track}\n  </trkseg></trk>\n</gpx>\n`;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function parseRange(url: URL): { start: number; end: number } | null {
  const start = Number(url.searchParams.get("start"));
  const end = Number(url.searchParams.get("end"));
  return Number.isFinite(start) && Number.isFinite(end) && start <= end ? { start, end } : null;
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  if (requested.includes("..")) return json(response, 400, { error: "Invalid path" });
  try {
    const content = await readFile(join(PUBLIC_DIR, requested));
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
    };
    response.writeHead(200, { "content-type": types[extname(requested)] || "application/octet-stream" });
    response.end(content);
  } catch {
    json(response, 404, { error: "Not found" });
  }
}

async function handleRequest(requestUrl: string, response: ServerResponse): Promise<void> {
  const url = new URL(requestUrl, `http://localhost:${PORT}`);
  if (url.pathname === "/api/meta") {
    const manifest = await loadManifest();
    return json(response, 200, {
      days: manifest.days,
      updatedAt: manifest.updatedAt,
      sources: Object.keys(manifest.sources),
    });
  }
  if (url.pathname === "/api/route" || url.pathname === "/api/export.geojson" || url.pathname === "/api/export.gpx") {
    const range = parseRange(url);
    if (!range) return json(response, 400, { error: "Valid start and end timestamps are required" });
    const allPoints = await queryPoints(range.start, range.end);
    if (url.pathname === "/api/export.gpx") {
      response.writeHead(200, {
        "content-type": "application/gpx+xml; charset=utf-8",
        "content-disposition": 'attachment; filename="route.gpx"',
      });
      return response.end(toGpx(allPoints));
    }
    const points = url.pathname === "/api/route" ? downsample(allPoints) : allPoints;
    const geoJson = toGeoJson(points);
    if (url.pathname === "/api/route") {
      Object.assign(geoJson.features[0].properties, {
        summary: summarizePoints(allPoints, range.start, range.end),
      });
    }
    response.writeHead(200, {
      "content-type": "application/geo+json; charset=utf-8",
      ...(url.pathname.includes("export") ? { "content-disposition": 'attachment; filename="route.geojson"' } : {}),
    });
    return response.end(JSON.stringify(geoJson));
  }
  await serveStatic(url.pathname, response);
}

async function serve(): Promise<void> {
  const server = createServer((request, response) => {
    handleRequest(request.url || "/", response).catch((error) => {
      console.error(error);
      json(response, 500, { error: "Internal server error" });
    });
  });
  server.listen(PORT, "127.0.0.1", () => console.log(`Car Camera Route Studio: http://127.0.0.1:${PORT}`));
}

async function main(): Promise<void> {
  const command = process.argv[2] || "serve";
  if (command === "import") return importData(process.argv.includes("--force"));
  if (command === "serve") return serve();
  console.error("Usage: node app.ts <import [--force] | serve>");
  process.exitCode = 1;
}

if (resolve(process.argv[1] || "") === resolve(fileURLToPath(import.meta.url))) await main();

export { parseGpsLine } from "./src/core.ts";
