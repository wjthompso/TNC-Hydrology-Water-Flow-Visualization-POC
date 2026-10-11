# Creek Water Visualization

UCS-246 phase 1 is a path-only move. The standalone Creek Visualization Browser Application lives in `apps/creek-visualization-browser`. Shared tests, the catalog, fixtures, and test commands live at this repository root. Application code stays out of the root. This phase does not implement the seven browser components or the five HTTP (Hypertext Transfer Protocol) object contracts.

The October 9 system design is the architecture source of truth when it conflicts with earlier notes in `docs/`.

## Layout

- `apps/creek-visualization-browser/` — Vite browser application. Its README is historical playground documentation.
- `tests/` — the six approved tests, fixtures, catalog, and support code.
- `scripts/test-runner.ts` and `scripts/view-test-catalog.mjs` — shared test commands. `npm run test:view-test-catalog` writes the catalog, serves `http://127.0.0.1:4174/`, and opens it; Ctrl+C stops the server. `--no-open` skips the browser and `--no-serve` only writes the file. The catalog viewer does not execute tests.
- `apps/creek-visualization-browser/scripts/generate-data.mjs` — playground data generator. It stays with the app until a data-production pipeline exists.
- `docs/` — earlier research and planning notes.
- `TESTING.md` — current test commands, lifecycle, enforcement, and the known production build error.

No empty library, pipeline, or component directories are created in this phase.

## Commands

Run these from the repository root. There is no root `dev` script, so a later root script cannot start the wrong server.

```bash
npm install
npm run dev -w creek-visualization-browser
npm run build -w creek-visualization-browser
npm run generate-data -w creek-visualization-browser
npm run test:view-test-catalog
npm run lint
```

`npm run build -w creek-visualization-browser` still fails on the preserved `constraints.collision` type error in `apps/creek-visualization-browser/src/arcgis-scene.ts`. Test command details are in [TESTING.md](TESTING.md).

## Design documents

- [Creek Water Visualization System Design](https://linear.app/ucsb-spatial-center/document/creek-water-visualization-system-design-593ddc502c13)
- [Creek Water Visualization Scope](https://linear.app/ucsb-spatial-center/document/creek-water-visualiation-scope-1af7965fca3e)
- [Data Sources](https://linear.app/ucsb-spatial-center/document/data-sources-doc-9e7604461984)

Local notes: [high-level plan](docs/high-level-plan.md), [research plan](docs/creek-water-visualization-research-plan.md), [research notes](docs/research-notes.md), and [testing plan](docs/testing-plan.md). The testing plan describes earlier ideas that are not in the approved catalog.
