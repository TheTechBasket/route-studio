export type Point = {
  timestamp: number;
  rawTimestamp: number;
  latitude: number;
  longitude: number;
  speed: number;
  rawSpeed: number;
  calculatedSpeed: number;
  heading: number;
  altitude: number | null;
  sensorX: number | null;
  sensorY: number | null;
  sensorZ: number | null;
  source: string;
  video: string;
};

export type VideoAnchor = { raw: number; corrected: number };

const VIDEO_DATE = /(?:NO|EV)(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/i;
const configuredMaximum = Number(process.env.MAX_SPEED_KMH || 130);
const MAX_REASONABLE_SPEED = Number.isFinite(configuredMaximum) && configuredMaximum > 0
  ? configuredMaximum
  : 130;

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === "") return null; // Number() turns both into 0
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function localVideoStart(video: string): number | null {
  const match = VIDEO_DATE.exec(video);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const value = new Date(year, month - 1, day, hour, minute, second).getTime();
  return Number.isFinite(value) ? value : null;
}

export function distanceKm(a: Point, b: Point): number {
  const radius = 6371;
  const dLat = (b.latitude - a.latitude) * Math.PI / 180;
  const dLon = (b.longitude - a.longitude) * Math.PI / 180;
  const lat1 = a.latitude * Math.PI / 180;
  const lat2 = b.latitude * Math.PI / 180;
  const value = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export function calculateSpeed(point: Point, previous: Point | null): number {
  if (!previous) return 0;
  const elapsedHours = (point.timestamp - previous.timestamp) / 3_600_000;
  if (elapsedHours <= 0 || elapsedHours > 1 / 60) return 0;
  const speed = distanceKm(previous, point) / elapsedHours;
  return Number.isFinite(speed) && speed <= MAX_REASONABLE_SPEED ? speed : 0;
}

export function cleanSpeed(rawSpeed: number, calculatedSpeed: number): number {
  if (!Number.isFinite(rawSpeed) || rawSpeed < 0) return calculatedSpeed;
  if (rawSpeed > MAX_REASONABLE_SPEED) return calculatedSpeed;
  if (calculatedSpeed > 0 && rawSpeed > calculatedSpeed * 1.75 + 30) return calculatedSpeed;
  return rawSpeed;
}

export function parseGpsLine(
  line: string,
  videoAnchors: Map<string, VideoAnchor>,
  source = "GPS data",
): Point | null {
  if (!line || line.startsWith("$")) return null;
  const fields = line.split(",");
  if (fields.length < 10 || fields[1]?.trim() !== "A") return null;

  const rawTimestamp = Number(fields[0]) * 1000;
  const latitude = Number(fields[2]);
  const longitude = Number(fields[3]);
  const speedRaw = Number(fields[4]);
  const headingRaw = Number(fields[5]);
  const video = fields[9]?.trim() || "";
  if (
    !Number.isFinite(rawTimestamp)
    || rawTimestamp <= 0
    || !Number.isFinite(latitude)
    || !Number.isFinite(longitude)
    || latitude < -90
    || latitude > 90
    || longitude < -180
    || longitude > 180
  ) return null;

  let anchor = videoAnchors.get(video);
  if (!anchor) {
    anchor = { raw: rawTimestamp, corrected: localVideoStart(video) ?? rawTimestamp };
    videoAnchors.set(video, anchor);
  }

  return {
    timestamp: anchor.corrected + (rawTimestamp - anchor.raw),
    rawTimestamp,
    latitude,
    longitude,
    speed: 0,
    rawSpeed: Number.isFinite(speedRaw) ? Math.max(0, speedRaw / 100) : 0,
    calculatedSpeed: 0,
    heading: Number.isFinite(headingRaw)
      ? Number((((headingRaw / 10) % 360 + 360) % 360).toFixed(1))
      : 0,
    altitude: null,
    sensorX: finiteOrNull(fields[6]),
    sensorY: finiteOrNull(fields[7]),
    sensorZ: finiteOrNull(fields[8]),
    source,
    video,
  };
}

function xmlText(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  return match?.[1]?.trim() ?? null;
}

function xmlNumber(block: string, tags: string[]): number | null {
  for (const tag of tags) {
    const value = finiteOrNull(xmlText(block, tag));
    if (value !== null) return value;
  }
  return null;
}

export function parseGpx(content: string, source: string, fallbackTime: number): Point[] {
  const points: Point[] = [];
  const pattern = /<(?:trkpt|rtept|wpt)\b([^>]*)>([\s\S]*?)<\/(?:trkpt|rtept|wpt)>/gi;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(content))) {
    const latitude = finiteOrNull(/\blat=["']([^"']+)/i.exec(match[1])?.[1]);
    const longitude = finiteOrNull(/\blon=["']([^"']+)/i.exec(match[1])?.[1]);
    if (latitude === null || longitude === null) continue;
    const block = match[2];
    const parsedTime = Date.parse(xmlText(block, "time") || "");
    const metersPerSecond = xmlNumber(block, ["speed", "gpxtpx:speed"]);
    const heading = xmlNumber(block, ["course", "heading"]) ?? 0;
    const timestamp = Number.isFinite(parsedTime) ? parsedTime : fallbackTime + index * 1000;
    points.push({
      timestamp,
      rawTimestamp: timestamp,
      latitude,
      longitude,
      speed: 0,
      rawSpeed: metersPerSecond === null ? NaN : metersPerSecond * 3.6,
      calculatedSpeed: 0,
      heading,
      altitude: xmlNumber(block, ["ele"]),
      sensorX: null,
      sensorY: null,
      sensorZ: null,
      source,
      video: xmlText(block, "name") ?? "",
    });
    index += 1;
  }
  return points;
}

function propertyAt(properties: Record<string, unknown>, names: string[], index: number): unknown {
  for (const name of names) {
    const value = properties[name];
    if (Array.isArray(value)) return value[index];
    if (value !== undefined) return value;
  }
  return undefined;
}

export function parseGeoJson(content: string, source: string, fallbackTime: number): Point[] {
  const document = JSON.parse(content);
  const features = document.type === "FeatureCollection"
    ? document.features
    : document.type === "Feature"
      ? [document]
      : [{ type: "Feature", geometry: document, properties: {} }];
  const points: Point[] = [];

  function addLine(coordinates: unknown[], properties: Record<string, unknown>): void {
    coordinates.forEach((coordinate, index) => {
      if (!Array.isArray(coordinate)) return;
      const longitude = finiteOrNull(coordinate[0]);
      const latitude = finiteOrNull(coordinate[1]);
      if (latitude === null || longitude === null) return;
      const timeValue = propertyAt(properties, ["timestamps", "times", "coordTimes", "time"], index);
      const parsedTime = typeof timeValue === "number" ? timeValue : Date.parse(String(timeValue ?? ""));
      const timestamp = Number.isFinite(parsedTime) ? parsedTime : fallbackTime + points.length * 1000;
      const speedValue = finiteOrNull(propertyAt(properties, ["speeds", "speed"], index)) ?? NaN;
      points.push({
        timestamp,
        rawTimestamp: timestamp,
        latitude,
        longitude,
        speed: 0,
        rawSpeed: speedValue,
        calculatedSpeed: 0,
        heading: finiteOrNull(propertyAt(properties, ["headings", "heading", "bearing"], index)) ?? 0,
        altitude: finiteOrNull(coordinate[2]),
        sensorX: finiteOrNull(propertyAt(properties, ["sensorX", "gX"], index)),
        sensorY: finiteOrNull(propertyAt(properties, ["sensorY", "gY"], index)),
        sensorZ: finiteOrNull(propertyAt(properties, ["sensorZ", "gZ"], index)),
        source,
        video: String(propertyAt(properties, ["videos", "video", "name"], index) ?? ""),
      });
    });
  }

  for (const feature of features ?? []) {
    const geometry = feature?.geometry;
    const properties = feature?.properties ?? {};
    if (geometry?.type === "LineString" || geometry?.type === "MultiPoint") {
      addLine(geometry.coordinates ?? [], properties);
    } else if (geometry?.type === "MultiLineString") {
      for (const line of geometry.coordinates ?? []) addLine(line, properties);
    } else if (geometry?.type === "Point") {
      addLine([geometry.coordinates], properties);
    }
  }
  return points;
}

export function finalizePoints(points: Point[], previous: Point | null = null): Point[] {
  for (const point of points) {
    point.calculatedSpeed = calculateSpeed(point, previous);
    point.speed = cleanSpeed(point.rawSpeed, point.calculatedSpeed);
    if (!Number.isFinite(point.rawSpeed)) point.rawSpeed = 0;
    previous = point;
  }
  return points;
}

export function serializePoint(point: Point): string {
  return [
    point.timestamp,
    point.rawTimestamp,
    point.latitude,
    point.longitude,
    point.speed,
    point.rawSpeed,
    point.calculatedSpeed,
    point.heading,
    point.altitude ?? "",
    point.sensorX ?? "",
    point.sensorY ?? "",
    point.sensorZ ?? "",
    encodeURIComponent(point.source),
    encodeURIComponent(point.video),
  ].join("\t");
}

export function deserializePoint(line: string): Point | null {
  const fields = line.split("\t");
  if (fields.length < 14) return null;
  const point: Point = {
    timestamp: Number(fields[0]),
    rawTimestamp: Number(fields[1]),
    latitude: Number(fields[2]),
    longitude: Number(fields[3]),
    speed: Number(fields[4]),
    rawSpeed: Number(fields[5]),
    calculatedSpeed: Number(fields[6]),
    heading: Number(fields[7]),
    altitude: fields[8] === "" ? null : Number(fields[8]),
    sensorX: fields[9] === "" ? null : Number(fields[9]),
    sensorY: fields[10] === "" ? null : Number(fields[10]),
    sensorZ: fields[11] === "" ? null : Number(fields[11]),
    source: decodeURIComponent(fields[12]),
    video: decodeURIComponent(fields[13]),
  };
  return [
    point.timestamp,
    point.latitude,
    point.longitude,
    point.speed,
    point.rawSpeed,
    point.calculatedSpeed,
    point.heading,
  ].every(Number.isFinite) ? point : null;
}
