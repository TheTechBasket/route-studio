// Pure route analysis: no DOM, so `node --test` can import it directly.

// Palette checked with the dataviz validator. ponytail: chart amber sits just over the dark lightness band
// (L 0.77); going darker makes it collide with orange, and bar height already encodes the same speed.
// `color` sits on the light map, `chartColor` on the dark telemetry panel.
export const BANDS = [
  { key: "crawl", label: "Crawl", below: 15, color: "#a50f3c", chartColor: "#e8457a" },
  { key: "slow", label: "Slow", below: 40, color: "#e8590c", chartColor: "#d9770f" },
  { key: "steady", label: "Steady", below: 70, color: "#e0a800", chartColor: "#c9b820" },
  { key: "fast", label: "Fast", below: Infinity, color: "#0a9a8f", chartColor: "#17a896" },
];

const STOP_RADIUS_KM = 0.05;
const SMOOTH_MS = 30_000;
const MIN_GAP_MS = 120_000;
const STRETCH_GROW_RATIO = 1.3;

export const bandIndex = (kmh) => BANDS.findIndex((band) => kmh < band.below);

function distanceKm(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * toRad;
  const dLon = (b.longitude - a.longitude) * toRad;
  const value = Math.sin(dLat / 2) ** 2
    + Math.cos(a.latitude * toRad) * Math.cos(b.latitude * toRad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

// A stop is staying inside a small circle for stopMinMs. Position, not speed, so
// GPS speed blips while parked cannot split one stop into short "traffic" pieces.
function markStopped(points, stops, stopMinMs) {
  const flagged = new Uint8Array(points.length);
  for (let i = 0; i < points.length;) {
    let j = i;
    while (j + 1 < points.length && distanceKm(points[i], points[j + 1]) <= STOP_RADIUS_KM) j += 1;
    if (points[j].timestamp - points[i].timestamp >= stopMinMs) {
      flagged.fill(1, i, j + 1);
      i = j + 1;
    } else i += 1;
  }
  let s = 0;
  points.forEach((point, index) => {
    while (s < stops.length && point.timestamp > stops[s].endTimestamp) s += 1;
    if (s < stops.length && point.timestamp >= stops[s].startTimestamp) flagged[index] = 1;
  });
  return flagged;
}

// Downsampled long ranges have wide point spacing, so a gap is relative to the median.
function recordingGapMs(points) {
  const gaps = [];
  for (let i = 1; i < points.length; i += 1) gaps.push(points[i].timestamp - points[i - 1].timestamp);
  gaps.sort((a, b) => a - b);
  return Math.max(MIN_GAP_MS, (gaps[gaps.length >> 1] ?? 0) * 10);
}

function smoothSpeeds(points, flagged) {
  const smooth = new Float64Array(points.length);
  let low = 0, high = 0, sum = 0, count = 0;
  points.forEach((point, index) => {
    while (high < points.length && points[high].timestamp <= point.timestamp + SMOOTH_MS) {
      if (!flagged[high]) { sum += points[high].speed; count += 1; }
      high += 1;
    }
    while (points[low].timestamp < point.timestamp - SMOOTH_MS) {
      if (!flagged[low]) { sum -= points[low].speed; count -= 1; }
      low += 1;
    }
    smooth[index] = count ? sum / count : point.speed;
  });
  return smooth;
}

const binKmh = (bin) => bin.km / (bin.ms / 3_600_000);

// Grows each seed over neighbours with a similar speed, so one long jam reads as
// one stretch instead of five rows. `used` keeps the two lists from sharing road.
function pickStretches(bins, direction, avgKmh, used, limit) {
  const order = bins.map((_, index) => index)
    .sort((a, b) => direction * (binKmh(bins[a]) - binKmh(bins[b])));
  const picked = [];
  for (const seed of order) {
    const seedKmh = binKmh(bins[seed]);
    // Only road slower than average is "slow", or a short route lists its open road as a jam.
    if (picked.length === limit || direction * (seedKmh - avgKmh) >= 0) break;
    if (used.has(seed)) continue;
    const similar = (index) => !used.has(index) && (direction > 0
      ? binKmh(bins[index]) <= seedKmh * STRETCH_GROW_RATIO
      : binKmh(bins[index]) >= seedKmh / STRETCH_GROW_RATIO);
    let first = seed, last = seed;
    while (first > 0 && bins[first - 1].endIndex === bins[first].startIndex && similar(first - 1)) first -= 1;
    while (last < bins.length - 1 && bins[last + 1].startIndex === bins[last].endIndex && similar(last + 1)) last += 1;
    const stretch = { startIndex: bins[first].startIndex, endIndex: bins[last].endIndex, km: 0, ms: 0 };
    for (let index = first; index <= last; index += 1) {
      used.add(index);
      stretch.km += bins[index].km;
      stretch.ms += bins[index].ms;
    }
    stretch.kmh = binKmh(stretch);
    picked.push(stretch);
  }
  return picked;
}

export function analyzeTraffic(points, { stops = [], stopMinMs = 180_000 } = {}) {
  const bands = BANDS.map((band) => ({ ...band, ms: 0, km: 0, pct: 0 }));
  const result = {
    bands, movingMs: 0, movingKm: 0, excludedMs: 0, avgKmh: 0,
    segBand: new Int8Array(points.length).fill(-1), smooth: new Float64Array(points.length),
    runs: [], slowest: [], fastest: [],
  };
  if (points.length < 2) return result;

  const flagged = markStopped(points, stops, stopMinMs);
  const gapMs = recordingGapMs(points);
  const smooth = result.smooth = smoothSpeeds(points, flagged);
  const segments = [];
  let run = null;
  for (let i = 1; i < points.length; i += 1) {
    const ms = Math.max(0, points[i].timestamp - points[i - 1].timestamp);
    const isGap = ms > gapMs;
    if (isGap || (flagged[i - 1] && flagged[i])) {
      result.excludedMs += ms;
      run = null;
      if (isGap) segments.push(null);
      continue;
    }
    const km = distanceKm(points[i - 1], points[i]);
    const band = result.segBand[i] = bandIndex(smooth[i]);
    bands[band].ms += ms;
    bands[band].km += km;
    result.movingMs += ms;
    result.movingKm += km;
    if (!run || run.band !== band) {
      run = { band, startIndex: i - 1, endIndex: i, km: 0, ms: 0 };
      result.runs.push(run);
    }
    run.endIndex = i;
    run.km += km;
    run.ms += ms;
    segments.push({ index: i, km, ms });
  }
  if (result.movingMs > 0) {
    result.avgKmh = result.movingKm / (result.movingMs / 3_600_000);
    for (const band of bands) band.pct = band.ms / result.movingMs * 100;
  }

  // Fixed-distance bins: time spent per km is what "where did the time go" means.
  const binKm = Math.min(10, Math.max(1, result.movingKm / 40));
  const bins = [];
  let bin = null;
  const closeBin = () => {
    if (bin && bin.ms > 0 && bin.km >= binKm / 2) bins.push(bin);
    bin = null;
  };
  for (const segment of segments) {
    if (!segment) { closeBin(); continue; }
    bin ??= { startIndex: segment.index - 1, endIndex: segment.index, km: 0, ms: 0 };
    bin.endIndex = segment.index;
    bin.km += segment.km;
    bin.ms += segment.ms;
    if (bin.km >= binKm) closeBin();
  }
  closeBin();
  const used = new Set();
  result.slowest = pickStretches(bins, 1, result.avgKmh, used, 5).sort((a, b) => b.ms - a.ms);
  result.fastest = pickStretches(bins, -1, result.avgKmh, used, 3);
  return result;
}
