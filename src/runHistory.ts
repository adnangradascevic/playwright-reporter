import fs from "node:fs";
import path from "node:path";
import { collectFailureFacts, type FailureFacts } from "./quickDiagnosis";

type SnapshotFailure = {
  id: string;
  matchKey: string;
  title: string;
  status: string;
};

type RunSnapshot = {
  generatedAt: string;
  branch: string;
  gitSha: string;
  failures: SnapshotFailure[];
};

type ReporterHistoryTest = {
  matchKey: string;
  title: string;
  status: string;
};

type ReporterHistorySnapshot = {
  generatedAt: string;
  branch: string;
  gitSha: string;
  failedCount: number;
  passedCount: number;
  totalTests: number;
  tests: ReporterHistoryTest[];
};

type LegacyRunSnapshot = Partial<RunSnapshot> & {
  path?: string;
  tests?: Array<{
    id?: string;
    matchKey?: string;
    title?: string;
    status?: string;
  }>;
};

type RunDiffSummary = {
  newFailures: number;
  fixedTests: number;
  stillFailing: number;
};

export type FailedRunHistorySummary = {
  lines: string[];
  passStreakBeforeFailure: number;
  previousWasGreen: boolean;
  newFailures: number;
  fixedTests: number;
  stillFailing: number;
  recurringCount: number;
  recurringTitle: string | null;
};

type HistoryContext = {
  comparedRunScope: "previous_attempt" | "last_failed_run";
};

const SENTINEL_HISTORY_DIR = path.join(".sentinel", "history");
const REPORTER_HISTORY_DIR = path.join(".sentinel", "reporter-history");

const ensureDir = (dirPath: string) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
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

const buildMatchKey = (failure: FailureFacts) =>
  [
    failure.signal,
    failure.locator || "unknown-locator",
    failure.expected || "unknown-expected",
    failure.received || "unknown-received",
    failure.titlePath.join(" > ") || failure.title
  ].join("|");

const buildSnapshot = (playwrightJsonPath: string): RunSnapshot => {
  const failures = collectFailureFacts(playwrightJsonPath);
  return {
    generatedAt: new Date().toISOString(),
    branch: getCurrentBranch(),
    gitSha: getCurrentGitSha(),
    failures: failures.map((failure) => ({
      id: failure.titlePath.join(" > ") || failure.title,
      matchKey: buildMatchKey(failure),
      title: failure.title,
      status: failure.status
    }))
  };
};

const getPointerPaths = (branch: string) => [
  path.join(".sentinel", "latest.json"),
  path.join(".sentinel", `latest-${branch}.json`),
  ...(branch === "main" ? [path.join(".sentinel", "latest-main.json")] : [])
];

const normalizeFailures = (snapshot: LegacyRunSnapshot | null): SnapshotFailure[] => {
  if (!snapshot) return [];
  if (Array.isArray(snapshot.failures)) {
    return snapshot.failures.filter(
      (failure): failure is SnapshotFailure =>
        Boolean(
          failure &&
            typeof failure.id === "string" &&
            typeof failure.matchKey === "string" &&
            typeof failure.title === "string" &&
            typeof failure.status === "string"
        )
    );
  }
  if (Array.isArray(snapshot.tests)) {
    return snapshot.tests
      .filter((test) => test && typeof test.id === "string")
      .map((test) => ({
        id: test.id as string,
        matchKey: typeof test.matchKey === "string" ? test.matchKey : (test.id as string),
        title: typeof test.title === "string" ? test.title : (test.id as string),
        status: typeof test.status === "string" ? test.status : "failed"
      }));
  }
  return [];
};

const readJson = <T>(filePath: string): T | null => {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
};

const readSnapshot = (filePath: string) => {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as LegacyRunSnapshot;
  } catch {
    return null;
  }
};

const listSnapshots = (branch: string) => {
  const historyDir = path.resolve(process.cwd(), SENTINEL_HISTORY_DIR);
  if (!fs.existsSync(historyDir)) return [] as RunSnapshot[];
  return fs
    .readdirSync(historyDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => readSnapshot(path.join(historyDir, file)))
    .filter((value): value is LegacyRunSnapshot => Boolean(value))
    .map((snapshot) => ({
      generatedAt: typeof snapshot.generatedAt === "string" ? snapshot.generatedAt : new Date(0).toISOString(),
      branch: typeof snapshot.branch === "string" ? snapshot.branch : branch,
      gitSha: typeof snapshot.gitSha === "string" ? snapshot.gitSha : "unknown",
      failures: normalizeFailures(snapshot)
    }))
    .filter((snapshot) => snapshot.branch === branch)
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
};


const isMeaningfulReporterSnapshot = (snapshot: ReporterHistorySnapshot | null | undefined) => {
  if (!snapshot) return false;
  if (snapshot.totalTests <= 0) return false;
  if ((snapshot.passedCount || 0) === 0 && (snapshot.failedCount || 0) === 0) return false;
  return true;
};

const listReporterSnapshots = (branch: string) => {
  const historyDir = path.resolve(process.cwd(), REPORTER_HISTORY_DIR);
  if (!fs.existsSync(historyDir)) return [] as ReporterHistorySnapshot[];
  return fs
    .readdirSync(historyDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => readJson<ReporterHistorySnapshot>(path.join(historyDir, file)))
    .filter((value): value is ReporterHistorySnapshot => Boolean(value))
    .filter((snapshot) => snapshot.branch === branch)
    .filter((snapshot) => isMeaningfulReporterSnapshot(snapshot))
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
};

const normalizeReporterFailures = (snapshot: ReporterHistorySnapshot | null | undefined): SnapshotFailure[] => {
  if (!snapshot) return [];
  return (snapshot.tests || [])
    .filter((test) => test && test.status === "failed")
    .map((test) => ({
      id: typeof test.title === "string" ? test.title : test.matchKey,
      matchKey: typeof test.matchKey === "string" ? test.matchKey : (typeof test.title === "string" ? test.title : "unknown"),
      title: typeof test.title === "string" ? test.title : test.matchKey,
      status: "failed"
    }));
};

const writeSnapshot = (snapshot: RunSnapshot) => {
  ensureDir(path.resolve(process.cwd(), ".sentinel"));
  ensureDir(path.resolve(process.cwd(), SENTINEL_HISTORY_DIR));
  const fileName = `${snapshot.generatedAt.replace(/[:.]/g, "-")}-${snapshot.gitSha}.json`;
  const historyPath = path.resolve(process.cwd(), SENTINEL_HISTORY_DIR, fileName);
  fs.writeFileSync(historyPath, JSON.stringify(snapshot, null, 2), "utf8");
  for (const pointerPath of getPointerPaths(snapshot.branch)) {
    fs.writeFileSync(
      path.resolve(process.cwd(), pointerPath),
      JSON.stringify({ path: historyPath, ...snapshot }, null, 2),
      "utf8"
    );
  }
};

const matchesFailure = (left: SnapshotFailure, right: SnapshotFailure) =>
  left.id === right.id || left.matchKey === right.matchKey;

export const buildRunDiffSummary = (playwrightJsonPath: string): RunDiffSummary | null => {
  const snapshot = buildSnapshot(playwrightJsonPath);
  const previous =
    readSnapshot(path.resolve(process.cwd(), ".sentinel", `latest-${snapshot.branch}.json`)) ||
    readSnapshot(path.resolve(process.cwd(), ".sentinel", "latest.json"));
  const previousFailures = normalizeFailures(previous);

  const currentFailureIds = new Set(snapshot.failures.map((test) => test.id));
  const currentFailureMatchKeys = new Set(snapshot.failures.map((test) => test.matchKey));

  const diff =
    previous && previous.generatedAt !== snapshot.generatedAt
      ? {
          newFailures: snapshot.failures.filter(
            (test) => !previousFailures.some((prev) => matchesFailure(prev, test))
          ).length,
          fixedTests: previousFailures.filter(
            (test) => !currentFailureIds.has(test.id) && !currentFailureMatchKeys.has(test.matchKey)
          ).length,
          stillFailing: snapshot.failures.filter(
            (test) => previousFailures.some((prev) => matchesFailure(prev, test))
          ).length
        }
      : null;

  writeSnapshot(snapshot);
  return diff;
};

export const buildFailedRunHistorySummary = (playwrightJsonPath: string): FailedRunHistorySummary | null => {
  const snapshot = buildSnapshot(playwrightJsonPath);
  if (snapshot.failures.length === 0) return null;

  const reporterSnapshots = listReporterSnapshots(snapshot.branch);
  const previousRun = reporterSnapshots[0] || null;
  const previousFailures = normalizeReporterFailures(previousRun);

  let passStreakBeforeFailure = 0;
  for (const previous of reporterSnapshots) {
    if ((previous.failedCount || 0) === 0) {
      passStreakBeforeFailure += 1;
      continue;
    }
    break;
  }

  const newFailures = snapshot.failures.filter(
    (failure) => !previousFailures.some((prev) => matchesFailure(prev, failure))
  ).length;
  const fixedTests = previousFailures.filter(
    (failure) => !snapshot.failures.some((current) => matchesFailure(current, failure))
  ).length;
  const stillFailing = snapshot.failures.filter(
    (failure) => previousFailures.some((prev) => matchesFailure(prev, failure))
  ).length;

  const failingReporterRuns = reporterSnapshots.filter((run) => (run.failedCount || 0) > 0);
  const recurringFailures = snapshot.failures
    .map((failure) => ({
      failure,
      occurrences: failingReporterRuns.filter((run) => normalizeReporterFailures(run).some((prev) => matchesFailure(prev, failure))).length
    }))
    .sort((a, b) => b.occurrences - a.occurrences);

  const topRecurring = recurringFailures.find((item) => item.occurrences > 0) || null;

  writeSnapshot(snapshot);

  const lines: string[] = [];
  if (passStreakBeforeFailure > 0) {
    lines.push(`- First failure after ${passStreakBeforeFailure} passing runs`);
  }
  if (previousRun && (newFailures > 0 || fixedTests > 0 || stillFailing > 0)) {
    const previousWasGreen = (previousRun.failedCount || 0) === 0;
    if (previousWasGreen) {
      lines.push(`- The immediately previous run was green. Compared to that previous run: ${newFailures} newly failing in this run, ${stillFailing} still failing, ${fixedTests} no longer failing`);
    } else {
      lines.push(`- Compared to the immediately previous run: ${newFailures} newly failing in this run, ${stillFailing} still failing, ${fixedTests} no longer failing`);
    }
  }
  if (topRecurring) {
    lines.push(`- Recurring across ${topRecurring.occurrences + 1} recorded failed runs in local history (${topRecurring.failure.title})`);
  }


  return lines.length
    ? {
        lines,
        passStreakBeforeFailure,
        previousWasGreen: Boolean(previousRun && (previousRun.failedCount || 0) === 0),
        newFailures,
        fixedTests,
        stillFailing,
        recurringCount: topRecurring ? topRecurring.occurrences : 0,
        recurringTitle: topRecurring?.failure.title || null
      }
    : null;
};
