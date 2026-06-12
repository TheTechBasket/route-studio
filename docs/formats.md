# Supported input formats

Put files in `data/input/`, including subdirectories, then run `pnpm import`.

## Dashcam TXT

The built-in TXT parser supports the `$V02` comma-separated records used by the sample camera files. Imports are incremental: appending data only reads the new bytes.

Displayed telemetry includes:

- Cleaned speed
- Original device speed
- Coordinate-derived speed
- Heading
- Sensor X, Y, and Z
- Video filename

Device speed is stored in hundredths of km/h. Clearly implausible spikes are replaced in the cleaned view using coordinate-derived speed, while raw values remain available.

The default plausible-speed ceiling is 130 km/h. Override it before rebuilding for a different vehicle:

```bash
MAX_SPEED_KMH=250 pnpm import -- --force
```

## GPX

Supported point types are `trkpt`, `rtept`, and `wpt`. Route Studio reads coordinates, time, elevation, speed, course/heading, and point name when present.

GPX speed follows the GPX convention of metres per second and is converted to km/h.

## GeoJSON

Supported geometries are `Point`, `MultiPoint`, `LineString`, and `MultiLineString`, either directly or inside Features and FeatureCollections.

Recognized property names include:

- `timestamps`, `times`, `coordTimes`, or `time`
- `speeds` or `speed` in km/h
- `headings`, `heading`, or `bearing`
- `sensorX`, `sensorY`, `sensorZ`
- `videos`, `video`, or `name`

When timestamps are absent, file modification time plus one second per point is used.

## Adding a format

Add a parser that returns `Point[]` in `src/core.ts`, register its extension in `app.ts`, and add a parser test in `test/parser.test.ts`.
