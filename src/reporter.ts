import {
  hasSupportedCiEnv,
  isLocalUploadEnabled,
  runSentinelUpload
} from "@sentinelqa/uploader/node";
import { loadSentinelEnv } from "./env";
import { buildQuickDiagnosis } from "./quickDiagnosis";
import { buildPassingRunSummary, recordReporterHistorySnapshot } from "./terminalSummary";
import { buildFailedRunHistorySummary } from "./runHistory";
import {
  emitFailedRunTelemetry,
  emitReporterTelemetry,
  flushTelemetry
} from "./telemetry";

const { sentinelCaptureFailureContextFromReporter } = require("@sentinelqa/uploader/playwright");

type ReporterUploadResult = Awaited<ReturnType<typeof runSentinelUpload>> & {
  diagnosis?: {
    status: "ready" | "processing" | "unavailable";
    lines: string[];
    footer?: string[];
  } | null;
};

type ReporterOptions = {
  project?: string | null;
  playwrightJsonPath: string;
  playwrightReportDir: string;
  testResultsDir: string;
  artifactDirs?: string[];
  verbose?: boolean;
};

const colorize = (value: string, code: string) => {
  if (!process.stdout.isTTY) return value;
  return `\u001b[${code}m${value}\u001b[0m`;
};

const styleCritical = (value: string) => colorize(value, "1;31");
const styleWarning = (value: string) => colorize(value, "1;33");
const styleAction = (value: string) => colorize(value, "1;36");
const stylePrimary = (value: string) => colorize(value, "1;97");
const styleSecondary = (value: string) => colorize(value, "2");
const divider = () => "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
const LABEL_WIDTH = 10;

const renderRow = (label: string, value: string, valueStyle?: (value: string) => string, indent = "") => {
  const paddedLabel = `${label}:`.padEnd(LABEL_WIDTH);
  const styledValue = valueStyle ? valueStyle(value) : value;
  return `${indent}${stylePrimary(paddedLabel)} ${styledValue}`;
};

const highlightCounts = (value: string) =>
  value
    .replace(/\b(\d+\s+tests?\s+failed)\b/gi, (_, match) => styleCritical(match))
    .replace(/\b(\d+\s+real\s+issues?)\b/gi, (_, match) => styleWarning(match))
    .replace(/\b(\d+\s+tests?)\b/gi, (_, match) => styleWarning(match))
    .replace(/\b(\d+\s+previous\s+runs?)\b/gi, (_, match) => styleSecondary(match))
    .replace(/\b(\d+\s+passing\s+runs?)\b/gi, (_, match) => styleSecondary(match))
    .replace(/\b(\d+\s+newly\s+failing)\b/gi, (_, match) => styleWarning(match))
    .replace(/\b(\d+\s+tests?\s+still\s+failing)\b/gi, (_, match) => styleWarning(match));

const styleIssueTitle = (value: string) =>
  value.replace(/\((\d+\s+tests?)\)/i, (_, match) => `(${styleWarning(match)})`);

const styleWhereValue = (value: string) =>
  value.replace(/\b([A-Za-z0-9_.-]+\.[cm]?[jt]sx?:\d+(?::\d+)?)\b/g, (_, match) => stylePrimary(match));

const formatCliLine = (line: string) => {
  if (!line.trim()) return line;
  if (line === divider()) return styleSecondary(line);
  if (/^NEW FAILURE/.test(line)) return styleCritical(line);
  if (/^RECURRING FAILURE/.test(line)) {
    return line.replace(/RECURRING FAILURE/, styleWarning("RECURRING FAILURE")).replace(/\(([^)]+)\)/, (_, inner) => `(${styleSecondary(inner)})`);
  }
  if (/^All tests passed$/.test(line)) return stylePrimary(line);
  if (/^\d+\s+tests?\s+failed$/.test(line)) return styleCritical(line);
  if (/^Collapsed into \d+\s+real issue/.test(line)) return highlightCounts(line);
  if (/^\d+\s+tests?\s+in\s+/.test(line)) return line;
  if (/^Issue \d+:/.test(line)) {
    const [head, rest] = line.split(": ", 2);
    return `${stylePrimary(head)}: ${styleIssueTitle(rest || "")}`;
  }

  const rowMatch = line.match(/^(\s*)(What broke|Why|Cause|Where|What changed|Next|Expected|Received|Confidence|Impact|At risk|Why this matters|Recommendation|Last failure|Status|Artifacts ready|Failing step|Failing code|Selector|Target state|Clears|Report):\s*(.*)$/);
  if (!rowMatch) return line;
  const [, indent, label, rawValue] = rowMatch;
  const value = highlightCounts(rawValue);
  switch (label) {
    case "What broke":
      return renderRow(label, value, undefined, indent);
    case "Why":
      return renderRow(label, value, undefined, indent);
    case "Cause":
      return renderRow(label, value, undefined, indent);
    case "Where":
      return renderRow(label, rawValue, styleWhereValue, indent);
    case "What changed":
      return renderRow(label, rawValue, styleWarning, indent);
    case "Next":
      return renderRow(label, rawValue, styleAction, indent);
    case "Report":
      return renderRow(label, rawValue, styleAction, indent);
    case "Expected":
      return renderRow(label, rawValue, stylePrimary, indent);
    case "Received":
      return renderRow(label, rawValue, styleCritical, indent);
    case "Confidence":
      return renderRow(label, rawValue, /high/i.test(rawValue) ? styleAction : /medium/i.test(rawValue) ? styleWarning : styleSecondary, indent);
    case "Impact":
      return renderRow(label, highlightCounts(rawValue), undefined, indent);
    case "At risk":
      return renderRow(label, rawValue, styleWarning, indent);
    case "Why this matters":
      return renderRow(label, rawValue, undefined, indent);
    case "Recommendation":
      return renderRow(label, rawValue, styleAction, indent);
    case "Last failure":
      return renderRow(label, rawValue, styleSecondary, indent);
    case "Status":
      return renderRow(label, rawValue, styleSecondary, indent);
    case "Artifacts ready":
      return renderRow(label, rawValue, styleSecondary, indent);
    case "Failing step":
      return renderRow(label, rawValue, stylePrimary, indent);
    case "Failing code":
      return renderRow(label, rawValue, stylePrimary, indent);
    case "Selector":
      return renderRow(label, rawValue, stylePrimary, indent);
    case "Target state":
      return renderRow(label, rawValue, styleWarning, indent);
    case "Clears":
      return renderRow(label, highlightCounts(rawValue), styleWarning, indent);
    default:
      return line;
  }
};

type PlaywrightReportShape = {
  specs?: PlaywrightReportShape[] | null;
  suites?: PlaywrightReportShape[] | null;
  tests?: Array<{
    results?: Array<{ status?: string | null }> | null;
  }> | null;
};

const readFinalFailedCount = (playwrightJsonPath: string) => {
  try {
    const parsed = JSON.parse(require("node:fs").readFileSync(playwrightJsonPath, "utf8")) as PlaywrightReportShape;
    let failed = 0;
    const walk = (node: PlaywrightReportShape | null | undefined) => {
      if (!node) return;
      for (const child of node.suites || []) walk(child);
      for (const child of node.specs || []) walk(child);
      for (const test of node.tests || []) {
        const results = Array.isArray(test.results) ? test.results : [];
        const finalStatus = results[results.length - 1]?.status || null;
        if (finalStatus === "failed" || finalStatus === "timedOut" || finalStatus === "interrupted") {
          failed += 1;
        }
      }
    };
    walk(parsed);
    return failed;
  } catch {
    return null;
  }
};

class SentinelReporter {
  private failedCount = 0;
  private totalCount = 0;
  private startedAt = Date.now();
  private options: ReporterOptions;

  constructor(options: ReporterOptions) {
    loadSentinelEnv();
    this.options = options;
  }

  onBegin(config: any, suite: any) {
    this.startedAt = Date.now();
    emitReporterTelemetry();
    this.totalCount = typeof suite?.allTests === "function" ? suite.allTests().length : 0;
    if (config?.projects?.length && !this.options.project) {
      this.options.project = config.projects[0]?.name || null;
    }
    if (this.options.verbose === true) {
      console.log("Sentinel detected Playwright artifact paths:");
      console.log(`- JSON report: ${this.options.playwrightJsonPath}`);
      console.log(`- HTML report: ${this.options.playwrightReportDir}`);
      console.log(`- Test results: ${this.options.testResultsDir}`);
      for (const dir of this.options.artifactDirs || []) {
        console.log(`- Extra artifacts: ${dir}`);
      }
      console.log("");
    }
  }

  async onTestEnd(test: any, result: any) {
    if (!result) return;
    if (["failed", "timedOut", "interrupted"].includes(result.status)) {
      await sentinelCaptureFailureContextFromReporter(test, result).catch(() => null);
      this.failedCount += 1;
    }
  }

  async onEnd() {
    const hasWorkspaceToken = Boolean(process.env.SENTINEL_TOKEN);
    const hasCiEnv = hasSupportedCiEnv(process.env);
    const localUploadEnabled = isLocalUploadEnabled(process.env);
    const usingImplicitLocalPublicMode =
      !hasWorkspaceToken &&
      !hasCiEnv &&
      !localUploadEnabled;
    const quickDiagnosis = buildQuickDiagnosis(this.options.playwrightJsonPath);
    const finalFailedCount = readFinalFailedCount(this.options.playwrightJsonPath);
    const effectiveFailedCount = typeof finalFailedCount === "number" ? finalFailedCount : this.failedCount;
    const passingSummary = effectiveFailedCount === 0
      ? buildPassingRunSummary(this.options.playwrightJsonPath, { observedRunDurationMs: Date.now() - this.startedAt })
      : null;
    const failedRunHistory = effectiveFailedCount > 0 ? buildFailedRunHistorySummary(this.options.playwrightJsonPath) : null;
    if (effectiveFailedCount > 0) {
      recordReporterHistorySnapshot(this.options.playwrightJsonPath);
    }
    console.log("");

    if (passingSummary) {
      console.log(stylePrimary("Sentinel run summary"));
      console.log(styleSecondary(divider()));
      console.log("");
      for (const line of passingSummary.lines) {
        console.log(formatCliLine(line));
      }
      console.log("");
      console.log(divider());
      console.log("");
    }

    if (effectiveFailedCount > 0) {
      emitFailedRunTelemetry();
    }
    await flushTelemetry();

    if (effectiveFailedCount === 0) {
      return;
    }

    if (hasWorkspaceToken && !hasCiEnv && !localUploadEnabled) {
      console.log("Uploading debug report skipped");
      console.log("Set SENTINEL_UPLOAD_LOCAL=1 for local workspace uploads.");
      return;
    }

    if (quickDiagnosis?.lines.length) {
      console.log(stylePrimary("Sentinel diagnosis"));
      console.log(styleSecondary(divider()));
      console.log("");
      if (failedRunHistory?.passStreakBeforeFailure && failedRunHistory.passStreakBeforeFailure > 0) {
        console.log(formatCliLine(`NEW FAILURE after ${failedRunHistory.passStreakBeforeFailure} passing runs`));
        console.log("");
      } else if ((failedRunHistory?.recurringCount || 0) > 0) {
        console.log(formatCliLine(`RECURRING FAILURE (${failedRunHistory?.recurringCount} previous runs)`));
        console.log("");
      }
      for (const line of quickDiagnosis.lines) {
        console.log(formatCliLine(line));
      }
      console.log("");
      console.log(styleSecondary(divider()));
      console.log("");
      if (failedRunHistory?.newFailures && failedRunHistory.newFailures > 0) {
        console.log(formatCliLine(`Impact: ${failedRunHistory.newFailures} newly failing in this run`));
        console.log("");
      } else if (failedRunHistory?.stillFailing && failedRunHistory.stillFailing > 0) {
        console.log(formatCliLine(`Impact: ${failedRunHistory.stillFailing} tests still failing`));
        console.log("");
      }
    }

    console.log(styleSecondary("Uploading debug report..."));
    console.log("");

    const upload = (await runSentinelUpload({
      playwrightJsonPath: this.options.playwrightJsonPath,
      playwrightReportDir: this.options.playwrightReportDir,
      testResultsDir: this.options.testResultsDir,
      artifactDirs: this.options.artifactDirs || [],
      suppressSummaryJson: true,
      env: {
        SENTINEL_REPORTER_PROJECT: this.options.project || undefined,
        SENTINEL_REPORTER_SILENT: "1",
        SENTINEL_UPLOAD_LOCAL:
          usingImplicitLocalPublicMode ? "1" : process.env.SENTINEL_UPLOAD_LOCAL
      }
    })) as ReporterUploadResult;

    if (upload.exitCode !== 0) {
      throw new Error(`Sentinel upload failed with exit code ${upload.exitCode}`);
    }

    if (!quickDiagnosis?.lines.length && upload.diagnosis?.lines.length) {
      console.log(stylePrimary("Sentinel diagnosis"));
      console.log(styleSecondary(divider()));
      console.log("");
      for (const line of upload.diagnosis.lines) {
        console.log(formatCliLine(line));
      }
      console.log("");
      console.log(styleSecondary(divider()));
    }

    console.log("");
    console.log(styleAction("Debug report ready"));
    console.log(formatCliLine(`Next: ${upload.shareRunUrl || upload.internalRunUrl}`));
    if (upload.shareLabel) {
      console.log(`  ${styleSecondary(upload.shareLabel)}`);
    }
  }
}

export = SentinelReporter;
