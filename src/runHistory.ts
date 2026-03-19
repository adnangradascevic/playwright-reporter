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

const SENTINEL_HISTORY_DIR = path.join(".sentinel", "history");

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

const readSnapshot = (filePath: string) => {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as LegacyRunSnapshot;
  } catch {
    return null;
  }
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
            (test) =>
              !previousFailures.some(
                (prev) => prev.id === test.id || prev.matchKey === test.matchKey
              )
          ).length,
          fixedTests: previousFailures.filter(
            (test) =>
              !currentFailureIds.has(test.id) && !currentFailureMatchKeys.has(test.matchKey)
          ).length,
          stillFailing: snapshot.failures.filter(
            (test) =>
              previousFailures.some(
                (prev) => prev.id === test.id || prev.matchKey === test.matchKey
              )
          ).length
        }
      : null;

  writeSnapshot(snapshot);
  return diff;
};
