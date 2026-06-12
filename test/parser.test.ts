import assert from "node:assert/strict";
import test from "node:test";
import { downsample, parseGpsLine, queryPoints, summarizePoints, toGeoJson, toGpx } from "../app.ts";
import { finalizePoints, parseGeoJson, parseGpx } from "../src/core.ts";

test("parses a valid V02 record and anchors time to its video name", () => {
  const point = parseGpsLine(
    "1781053296,A,25.710150,78.644722,7600,2361,-97,-1,50,NO20260610-142922-006715B.MP4,0,0,0",
    new Map(),
  );
  assert.ok(point);
  finalizePoints([point]);
  assert.equal(point.rawSpeed, 76);
  assert.equal(point.speed, 76);
  assert.equal(point.heading, 236.1);
  assert.equal(point.latitude, 25.71015);
  const expected = new Date(2026, 5, 10, 14, 29, 22).getTime();
  assert.equal(point.timestamp, expected);
});

test("preserves elapsed time for records in the same video", () => {
  const anchors = new Map();
  const first = parseGpsLine(
    "1781053296,A,25.710150,78.644722,7600,2361,0,0,0,NO20260610-142922-006715B.MP4,0,0,0",
    anchors,
  );
  const second = parseGpsLine(
    "1781053302,A,25.710474,78.646085,7400,2277,0,0,0,NO20260610-142922-006715B.MP4,0,0,0",
    anchors,
  );
  assert.equal(second!.timestamp - first!.timestamp, 6000);
});

test("rejects invalid fixes and nan coordinates", () => {
  assert.equal(parseGpsLine("0,V, 0.000000,      nan,-8,38,0,0,0,0,0,0,0", new Map()), null);
  assert.equal(parseGpsLine("$V02", new Map()), null);
});

test("replaces an implausible raw speed with coordinate-derived speed", () => {
  const anchors = new Map();
  const first = parseGpsLine(
    "1713045117,A,26.803310,81.001286,21300,166,0,0,0,NO20240414-112044-000005B.MP4,0,0,0",
    anchors,
  )!;
  const second = parseGpsLine(
    "1713045118,A,26.803295,81.001273,22100,222,0,0,0,NO20240414-112044-000005B.MP4,0,0,0",
    anchors,
  )!;
  finalizePoints([first, second]);
  assert.equal(first.speed, 0);
  assert.ok(second.speed > 0 && second.speed < 20);
  assert.equal(second.rawSpeed, 221);
});

test("parses GPX and GeoJSON route files", () => {
  const gpx = parseGpx(
    '<gpx><trk><trkseg><trkpt lat="25.1" lon="78.2"><time>2026-06-10T10:00:00Z</time><speed>10</speed><ele>220</ele></trkpt></trkseg></trk></gpx>',
    "sample.gpx",
    0,
  );
  const geojson = parseGeoJson(JSON.stringify({
    type: "LineString",
    coordinates: [[78.2, 25.1], [78.3, 25.2]],
  }), "sample.geojson", 1000);
  assert.equal(gpx[0].rawSpeed, 36);
  assert.equal(gpx[0].altitude, 220);
  assert.equal(geojson.length, 2);
});

test("queries indexed points and produces both export formats", async () => {
  const start = new Date(2026, 5, 10, 14, 29, 0).getTime();
  const end = new Date(2026, 5, 10, 14, 30, 0).getTime();
  const points = await queryPoints(start, end);
  assert.ok(points.length > 10);
  assert.equal(downsample(points, 5).length, 5);
  assert.equal(toGeoJson(points).features[0].geometry.type, "LineString");
  assert.match(toGpx(points.slice(0, 2)), /<trkpt lat="25\./);
});

test("summaries use every selected point rather than map downsampling", async () => {
  const start = new Date(2026, 5, 10, 14, 29, 0).getTime();
  const end = new Date(2026, 5, 10, 14, 35, 0).getTime();
  const points = await queryPoints(start, end);
  const sampled = downsample(points, 5);
  const summary = summarizePoints(points, start, end);
  assert.equal(summary.pointCount, points.length);
  assert.ok(summary.pointCount > sampled.length);
  assert.equal(summary.selectedDurationMs, 6 * 60_000);
});
