import assert from "node:assert/strict";
import test from "node:test";
import { summarizePoints } from "../app.ts";
import { analyzeTraffic } from "../public/traffic.js";
import { finalizePoints, parseGpx, type Point } from "../src/core.ts";

const KM_PER_DEG = 111.195;

// Builds a 1 Hz drive along a meridian. Each leg: [seconds, km/h].
function drive(legs: [number, number][]): Point[] {
  const points: Point[] = [];
  let latitude = 20, timestamp = 1_700_000_000_000;
  for (const [seconds, speed] of legs) {
    for (let second = 0; second < seconds; second += 1) {
      points.push({
        timestamp, rawTimestamp: timestamp, latitude, longitude: 78,
        speed, rawSpeed: speed, calculatedSpeed: speed, heading: 0,
        altitude: null, sensorX: null, sensorY: null, sensorZ: null, source: "t", video: "",
      });
      timestamp += 1000;
      latitude += speed / 3600 / KM_PER_DEG;
    }
  }
  return points;
}

const minutes = (ms: number) => Math.round(ms / 60_000);

test("a parked stop is excluded from moving time and speed bands", () => {
  const moving = analyzeTraffic(drive([[1800, 80], [1800, 80]]));
  const stopped = analyzeTraffic(drive([[1800, 80], [1800, 0], [1800, 80]]));
  assert.equal(minutes(stopped.excludedMs), 30);
  assert.equal(minutes(stopped.movingMs), 60);
  assert.equal(minutes(stopped.bands[0].ms), minutes(moving.bands[0].ms));
  assert.ok(Math.abs(stopped.avgKmh - 80) < 1, `avg ${stopped.avgKmh}`);
});

test("a short signal halt stays as traffic, the threshold decides", () => {
  const signal = drive([[900, 60], [60, 0], [900, 60]]);
  assert.ok(analyzeTraffic(signal).excludedMs === 0);
  assert.ok(analyzeTraffic(signal, { stopMinMs: 30_000 }).excludedMs > 0);
});

test("GPS speed noise while parked does not leak into crawl time", () => {
  const points = drive([[600, 80], [1800, 0], [600, 80]]);
  for (let i = 700; i < 2300; i += 50) points[i].speed = 4;
  const result = analyzeTraffic(points);
  assert.ok(minutes(result.bands[0].ms) <= 1, `crawl ${minutes(result.bands[0].ms)}m`);
  assert.ok(minutes(result.excludedMs) >= 29);
});

test("a recording gap counts as neither moving time nor a long stretch", () => {
  const points = drive([[1800, 80], [1800, 80]]);
  for (let i = 1800; i < points.length; i += 1) {
    points[i].timestamp += 3_600_000;
    points[i].latitude += 1;
  }
  const result = analyzeTraffic(points);
  assert.equal(minutes(result.excludedMs), 60);
  assert.equal(minutes(result.movingMs), 60);
  assert.ok(result.movingKm < 85, `km ${result.movingKm}`);
});

test("slowest and fastest stretches find the jam and the open road", () => {
  const result = analyzeTraffic(drive([[1800, 90], [1800, 10], [1800, 90]]));
  const [jam] = result.slowest;
  assert.ok(jam.kmh < 15, `jam ${jam.kmh}`);
  assert.ok(Math.abs(jam.km - 5) < 2.5, `jam km ${jam.km}`);
  assert.ok(result.fastest[0].kmh > 85);
  const overlap = result.fastest.some((fast) => fast.startIndex < jam.endIndex && jam.startIndex < fast.endIndex);
  assert.equal(overlap, false);
});

test("a route with no movement reports nothing instead of NaN", () => {
  const result = analyzeTraffic(drive([[1800, 0]]));
  assert.equal(result.movingMs, 0);
  assert.equal(result.avgKmh, 0);
  assert.deepEqual(result.slowest, []);
  assert.equal(analyzeTraffic([]).movingMs, 0);
});

test("summary survives ranges too large for Math.max spread", () => {
  const point = drive([[1, 50]])[0];
  const summary = summarizePoints(new Array(300_000).fill(point), 0, 1);
  assert.equal(summary.peakSpeed, 50);
});

test("parked GPS jitter is not added to distance", () => {
  const points = drive([[3, 0]]);
  points[1].latitude += 0.001;
  assert.equal(summarizePoints(points, 0, 1).distanceKm, 0);
});

test("GPX without speed falls back to the calculated speed", () => {
  const gpx = `<gpx><trk><trkseg>
    <trkpt lat="20" lon="78"><time>2024-01-01T00:00:00Z</time></trkpt>
    <trkpt lat="20.001" lon="78"><time>2024-01-01T00:00:10Z</time></trkpt>
  </trkseg></trk></gpx>`;
  const [, second] = finalizePoints(parseGpx(gpx, "t.gpx", 0));
  assert.ok(second.speed > 35, `speed ${second.speed}`);
  assert.equal(second.rawSpeed, 0);
});
