import fs from "fs";
import path from "path";
import crypto from "crypto";

type ReporterSourcePaths = {
  playwrightJsonPath: string;
  playwrightReportDir: string;
  testResultsDir: string;
  artifactDirs: string[];
};

type LocalReportOptions = ReporterSourcePaths & {
  reportDir?: string;
  reportFileName?: string;
  redirectFileName?: string;
};

type ArtifactKind =
  | "trace"
  | "screenshot"
  | "video"
  | "log"
  | "network"
  | "report"
  | "attachment";

type CopiedArtifact = {
  sourcePath: string;
  fileName: string;
  relativePath: string;
  kind: ArtifactKind;
  label: string;
  testId: string | null;
};

type ReportTest = {
  id: string;
  title: string;
  titlePath: string[];
  file: string | null;
  projectName: string | null;
  status: string;
  duration: number;
  errors: string[];
  artifacts: CopiedArtifact[];
};

type ParsedTestRef = {
  id: string;
  resultList: any[];
};

type LocalReportSummary = {
  total: number;
  failed: number;
  passed: number;
  skipped: number;
};

type LocalReportResult = {
  htmlPath: string;
  redirectPath: string;
  artifactCount: number;
  summary: LocalReportSummary;
};

const DEFAULT_REPORT_DIR = "sentinel-report";
const DEFAULT_REPORT_FILE = "index.html";
const DEFAULT_REDIRECT_FILE = "sentinel-debug.html";
const SENTINEL_URL = "https://sentinelqa.com";

const ARTIFACT_EXTENSIONS: Record<ArtifactKind, string[]> = {
  trace: [".zip"],
  screenshot: [".png", ".jpg", ".jpeg", ".webp", ".gif"],
  video: [".webm", ".mp4", ".mov"],
  log: [".log", ".txt", ".jsonl"],
  network: [".har"],
  report: [".html", ".json"],
  attachment: []
};

const normalizeTestStatus = (status: string | null | undefined) => {
  if (!status) return "unknown";
  if (status === "expected") return "passed";
  if (status === "unexpected") return "failed";
  if (status === "flaky") return "passed";
  return status;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const ansiToHtml = (value: string) => {
  const parts = value.split(/(\u001b\[[0-9;]*m)/g);
  const html: string[] = [];
  const openTags: string[] = [];

  const closeAll = () => {
    while (openTags.length > 0) {
      html.push("</span>");
      openTags.pop();
    }
  };

  for (const part of parts) {
    const match = part.match(/^\u001b\[([0-9;]*)m$/);
    if (!match) {
      html.push(escapeHtml(part));
      continue;
    }

    const codes = match[1]
      .split(";")
      .filter(Boolean)
      .map((entry) => Number.parseInt(entry, 10));

    if (codes.length === 0 || codes.includes(0)) {
      closeAll();
      continue;
    }

    for (const code of codes) {
      const className =
        code === 1
          ? "ansi-bold"
          : code === 31
            ? "ansi-red"
            : code === 32
              ? "ansi-green"
              : code === 33
                ? "ansi-yellow"
                : code === 36
                  ? "ansi-cyan"
                  : null;
      if (!className) continue;
      html.push(`<span class="${className}">`);
      openTags.push(className);
    }
  }

  closeAll();
  return html.join("");
};

const ensureDir = (dirPath: string) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const safeSlug = (value: string) => {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "artifact"
  );
};

const formatDuration = (durationMs: number) => {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "0 ms";
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 0 : 1)} s`;
};

const relativeFromCwd = (targetPath: string) => {
  const relative = path.relative(process.cwd(), targetPath).replace(/\\/g, "/");
  if (!relative || relative === "") return ".";
  return relative.startsWith(".") ? relative : `./${relative}`;
};

const isRelevantArtifact = (filePath: string) => {
  const lower = path.basename(filePath).toLowerCase();
  if (lower === "index.html" || lower === "report.json") return true;
  return Object.values(ARTIFACT_EXTENSIONS)
    .flat()
    .some((ext) => lower.endsWith(ext));
};

const classifyArtifact = (filePath: string): ArtifactKind => {
  const lower = path.basename(filePath).toLowerCase();
  if (lower.includes("trace") && lower.endsWith(".zip")) return "trace";
  if (ARTIFACT_EXTENSIONS.screenshot.some((ext) => lower.endsWith(ext))) {
    return "screenshot";
  }
  if (ARTIFACT_EXTENSIONS.video.some((ext) => lower.endsWith(ext))) {
    return "video";
  }
  if (ARTIFACT_EXTENSIONS.log.some((ext) => lower.endsWith(ext))) {
    return "log";
  }
  if (ARTIFACT_EXTENSIONS.network.some((ext) => lower.endsWith(ext))) {
    return "network";
  }
  if (ARTIFACT_EXTENSIONS.report.some((ext) => lower.endsWith(ext))) {
    return "report";
  }
  if (lower.endsWith(".zip")) return "trace";
  return "attachment";
};

const listFilesRecursive = (dirPath: string): string[] => {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return [];

  const results: string[] = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(fullPath));
      continue;
    }
    if (entry.isFile() && isRelevantArtifact(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
};

const dedupePaths = (paths: string[]) => {
  return Array.from(new Set(paths.map((entry) => path.resolve(entry))));
};

const resolveExistingFile = (candidate: string | null | undefined, baseDirs: string[]) => {
  if (!candidate) return null;

  const attempts = path.isAbsolute(candidate)
    ? [candidate]
    : baseDirs.map((baseDir) => path.resolve(baseDir, candidate));

  for (const attempt of attempts) {
    if (!fs.existsSync(attempt)) continue;
    const stat = fs.statSync(attempt);
    if (stat.isFile()) return attempt;
  }

  return null;
};

const copyArtifact = (
  sourcePath: string,
  kind: ArtifactKind,
  reportDir: string,
  usedRelativePaths: Set<string>,
  testId: string | null
) => {
  const hash = crypto
    .createHash("sha1")
    .update(sourcePath)
    .digest("hex")
    .slice(0, 10);
  const sourceName = path.basename(sourcePath);
  const candidateName = `${safeSlug(path.parse(sourceName).name)}-${hash}${path.extname(
    sourceName
  )}`;
  let relativePath = path.join("artifacts", candidateName).replace(/\\/g, "/");
  if (usedRelativePaths.has(relativePath)) {
    relativePath = path
      .join("artifacts", `${safeSlug(path.parse(sourceName).name)}-${hash}-1${path.extname(sourceName)}`)
      .replace(/\\/g, "/");
  }
  usedRelativePaths.add(relativePath);
  const destination = path.join(reportDir, relativePath);
  ensureDir(path.dirname(destination));
  fs.copyFileSync(sourcePath, destination);

  return {
    sourcePath,
    fileName: path.basename(destination),
    relativePath,
    kind,
    label: sourceName,
    testId
  } satisfies CopiedArtifact;
};

const createReportTest = (test: any, titlePath: string[]) => {
  const results = Array.isArray(test?.results) ? test.results : [];
  const lastResult = results.length > 0 ? results[results.length - 1] : null;
  const errors = results.flatMap((result: any) =>
    Array.isArray(result?.errors)
      ? result.errors
          .map((error: any) => error?.message || error?.stack || String(error || ""))
          .filter(Boolean)
      : []
  );
  const duration = results.reduce(
    (total: number, result: any) => total + (Number(result?.duration) || 0),
    0
  );
  const id = [
    test?.location?.file || "unknown",
    test?.projectName || "default",
    titlePath.join(" > ")
  ].join("::");

  return {
    id,
    title: test?.title || titlePath[titlePath.length - 1] || "Untitled test",
    titlePath,
    file: test?.location?.file || null,
    projectName: test?.projectName || null,
    status: normalizeTestStatus(test?.status || lastResult?.status || "unknown"),
    duration,
    errors,
    artifacts: []
  } satisfies ReportTest;
};

const collectTests = (node: any, parentTitles: string[] = []): ReportTest[] => {
  const nextTitles = node?.title ? [...parentTitles, node.title] : parentTitles;
  const collected: ReportTest[] = [];

  if (Array.isArray(node?.tests)) {
    for (const test of node.tests) {
      collected.push(createReportTest(test, [...nextTitles, test?.title].filter(Boolean)));
    }
  }

  if (Array.isArray(node?.specs)) {
    for (const spec of node.specs) {
      const specTitles = [...nextTitles, spec?.title].filter(Boolean);
      const specTests = Array.isArray(spec?.tests) ? spec.tests : [];
      for (const test of specTests) {
        collected.push(createReportTest(test, specTitles));
      }
    }
  }

  if (Array.isArray(node?.suites)) {
    for (const suite of node.suites) {
      collected.push(...collectTests(suite, nextTitles));
    }
  }

  return collected;
};

const collectTestRefs = (node: any, parentTitles: string[] = []): ParsedTestRef[] => {
  const nextTitles = node?.title ? [...parentTitles, node.title] : parentTitles;
  const refs: ParsedTestRef[] = [];

  if (Array.isArray(node?.tests)) {
    for (const test of node.tests) {
      const titlePath = [...nextTitles, test?.title].filter(Boolean);
      const id = [
        test?.location?.file || "unknown",
        test?.projectName || "default",
        titlePath.join(" > ")
      ].join("::");
      refs.push({ id, resultList: Array.isArray(test?.results) ? test.results : [] });
    }
  }

  if (Array.isArray(node?.specs)) {
    for (const spec of node.specs) {
      const titlePath = [...nextTitles, spec?.title].filter(Boolean);
      for (const test of Array.isArray(spec?.tests) ? spec.tests : []) {
        const id = [
          test?.location?.file || "unknown",
          test?.projectName || "default",
          titlePath.join(" > ")
        ].join("::");
        refs.push({ id, resultList: Array.isArray(test?.results) ? test.results : [] });
      }
    }
  }

  if (Array.isArray(node?.suites)) {
    for (const suite of node.suites) {
      refs.push(...collectTestRefs(suite, nextTitles));
    }
  }

  return refs;
};

const summarizeTests = (tests: ReportTest[]): LocalReportSummary => {
  return tests.reduce<LocalReportSummary>(
    (summary, test) => {
      summary.total += 1;
      if (test.status === "passed") summary.passed += 1;
      else if (test.status === "skipped") summary.skipped += 1;
      else if (["failed", "timedOut", "interrupted"].includes(test.status)) {
        summary.failed += 1;
      }
      return summary;
    },
    { total: 0, failed: 0, passed: 0, skipped: 0 }
  );
};

const renderArtifact = (artifact: CopiedArtifact) => {
  const href = escapeHtml(artifact.relativePath);
  const label = escapeHtml(artifact.label);

  if (artifact.kind === "trace") {
    return `
      <div class="artifact-link artifact-link-trace">
        <div class="artifact-trace-row">
          <div class="artifact-trace-meta">
            <span class="artifact-kind">Trace</span>
            <a href="${href}" target="_blank" rel="noreferrer">${label}</a>
          </div>
          <a
            class="trace-button"
            href="${href}"
            target="_blank"
            rel="noreferrer"
            data-trace-path="${href}"
          >
            View Trace
          </a>
        </div>
      </div>
    `;
  }

  if (artifact.kind === "screenshot") {
    return `
      <div class="artifact-card">
        <div class="artifact-meta">
          <span class="artifact-kind">Screenshot</span>
          <a href="${href}" target="_blank" rel="noreferrer">${label}</a>
        </div>
        <img src="${href}" alt="${label}" loading="lazy" data-preview-image="${href}" />
      </div>
    `;
  }

  if (artifact.kind === "video") {
    return `
      <div class="artifact-card">
        <div class="artifact-meta">
          <span class="artifact-kind">Video</span>
          <a href="${href}" target="_blank" rel="noreferrer">${label}</a>
        </div>
        <video controls preload="metadata" src="${href}"></video>
      </div>
    `;
  }

  return `
    <div class="artifact-link">
      <span class="artifact-kind">${escapeHtml(artifact.kind)}</span>
      <a href="${href}" target="_blank" rel="noreferrer">${label}</a>
    </div>
  `;
};

const renderArtifactGroups = (artifacts: CopiedArtifact[]) => {
  if (artifacts.length === 0) {
    return `<div class="empty-state">No test-linked artifacts were detected for this result.</div>`;
  }

  const groups = [
    {
      title: "Screenshots",
      items: artifacts.filter((artifact) => artifact.kind === "screenshot")
    },
    {
      title: "Videos",
      items: artifacts.filter((artifact) => artifact.kind === "video")
    },
    {
      title: "Traces",
      items: artifacts.filter((artifact) => artifact.kind === "trace")
    },
    {
      title: "Other files",
      items: artifacts.filter(
        (artifact) => !["screenshot", "video", "trace"].includes(artifact.kind)
      )
    }
  ].filter((group) => group.items.length > 0);

  return groups
    .map(
      (group) => `
        <details class="artifact-group" ${group.title === "Screenshots" ? "open" : ""}>
          <summary class="artifact-group-summary">
            <span>${escapeHtml(group.title)}</span>
            <span class="artifact-group-count">(${group.items.length})</span>
          </summary>
          <div class="artifact-grid">
            ${group.items.map((artifact) => renderArtifact(artifact)).join("\n")}
          </div>
        </details>
      `
    )
    .join("\n");
};

const renderTestCard = (test: ReportTest) => {
  const statusClass = test.status === "passed" ? "status-passed" : "status-failed";
  const fileLine = test.file ? `<div class="meta-item">${escapeHtml(test.file)}</div>` : "";
  const projectLine = test.projectName
    ? `<div class="meta-item">Project: ${escapeHtml(test.projectName)}</div>`
    : "";
  const errorBlock =
    test.errors.length > 0
      ? (() => {
          const rawError = escapeHtml(test.errors.join("\n\n"));
          return `<div class="error-block" data-collapsed="true">
            <div class="error-actions">
              <button
                type="button"
                class="copy-button"
                data-copy-error="${rawError}"
                aria-label="Copy error"
              >
                Copy
              </button>
            </div>
            <pre class="error-preview">${ansiToHtml(test.errors.join("\n\n"))}</pre>
            <button type="button" class="expand-button" data-expand-error>Expand full error</button>
          </div>`;
        })()
      : `<pre>No error message was attached to this result.</pre>`;
  const artifactMarkup = renderArtifactGroups(test.artifacts);

  return `
    <details class="test-card">
      <summary class="test-summary">
        <div>
          <div class="status-pill ${statusClass}">${escapeHtml(test.status)}</div>
          <h3>${escapeHtml(test.titlePath.join(" > ") || test.title)}</h3>
        </div>
        <div class="meta-stack">
          ${fileLine}
          ${projectLine}
          <div class="meta-item">Duration: ${escapeHtml(formatDuration(test.duration))}</div>
        </div>
      </summary>
      <div class="panel">
        <h4>Error</h4>
        ${errorBlock}
      </div>
      <div class="panel">
        <h4>Artifacts</h4>
        <div class="artifact-grid">
          ${artifactMarkup}
        </div>
      </div>
    </details>
  `;
};

const renderAdditionalArtifacts = (artifacts: CopiedArtifact[]) => {
  if (artifacts.length === 0) {
    return "";
  }

  return renderArtifactGroups(artifacts);
};

const tryMapRemainingArtifactsToTests = (
  tests: ReportTest[],
  artifactPaths: string[],
  reportDir: string,
  usedRelativePaths: Set<string>,
  claimedSourcePaths: Set<string>
) => {
  const candidateTests = tests.filter((test) =>
    ["failed", "timedOut", "interrupted"].includes(test.status)
  );
  const preferredKinds: ArtifactKind[] = ["screenshot", "video", "trace", "log", "network"];

  for (const kind of preferredKinds) {
    const pathsForKind = artifactPaths.filter(
      (filePath) => !claimedSourcePaths.has(path.resolve(filePath)) && classifyArtifact(filePath) === kind
    );
    let cursor = 0;

    for (const test of candidateTests) {
      const alreadyHasKind = test.artifacts.some((artifact) => artifact.kind === kind);
      if (alreadyHasKind) continue;
      const nextPath = pathsForKind[cursor];
      if (!nextPath) break;

      const resolved = path.resolve(nextPath);
      const artifact = copyArtifact(resolved, kind, reportDir, usedRelativePaths, test.id);
      test.artifacts.push(artifact);
      claimedSourcePaths.add(resolved);
      cursor += 1;
    }
  }
};

const buildHtml = (
  tests: ReportTest[],
  summary: LocalReportSummary,
  extraArtifacts: CopiedArtifact[]
) => {
  const failedTests = tests.filter((test) =>
    ["failed", "timedOut", "interrupted"].includes(test.status)
  );
  const generatedAt = new Date().toLocaleString();

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sentinel Playwright Reporter</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0d1117;
        --panel: #161b22;
        --panel-border: #273042;
        --text: #f5f7fb;
        --muted: #98a2b3;
        --accent: #7dd3fc;
        --accent-soft: rgba(125, 211, 252, 0.14);
        --danger: #fb7185;
        --success: #4ade80;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(125, 211, 252, 0.12), transparent 30%),
          linear-gradient(180deg, #0b1020 0%, var(--bg) 42%, #090d14 100%);
        color: var(--text);
      }
      a { color: var(--accent); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .page {
        max-width: 1200px;
        margin: 0 auto;
        padding: 40px 20px 80px;
      }
      .hero {
        position: relative;
        padding: 22px;
        border: 1px solid var(--panel-border);
        border-radius: 24px;
        background: rgba(13, 17, 23, 0.88);
        backdrop-filter: blur(12px);
      }
      .hero-badge {
        position: absolute;
        top: 18px;
        right: 18px;
        display: inline-flex;
        align-items: center;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid rgba(125, 211, 252, 0.28);
        background: rgba(125, 211, 252, 0.08);
        color: var(--accent);
        font-size: 11px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .eyebrow {
        color: var(--accent);
        text-transform: uppercase;
        letter-spacing: 0.18em;
        font-size: 10px;
        margin-bottom: 10px;
      }
      h1, h2, h3, h4 { margin: 0; }
      h1 { font-size: clamp(24px, 4vw, 38px); line-height: 1.05; }
      .hero p {
        margin: 10px 0 0;
        color: var(--muted);
        max-width: 640px;
        font-size: 14px;
        line-height: 1.6;
      }
      .summary-grid {
        display: grid;
        gap: 16px;
        margin-top: 18px;
      }
      .summary-grid { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
      .summary-card, .section-shell, .test-card {
        border: 1px solid var(--panel-border);
        border-radius: 20px;
        background: var(--panel);
      }
      .summary-card {
        padding: 18px;
      }
      .summary-label {
        display: block;
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.14em;
      }
      .summary-value {
        display: block;
        margin-top: 10px;
        font-size: 34px;
        font-weight: 700;
      }
      .section-shell {
        padding: 24px;
        margin-top: 24px;
      }
      .section-shell p {
        margin: 8px 0 0;
        color: var(--muted);
        line-height: 1.6;
      }
      .test-card {
        margin-top: 18px;
        overflow: hidden;
      }
      .test-summary {
        display: flex;
        justify-content: space-between;
        gap: 20px;
        align-items: flex-start;
        list-style: none;
        padding: 20px;
        cursor: pointer;
      }
      .test-summary::-webkit-details-marker {
        display: none;
      }
      .status-pill {
        display: inline-flex;
        align-items: center;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        margin-bottom: 12px;
      }
      .status-passed { background: rgba(74, 222, 128, 0.12); color: var(--success); }
      .status-failed { background: rgba(251, 113, 133, 0.12); color: var(--danger); }
      .meta-stack {
        min-width: 220px;
        display: grid;
        gap: 6px;
        color: var(--muted);
        font-size: 14px;
        text-align: right;
      }
      .panel {
        margin: 0 20px 18px;
        padding: 16px;
        background: rgba(13, 17, 23, 0.74);
        border: 1px solid rgba(39, 48, 66, 0.9);
        border-radius: 16px;
      }
      pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        margin: 12px 0 0;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 13px;
        color: #d5dde8;
      }
      .ansi-bold { font-weight: 700; }
      .ansi-red { color: #fb7185; }
      .ansi-green { color: #4ade80; }
      .ansi-yellow { color: #facc15; }
      .ansi-cyan { color: #67e8f9; }
      .error-block[data-collapsed="true"] .error-preview {
        max-height: 180px;
        overflow: hidden;
        position: relative;
      }
      .error-actions {
        display: flex;
        justify-content: flex-end;
      }
      .error-block[data-collapsed="true"] .error-preview::after {
        content: "";
        position: absolute;
        inset: auto 0 0 0;
        height: 56px;
        background: linear-gradient(180deg, rgba(13, 17, 23, 0), rgba(13, 17, 23, 1));
      }
      .copy-button,
      .expand-button {
        margin-top: 12px;
        border: 1px solid rgba(125, 211, 252, 0.28);
        background: rgba(125, 211, 252, 0.08);
        color: var(--accent);
        border-radius: 999px;
        padding: 8px 12px;
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        cursor: pointer;
      }
      .copy-button {
        margin-top: 0;
        margin-left: auto;
      }
      .artifact-grid {
        display: grid;
        gap: 14px;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        margin-top: 12px;
      }
      .artifact-card, .artifact-link {
        border: 1px solid rgba(39, 48, 66, 0.9);
        border-radius: 14px;
        background: rgba(9, 13, 20, 0.9);
        padding: 12px;
      }
      .artifact-link-trace {
        padding: 14px;
      }
      .artifact-card img, .artifact-card video {
        width: 100%;
        border-radius: 10px;
        margin-top: 12px;
        background: #05070b;
        cursor: zoom-in;
      }
      .artifact-meta {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
      }
      .artifact-kind {
        display: inline-flex;
        align-items: center;
        width: fit-content;
        padding: 4px 8px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .artifact-trace-row {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
      }
      .artifact-trace-meta {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }
      .trace-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 8px 12px;
        border-radius: 999px;
        border: 1px solid rgba(125, 211, 252, 0.28);
        background: rgba(125, 211, 252, 0.08);
        color: var(--accent);
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        white-space: nowrap;
      }
      .trace-button:hover {
        text-decoration: none;
        background: rgba(125, 211, 252, 0.14);
      }
      .artifact-list {
        display: grid;
        gap: 12px;
        margin-top: 16px;
      }
      .artifact-group {
        margin-top: 12px;
        border: 1px solid rgba(39, 48, 66, 0.9);
        border-radius: 14px;
        background: rgba(9, 13, 20, 0.42);
        overflow: hidden;
      }
      .artifact-group-summary {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 14px 16px;
        cursor: pointer;
        list-style: none;
        font-weight: 600;
      }
      .artifact-group-summary::-webkit-details-marker {
        display: none;
      }
      .artifact-group-count {
        color: var(--muted);
        font-weight: 500;
      }
      .artifact-group .artifact-grid {
        padding: 0 16px 16px;
        margin-top: 0;
      }
      .section-shell ul {
        margin: 12px 0 0 18px;
        color: var(--text);
      }
      .section-shell li {
        margin-top: 6px;
      }
      .empty-state {
        color: var(--muted);
        border: 1px dashed rgba(39, 48, 66, 0.9);
        border-radius: 14px;
        padding: 16px;
      }
      .failed-list-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
      }
      .failed-count {
        color: var(--muted);
        font-size: 14px;
      }
      footer {
        margin-top: 28px;
        color: var(--muted);
        font-size: 14px;
      }
      .preview-overlay {
        position: fixed;
        inset: 0;
        background: rgba(4, 8, 14, 0.88);
        display: none;
        align-items: center;
        justify-content: center;
        padding: 32px;
        z-index: 999;
      }
      .preview-overlay.is-open {
        display: flex;
      }
      .preview-shell {
        max-width: min(1200px, 96vw);
        max-height: 92vh;
        position: relative;
      }
      .preview-shell img {
        display: block;
        max-width: 100%;
        max-height: 92vh;
        border-radius: 16px;
        border: 1px solid rgba(39, 48, 66, 0.9);
        box-shadow: 0 20px 80px rgba(0, 0, 0, 0.5);
      }
      .preview-close {
        position: absolute;
        top: 12px;
        right: 12px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(9, 13, 20, 0.75);
        color: #fff;
        border-radius: 999px;
        width: 40px;
        height: 40px;
        cursor: pointer;
        font-size: 18px;
      }
      @media (max-width: 720px) {
        .hero-badge {
          position: static;
          margin-bottom: 12px;
        }
        .test-summary { flex-direction: column; }
        .meta-stack { min-width: 0; }
        .artifact-trace-row {
          flex-direction: column;
          align-items: flex-start;
        }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <header class="hero">
        <a class="hero-badge" href="${SENTINEL_URL}" target="_blank" rel="noreferrer">Powered by sentinelqa.com</a>
        <div class="eyebrow">Playwright Reporter for CI Debugging</div>
        <h1>Playwright Reporter</h1>
        <p>
          A Playwright reporter that collects traces, screenshots, videos, and logs into
          a single debugging report. Designed to make CI failures easier to diagnose.
        </p>
        <div class="summary-grid">
          <div class="summary-card">
            <span class="summary-label">Tests</span>
            <span class="summary-value">${summary.total}</span>
          </div>
          <div class="summary-card">
            <span class="summary-label">Failed</span>
            <span class="summary-value">${summary.failed}</span>
          </div>
          <div class="summary-card">
            <span class="summary-label">Passed</span>
            <span class="summary-value">${summary.passed}</span>
          </div>
          <div class="summary-card">
            <span class="summary-label">Generated</span>
            <span class="summary-value" style="font-size: 22px;">${escapeHtml(generatedAt)}</span>
          </div>
        </div>
      </header>

      <section class="section-shell">
        <div class="failed-list-head">
          <h2>Failed Tests</h2>
          <div class="failed-count">${failedTests.length} failed</div>
        </div>
        ${
          failedTests.length > 0
            ? failedTests.map((test) => renderTestCard(test)).join("\n")
            : `<div class="empty-state">No failed tests were found in this run. The local report still includes collected artifacts below.</div>`
        }
      </section>

      <section class="section-shell">
        <h2>Additional Artifacts</h2>
        <p>Artifacts collected from Playwright output folders that were not directly attached to a single test.</p>
        ${
          extraArtifacts.length > 0
            ? renderAdditionalArtifacts(extraArtifacts)
            : `<div class="empty-state">All detected artifacts were mapped onto failed tests.</div>`
        }
      </section>

      <section class="section-shell">
        <h2>Optional: Sentinel Cloud</h2>
        <p>Upload runs to Sentinel Cloud for:</p>
        <ul>
          <li>CI history</li>
          <li>shareable run links</li>
          <li>AI failure summaries</li>
        </ul>
        <p>
          <a href="${SENTINEL_URL}" target="_blank" rel="noreferrer">More on sentinelqa.com</a>
        </p>
      </section>

      <footer>
        Generated by <a href="${SENTINEL_URL}" target="_blank" rel="noreferrer">Sentinel Playwright Reporter</a>.
      </footer>
    </div>
    <div class="preview-overlay" id="preview-overlay" aria-hidden="true">
      <div class="preview-shell">
        <button type="button" class="preview-close" id="preview-close" aria-label="Close preview">×</button>
        <img id="preview-image" alt="Screenshot preview" />
      </div>
    </div>
    <script>
      (function () {
        document.querySelectorAll("[data-trace-path]").forEach(function (button) {
          var tracePath = button.getAttribute("data-trace-path");
          if (!tracePath) return;
          try {
            var traceUrl = new URL(tracePath, window.location.href).href;
            button.setAttribute(
              "href",
              "https://trace.playwright.dev/?trace=" + encodeURIComponent(traceUrl)
            );
          } catch (_error) {
            // Keep the raw trace file link as fallback.
          }
        });

        document.querySelectorAll("[data-expand-error]").forEach(function (button) {
          button.addEventListener("click", function () {
            var block = button.closest(".error-block");
            if (!block) return;
            var isCollapsed = block.getAttribute("data-collapsed") !== "false";
            block.setAttribute("data-collapsed", isCollapsed ? "false" : "true");
            button.textContent = isCollapsed ? "Collapse error" : "Expand full error";
          });
        });

        document.querySelectorAll("[data-copy-error]").forEach(function (button) {
          button.addEventListener("click", async function () {
            var rawError = button.getAttribute("data-copy-error");
            if (!rawError) return;
            var text = rawError
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&amp;/g, "&");
            try {
              await navigator.clipboard.writeText(text);
              var previousText = button.textContent;
              button.textContent = "Copied";
              setTimeout(function () {
                button.textContent = previousText || "Copy";
              }, 1200);
            } catch (_error) {
              button.textContent = "Copy failed";
              setTimeout(function () {
                button.textContent = "Copy";
              }, 1200);
            }
          });
        });

        var overlay = document.getElementById("preview-overlay");
        var previewImage = document.getElementById("preview-image");
        var previewClose = document.getElementById("preview-close");
        if (overlay && previewImage && previewClose) {
          var closePreview = function () {
            overlay.classList.remove("is-open");
            overlay.setAttribute("aria-hidden", "true");
            previewImage.removeAttribute("src");
          };

          document.querySelectorAll("[data-preview-image]").forEach(function (image) {
            image.addEventListener("click", function () {
              var src = image.getAttribute("data-preview-image");
              if (!src) return;
              previewImage.setAttribute("src", src);
              overlay.classList.add("is-open");
              overlay.setAttribute("aria-hidden", "false");
            });
          });

          previewClose.addEventListener("click", closePreview);
          overlay.addEventListener("click", function (event) {
            if (event.target === overlay) closePreview();
          });
          window.addEventListener("keydown", function (event) {
            if (event.key === "Escape") closePreview();
          });
        }
      })();
    </script>
  </body>
</html>`;
};

export function generateLocalDebugReport(
  options: LocalReportOptions
): LocalReportResult {
  const reportDir = path.resolve(process.cwd(), options.reportDir || DEFAULT_REPORT_DIR);
  const reportFileName = options.reportFileName || DEFAULT_REPORT_FILE;
  const redirectFileName = options.redirectFileName || DEFAULT_REDIRECT_FILE;
  const reportHtmlPath = path.join(reportDir, reportFileName);
  const redirectPath = path.resolve(process.cwd(), redirectFileName);
  const usedRelativePaths = new Set<string>();

  ensureDir(reportDir);

  const sourceDirs = dedupePaths(
    [
      options.testResultsDir,
      options.playwrightReportDir,
      ...(options.artifactDirs || [])
    ].filter(Boolean)
  );
  const baseDirs = dedupePaths([
    process.cwd(),
    path.dirname(options.playwrightJsonPath),
    ...sourceDirs
  ]);

  const reportJsonRaw = fs.readFileSync(options.playwrightJsonPath, "utf8");
  const reportJson = JSON.parse(reportJsonRaw);
  const reportRoot = { suites: reportJson?.suites || [] };
  const tests = collectTests(reportRoot);
  const testsById = new Map(tests.map((test) => [test.id, test]));
  const claimedSourcePaths = new Set<string>();

  const attachArtifactToTest = (sourcePath: string, testId: string | null) => {
    const resolved = path.resolve(sourcePath);
    if (claimedSourcePaths.has(resolved)) return;

    const artifact = copyArtifact(
      resolved,
      classifyArtifact(resolved),
      reportDir,
      usedRelativePaths,
      testId
    );
    claimedSourcePaths.add(resolved);

    if (testId && testsById.has(testId)) {
      testsById.get(testId)!.artifacts.push(artifact);
      return;
    }
  };

  for (const testRef of collectTestRefs(reportRoot)) {
    for (const result of testRef.resultList) {
      const attachments = Array.isArray(result?.attachments) ? result.attachments : [];
      for (const attachment of attachments) {
        const resolvedPath = resolveExistingFile(attachment?.path, baseDirs);
        if (!resolvedPath) continue;
        attachArtifactToTest(resolvedPath, testRef.id);
      }
    }
  }

  const discoveredArtifactPaths: string[] = [];
  for (const sourceDir of sourceDirs) {
    for (const filePath of listFilesRecursive(sourceDir)) {
      const resolved = path.resolve(filePath);
      if (claimedSourcePaths.has(resolved)) continue;
      discoveredArtifactPaths.push(resolved);
    }
  }

  tryMapRemainingArtifactsToTests(
    tests,
    discoveredArtifactPaths,
    reportDir,
    usedRelativePaths,
    claimedSourcePaths
  );

  const extraArtifacts: CopiedArtifact[] = [];
  for (const filePath of discoveredArtifactPaths) {
    const resolved = path.resolve(filePath);
    if (claimedSourcePaths.has(resolved)) continue;
    const artifact = copyArtifact(
      resolved,
      classifyArtifact(resolved),
      reportDir,
      usedRelativePaths,
      null
    );
    claimedSourcePaths.add(resolved);
    extraArtifacts.push(artifact);
  }

  const summary = summarizeTests(tests);
  const html = buildHtml(tests, summary, extraArtifacts);
  fs.writeFileSync(reportHtmlPath, html, "utf8");
  fs.writeFileSync(
    redirectPath,
    `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta http-equiv="refresh" content="0; url=${relativeFromCwd(
      reportHtmlPath
    )}" /><title>Sentinel Playwright Reporter</title></head><body><p>Open <a href="${relativeFromCwd(
      reportHtmlPath
    )}">${relativeFromCwd(reportHtmlPath)}</a>.</p></body></html>`,
    "utf8"
  );

  return {
    htmlPath: reportHtmlPath,
    redirectPath,
    artifactCount: claimedSourcePaths.size,
    summary
  };
}
