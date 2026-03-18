# Playwright Reporter

[![npm](https://img.shields.io/npm/v/@sentinelqa/playwright-reporter)](https://www.npmjs.com/package/@sentinelqa/playwright-reporter)
[![downloads](https://img.shields.io/npm/dm/@sentinelqa/playwright-reporter)](https://www.npmjs.com/package/@sentinelqa/playwright-reporter)
[![license](https://img.shields.io/npm/l/@sentinelqa/playwright-reporter)](./LICENSE)

A Playwright reporter that aggregates traces, screenshots, videos, and logs
into a single debugging report for failed tests.

Works locally out of the box with no account required.

Optionally upload runs to Sentinel Cloud for CI history and AI failure analysis.

![Sentinel Report Example](./docs/screenshot.png)

## Features

- Aggregates Playwright traces, screenshots, videos, and logs
- Generates a local HTML debugging report
- Works with existing Playwright reporter setup
- Optional Sentinel Cloud integration
- CI run history and AI debugging summaries in cloud mode

## Why this exists

Debugging Playwright CI failures often means downloading traces,
screenshots, and videos separately.

Reporter aggregates everything into one debugging report
so you can quickly understand what failed.

## Requirements

- Node.js 18+
- `@playwright/test` 1.40+

## Quick Start

Install:

```bash
npm install -D @sentinelqa/playwright-reporter
```

Add Sentinel to your Playwright config:

```ts
import { defineConfig } from "@playwright/test";
import { withSentinel } from "@sentinelqa/playwright-reporter";

export default withSentinel(
  defineConfig({
    reporter: [["line"]],
    outputDir: "test-results",
    use: {
      trace: "retain-on-failure",
      screenshot: "only-on-failure",
      video: "retain-on-failure",
    },
  }),
  {
    project: "my-app",
  },
);
```

## Example

Run your Playwright tests:

```bash
npx playwright test
```

If tests fail and `SENTINEL_TOKEN` is not set, Sentinel generates:

- `sentinel-report/index.html`
- `sentinel-debug.html`

Open the report to inspect:

- failed tests
- screenshots
- videos
- trace files
- logs

## Modes

### Local mode

If `SENTINEL_TOKEN` is not set, the reporter generates a local HTML debugging report.

### Cloud mode

If `SENTINEL_TOKEN` is set, the reporter uploads the run to Sentinel instead of generating the local HTML report.

```bash
SENTINEL_TOKEN=your_project_ingest_token npx playwright test
```

For intentional uploads outside CI, also set `SENTINEL_UPLOAD_LOCAL=1` and provide the usual commit and run metadata expected by the uploader.

## What `withSentinel()` does

- Preserves your existing reporter configuration
- Injects a Playwright JSON reporter if one is missing
- Reuses your existing Playwright HTML reporter path when configured
- Sets sensible artifact defaults:
  - trace: `retain-on-failure`
  - screenshot: `only-on-failure`
  - video: `retain-on-failure`

## Options

```ts
withSentinel(config, {
  project: "my-app",
  playwrightJsonPath: "playwright-report/report.json",
  playwrightReportDir: "playwright-report",
  testResultsDir: "test-results",
  artifactDirs: ["tmp/extra-artifacts"],
  verbose: true,
  localReportDir: "sentinel-report",
  localReportFileName: "index.html",
  localRedirectFileName: "sentinel-debug.html",
});
```

## Sentinel Cloud (optional)

Sentinel Cloud adds:

- hosted debugging dashboards
- CI run history
- AI-generated failure summaries
- flaky test detection
- shareable run links

Free for up to 100 CI runs per month.
Create an account at [sentinelqa.com](https://sentinelqa.com).
