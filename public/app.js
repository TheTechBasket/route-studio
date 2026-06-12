const $ = (selector) => document.querySelector(selector);
const map = L.map("map", { zoomControl: false, preferCanvas: true }).setView([25.7, 78.7], 8);
L.control.zoom({ position: "topright" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 19,
}).addTo(map);

const metrics = {
  speed: { label: "Cleaned speed", unit: "speed" },
  rawSpeed: { label: "Raw device speed", unit: "speed" },
  calculatedSpeed: { label: "Calculated speed", unit: "speed" },
  heading: { label: "Heading", unit: "°" },
  altitude: { label: "Altitude", unit: "m" },
  sensorX: { label: "Sensor X", unit: "raw" },
  sensorY: { label: "Sensor Y", unit: "raw" },
  sensorZ: { label: "Sensor Z", unit: "raw" },
};

let routeLayer;
let traveledLayer;
let startMarker;
let endMarker;
let marker;
let points = [];
let replayTimeline = [];
let replayFrame = null;
let replayStartedAt = 0;
let replayBaseIndex = 0;
let latestRange = null;
let lastReplayIndex = -1;
let lastFollowAt = 0;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const toast = (message) => {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").classList.remove("show"), 3000);
};

function toInputValue(timestamp) {
  const date = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 19);
}

function selectedRange() {
  return { start: new Date($("#start").value).getTime(), end: new Date($("#end").value).getTime() };
}

function updateExportLinks() {
  const { start, end } = selectedRange();
  const query = new URLSearchParams({ start, end });
  $("#gpx").href = `/api/export.gpx?${query}`;
  $("#geojson").href = `/api/export.geojson?${query}`;
}

function useLatestDay() {
  if (!latestRange) return;
  $("#start").value = toInputValue(latestRange.start);
  $("#end").value = toInputValue(latestRange.end);
  updateExportLinks();
}

async function initialize() {
  const response = await fetch("/api/meta");
  const meta = await response.json();
  const days = Object.entries(meta.days).sort(([a], [b]) => a.localeCompare(b));
  if (!days.length) {
    $("#index-status").textContent = "Index is empty";
    toast("Add files to data/input, then run pnpm import");
    return;
  }
  const [, latest] = days.at(-1);
  latestRange = { start: latest.minTime, end: latest.maxTime };
  useLatestDay();
  const count = days.reduce((sum, [, day]) => sum + day.count, 0);
  $("#index-status").textContent = `${count.toLocaleString()} points / ${meta.sources.length} files`;
}

function displayValue(point, metricName = $("#metric").value) {
  const metric = metrics[metricName];
  const raw = point?.[metricName];
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return { value: null, text: "—", unit: metric.unit };
  if (metric.unit === "speed") {
    const mph = $("#unit").value === "mph";
    const value = mph ? raw * 0.621371 : raw;
    return { value, text: value.toFixed(1), unit: mph ? "mph" : "km/h" };
  }
  return { value: raw, text: raw.toFixed(1), unit: metric.unit };
}

function chartValues() {
  return points.map((point) => displayValue(point).value);
}

function drawChart(activeIndex = -1) {
  const canvas = $("#chart");
  const ratio = devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);
  if (!points.length) return;
  const values = chartValues();
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return;
  const minimum = Math.min(0, ...valid);
  const maximum = Math.max(10, ...valid);
  const span = Math.max(1, maximum - minimum);
  const x = (index) => index / Math.max(1, points.length - 1) * width;
  const y = (value) => height - 7 - ((value ?? minimum) - minimum) / span * (height - 15);

  context.beginPath();
  values.forEach((value, index) => {
    const current = Number.isFinite(value) ? value : minimum;
    index ? context.lineTo(x(index), y(current)) : context.moveTo(x(index), y(current));
  });
  context.lineTo(width, height);
  context.lineTo(0, height);
  context.closePath();
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "#c9ff3d99");
  gradient.addColorStop(1, "#c9ff3d05");
  context.fillStyle = gradient;
  context.fill();
  context.beginPath();
  values.forEach((value, index) => {
    const current = Number.isFinite(value) ? value : minimum;
    index ? context.lineTo(x(index), y(current)) : context.moveTo(x(index), y(current));
  });
  context.strokeStyle = "#c9ff3d";
  context.lineWidth = 1.5;
  context.stroke();
  if (activeIndex >= 0) {
    context.fillStyle = "#fff";
    context.fillRect(x(activeIndex) - 1, 0, 2, height);
  }
}

function buildReplayTimeline() {
  replayTimeline = [0];
  for (let index = 1; index < points.length; index += 1) {
    const realGap = points[index].timestamp - points[index - 1].timestamp;
    const compressedGap = Math.min(1000, Math.max(30, Number.isFinite(realGap) ? realGap : 30));
    replayTimeline.push(replayTimeline[index - 1] + compressedGap);
  }
}

function timelineIndex(target) {
  let low = 0;
  let high = replayTimeline.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (replayTimeline[middle] <= target) low = middle;
    else high = middle - 1;
  }
  return low;
}

function setReplayIndex(index, position = null) {
  if (!points.length || !marker) return;
  index = Math.max(0, Math.min(points.length - 1, Math.round(index)));
  const point = points[index];
  const markerPosition = position ?? [point.latitude, point.longitude];
  marker.setLatLng(markerPosition);
  if (index !== lastReplayIndex) {
    traveledLayer.setLatLngs(points.slice(0, index + 1).map((item) => [item.latitude, item.longitude]));
    lastReplayIndex = index;
  }
  const now = performance.now();
  if ($("#follow").checked && replayFrame !== null && now - lastFollowAt > 350) {
    map.panInside(markerPosition, {
      paddingTopLeft: [90, 90],
      paddingBottomRight: [90, 90],
      animate: !reduceMotion,
      duration: 0.45,
      easeLinearity: 0.2,
    });
    lastFollowAt = now;
  }
  $("#scrubber").value = index;
  const current = displayValue(point);
  $("#current-value").innerHTML = `${current.text} <em>${current.unit}</em>`;
  $("#current-time").textContent = new Date(point.timestamp).toLocaleString();
  $("#video-name").textContent = point.video || point.source;
  drawChart(index);
}

function stopReplay() {
  if (replayFrame !== null) cancelAnimationFrame(replayFrame);
  replayFrame = null;
  $("#play").textContent = "▶";
  $("#play").setAttribute("aria-label", "Play replay");
}

function playReplay() {
  if (!points.length) return toast("Load a route first");
  if (replayFrame !== null) return stopReplay();
  replayBaseIndex = Number($("#scrubber").value);
  if (replayBaseIndex >= points.length - 1) replayBaseIndex = 0;
  setReplayIndex(replayBaseIndex);
  if ($("#follow").checked) {
    const point = points[replayBaseIndex];
    map.flyTo(
      [point.latitude, point.longitude],
      Math.max(map.getZoom(), 15),
      { animate: !reduceMotion, duration: reduceMotion ? 0 : 1.1, easeLinearity: 0.2 },
    );
  }
  replayStartedAt = performance.now();
  lastFollowAt = 0;
  $("#play").textContent = "Ⅱ";
  $("#play").setAttribute("aria-label", "Pause replay");
  const tick = (now) => {
    const rate = Number($("#rate").value);
    const target = replayTimeline[replayBaseIndex] + (now - replayStartedAt) * rate;
    const index = timelineIndex(target);
    const nextIndex = Math.min(index + 1, points.length - 1);
    const segmentStart = replayTimeline[index];
    const segmentEnd = replayTimeline[nextIndex];
    const progress = segmentEnd > segmentStart
      ? Math.min(1, Math.max(0, (target - segmentStart) / (segmentEnd - segmentStart)))
      : 0;
    const current = points[index];
    const next = points[nextIndex];
    const position = [
      current.latitude + (next.latitude - current.latitude) * progress,
      current.longitude + (next.longitude - current.longitude) * progress,
    ];
    setReplayIndex(index, position);
    if (index >= points.length - 1) return stopReplay();
    replayFrame = requestAnimationFrame(tick);
  };
  replayFrame = requestAnimationFrame(tick);
}

async function loadRoute() {
  stopReplay();
  updateExportLinks();
  const { start, end } = selectedRange();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return toast("Choose a valid date and time range");
  $("#load").disabled = true;
  $("#load").firstChild.textContent = "Loading… ";
  try {
    const response = await fetch(`/api/route?${new URLSearchParams({ start, end })}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    const feature = data.features[0];
    const coordinates = feature.geometry.coordinates;
    const properties = feature.properties;
    const summary = properties.summary;
    points = coordinates.map(([longitude, latitude, altitude], index) => ({
      longitude,
      latitude,
      altitude: properties.altitudes[index] ?? altitude ?? null,
      speed: properties.speeds[index],
      rawSpeed: properties.rawSpeeds[index],
      calculatedSpeed: properties.calculatedSpeeds[index],
      heading: properties.headings[index],
      sensorX: properties.sensorX[index],
      sensorY: properties.sensorY[index],
      sensorZ: properties.sensorZ[index],
      timestamp: properties.timestamps[index],
      source: properties.sources[index],
      video: properties.videos[index],
    }));
    if (!points.length) return toast("No valid GPS points in that period");
    routeLayer?.remove();
    traveledLayer?.remove();
    marker?.remove();
    startMarker?.remove();
    endMarker?.remove();
    const latLngs = points.map((point) => [point.latitude, point.longitude]);
    routeLayer = L.polyline(latLngs, { color: "#171a18", weight: 5, opacity: .72 }).addTo(map);
    traveledLayer = L.polyline([], { color: "#c9ff3d", weight: 5 }).addTo(map);
    marker = L.circleMarker(latLngs[0], { radius: 8, fillColor: "#c9ff3d", color: "#171a18", weight: 3, fillOpacity: 1 }).addTo(map);
    startMarker = L.circleMarker(latLngs[0], { radius: 5, fillColor: "#fff", color: "#171a18", weight: 2, fillOpacity: 1 }).bindTooltip("Start").addTo(map);
    endMarker = L.circleMarker(latLngs.at(-1), { radius: 5, fillColor: "#171a18", color: "#fff", weight: 2, fillOpacity: 1 }).bindTooltip("End").addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [35, 35] });
    buildReplayTimeline();
    lastReplayIndex = -1;
    $("#scrubber").max = points.length - 1;
    $("#scrubber").value = 0;
    $("#point-count").textContent = summary.pointCount.toLocaleString();
    $("#distance").textContent = `${summary.distanceKm.toFixed(1)} km`;
    $("#peak").textContent = `${summary.peakSpeed.toFixed(1)} km/h`;
    $("#duration").textContent = formatDuration(summary.selectedDurationMs);
    $("#source-count").textContent = summary.sourceCount;
    $("#range-label").textContent = `${new Date(start).toLocaleString()} → ${new Date(end).toLocaleString()}`;
    setReplayIndex(0);
  } catch (error) {
    toast(error.message || "Could not load route");
  } finally {
    $("#load").disabled = false;
    $("#load").firstChild.textContent = "Load route ";
  }
}

function formatDuration(milliseconds) {
  const totalMinutes = Math.floor(milliseconds / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
}

$("#load").addEventListener("click", loadRoute);
$("#latest").addEventListener("click", useLatestDay);
$("#play").addEventListener("click", playReplay);
$("#scrubber").addEventListener("input", (event) => { stopReplay(); setReplayIndex(event.target.value); });
$("#metric").addEventListener("change", () => setReplayIndex($("#scrubber").value));
$("#unit").addEventListener("change", () => setReplayIndex($("#scrubber").value));
$("#start").addEventListener("change", updateExportLinks);
$("#end").addEventListener("change", updateExportLinks);
window.addEventListener("resize", () => drawChart(Number($("#scrubber").value)));
initialize().catch(() => toast("Could not read the route index"));
