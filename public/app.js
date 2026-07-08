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
let pausedStops = new Set();
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let stopsOverrides = {};
let highlights = [];
let stopMarkers = [];
let highlightMarkers = [];
let detectedStops = [];
let categories = [
  { type: "jyotirlinga", label: "Jyotirlinga", emoji: "🛕" },
  { type: "city", label: "City / Town", emoji: "🏙️" },
  { type: "scenic", label: "Scenic Spot", emoji: "📸" },
  { type: "stay", label: "Stay / Hotel", emoji: "🏨" },
  { type: "food", label: "Food / Rest", emoji: "🍴" },
  { type: "other", label: "Other Highlight", emoji: "📍" }
];

let snappedLatLngs = null;
let snappedLayer = null;

const toast = (message) => {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").classList.remove("show"), 3000);
};

function toInputValue(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function selectedRange() {
  const startVal = $("#start").value;
  const endVal = $("#end").value;
  if (!startVal || !endVal) return { start: 0, end: 0 };
  const startDate = new Date(startVal + "T00:00:00");
  const endDate = new Date(endVal + "T23:59:59");
  return { start: startDate.getTime(), end: endDate.getTime() };
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
  try {
    const configRes = await fetch("/api/config");
    const configData = await configRes.json();
    stopsOverrides = configData.stopsOverrides || {};
    highlights = configData.highlights || [];
    if (configData.categories) {
      categories = configData.categories;
    }
  } catch (e) {
    console.error("Could not load config", e);
  }

  const response = await fetch("/api/meta");
  const meta = await response.json();
  const days = Object.entries(meta.days).sort(([a], [b]) => a.localeCompare(b));
  if (!days.length) {
    $("#index-status").textContent = "Index is empty";
    toast("Add files to data/input, then run pnpm import");
    return;
  }

  // Populate day picker dropdown
  const picker = $("#day-picker");
  picker.innerHTML = '<option value="">-- Choose a day --</option>';
  days.forEach(([dayKey, dayData]) => {
    const opt = document.createElement("option");
    opt.value = dayKey;
    opt.textContent = `${dayKey} (${dayData.count.toLocaleString()} pts)`;
    picker.appendChild(opt);
  });

  picker.addEventListener("change", () => {
    const selectedDay = picker.value;
    if (selectedDay) {
      $("#start").value = selectedDay;
      $("#end").value = selectedDay;
      updateExportLinks();
      loadRoute();
    }
  });

  const [, latest] = days.at(-1);
  latestRange = { start: latest.minTime, end: latest.maxTime };
  useLatestDay();
  const count = days.reduce((sum, [, day]) => sum + day.count, 0);
  $("#index-status").textContent = `${count.toLocaleString()} points / ${meta.sources.length} files`;

  renderCategoriesList();
  await loadRoute();
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
  if ($("#follow").checked && replayFrame !== null && now - lastFollowAt > 500) {
    map.panTo(markerPosition, {
      animate: !reduceMotion,
      duration: 0.35,
      easeLinearity: 0.3,
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
  pausedStops.clear();
  if ($("#follow").checked) {
    const point = points[replayBaseIndex];
    map.setView(
      [point.latitude, point.longitude],
      Math.min(map.getZoom(), 13),
      { animate: !reduceMotion, duration: reduceMotion ? 0 : 0.5, easeLinearity: 0.2 },
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
    // Pause briefly at detected stops
    const stopPause = (() => {
      for (const s of detectedStops) {
        if (current.timestamp >= s.startTimestamp && current.timestamp < s.endTimestamp && !pausedStops.has(s.id)) {
          pausedStops.add(s.id);
          return 800;
        }
      }
      return 0;
    })();
    if (stopPause > 0) {
      setTimeout(() => {
        if (replayFrame !== null) replayFrame = requestAnimationFrame(tick);
      }, stopPause / Math.min(rate, 20));
      return;
    }
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

    // Detect and render stops / highlights
    detectedStops = detectStops(points);
    geocodeQueue = [];
    detectedStops.forEach(stop => {
      queueGeocode(stop.latitude, stop.longitude, (name) => {
        stop.name = `Stop near ${name}`;
        renderStopsList();
        const marker = stopMarkers.find(m => m.getLatLng().lat === stop.latitude && m.getLatLng().lng === stop.longitude);
        if (marker) {
          marker.setTooltipContent(`${formatDuration(stop.duration)} — ${stop.name}`);
        }
      });
    });

    snappedLatLngs = null;
    if (snappedLayer) {
      snappedLayer.remove();
      snappedLayer = null;
    }
    if ($("#snap-roads").checked) {
      await updateRoadSnapping();
    }

    renderStopsList();
    renderStopsOnMap();
    renderHighlightsOnMap();
    renderHighlightsList();

    $("#range-display").textContent = `${toInputValue(start)} → ${toInputValue(end)}`;
    $("#time-section").classList.add("loaded");

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

async function saveConfig() {
  try {
    await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stopsOverrides, highlights, categories })
    });
  } catch (e) {
    console.error("Could not save config", e);
    toast("Error saving changes to server");
  }
}

// Nominatim Geocoding queue to respect rate limits (max 1 req/sec)
let geocodeQueue = [];
let geocodeTimeout = null;

function processGeocodeQueue() {
  if (geocodeQueue.length === 0) return;
  const task = geocodeQueue.shift();
  task().then(() => {
    geocodeTimeout = setTimeout(processGeocodeQueue, 1100);
  });
}

function queueGeocode(lat, lng, callback) {
  geocodeQueue.push(async () => {
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=12`, {
        headers: { "User-Agent": "RouteStudio/1.0" }
      });
      const data = await res.json();
      const name = data.address.city || data.address.town || data.address.village || data.address.suburb || data.display_name.split(',')[0] || "Unknown Place";
      callback(name);
    } catch (e) {
      console.error(e);
    }
  });
  if (!geocodeTimeout && geocodeQueue.length === 1) {
    processGeocodeQueue();
  }
}

function detectStops(routePoints) {
  const stops = [];
  if (routePoints.length < 2) return stops;

  const TIME_GAP_LIMIT = 15 * 60 * 1000; // 15 mins
  const STATIONARY_SPEED_LIMIT = 1.5; // km/h
  const STATIONARY_TIME_LIMIT = 15 * 60 * 1000; // 15 mins

  let i = 0;
  while (i < routePoints.length - 1) {
    const p1 = routePoints[i];
    const p2 = routePoints[i + 1];
    const timeDiff = p2.timestamp - p1.timestamp;

    if (timeDiff > TIME_GAP_LIMIT) {
      const stopId = `stop-${p1.timestamp}`;
      stops.push({
        id: stopId,
        latitude: p1.latitude,
        longitude: p1.longitude,
        startTimestamp: p1.timestamp,
        endTimestamp: p2.timestamp,
        duration: timeDiff,
        type: stopsOverrides[stopId] || (timeDiff > 6 * 60 * 60 * 1000 ? "night" : "rest"),
        isAuto: !stopsOverrides[stopId]
      });
      i++;
      continue;
    }

    if (p1.speed < STATIONARY_SPEED_LIMIT) {
      let j = i + 1;
      let stationaryDuration = 0;
      while (j < routePoints.length && routePoints[j].speed < STATIONARY_SPEED_LIMIT) {
        stationaryDuration = routePoints[j].timestamp - p1.timestamp;
        j++;
      }
      if (stationaryDuration > STATIONARY_TIME_LIMIT) {
        const lastStationaryPoint = routePoints[j - 1];
        const stopId = `stop-${p1.timestamp}`;
        stops.push({
          id: stopId,
          latitude: p1.latitude,
          longitude: p1.longitude,
          startTimestamp: p1.timestamp,
          endTimestamp: lastStationaryPoint.timestamp,
          duration: stationaryDuration,
          type: stopsOverrides[stopId] || (stationaryDuration > 6 * 60 * 60 * 1000 ? "night" : "rest"),
          isAuto: !stopsOverrides[stopId]
        });
        i = j;
        continue;
      }
    }

    i++;
  }
  return stops;
}

function loadedHighlights() {
  if (!$("#show-highlights").checked) return [];
  const { start, end } = selectedRange();
  return highlights.filter(place => {
    if (!place.timestamp) return true; // show legacy/global pins
    return place.timestamp >= start && place.timestamp <= end;
  });
}

function findClosestRoutePoint(lat, lng) {
  if (!points || !points.length) return null;
  let closest = points[0];
  let minDist = Infinity;
  points.forEach(p => {
    const dist = Math.pow(p.latitude - lat, 2) + Math.pow(p.longitude - lng, 2);
    if (dist < minDist) {
      minDist = dist;
      closest = p;
    }
  });
  return closest;
}

function renderStopsList() {
  const container = $("#stops-list");
  if (!detectedStops.length) {
    container.innerHTML = `<p class="empty-note">No stops detected</p>`;
    return;
  }
  container.innerHTML = "";
  detectedStops.forEach(stop => {
    const card = document.createElement("div");
    card.className = "stop-card";
    
    const startTimeStr = new Date(stop.startTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const durationStr = formatDuration(stop.duration);
    const stopType = stop.type;
    
    card.innerHTML = `
      <div class="card-header">
        <span class="card-title">${stop.name || `Stop at ${startTimeStr}`}</span>
        <span class="stop-duration">${durationStr}</span>
      </div>
      <div class="card-subtitle">
        ${new Date(stop.startTimestamp).toLocaleDateString()} ${startTimeStr}
      </div>
      <div class="toggle-group">
        <button class="${stopType === 'rest' ? 'active' : ''}" data-type="rest">Rest Stop</button>
        <button class="${stopType === 'night' ? 'active' : ''}" data-type="night">Night Stay</button>
      </div>
    `;
    
    const buttons = card.querySelectorAll(".toggle-group button");
    buttons.forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const newType = btn.getAttribute("data-type");
        stopsOverrides[stop.id] = newType;
        stop.type = newType;
        saveConfig();
        renderStopsList();
        renderStopsOnMap();
      });
    });
    
    card.addEventListener("click", () => {
      map.flyTo([stop.latitude, stop.longitude], 15);
    });
    
    container.appendChild(card);
  });
}

function renderStopsOnMap() {
  stopMarkers.forEach(m => m.remove());
  stopMarkers = [];

  if (!$("#show-stops").checked) return;

  detectedStops.forEach(stop => {
    const isNight = stop.type === "night";
    const m = L.circleMarker([stop.latitude, stop.longitude], {
      radius: isNight ? 9 : 6,
      fillColor: isNight ? "#171a18" : "#c9ff3d",
      color: isNight ? "#c9ff3d" : "#171a18",
      weight: 2.5,
      fillOpacity: 1
    })
      .bindTooltip(formatDuration(stop.duration), {
        direction: 'top',
        className: 'custom-tooltip'
      })
      .addTo(map);

    m.bindPopup(() => {
      const container = document.createElement("div");
      container.className = "highlight-info-popup";
      container.innerHTML = `
        <h3>${stop.name || 'Stop'}</h3>
        <p class="category">${isNight ? 'Night Stay' : 'Rest Stop'}</p>
        <p style="margin: 0; font-size: 10px; color: var(--muted);">Duration: ${formatDuration(stop.duration)}</p>
        <p style="margin: 4px 0 8px; font-size: 10px; color: var(--muted);">${new Date(stop.startTimestamp).toLocaleString()}</p>
        <button class="secondary popup-btn-toggle" style="width: 100%; font-size: 10px; padding: 4px 8px;">
          Switch to ${isNight ? 'Rest Stop' : 'Night Stay'}
        </button>
      `;

      container.querySelector(".popup-btn-toggle").addEventListener("click", () => {
        const newType = isNight ? 'rest' : 'night';
        stopsOverrides[stop.id] = newType;
        stop.type = newType;
        saveConfig();
        m.closePopup();
        renderStopsList();
        renderStopsOnMap();
      });

      return container;
    });

    stopMarkers.push(m);
  });
}

function renderHighlightsList() {
  const container = $("#highlights-list");
  const list = loadedHighlights();
  if (!list.length) {
    container.innerHTML = `<p class="empty-note">No highlighted places</p>`;
    return;
  }
  container.innerHTML = "";
  
  list.forEach(place => {
    const card = document.createElement("div");
    card.className = "highlight-card";
    
    const cat = categories.find(c => c.type === place.type) || { label: "Highlight" };
    const catName = cat.label;

    card.innerHTML = `
      <div class="card-header">
        <span class="card-title">${place.name}</span>
        <span class="highlight-tag">${catName}</span>
      </div>
      <div class="card-subtitle" style="font-family: 'DM Mono', monospace; font-size: 9px; color: var(--muted);">
        ${place.timestamp ? new Date(place.timestamp).toLocaleString() : 'Global Pin'}
      </div>
      <div class="card-actions">
        <button class="btn-delete">Delete</button>
        <button class="btn-edit">Edit</button>
      </div>
    `;
    
    card.querySelector(".btn-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteHighlight(place.id);
    });
    
    card.querySelector(".btn-edit").addEventListener("click", (e) => {
      e.stopPropagation();
      editHighlight(place);
    });
    
    card.addEventListener("click", () => {
      map.flyTo([place.lat, place.lng], 14);
      const marker = highlightMarkers.find(m => m.options.highlightId === place.id);
      if (marker) marker.openPopup();
    });
    
    container.appendChild(card);
  });
}

function renderHighlightsOnMap() {
  highlightMarkers.forEach(m => m.remove());
  highlightMarkers = [];
  
  if (!$("#show-highlights").checked) return;

  const list = loadedHighlights();
  list.forEach(place => {
    const cat = categories.find(c => c.type === place.type) || { label: "Highlight" };

    const markerHtml = `
      <div style="
        background: var(--lime);
        border: 2px solid var(--ink);
        border-radius: 50%;
        width: 26px;
        height: 26px;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
      ">
        <div style="width: 6px; height: 6px; background: var(--ink); border-radius: 50%;"></div>
      </div>
    `;

    const icon = L.divIcon({
      html: markerHtml,
      className: '',
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });

    const m = L.marker([place.lat, place.lng], { icon })
      .bindTooltip(place.name, {
        permanent: true,
        direction: 'top',
        className: 'custom-tooltip',
        offset: [0, -10]
      })
      .addTo(map);
      
    m.options.highlightId = place.id;
    
    m.bindPopup(() => {
      const container = document.createElement("div");
      container.className = "highlight-info-popup";
      container.innerHTML = `
        <h3>${place.name}</h3>
        <p class="category">${cat.emoji || '📍'} ${cat.label}</p>
        <p style="margin: 0 0 8px; font-family: 'DM Mono', monospace; font-size: 9px; color: var(--muted);">
          ${place.timestamp ? new Date(place.timestamp).toLocaleString() : 'Global Pin'}
        </p>
        <div style="display:flex; justify-content:space-between; margin-top: 8px; gap: 8px;">
          <button class="popup-btn-delete text-button" style="color: #ff5252; font-size: 10px;">Delete</button>
          <button class="popup-btn-edit secondary" style="font-size: 10px; padding: 4px 8px;">Edit</button>
        </div>
      `;
      
      container.querySelector(".popup-btn-delete").addEventListener("click", () => {
        deleteHighlight(place.id);
      });
      
      container.querySelector(".popup-btn-edit").addEventListener("click", () => {
        m.closePopup();
        editHighlight(place);
      });
      
      return container;
    });
    
    highlightMarkers.push(m);
  });
}

function deleteHighlight(id) {
  highlights = highlights.filter(h => h.id !== id);
  saveConfig();
  renderHighlightsList();
  renderHighlightsOnMap();
}

function editHighlight(place) {
  openHighlightForm(place.lat, place.lng, place);
}

function openHighlightForm(lat, lng, existingHighlight = null) {
  map.closePopup();
  
  const tempMarker = L.marker([lat, lng]).addTo(map);
  
  const container = document.createElement("div");
  container.className = "highlight-popup";
  
  const isEdit = !!existingHighlight;
  const title = isEdit ? "Edit Highlighted Place" : "Highlight this Place";
  const placeName = isEdit ? existingHighlight.name : "";
  const placeType = isEdit ? existingHighlight.type : "jyotirlinga";
  
  const closestPoint = findClosestRoutePoint(lat, lng);
  let initialTime = closestPoint ? closestPoint.timestamp : (selectedRange().start || Date.now());
  if (isEdit && existingHighlight.timestamp) {
    initialTime = existingHighlight.timestamp;
  }
  const timeInputValue = toInputValue(initialTime);

  const optionsHtml = categories.map(cat => 
    `<option value="${cat.type}" ${placeType === cat.type ? 'selected' : ''}>${cat.emoji} ${cat.label}</option>`
  ).join("");
  
  container.innerHTML = `
    <h3>${title}</h3>
    <input type="text" id="popup-place-name" placeholder="Place name (e.g. Omkareshwar)" value="${placeName}">
    <select id="popup-place-type">
      ${optionsHtml}
    </select>
    <label style="margin-top: 6px; font-size: 9px; font-family: 'DM Mono', monospace; text-transform: uppercase;">Time Visited</label>
    <input type="date" id="popup-place-time" value="${timeInputValue}">
    <div style="display:flex; justify-content:space-between; margin-top: 8px; gap: 8px;">
      <button class="popup-btn-cancel text-button" style="font-size: 10px;">Cancel</button>
      <button class="popup-btn-save secondary" style="font-size: 10px; padding: 4px 8px;">Save</button>
    </div>
  `;
  
  tempMarker.bindPopup(container, { closeOnClick: false, closeButton: false }).openPopup();
  
  setTimeout(() => {
    const input = document.getElementById("popup-place-name");
    if (input) input.focus();
  }, 100);
  
  if (!isEdit) {
    const input = container.querySelector("#popup-place-name");
    input.placeholder = "Loading location name...";
    
    fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=12`, {
      headers: { "User-Agent": "RouteStudio/1.0" }
    })
      .then(res => res.json())
      .then(data => {
        const address = data.address;
        const suggested = address.city || address.town || address.village || address.suburb || data.display_name.split(',')[0];
        if (suggested) {
          input.value = suggested;
        }
        input.placeholder = "Place name (e.g. Omkareshwar)";
      })
      .catch(() => {
        input.placeholder = "Place name (e.g. Omkareshwar)";
      });
  }
  
  container.querySelector(".popup-btn-cancel").addEventListener("click", () => {
    tempMarker.remove();
  });
  
  container.querySelector(".popup-btn-save").addEventListener("click", () => {
    const name = container.querySelector("#popup-place-name").value.trim();
    const type = container.querySelector("#popup-place-type").value;
    const timeString = container.querySelector("#popup-place-time").value;
    // Set default time to midnight for the selected date
    const timestamp = timeString ? new Date(timeString + "T00:00:00").getTime() : null;

    if (!name) return toast("Please enter a name for the highlight");
    
    if (isEdit) {
      const h = highlights.find(item => item.id === existingHighlight.id);
      if (h) {
        h.name = name;
        h.type = type;
        h.timestamp = timestamp;
      }
    } else {
      highlights.push({
        id: `highlight-${Date.now()}`,
        name,
        type,
        lat,
        lng,
        timestamp
      });
    }
    
    saveConfig();
    tempMarker.remove();
    renderHighlightsList();
    renderHighlightsOnMap();
  });
}

// Map Click Listener to add highlights
map.on("click", (e) => {
  openHighlightForm(e.latlng.lat, e.latlng.lng);
});

// Custom pin at center button
$("#add-custom-highlight").addEventListener("click", () => {
  const center = map.getCenter();
  openHighlightForm(center.lat, center.lng);
});

// Search functionality
let searchDebounceTimeout = null;

function performSearch() {
  const query = $("#highlight-search").value.trim();
  if (query.length < 3) {
    $("#search-results").classList.add("hidden");
    return;
  }
  
  fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`, {
    headers: { "User-Agent": "RouteStudio/1.0" }
  })
    .then(res => res.json())
    .then(data => {
      const resultsDiv = $("#search-results");
      if (!data.length) {
        resultsDiv.innerHTML = `<p class="empty-note" style="padding: 10px;">No places found</p>`;
        resultsDiv.classList.remove("hidden");
        return;
      }
      
      resultsDiv.innerHTML = "";
      data.forEach(item => {
        const btn = document.createElement("button");
        btn.className = "search-result-item";
        btn.textContent = item.display_name;
        btn.addEventListener("click", () => {
          const lat = parseFloat(item.lat);
          const lon = parseFloat(item.lon);
          map.flyTo([lat, lon], 13);
          openHighlightForm(lat, lon);
          $("#highlight-search").value = "";
          resultsDiv.classList.add("hidden");
        });
        resultsDiv.appendChild(btn);
      });
      resultsDiv.classList.remove("hidden");
    })
    .catch(() => {
      toast("Error searching for place");
    });
}

$("#highlight-search").addEventListener("input", () => {
  clearTimeout(searchDebounceTimeout);
  searchDebounceTimeout = setTimeout(performSearch, 500);
});

$("#search-btn").addEventListener("click", performSearch);

// Close search dropdown when clicking outside
document.addEventListener("click", (e) => {
  if (!e.target.closest(".highlights-section")) {
    $("#search-results").classList.add("hidden");
  }
});

// Category Editor toggle and render helpers
$("#toggle-categories-btn").addEventListener("click", () => {
  const editor = $("#categories-editor");
  editor.classList.toggle("hidden");
});

function renderCategoriesList() {
  const list = $("#categories-list");
  list.innerHTML = "";
  categories.forEach((cat, index) => {
    const div = document.createElement("div");
    div.style.display = "flex";
    div.style.justifyContent = "space-between";
    div.style.alignItems = "center";
    div.style.padding = "4px 0";
    div.style.borderBottom = "1px dotted var(--line)";
    
    const isDefault = ["jyotirlinga", "city", "scenic", "stay", "food", "other"].includes(cat.type);
    
    div.innerHTML = `
      <span>${cat.emoji} ${cat.label}</span>
      ${isDefault ? '<span style="font-size:8px; color:var(--muted);">Default</span>' : `<button class="text-button btn-del-cat" data-index="${index}" style="color:#ff5252; padding:0; margin:0;">Delete</button>`}
    `;
    
    if (!isDefault) {
      div.querySelector(".btn-del-cat").addEventListener("click", () => {
        categories.splice(index, 1);
        saveConfig();
        renderCategoriesList();
        renderHighlightsList();
        renderHighlightsOnMap();
      });
    }
    list.appendChild(div);
  });
}

$("#add-cat-btn").addEventListener("click", () => {
  const emoji = $("#new-cat-emoji").value.trim() || "📍";
  const label = $("#new-cat-label").value.trim();
  if (!label) return toast("Please enter a category name");
  
  const type = label.toLowerCase().replace(/[^a-z0-9]/g, "-");
  if (categories.some(cat => cat.type === type)) {
    return toast("Category name already exists");
  }
  
  categories.push({ type, label, emoji });
  saveConfig();
  
  $("#new-cat-emoji").value = "";
  $("#new-cat-label").value = "";
  renderCategoriesList();
  toast("Category added!");
});

// Settings Checkbox listeners
$("#show-stops").addEventListener("change", () => renderStopsOnMap());
$("#show-highlights").addEventListener("change", () => {
  renderHighlightsOnMap();
  renderHighlightsList();
});
$("#show-labels").addEventListener("change", (e) => {
  document.body.classList.toggle("hide-tooltip-labels", !e.target.checked);
});
$("#snap-roads").addEventListener("change", () => updateRoadSnapping());

// Snap to Roads (OSRM Map Matching) helpers
async function fetchSnappedRoute() {
  if (snappedLatLngs) return snappedLatLngs;
  
  const limit = 80;
  const sampled = [];
  if (points.length <= limit) {
    sampled.push(...points);
  } else {
    sampled.push(points[0]);
    const step = (points.length - 2) / (limit - 2);
    for (let i = 1; i < limit - 1; i++) {
      sampled.push(points[Math.round(i * step)]);
    }
    sampled.push(points[points.length - 1]);
  }
  
  const coordsStr = sampled.map(p => `${p.longitude},${p.latitude}`).join(';');
  const url = `https://router.project-osrm.org/match/v1/driving/${coordsStr}?geometries=geojson&overview=full`;
  
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.matchings || !data.matchings.length) {
    throw new Error("Could not match route to road network");
  }
  
  snappedLatLngs = data.matchings[0].geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  return snappedLatLngs;
}

async function updateRoadSnapping() {
  const checked = $("#snap-roads").checked;
  if (checked) {
    if (!points.length) return;
    try {
      toast("Snapping route to roads...");
      const latLngs = await fetchSnappedRoute();
      if (snappedLayer) snappedLayer.remove();
      snappedLayer = L.polyline(latLngs, { color: "#3f51b5", weight: 5, opacity: 0.9, dashArray: "10, 5" }).addTo(map);
      if (routeLayer) routeLayer.setStyle({ opacity: 0 }); // Hide raw route completely
      toast("Route snapped to roads!");
    } catch (e) {
      console.error(e);
      toast("Failed to snap route. Using raw route.");
      $("#snap-roads").checked = false;
    }
  } else {
    if (snappedLayer) {
      snappedLayer.remove();
      snappedLayer = null;
    }
    if (routeLayer) routeLayer.setStyle({ color: "#171a18", weight: 5, opacity: 0.72 }); // Restore raw route
  }
}

$("#expand-time").addEventListener("click", () => {
  $("#time-section").classList.remove("loaded");
});
