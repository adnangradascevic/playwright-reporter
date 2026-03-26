import fs from "node:fs";
import path from "node:path";

type PlaywrightErrorShape = {
  message?: string | null;
  stack?: string | null;
  value?: string | null;
};

type PlaywrightResultShape = {
  status?: string;
  duration?: number;
  retry?: number;
  startTime?: string | null;
  error?: PlaywrightErrorShape | null;
  errors?: PlaywrightErrorShape[] | null;
};

type PlaywrightTestShape = {
  title?: string;
  timeout?: number | null;
  projectName?: string | null;
  results?: PlaywrightResultShape[] | null;
  location?: { file?: string | null } | null;
};

type PlaywrightSpecShape = {
  title?: string;
  file?: string;
  tests?: PlaywrightTestShape[] | null;
  specs?: PlaywrightSpecShape[] | null;
  suites?: PlaywrightSpecShape[] | null;
  location?: { file?: string | null } | null;
};

type HistoryTest = {
  matchKey: string;
  title: string;
  status: string;
  durationMs: number;
  retries: number;
  timeoutMs: number | null;
};

type HistorySnapshot = {
  generatedAt: string;
  branch: string;
  gitSha: string;
  wallDurationMs: number | null;
  totalTests: number;
  passedCount: number;
  failedCount: number;
  skippedCount: number;
  retryPassedCount: number;
  failures: string[];
  tests: HistoryTest[];
};

type CurrentTest = HistoryTest;

export type PassingRunSummary = {
  lines: string[];
};

type NearFailureCandidate = {
  title: string;
  ratio: number | null;
  recentTrendRatio: number | null;
  retries: number;
  historicalRetries: number;
  historicalFailures: number;
  repeatedSlowPasses: number;
  timeoutUtilization: number | null;
  medianDurationMs: number | null;
  currentDurationMs: number;
  score: number;
  strongSignal: boolean;
  currentRunSignal: boolean;
  primaryReason: string;
};

type PassingRunSummaryOptions = {
  observedRunDurationMs?: number | null;
};

const HISTORY_DIR = path.join(".sentinel", "reporter-history");

const ensureDir = (dirPath: string) => {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
};

const readJson = <T>(filePath: string): T | null => {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
};

const getCurrentBranch = () => {
  const fromEnv =
    process.env.GITHUB_REF_NAME ||
    process.env.CI_COMMIT_REF_NAME ||
    process.env.CI_COMMIT_BRANCH ||
    process.env.BRANCH_NAME ||
    null;
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : "main";
};

const getCurrentGitSha = () => {
  const fromEnv =
    process.env.GITHUB_SHA ||
    process.env.CI_COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    null;
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : "unknown";
};

const normalizeStatus = (status: string | undefined) => {
  if (status === "failed" || status === "timedOut" || status === "interrupted") return "failed";
  if (status === "passed" || status === "flaky") return "passed";
  return "skipped";
};

const formatDuration = (durationMs: number) => {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
};


const formatShortDuration = (durationMs: number | null) => {
  if (durationMs === null || !Number.isFinite(durationMs)) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(durationMs >= 10000 ? 0 : 1)}s`;
};

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
};

const medianAbsoluteDeviation = (values: number[]) => {
  const med = median(values);
  if (med === null) return null;
  return median(values.map((value) => Math.abs(value - med)));
};

const getPrimaryRiskKind = (candidate: NearFailureCandidate) => {
  if (candidate.primaryReason.startsWith("failed in ")) return "historical_failures";
  if (candidate.primaryReason.startsWith("passed after ")) return "retry";
  if (candidate.primaryReason.startsWith("needed retries in ")) return "historical_retries";
  if (candidate.primaryReason.startsWith("took ")) return "slowdown";
  if (candidate.primaryReason.startsWith("has been unusually slow in ")) return "repeated_slow";
  if (candidate.primaryReason.startsWith("used ")) return "timeout_pressure";
  if (candidate.primaryReason.startsWith("is trending slower")) return "trend";
  if (candidate.retries > 0) return "retry";
  if (candidate.historicalRetries >= 2) return "historical_retries";
  if (candidate.ratio !== null && candidate.ratio >= 1.8) return "slowdown";
  if (candidate.repeatedSlowPasses >= 3) return "repeated_slow";
  if (candidate.recentTrendRatio !== null && candidate.recentTrendRatio >= 1.5) return "trend";
  if (candidate.timeoutUtilization !== null && candidate.timeoutUtilization >= 0.85) return "timeout_pressure";
  if (candidate.historicalFailures >= 5) return "historical_failures";
  return "generic";
};

const cleanTitlePath = (parts: string[]) => {
  const normalized = parts.map((part) => part.trim()).filter(Boolean);
  const withoutUnnamed = normalized.filter((part) => part !== "Unnamed test");
  return withoutUnnamed.length ? withoutUnnamed : normalized;
};

const formatHistoryTitle = (value: string | null) => {
  if (!value) return null;
  return cleanTitlePath(value.split(" > ")) .join(" > ") || value;
};

const buildMatchKey = (file: string, projectName: string, titlePath: string[]) =>
  [file || "unknown", projectName || "default", cleanTitlePath(titlePath).join(" > ")].join("::");


const collectWallDurationMs = (node: PlaywrightSpecShape): number | null => {
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = 0;
  const walk = (current: PlaywrightSpecShape | null | undefined) => {
    if (!current) return;
    for (const child of current.suites || []) walk(child);
    for (const child of current.specs || []) walk(child);
    for (const test of current.tests || []) {
      for (const result of test.results || []) {
        if (!result?.startTime || typeof result.duration !== 'number') continue;
        const start = Date.parse(result.startTime);
        if (!Number.isFinite(start)) continue;
        minStart = Math.min(minStart, start);
        maxEnd = Math.max(maxEnd, start + result.duration);
      }
    }
  };
  walk(node);
  if (!Number.isFinite(minStart) || maxEnd <= minStart) return null;
  return maxEnd - minStart;
};

const collectTests = (node: PlaywrightSpecShape, ancestors: string[] = []): CurrentTest[] => {
  const currentTitlePath = node.title ? [...ancestors, node.title] : ancestors;
  const tests: CurrentTest[] = [];

  for (const child of node.suites || []) tests.push(...collectTests(child, currentTitlePath));
  for (const child of node.specs || []) tests.push(...collectTests(child, currentTitlePath));

  const specTests = Array.isArray(node.tests) ? node.tests : [];
  for (const test of specTests) {
    const results = Array.isArray(test.results) ? test.results : [];
    const finalStatus = normalizeStatus(test.results?.[test.results.length - 1]?.status);
    const finalDurationMs = typeof results[results.length - 1]?.duration === "number" ? results[results.length - 1].duration as number : 0;
    let durationMs = finalDurationMs;
    let retries = 0;
    for (const result of results) {
      if (typeof result.retry === "number") retries = Math.max(retries, result.retry);
    }
    const titlePath = cleanTitlePath([...currentTitlePath, test.title || "Unnamed test"]);
    const file =
      node.file || node.location?.file || test.location?.file || "";
    const projectName = test.projectName || "";
    tests.push({
      matchKey: buildMatchKey(file, projectName, titlePath),
      title: titlePath.join(" > "),
      status: finalStatus,
      durationMs,
      retries,
      timeoutMs: typeof test.timeout === "number" ? test.timeout : null
    });
  }

  return tests;
};

const buildSnapshot = (playwrightJsonPath: string): HistorySnapshot | null => {
  const parsed = readJson<PlaywrightSpecShape>(playwrightJsonPath);
  if (!parsed) return null;
  const tests = collectTests(parsed);
  const failedTests = tests.filter((test) => test.status === "failed");
  const passedCount = tests.filter((test) => test.status === "passed").length;
  const skippedCount = tests.filter((test) => test.status === "skipped").length;
  return {
    generatedAt: new Date().toISOString(),
    branch: getCurrentBranch(),
    gitSha: getCurrentGitSha(),
    wallDurationMs: collectWallDurationMs(parsed),
    totalTests: tests.length,
    passedCount,
    failedCount: failedTests.length,
    skippedCount,
    retryPassedCount: tests.filter((test) => test.status === "passed" && test.retries > 0).length,
    failures: failedTests.map((test) => test.title),
    tests
  };
};

const listSnapshots = (branch: string) => {
  const historyDir = path.resolve(process.cwd(), HISTORY_DIR);
  if (!fs.existsSync(historyDir)) return [] as HistorySnapshot[];
  return fs
    .readdirSync(historyDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => readJson<HistorySnapshot>(path.join(historyDir, file)))
    .filter((value): value is HistorySnapshot => Boolean(value))
    .filter((snapshot) => snapshot.branch === branch)
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
};

const writeSnapshot = (snapshot: HistorySnapshot) => {
  ensureDir(path.resolve(process.cwd(), HISTORY_DIR));
  const fileName = `${snapshot.generatedAt.replace(/[:.]/g, "-")}-${snapshot.gitSha}.json`;
  fs.writeFileSync(
    path.resolve(process.cwd(), HISTORY_DIR, fileName),
    JSON.stringify(snapshot, null, 2),
    "utf8"
  );
};


export const recordReporterHistorySnapshot = (playwrightJsonPath: string) => {
  const snapshot = buildSnapshot(playwrightJsonPath);
  if (!snapshot) return null;
  writeSnapshot(snapshot);
  return snapshot;
};

export const buildPassingRunSummary = (playwrightJsonPath: string, options?: PassingRunSummaryOptions): PassingRunSummary | null => {
  const snapshot = buildSnapshot(playwrightJsonPath);
  if (!snapshot) return null;

  const previousRuns = listSnapshots(snapshot.branch);
  writeSnapshot(snapshot);

  if (snapshot.failedCount > 0 || snapshot.totalTests === 0 || snapshot.passedCount === 0) return null;

  let passStreak = 1;
  let lastFailureRunsAgo: number | null = null;
  for (let i = 0; i < previousRuns.length; i += 1) {
    const previous = previousRuns[i];
    if (previous.failedCount === 0) {
      passStreak += 1;
      continue;
    }
    lastFailureRunsAgo = i + 1;
    break;
  }

  const retryPassedCount = snapshot.retryPassedCount;
  const durationSamples = new Map<string, number[]>();
  const recentDurationSamples = new Map<string, number[]>();
  const slowPassCounts = new Map<string, number>();
  for (const previous of previousRuns.slice(0, 20)) {
    for (const test of previous.tests || []) {
      if (test.status !== "passed" || test.durationMs <= 0) continue;
      const bucket = durationSamples.get(test.matchKey) || [];
      bucket.push(test.durationMs);
      durationSamples.set(test.matchKey, bucket);
      if (durationSamples.get(test.matchKey)!.length <= 5) {
        const recentBucket = recentDurationSamples.get(test.matchKey) || [];
        recentBucket.push(test.durationMs);
        recentDurationSamples.set(test.matchKey, recentBucket);
      }
    }
  }

  let slowestRisk: { title: string; ratio: number } | null = null;
  const historicalRetryCounts = new Map<string, number>();
  const historicalFailureCounts = new Map<string, number>();
  for (const previous of previousRuns.slice(0, 10)) {
    for (const test of previous.tests || []) {
      if (test.status === "passed" && test.retries > 0) {
        historicalRetryCounts.set(test.matchKey, (historicalRetryCounts.get(test.matchKey) || 0) + 1);
      }
      if (test.status === "failed") {
        historicalFailureCounts.set(test.matchKey, (historicalFailureCounts.get(test.matchKey) || 0) + 1);
      }
      if (test.status === "passed" && test.durationMs > 0) {
        const all = durationSamples.get(test.matchKey) || [];
        const historicalMedian = median(all);
        if (historicalMedian && test.durationMs / historicalMedian >= 1.35) {
          slowPassCounts.set(test.matchKey, (slowPassCounts.get(test.matchKey) || 0) + 1);
        }
      }
    }
  }

  const nearFailureCandidates: NearFailureCandidate[] = [];

  for (const test of snapshot.tests) {
    if (test.status !== "passed" || test.durationMs <= 0) continue;
    const samples = durationSamples.get(test.matchKey) || [];
    const med = median(samples);
    const variability = medianAbsoluteDeviation(samples);
    const recentMedian = median(recentDurationSamples.get(test.matchKey) || []);
    const hasReliableMedian = samples.length >= 5 && Boolean(med) && (med || 0) >= 250;
    const hasReliableRecentMedian = (recentDurationSamples.get(test.matchKey) || []).length >= 3 && Boolean(recentMedian) && Boolean(med) && (med || 0) >= 250;
    const varianceFloor = Math.max(400, variability ? variability * 3 : 400);
    const absoluteDelta = hasReliableMedian && med ? test.durationMs - med : null;
    const ratio = hasReliableMedian && med && absoluteDelta !== null && absoluteDelta >= varianceFloor ? test.durationMs / med : null;
    const recentTrendDelta = hasReliableRecentMedian && recentMedian && med ? recentMedian - med : null;
    const recentTrendRatio =
      hasReliableRecentMedian &&
      recentMedian &&
      med &&
      recentTrendDelta !== null &&
      recentTrendDelta >= varianceFloor
        ? recentMedian / med
        : null;
    if (ratio && ratio >= 1.8 && (!slowestRisk || ratio > slowestRisk.ratio)) {
      slowestRisk = { title: test.title, ratio };
    }
    const historicalRetries = historicalRetryCounts.get(test.matchKey) || 0;
    const historicalFailures = historicalFailureCounts.get(test.matchKey) || 0;
    const repeatedSlowPasses = slowPassCounts.get(test.matchKey) || 0;
    const timeoutUtilization = test.timeoutMs && test.timeoutMs > 0 ? test.durationMs / test.timeoutMs : null;
    const recentFailurePressure = historicalFailures >= 5 && lastFailureRunsAgo !== null && lastFailureRunsAgo <= 3;
    const currentRunSignal = Boolean(
      test.retries > 0 ||
      (ratio && ratio >= 1.8) ||
      (timeoutUtilization && timeoutUtilization >= 0.9)
    );
    const persistentPassSignal = Boolean(
      historicalRetries >= 2 ||
      repeatedSlowPasses >= 3 ||
      (recentTrendRatio && recentTrendRatio >= 1.5)
    );
    const score =
      (test.retries > 0 ? 4 : 0) +
      (ratio && ratio >= 1.8 ? 2 : 0) +
      (ratio && ratio >= 2.2 ? 1 : 0) +
      (recentTrendRatio && recentTrendRatio >= 1.5 ? 1 : 0) +
      (repeatedSlowPasses >= 2 ? 2 : repeatedSlowPasses > 0 ? 1 : 0) +
      (timeoutUtilization && timeoutUtilization >= 0.65 ? 1 : 0) +
      (timeoutUtilization && timeoutUtilization >= 0.85 ? 1 : 0) +
      (historicalRetries >= 2 ? 2 : historicalRetries > 0 ? 1 : 0) +
      (recentFailurePressure ? 1 : 0);
    const strongSignal = Boolean(
      currentRunSignal ||
      persistentPassSignal
    );
    const primaryReason =
      test.retries > 0
        ? `passed after ${test.retries} retr${test.retries === 1 ? 'y' : 'ies'} in this run`
        : historicalRetries >= 2
          ? `needed retries in ${historicalRetries} of the last 10 passing runs`
          : ratio && ratio >= 1.8
              ? `took ${formatShortDuration(test.durationMs)} vs ${formatShortDuration(med)} recent median (${ratio.toFixed(1)}x)`
              : repeatedSlowPasses >= 2
                ? `has been unusually slow in ${repeatedSlowPasses} of the last 10 passing runs`
                : timeoutUtilization && timeoutUtilization >= 0.85
                  ? `used ${(timeoutUtilization * 100).toFixed(0)}% of its timeout budget`
                  : recentTrendRatio && recentTrendRatio >= 1.5
                    ? `is trending slower over recent runs`
                    : recentFailurePressure
                      ? `failed in ${historicalFailures} of the last 10 runs`
                      : `has weak instability signals`;
    if (score > 0) {
      nearFailureCandidates.push({
        title: test.title,
        ratio,
        recentTrendRatio,
        retries: test.retries,
        historicalRetries,
        historicalFailures,
        repeatedSlowPasses,
        timeoutUtilization,
        medianDurationMs: med,
        currentDurationMs: test.durationMs,
        score,
        strongSignal,
        currentRunSignal,
        primaryReason
      });
    }
  }

  nearFailureCandidates.sort(
    (left, right) =>
      Number(right.currentRunSignal) - Number(left.currentRunSignal) ||
      right.score - left.score ||
      (right.historicalFailures || 0) - (left.historicalFailures || 0) ||
      (right.timeoutUtilization || 0) - (left.timeoutUtilization || 0) ||
      (right.ratio || 0) - (left.ratio || 0)
  );
  const strongNearFailures = nearFailureCandidates.filter(
    (candidate) =>
      candidate.strongSignal &&
      (
        candidate.currentRunSignal ||
        candidate.historicalRetries >= 2 ||
        candidate.repeatedSlowPasses >= 3 ||
        (candidate.recentTrendRatio !== null && candidate.recentTrendRatio >= 1.5)
      ) &&
      candidate.score >= 3
  );
  const topNearFailures = strongNearFailures.slice(0, 2);
  const flakyLookingCount = strongNearFailures.length;
  const hasActiveRisk = flakyLookingCount > 0;
  const totalDurationMs = snapshot.tests.reduce((sum, test) => sum + test.durationMs, 0);
  const displayedRunDurationMs = options?.observedRunDurationMs || snapshot.wallDurationMs || totalDurationMs;

  const lines = ["All tests passed", `${snapshot.passedCount} tests in ${formatDuration(displayedRunDurationMs)}`];

  if (hasActiveRisk && topNearFailures[0]) {
    const riskKind = getPrimaryRiskKind(topNearFailures[0]);
    lines.push(`At risk: ${topNearFailures[0].title} ${topNearFailures[0].primaryReason}`);
    if (riskKind === "retry" || riskKind === "historical_retries") {
      lines.push("Why this matters: Similar retry patterns often turn into flaky failures");
    } else if (riskKind === "slowdown" || riskKind === "repeated_slow" || riskKind === "trend") {
      lines.push("Why this matters: Performance regressions often lead to flaky failures");
    } else if (riskKind === "historical_failures") {
      lines.push("Why this matters: This test has been failing repeatedly and is likely to regress again");
    } else if (riskKind === "timeout_pressure") {
      lines.push("Why this matters: Tests that run close to their timeout budget often become flaky");
    } else {
      lines.push("Why this matters: This instability pattern often turns into a future failure");
    }
    if (lastFailureRunsAgo !== null) lines.push(`Last failure: ${lastFailureRunsAgo} runs ago`);
    if (riskKind === "retry" || riskKind === "historical_retries") {
      lines.push("Recommendation: inspect retry behavior or timing around this test");
    } else if (riskKind === "slowdown" || riskKind === "repeated_slow" || riskKind === "trend") {
      lines.push("Recommendation: monitor the next runs or investigate the slowdown");
    } else if (riskKind === "historical_failures") {
      lines.push("Recommendation: rerun this test locally and inspect the last failing behavior");
    } else if (riskKind === "timeout_pressure") {
      lines.push("Recommendation: inspect timeout pressure or waiting logic in this test");
    } else {
      lines.push("Recommendation: monitor the next runs and inspect this test if the pattern repeats");
    }
  } else {
    lines.push("No anomalies detected");
    if (lastFailureRunsAgo !== null) lines.push(`Last failure: ${lastFailureRunsAgo} runs ago`);
    lines.push("Status: Stable");
  }

  lines.push("Artifacts ready: traces, screenshots, video");

  return { lines };
};
