# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm start              # import + serve (http://127.0.0.1:4173)
pnpm import              # index new/changed files in data/input/ into data/cache/
pnpm import -- --force   # wipe and rebuild the cache from scratch
pnpm serve                # serve without reimporting
pnpm test                 # node --test test/*.test.ts (built-in Node test runner)
node --test test/parser.test.ts   # run a single test file
```

Requires Node.js 22.6+ (runs `.ts` files directly via Node's native TypeScript support — no build step, no bundler, no transpiler). Runtime override: `MAX_SPEED_KMH=250 pnpm import -- --force` changes the plausible-speed ceiling used to clean GPS speed spikes.

There is no lint/typecheck script; `src/core.ts` and `app.ts` are plain TypeScript run directly by Node.

## Architecture

Two-stage pipeline, no framework, no database, no bundler:

1. **Import** (`app.ts` `importData`) reads files from `data/input/` (recursively) and writes them into a flat per-day cache at `data/cache/days/YYYY-MM-DD.tsv`, tracked by `data/cache/manifest.json`.
   - `.txt` dashcam logs are imported **incrementally**: `manifest.sources[name]` records byte `offset` + a `carry` (partial last line) so re-running `pnpm import` only reads newly appended bytes. Import is line-streamed (`createReadStream` + manual `\r?\n` splitting), not loaded fully into memory — this matters for large logs (see `data/input/GPSData000001.txt`, tens of MB).
   - `.gpx`/`.geojson`/`.json` are **not** incremental — any size/mtime change on those triggers a full manifest rebuild (`needsRebuild` in `importData`), because structured formats can't be diffed by byte offset the way an append-only TXT log can.
   - Points are parsed by format-specific functions in `src/core.ts` (`parseGpsLine` for the `$V02` dashcam format, `parseGpx`, `parseGeoJson`) that all normalize into a common `Point` type, then written with `serializePoint`/`deserializePoint` (TSV) into the day-bucketed cache files.
2. **Serve** (`app.ts` `serve`/`handleRequest`) is a dependency-free `node:http` server. No router library — `handleRequest` is a manual if-chain over `url.pathname`. Static files are served from `public/` (`serveStatic`); everything else is a handful of JSON/GPX/GeoJSON API endpoints reading from the day-cache via `queryPoints`.

Frontend (`public/index.html`, `public/app.js`, `public/styles.css`) is vanilla JS + Tailwind CDN + Leaflet, no build step, no framework — `app.js` is one file covering map rendering, replay, charts, stop detection, and trip report/print export. It talks to the backend only through the `/api/*` endpoints in `app.ts`.

### Adding a new input format

Add a parser in `src/core.ts` that returns `Point[]`, register its extension in `SUPPORTED_EXTENSIONS` (`app.ts`) and wire it into `importStructured` (or `importText` if it needs incremental/streaming import like TXT), then add a parser test in `test/parser.test.ts`. See `docs/formats.md` for the field-level contract each format must satisfy (timestamp, lat/lon, speed, heading, and how missing data is defaulted).

### Speed handling

Three parallel speed values are tracked per `Point`: `rawSpeed` (device-reported), `calculatedSpeed` (derived from consecutive point distance/time via `calculateSpeed`), and `speed` (the "cleaned" value from `cleanSpeed`, which falls back to `calculatedSpeed` when `rawSpeed` is missing, negative, exceeds `MAX_REASONABLE_SPEED`, or diverges too far from the calculated value). All three stay in the cache and are exposed separately so the frontend can plot raw vs. cleaned vs. calculated.

## Data layout

- `data/input/` — user-supplied source files (dashcam TXT, GPX, GeoJSON), not committed.
- `data/cache/` — generated: `days/*.tsv` (point data) + `manifest.json` (import state) + `trip-config.json` (user-added highlights/stop-name overrides, edited via `/api/config`). Safe to delete; `pnpm import -- --force` regenerates from `data/input/`.
