# Car Camera Route Studio

Local, dependency-light route viewer for dashcam TXT, GPX, and GeoJSON files.

![Preview screenshots](preview.png)

## Features

- Date and time range filtering
- Leaflet map with start/end markers
- Route replay with inactive gaps compressed
- Cleaned, raw, and calculated speed views
- Heading, altitude, and sensor charts
- GPX and GeoJSON exports
- Incremental imports for growing dashcam TXT files

## Run

Requires Node.js 22.6+.

```bash
pnpm start
```

Open <http://127.0.0.1:4173>.

## Add data

Place `.txt`, `.gpx`, `.geojson`, or `.json` files in `data/input/`, then run:

```bash
pnpm import
```

Use `pnpm import -- --force` to rebuild the generated cache.

Cleaned speed defaults to a 130 km/h plausibility ceiling. Set `MAX_SPEED_KMH` when importing to change it.

See [docs/formats.md](docs/formats.md) for supported fields and extension guidance.

Preview screenshots and videos can be added to `assets/images/` and `assets/videos/`.

## Supported formats

<details>
<summary><strong>Dashcam TXT</strong> — GPSData*.txt, $V02 records</summary>

Built and tested against a 70mai Dash Cam 4K A810 (`GPSData000001.txt` style logs). Any dashcam or GPS logger writing the same `$V02` comma-separated line format — timestamp, fix status, lat, lon, speed, heading, plus sensor and video filename fields — should work without changes.

</details>

<details>
<summary><strong>GPX</strong> — standard, any device or app</summary>

Not tied to a brand. Reads `trkpt`, `rtept`, and `wpt` points with time, elevation, speed, course/heading, and name — the same subset exported by Garmin, Strava, GaiaGPS, and most GPS units.

</details>

<details>
<summary><strong>GeoJSON</strong> — standard, any source</summary>

Not tied to a brand. Reads `Point`, `MultiPoint`, `LineString`, and `MultiLineString` geometries (raw or inside Features/FeatureCollections), with optional `timestamps`, `speeds`, `headings`, and sensor/video properties if present.

</details>

Full field-level detail is in [docs/formats.md](docs/formats.md). GPX and GeoJSON are open standards, so this should already work with most dashcams and GPS trackers that export either — if yours doesn't parse, open an issue with a sample.

## Contributing

- Open an issue describing the change you want to make and wait for it to be approved before starting work.
- Fork the repo and create a branch for that one change.
- Keep the pull request scoped to the approved feature only — smaller diffs are easier to review and merge.
- Open the PR against `main`.

## License

Licensed under [GNU AGPL-3.0-only](LICENSE). Commercial use is allowed. Modified versions offered to users, including over a network, must keep the license notices and make corresponding source code available under the AGPL.

---

Built by People at [The Tech Basket](https://www.thetechbasket.com).
