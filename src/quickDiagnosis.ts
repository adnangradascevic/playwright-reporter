import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

type PlaywrightErrorShape = {
  message?: string | null;
  stack?: string | null;
  value?: string | null;
  location?: { file?: string | null; line?: number | null; column?: number | null } | null;
};

type PlaywrightAttachmentShape = {
  name?: string | null;
  path?: string | null;
};

type PlaywrightResultShape = {
  status?: string;
  retry?: number;
  attachments?: PlaywrightAttachmentShape[] | null;
  error?: (PlaywrightErrorShape & { location?: { file?: string | null; line?: number | null; column?: number | null } | null }) | null;
  errors?: Array<PlaywrightErrorShape & { location?: { file?: string | null; line?: number | null; column?: number | null } | null }> | null;
};

type PlaywrightTestShape = {
  title?: string;
  projectName?: string | null;
  timeout?: number | null;
  results?: PlaywrightResultShape[] | null;
  location?: { file?: string | null; line?: number | null; column?: number | null } | null;
};

type PlaywrightNode = {
  title?: string;
  file?: string | null;
  location?: { file?: string | null } | null;
  specs?: PlaywrightNode[] | null;
  tests?: PlaywrightTestShape[] | null;
  suites?: PlaywrightNode[] | null;
};

type DiagnosisSignal =
  | "timeout"
  | "assertion_mismatch"
  | "locator_not_found"
  | "actionability"
  | "network"
  | "runtime"
  | "infra"
  | "unknown";

export type QuickDiagnosis = {
  lines: string[];
  footer?: string[];
};

type CommitCandidate = {
  sha: string;
  author: string;
  message: string;
  changedFiles: string[];
};

type CommitMatch = {
  commit: CommitCandidate;
  score: number;
  reasons: string[];
  touchedFiles: string[];
};

type CodeContextCapture = {
  file?: string | null;
  line?: number | null;
  column?: number | null;
  action?: string | null;
  locator?: string | null;
  expectedText?: string | null;
  timeoutMs?: number | null;
  apiCall?: string | null;
  assertion?: string | null;
  methodName?: string | null;
  focusLine?: string | null;
  previousActionLine?: string | null;
  found?: boolean;
};

type DomCapture = {
  locator?: string | null;
  expectedText?: string | null;
  observedText?: string | null;
  captureSource?: "live_page" | "error_fallback";
  matchedCount?: number | null;
  targetFound?: boolean | null;
  visible?: boolean | null;
  attached?: boolean | null;
  enabled?: boolean | null;
  testId?: string | null;
  role?: string | null;
  accessibleName?: string | null;
  textContent?: string | null;
  tagName?: string | null;
  inputType?: string | null;
  placeholder?: string | null;
  ariaLabel?: string | null;
  textAlternatives?: string[] | null;
  matchedElements?: Array<{
    index: number;
    role: string | null;
    accessibleName: string | null;
    visible: boolean | null;
    enabled: boolean | null;
    text: string | null;
  }> | null;
};

export type FailureFacts = {
  title: string;
  titlePath: string[];
  projectName: string | null;
  message: string;
  firstErrorLine: string | null;
  signal: DiagnosisSignal;
  locator: string | null;
  expected: string | null;
  received: string | null;
  timeoutMs: number | null;
  timeoutBudgetMs: number | null;
  lastUrl: string | null;
  status: string;
  file: string | null;
  likelyFile: string | null;
  likelyModule: string | null;
  apiHint: string | null;
  codeContext: CodeContextCapture | null;
  domCapture: DomCapture | null;
};

type FailureCluster = {
  key: string;
  count: number;
  sample: FailureFacts;
  titles: string[];
  suspects: CommitMatch[];
  failures: FailureFacts[];
};

type TimeoutClusterEvidence = {
  action: string | null;
  locator: string | null;
  state: "missing" | "hidden" | "disabled" | "present" | "unknown";
};

type HistorySnapshot = {
  generatedAt?: string;
  branch?: string;
  gitSha?: string;
  failedCount?: number;
  passedCount?: number;
  totalTests?: number;
};

type CommitWindow = {
  commits: CommitCandidate[];
  trusted: boolean;
  reason: string | null;
};

type LastPassingSnapshot = {
  sha: string;
  reason: string | null;
};

const REPORTER_HISTORY_DIR = path.join(".sentinel", "reporter-history");

const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, "");

const normalizeTitleParts = (value: string) =>
  value
    .split(" > ")
    .map((part) => part.trim())
    .filter(Boolean);

const cleanTitleParts = (parts: string[]) => {
  const withoutUnnamed = parts.filter((part) => part && part !== "Unnamed test");
  return withoutUnnamed.length ? withoutUnnamed : parts.filter(Boolean);
};

const pickHumanTitleParts = (value: string) => cleanTitleParts(normalizeTitleParts(value)).slice(-2);

const formatTitle = (title: string) => pickHumanTitleParts(title).join(" > ") || title;

const shortenTitle = (value: string) => {
  const parts = pickHumanTitleParts(value);
  return parts[parts.length - 1] || value;
};

const normalizePath = (value: string | null | undefined) => (value || "").replace(/\\/g, "/").toLowerCase().trim();

const basename = (value: string | null | undefined) => {
  const normalized = normalizePath(value);
  if (!normalized) return "";
  return normalized.split("/").pop() || normalized;
};

const dirnameToken = (value: string | null | undefined) => {
  const normalized = normalizePath(value);
  if (!normalized || !normalized.includes("/")) return "";
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : "";
};

const gitOutput = (args: string[]) => {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8"
    }).trim();
  } catch {
    return null;
  }
};

const currentSha = () =>
  (
    process.env.GITHUB_SHA ||
    process.env.CI_COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    gitOutput(["rev-parse", "HEAD"]) ||
    ""
  ).trim();

const currentBranch = () =>
  (
    process.env.GITHUB_REF_NAME ||
    process.env.CI_COMMIT_REF_NAME ||
    process.env.CI_COMMIT_BRANCH ||
    process.env.BRANCH_NAME ||
    gitOutput(["rev-parse", "--abbrev-ref", "HEAD"]) ||
    "main"
  ).trim();

const normalizeMessageFingerprint = (message: string) =>
  stripAnsi(message)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(" | ")
    .replace(/\b\d+ms\b/gi, "<ms>")
    .replace(/:\d+:\d+/g, ":<line>:<col>")
    .replace(/\s+/g, " ")
    .slice(0, 240);

const readJson = <T>(filePath: string): T | null => {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
};

const isMeaningfulHistorySnapshot = (snapshot: HistorySnapshot | null | undefined) => {
  if (!snapshot) return false;
  if (typeof snapshot.totalTests === 'number' && snapshot.totalTests <= 0) return false;
  if (typeof snapshot.failedCount === 'number' && typeof snapshot.passedCount === 'number') {
    if (snapshot.failedCount === 0 && snapshot.passedCount === 0) return false;
  }
  return true;
};

const listHistorySnapshots = (branch: string) => {
  const dir = path.resolve(process.cwd(), REPORTER_HISTORY_DIR);
  if (!fs.existsSync(dir)) return [] as HistorySnapshot[];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => readJson<HistorySnapshot>(path.join(dir, file)))
    .filter((value): value is HistorySnapshot => Boolean(value))
    .filter((snapshot) => (snapshot.branch || branch) === branch)
    .filter((snapshot) => isMeaningfulHistorySnapshot(snapshot))
    .sort((a, b) => String(b.generatedAt || "").localeCompare(String(a.generatedAt || "")));
};

const getLastPassingSnapshot = (): LastPassingSnapshot | null => {
  const branch = currentBranch();
  const sha = currentSha();
  const snapshots = listHistorySnapshots(branch);
  const sameCommitFailure = sha
    ? snapshots.find(
        (snapshot) =>
          snapshot.gitSha === sha &&
          Number(snapshot.failedCount || 0) > 0
      )
    : null;
  if (sameCommitFailure) {
    return {
      sha: sameCommitFailure.gitSha || "unknown",
      reason: "current commit has already failed in local history"
    };
  }
  const sameCommitPass = sha
    ? snapshots.find(
        (snapshot) =>
          snapshot.gitSha === sha &&
          Number(snapshot.failedCount || 0) === 0 &&
          Number(snapshot.passedCount || 0) > 0
      )
    : null;
  if (sameCommitPass) {
    return {
      sha: sameCommitPass.gitSha || "unknown",
      reason: "current commit already passed locally; no new code change separates that pass from this failure"
    };
  }
  const match = snapshots.find(
    (snapshot) =>
      Number(snapshot.failedCount || 0) === 0 &&
      Number(snapshot.passedCount || 0) > 0 &&
      Number(snapshot.totalTests || 0) > 0 &&
      snapshot.gitSha !== sha &&
      snapshot.gitSha &&
      snapshot.gitSha !== "unknown"
  );
  if (!match?.gitSha) return null;
  return { sha: match.gitSha, reason: null };
};

const resolveAttachmentPath = (filePath: string | null | undefined) => {
  if (!filePath) return null;
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
};

const readAttachmentJson = <T>(result: PlaywrightResultShape | null | undefined, name: string) => {
  const attachment = (result?.attachments || []).find((item) => item?.name === name && item.path);
  const resolved = resolveAttachmentPath(attachment?.path);
  return resolved ? readJson<T>(resolved) : null;
};

const extractFocusLineFromSnippet = (snippet: string | null | undefined) => {
  if (!snippet) return null;
  const lines = snippet.split(/\r?\n/);
  const marked = lines.find((line) => /^\s*>\s*\d+\s*\|/.test(line));
  const preferred = marked || lines.find((line) => /\S/.test(line));
  if (!preferred) return null;
  return preferred
    .replace(/^\s*>\s*/, "")
    .replace(/^\s*\d+\s*\|\s*/, "")
    .trim() || null;
};

const extractFocusLineFromMessage = (message: string | null | undefined) => {
  if (!message) return null;
  const lines = stripAnsi(message).split(/\r?\n/);
  const marked = lines.find((line) => /^\s*>\s*\d+\s*\|/.test(line));
  if (marked) {
    return marked
      .replace(/^\s*>\s*/, "")
      .replace(/^\s*\d+\s*\|\s*/, "")
      .trim() || null;
  }
  const expectLine = lines.find((line) => /\b(await\s+)?expect\(/.test(line));
  if (expectLine) return expectLine.trim();
  const stepLine = lines.find((line) => /\b(getBy|locator\(|page\.)/.test(line));
  return stepLine?.trim() || null;
};

const parseCommitLine = (line: string): CommitCandidate | null => {
  const [sha, author, message] = line.split("\u001f");
  if (!sha) return null;
  const changedFilesRaw = gitOutput(["show", "--pretty=", "--name-only", sha]) || "";
  return {
    sha,
    author: author || "Unknown",
    message: message || "Recent commit",
    changedFiles: changedFilesRaw
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 80)
  };
};

const getCommitWindow = (limit = 24): CommitWindow => {
  const sha = currentSha();
  const lastPassing = getLastPassingSnapshot();
  const lastPassingSha = lastPassing?.sha || null;
  const pretty = `--pretty=format:%H%x1f%an%x1f%s`;
  if (!sha || !lastPassingSha || lastPassingSha === sha) {
    return { commits: [], trusted: false, reason: lastPassing?.reason || "no trusted last passing commit available yet" };
  }
  const mergeBase = gitOutput(["merge-base", lastPassingSha, sha]);
  if (!mergeBase || mergeBase !== lastPassingSha) {
    return { commits: [], trusted: false, reason: "local git history does not contain a safe pass-to-fail commit range" };
  }
  const log = gitOutput(["log", "--first-parent", "--ancestry-path", `${lastPassingSha}..${sha}`, pretty]) || "";
  const commits = log
    .split(/\r?\n/)
    .map((line) => parseCommitLine(line))
    .filter((value): value is CommitCandidate => Boolean(value))
    .slice(0, limit);
  if (!commits.length) {
    return { commits: [], trusted: false, reason: "no commits found between the last pass and current failure" };
  }
  return { commits, trusted: true, reason: null };
};

const normalizeStatus = (status: string | undefined | null) => {
  if (status === "failed" || status === "timedOut" || status === "interrupted") return "failed";
  if (status === "passed" || status === "flaky") return "passed";
  return "skipped";
};

const errorRichness = (error: PlaywrightErrorShape | null | undefined) => {
  if (!error) return -1;
  const message = String(error.message || error.stack || error.value || "");
  let score = message.length;
  if (error.location?.file) score += 200;
  if (/locator\.|Call log:|intercepts pointer events|waiting for|getBy|at .*:\d+:\d+/i.test(message)) score += 400;
  if (/Test timeout of \d+ms exceeded\.$/i.test(stripAnsi(message).trim())) score -= 300;
  return score;
};

const selectBestError = (result: PlaywrightResultShape) => {
  const candidates = [result.error, ...(result.errors || [])].filter(Boolean) as PlaywrightErrorShape[];
  if (!candidates.length) return null;
  return candidates.sort((a, b) => errorRichness(b) - errorRichness(a))[0] || null;
};

const toMessage = (result: PlaywrightResultShape) => {
  const best = selectBestError(result);
  return best ? stripAnsi(String(best.message || best.stack || best.value || "")) : "";
};

const classifySignal = (message: string): DiagnosisSignal => {
  const lower = message.toLowerCase();
  if (/browser has been closed|target page, context or browser has been closed|crash|page crashed|browser disconnected/.test(lower)) {
    return "infra";
  }
  if (/expected substring|expected string|received string|tohavetext|tocontaintext|tohavevalue|tobechecked/.test(lower)) {
    return "assertion_mismatch";
  }
  if (/timeout|timed out|waiting for/.test(lower)) return "timeout";
  if (/resolved to 0 elements|locator.*not found|never appeared|strict mode violation/.test(lower)) {
    return "locator_not_found";
  }
  if (/not visible|not enabled|not stable|intercepts pointer events|not actionable/.test(lower)) {
    return "actionability";
  }
  if (/status\s*[45]\d{2}|net::|failed to fetch|network|request failed|socket hang up|econnreset|503|502|500/.test(lower)) {
    return "network";
  }
  if (/simulated flaky retry|retry guard|flaky retry/.test(lower)) return "runtime";
  if (/^error:|\nerror:|typeerror|referenceerror|syntaxerror|unhandled/.test(lower)) return "runtime";
  return "unknown";
};

const extractLocator = (message: string) => {
  const locatorLine = message.match(/Locator:\s*(.+)/i);
  if (locatorLine?.[1]) return locatorLine[1].trim();
  const callLine = message.match(/(getByTestId|getByRole|getByText|locator)\([^)]+\)/);
  return callLine?.[0] || null;
};

const extractExpected = (message: string) => {
  const match =
    message.match(/Expected substring:\s*"([^"]+)"/i) ||
    message.match(/Expected string:\s*"([^"]+)"/i) ||
    message.match(/Expected:\s*"([^"]+)"/i);
  return match?.[1] || null;
};

const extractReceived = (message: string) => {
  const match =
    message.match(/Received string:\s*"([^"]+)"/i) ||
    message.match(/Received:\s*"([^"]+)"/i);
  return match?.[1] || null;
};

const extractTimeoutMs = (message: string) => {
  const match =
    message.match(/Timeout:\s*(\d+)\s*ms/i) ||
    message.match(/timeout(?: of)?\s*(\d+)\s*ms/i) ||
    message.match(/(\d+)\s*ms/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
};

const extractLastUrl = (message: string) => {
  const match = message.match(/https?:\/\/[^\s)"']+/i);
  return match?.[0] || null;
};

const extractApiHint = (message: string, codeContext: CodeContextCapture | null) => {
  if (codeContext?.apiCall) return codeContext.apiCall;
  const url = extractLastUrl(message);
  if (url) return url;
  const apiMatch = message.match(/\/(api|graphql|rest)\/[^\s)"']+/i);
  return apiMatch?.[0] || null;
};

const extractStackLocation = (message: string) => {
  const lines = stripAnsi(message).split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/((?:[A-Za-z]:)?[^:\n]+\.[cm]?[jt]sx?):(\d+):(\d+)/);
    if (!match) continue;
    const file = match[1]?.trim();
    if (!file || file.includes("node_modules")) continue;
    const lineNumber = Number(match[2]);
    const columnNumber = Number(match[3]);
    return {
      file,
      line: Number.isFinite(lineNumber) ? lineNumber : null,
      column: Number.isFinite(columnNumber) ? columnNumber : null
    };
  }
  return null;
};

const loadCodeContext = (result: PlaywrightResultShape | null | undefined) =>
  readAttachmentJson<CodeContextCapture>(result, "sentinel-code-context");

const loadDomCapture = (result: PlaywrightResultShape | null | undefined) =>
  readAttachmentJson<DomCapture>(result, "sentinel-dom-capture");

const inferLikelyFile = (file: string | null, codeContext: CodeContextCapture | null) => codeContext?.file || file || null;

const inferLikelyModule = (file: string | null, locator: string | null, codeContext: CodeContextCapture | null) => {
  const fileBase = basename(inferLikelyFile(file, codeContext));
  if (fileBase) return fileBase.replace(/\.(spec|test|e2e)?\.[cm]?[jt]sx?$/i, "");
  const locatorToken = (locator || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .find((token) => token.length >= 4);
  return locatorToken || null;
};

const describeDomState = (failure: FailureFacts) => {
  const dom = failure.domCapture;
  if (!dom) return null;
  if (dom.targetFound === false || dom.matchedCount === 0) {
    return failure.locator
      ? `${failure.locator} never appeared before the timeout`
      : "the expected target never appeared before the timeout";
  }
  if (dom.visible === false) {
    return failure.locator
      ? `${failure.locator} was found but stayed hidden before the timeout`
      : "the target was found but stayed hidden before the timeout";
  }
  if (dom.enabled === false) {
    return failure.locator
      ? `${failure.locator} was found but stayed disabled before the timeout`
      : "the target was found but stayed disabled before the timeout";
  }
  if (dom.targetFound === true && dom.visible === true && failure.codeContext?.action) {
    return failure.locator
      ? `${failure.codeContext.action} on ${failure.locator} never completed even though the target was present`
      : `${failure.codeContext.action} never completed even though the target was present`;
  }
  return null;
};

const dominantValue = (values: Array<string | null | undefined>) => {
  const counts = new Map<string, number>();
  for (const value of values) {
    const normalized = (value || "").trim();
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return null;
  return sorted[0][0];
};

const dominantFocusLine = (failures: FailureFacts[]) =>
  dominantValue(failures.map((failure) => failure.codeContext?.focusLine || null));

const timeoutState = (failure: FailureFacts): TimeoutClusterEvidence["state"] => {
  const dom = failure.domCapture;
  if (!dom) return "unknown";
  if (dom.targetFound === false || dom.matchedCount === 0) return "missing";
  if (dom.visible === false) return "hidden";
  if (dom.enabled === false) return "disabled";
  if (dom.targetFound === true && dom.visible === true) return "present";
  return "unknown";
};

const sharedTimeoutEvidence = (failures: FailureFacts[]): TimeoutClusterEvidence => {
  const timeoutFailures = failures.filter((failure) => failure.signal === "timeout");
  return {
    action: dominantValue(timeoutFailures.map((failure) => failure.codeContext?.action || null)),
    locator: dominantValue(timeoutFailures.map((failure) => failure.locator || null)),
    state: dominantValue(timeoutFailures.map((failure) => timeoutState(failure))) as TimeoutClusterEvidence["state"] || "unknown"
  };
};

const timeoutStateLabel = (state: TimeoutClusterEvidence["state"]) => {
  switch (state) {
    case "missing":
      return "locator never appeared";
    case "hidden":
      return "found but hidden";
    case "disabled":
      return "found but disabled";
    case "present":
      return "found and visible before timeout";
    default:
      return null;
  }
};

const buildTouchedFileReason = (label: string, files: string[]) => `${label}: ${files.slice(0, 2).map((file) => basename(file)).join(", ")}`;

const commitTouchedFailure = (commit: CommitCandidate, failure: FailureFacts): CommitMatch => {
  const reasons: string[] = [];
  const touchedFiles = new Set<string>();
  let score = 0;

  const likelyFileBase = basename(failure.likelyFile);
  const likelyDir = dirnameToken(failure.likelyFile);
  const likelyModule = (failure.likelyModule || "").toLowerCase();
  const locatorToken = (failure.locator || failure.domCapture?.testId || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .find((token) => token.length >= 4) || null;
  const apiToken = (failure.apiHint || "")
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9/]+/g, " ")
    .split(/[\s/]+/)
    .find((token) => token.length >= 4) || null;
  const titleToken = cleanTitleParts(failure.titlePath)
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .find((token) => token.length >= 4) || null;

  if (commit.sha === currentSha()) {
    score += 0.08;
    reasons.push("current failing commit");
  }

  const exactFileMatches = commit.changedFiles.filter((item) => basename(item) === likelyFileBase);
  if (exactFileMatches.length) {
    score += 0.42;
    exactFileMatches.forEach((file) => touchedFiles.add(file));
    reasons.push(buildTouchedFileReason("touches likely file", exactFileMatches));
  }

  const dirMatches = likelyDir ? commit.changedFiles.filter((item) => normalizePath(item).includes(`/${likelyDir}/`) || normalizePath(item).endsWith(`/${likelyDir}`)) : [];
  if (dirMatches.length) {
    score += 0.18;
    dirMatches.slice(0, 2).forEach((file) => touchedFiles.add(file));
    reasons.push(buildTouchedFileReason("touches same area", dirMatches));
  }

  const moduleMatches = likelyModule ? commit.changedFiles.filter((item) => normalizePath(item).includes(likelyModule)) : [];
  if (moduleMatches.length) {
    score += 0.16;
    moduleMatches.slice(0, 2).forEach((file) => touchedFiles.add(file));
    reasons.push(buildTouchedFileReason("overlaps likely module", moduleMatches));
  }

  const locatorMatches = locatorToken ? commit.changedFiles.filter((item) => normalizePath(item).includes(locatorToken)) : [];
  if (locatorMatches.length) {
    score += 0.22;
    locatorMatches.slice(0, 2).forEach((file) => touchedFiles.add(file));
    reasons.push(buildTouchedFileReason(`overlaps selector token (${locatorToken})`, locatorMatches));
  }

  const apiMatches = apiToken ? commit.changedFiles.filter((item) => normalizePath(item).includes(apiToken)) : [];
  if (apiMatches.length) {
    score += 0.24;
    apiMatches.slice(0, 2).forEach((file) => touchedFiles.add(file));
    reasons.push(buildTouchedFileReason(`overlaps API token (${apiToken})`, apiMatches));
  }

  if (locatorToken && commit.message.toLowerCase().includes(locatorToken)) {
    score += 0.12;
    reasons.push("commit message overlaps the failing selector");
  }
  if (apiToken && commit.message.toLowerCase().includes(apiToken)) {
    score += 0.12;
    reasons.push("commit message overlaps the failing API");
  }
  if (titleToken && commit.changedFiles.some((item) => normalizePath(item).includes(titleToken))) {
    score += 0.12;
    reasons.push(`changed file overlaps the failing flow (${titleToken})`);
  }
  if (failure.signal === "network" && /api|request|fetch|backend|service|latency|timeout/i.test(commit.message)) {
    score += 0.14;
    reasons.push("commit message points to backend or network changes");
  }
  if (["assertion_mismatch", "locator_not_found", "actionability"].includes(failure.signal) && /ui|button|modal|page|auth|login|checkout|selector|form/i.test(commit.message)) {
    score += 0.14;
    reasons.push("commit message points to the failing UI flow");
  }
  if (failure.signal === "infra" && /browser|playwright|infra|ci|worker|build|docker|image/i.test(commit.message)) {
    score += 0.16;
    reasons.push("commit message points to CI or browser infrastructure changes");
  }

  return {
    commit,
    score,
    reasons: Array.from(new Set(reasons)).slice(0, 3),
    touchedFiles: Array.from(touchedFiles).slice(0, 3)
  };
};

const rankCommitsForFailure = (failure: FailureFacts, window: CommitWindow) =>
  window.commits
    .map((commit) => commitTouchedFailure(commit, failure))
    .filter((entry) => entry.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

const flattenFailedCases = (node: PlaywrightNode, titlePath: string[] = []): FailureFacts[] => {
  const currentTitlePath = node.title ? [...titlePath, node.title] : titlePath;
  const failures: FailureFacts[] = [];

  for (const child of node.suites || []) failures.push(...flattenFailedCases(child, currentTitlePath));
  for (const child of node.specs || []) failures.push(...flattenFailedCases(child, currentTitlePath));

  for (const test of node.tests || []) {
    const results = Array.isArray(test.results) ? test.results : [];
    const finalResult = results[results.length - 1];
    if (!finalResult) continue;
    const finalStatus = normalizeStatus(finalResult.status);
    if (finalStatus !== "failed") continue;
    const message = toMessage(finalResult);
    const titleParts = cleanTitleParts([...currentTitlePath, test.title || "Unnamed test"]);
    failures.push(
      parseFailureFacts(titleParts.join(" > "), titleParts, message, "failed", node.file || node.location?.file || test.location?.file || null, {
        projectName: test.projectName || null,
        timeoutBudgetMs: typeof test.timeout === "number" ? test.timeout : null,
        codeContext: loadCodeContext(finalResult),
        domCapture: loadDomCapture(finalResult),
        errorLocation:
          selectBestError(finalResult)?.location ||
          finalResult.error?.location ||
          finalResult.errors?.find((item) => item?.location)?.location ||
          test.location ||
          null,
        errorSnippet: (selectBestError(finalResult) as any)?.snippet || (finalResult.error as any)?.snippet || null
      })
    );
  }

  return failures;
};

const checkFirst = (failure: FailureFacts) => {
  if (failure.signal === "runtime" && /retry|flaky/i.test(failure.message)) {
    const file = basename(failure.codeContext?.file || failure.likelyFile);
    const line = failure.codeContext?.line;
    if (file && line) {
      return `inspect the throw at ${file}:${line} before opening the trace`;
    }
    if (failure.codeContext?.focusLine) {
      return `inspect ${failure.codeContext.focusLine.trim()} before opening the trace`;
    }
    return "inspect the shared retry or flaky helper before opening the trace";
  }
  if (failure.signal === "infra") {
    return "inspect the browser crash or CI worker logs before digging into the test code";
  }
  if (failure.signal === "network") {
    return failure.apiHint ? `inspect ${failure.apiHint}` : "inspect the failing request and backend response";
  }
  if (failure.signal === "timeout" && failure.codeContext?.action) {
    if (failure.locator && failure.domCapture?.targetFound === false) {
      return `inspect why ${failure.locator} never appeared before the ${failure.codeContext.action}`;
    }
    if (failure.locator && failure.domCapture?.visible === false) {
      return `inspect why ${failure.locator} stayed hidden before the ${failure.codeContext.action}`;
    }
    if (failure.locator && failure.domCapture?.enabled === false) {
      return `inspect why ${failure.locator} stayed disabled before the ${failure.codeContext.action}`;
    }
    if (failure.locator && failure.domCapture?.targetFound === true && failure.domCapture?.visible === true) {
      return `inspect what blocked ${failure.codeContext.action} on ${failure.locator} (overlay or pointer interception is likely)`;
    }
    return `inspect the blocked ${failure.codeContext.action} step before the timeout`;
  }
  if (failure.locator) return `verify ${failure.locator}`;
  if (failure.codeContext?.focusLine) return `inspect ${failure.codeContext.focusLine.trim()}`;
  if (failure.likelyFile) return `inspect ${basename(failure.likelyFile)}`;
  return "open the failing trace step";
};

const confidenceLabel = (score: number) => {
  if (score >= 0.62) return "High";
  if (score >= 0.34) return "Medium";
  return "Low";
};

const compactCommitLine = (match: CommitMatch | undefined) => {
  if (!match) return null;
  return `Suspected commit: ${match.commit.sha.slice(0, 7)} "${match.commit.message}"`;
};

const compactWhyLine = (match: CommitMatch | undefined) => {
  if (!match?.reasons.length) return null;
  return match.reasons.join("; ");
};

const alternateCommitLine = (match: CommitMatch | undefined) => {
  if (!match) return null;
  return `Also changed: ${match.commit.sha.slice(0, 7)} "${match.commit.message}"`;
};

const rootCauseLabel = (failure: FailureFacts) => {
  switch (failure.signal) {
    case "assertion_mismatch":
      return "UI assertion mismatch";
    case "locator_not_found":
      return "Locator or render regression";
    case "actionability":
      return "Actionability regression";
    case "network":
      return "Backend or network failure";
    case "runtime":
      return /retry|flaky/i.test(failure.message) ? "Same test-side throw before the app flow completed" : "Runtime error during the flow";
    case "timeout":
      return "Timeout waiting for state change";
    case "infra":
      return "Browser or CI infrastructure failure";
    default:
      return "Failure pattern";
  }
};

export const describeFailure = (failure: FailureFacts) => {
  if (failure.signal === "assertion_mismatch" && failure.locator && failure.expected && failure.received) {
    return `${compactLocator(failure.locator)} showed "${truncateValue(failure.received, 72)}" instead of "${truncateValue(failure.expected, 40)}".`;
  }
  if (failure.signal === "locator_not_found" && failure.locator) {
    return `${compactLocator(failure.locator)} was not found when the test expected it to be available.`;
  }
  if (failure.signal === "actionability" && failure.locator) {
    return `${compactLocator(failure.locator)} was found but was not actionable when the interaction ran.`;
  }
  if (failure.signal === "network") {
    return failure.apiHint
      ? `A network or API request around ${failure.apiHint} did not complete successfully.`
      : `A network or API request did not complete successfully.`;
  }
  if (failure.signal === "timeout") {
    const domState = describeDomState(failure);
    if (domState) return `${domState}.`;
    return failure.timeoutMs
      ? `The expected UI or network condition did not complete before the ${failure.timeoutMs}ms timeout.`
      : `The expected UI or network condition did not complete before timeout.`;
  }
  if (failure.signal === "runtime" && /retry|flaky/i.test(failure.message)) {
    return `The test code threw a retry or flaky guard error before the app flow completed.`;
  }
  if (failure.signal === "runtime") {
    return `A runtime error interrupted the test flow before the expected state was reached.`;
  }
  if (failure.signal === "infra") {
    return `The test failed because the browser or CI worker became unstable before the flow completed.`;
  }
  return `The failure signal could not be classified cleanly from the captured error.`;
};

const describeCluster = (cluster: FailureCluster) => {
  const failure = cluster.sample;
  if (failure.signal === "runtime" && /retry|flaky/i.test(failure.message)) {
    const location = buildLocationLine(failure);
    const origin = location ? ` The same helper threw at ${location.replace(/^Error location: /, '').replace(/^Likely file: /, '')}.` : "";
    return `${cluster.count} tests hit the same test-side throw before the app flow completed.${origin}`;
  }
  if (cluster.count > 1 && failure.signal === "assertion_mismatch") {
    return `${cluster.count} tests hit the same UI assertion mismatch, which usually means one shared UI regression.`;
  }
  if (cluster.count > 1 && failure.signal === "network") {
    return `${cluster.count} tests failed behind the same network or API signal.`;
  }
  if (cluster.count > 1 && failure.signal === "timeout") {
    const evidence = sharedTimeoutEvidence(cluster.failures);
    const action = evidence.action ? evidence.action.trim() : "the expected interaction";
    const locator = evidence.locator ? compactLocator(evidence.locator) : "the target element";
    if (evidence.state === "missing") {
      return `${cluster.count} tests timed out because ${locator} never appeared before ${action}.`;
    }
    if (evidence.state === "hidden") {
      return `${cluster.count} tests timed out because ${locator} stayed hidden and blocked ${action}.`;
    }
    if (evidence.state === "disabled") {
      return `${cluster.count} tests timed out because ${locator} stayed disabled and blocked ${action}.`;
    }
    if (evidence.state === "present" && evidence.action) {
      return `${cluster.count} tests timed out because ${action} on ${locator} never completed even though the target was present.`;
    }
    if (evidence.action && evidence.locator) {
      return `${cluster.count} tests timed out on the same ${action} step for ${locator}.`;
    }
    return `${cluster.count} tests timed out while waiting for the same UI state change to complete.`;
  }
  if (cluster.count > 1 && failure.signal === "infra") {
    return `${cluster.count} tests failed behind the same browser or CI instability signal.`;
  }
  return describeFailure(failure);
};

const clusterCheckFirst = (cluster: FailureCluster) => {
  const failure = cluster.sample;
  if (failure.signal === "runtime" && /retry|flaky/i.test(failure.message)) {
    const file = basename(failure.codeContext?.file || failure.likelyFile);
    const line = failure.codeContext?.line;
    if (file && line) {
      return `inspect the throw at ${file}:${line} before opening the trace`;
    }
    return "inspect the shared retry/flaky helper or intentional throw in these tests before opening the trace";
  }
  if (failure.signal === "timeout") {
    const evidence = sharedTimeoutEvidence(cluster.failures);
    const locator = evidence.locator ? compactLocator(evidence.locator) : "the target element";
    if (evidence.state === "missing") {
      return `make ${locator} render before the blocked step`;
    }
    if (evidence.state === "hidden") {
      return `remove the condition keeping ${locator} hidden before the action`;
    }
    if (evidence.state === "disabled") {
      return `enable ${locator} before the action runs`;
    }
    if (evidence.state === "present" && evidence.action && evidence.locator) {
      return `fix what blocks ${evidence.action} on ${compactLocator(evidence.locator)} (overlay or pointer interception is likely)`;
    }
    if (failure.codeContext?.focusLine) {
      return `inspect the waiting assertion or step: ${failure.codeContext.focusLine.trim()}`;
    }
    if (failure.likelyFile) {
      return `inspect the waiting assertion or blocked state transition in ${basename(failure.likelyFile)}`;
    }
  }
  return checkFirst(failure);
};

const buildClusterEvidenceLines = (cluster: FailureCluster) => {
  const failure = cluster.sample;
  const lines: string[] = [];
  if (failure.signal === "timeout") {
    const evidence = sharedTimeoutEvidence(cluster.failures);
    const focusLine = dominantFocusLine(cluster.failures);
    if (focusLine) lines.push(`Failing code: ${focusLine.trim()}`);
    if (evidence.action) lines.push(`Failing step: ${evidence.action}`);
    if (evidence.locator) lines.push(`Selector: ${compactLocator(evidence.locator)}`);
    const stateLabel = timeoutStateLabel(evidence.state);
    if (stateLabel) lines.push(`Target state: ${stateLabel}`);
    return lines.slice(0, 4);
  }
  const focusLine = dominantFocusLine(cluster.failures);
  if (focusLine) lines.push(`Failing code: ${focusLine.trim()}`);
  for (const line of buildSecondaryEvidenceLines(failure)) {
    if (lines.includes(line)) continue;
    lines.push(line);
  }
  return lines.slice(0, 4);
};

const formatAffectedTests = (titles: string[]) => {
  const unique = Array.from(new Set(titles.map((title) => shortenTitle(title)))).slice(0, 3);
  if (!unique.length) return null;
  return `Affected tests: ${unique.join("; ")}`;
};

const buildLocationLine = (failure: FailureFacts) => {
  const file = failure.codeContext?.file || failure.likelyFile;
  const line = failure.codeContext?.line;
  const column = failure.codeContext?.column;
  if (!file) return null;
  if (line && column) return `Error location: ${basename(file)}:${line}:${column}`;
  if (line) return `Error location: ${basename(file)}:${line}`;
  return `Likely file: ${basename(file)}`;
};


const compactLocation = (failure: FailureFacts) => {
  const file = failure.codeContext?.file || failure.likelyFile;
  const line = failure.codeContext?.line;
  if (!file) return null;
  return line ? `${basename(file)}:${line}` : basename(file);
};

const buildClusterLocationLine = (failures: FailureFacts[]) => {
  const locations = Array.from(new Set(failures.map((failure) => compactLocation(failure)).filter(Boolean))) as string[];
  if (!locations.length) return null;
  const label = locations.length > 1 ? 'Error locations' : 'Error location';
  return `${label}: ${locations.slice(0, 3).join('; ')}`;
};

const buildEvidenceLines = (failure: FailureFacts) => {
  const lines: string[] = [];
  const locationLine = buildLocationLine(failure);
  if (locationLine) lines.push(locationLine);
  if (failure.codeContext?.focusLine) lines.push(`Failing code: ${failure.codeContext.focusLine.trim()}`);
  if (failure.codeContext?.action) lines.push(`Failing step: ${failure.codeContext.action}`);
  if (failure.locator) lines.push(`Selector: ${failure.locator}`);
  if (failure.signal === "timeout" && failure.domCapture) {
    if (failure.domCapture.targetFound === false || failure.domCapture.matchedCount === 0) {
      lines.push(`Target state: locator never appeared`);
    } else if (failure.domCapture.visible === false) {
      lines.push(`Target state: found but hidden`);
    } else if (failure.domCapture.enabled === false) {
      lines.push(`Target state: found but disabled`);
    } else if (failure.domCapture.targetFound === true && failure.domCapture.visible === true) {
      lines.push(`Target state: found and visible before timeout`);
    }
  }
  if (failure.apiHint) lines.push(`API: ${failure.apiHint}`);
  return lines.slice(0, 4);
};


const withoutPrefix = (value: string, prefix: string) =>
  value.startsWith(prefix) ? value.slice(prefix.length).trim() : value;

const truncateValue = (value: string | null | undefined, max = 96) => {
  if (!value) return null;
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
};

const compactLocator = (value: string | null | undefined) => {
  const compact = truncateValue(value, 40);
  return compact || "target element";
};

const buildSecondaryEvidenceLines = (failure: FailureFacts) =>
  buildEvidenceLines(failure)
    .filter((line) => !line.startsWith("Error location:") && !line.startsWith("Likely file:"))
    .slice(0, 3);


const compactRootCauseSummary = (cluster: FailureCluster) => {
  const failure = cluster.sample;
  if (failure.signal === "runtime" && /retry|flaky/i.test(failure.message)) {
    return "Same test-side throw before the app flow completed";
  }
  if (failure.signal === "network") {
    return failure.apiHint
      ? `Same network/API failure around ${failure.apiHint}`
      : "Same network/API failure across these tests";
  }
  if (failure.signal === "timeout") {
    return "Same blocked state transition timed out across these tests";
  }
  if (failure.signal === "assertion_mismatch") {
    return "Same UI assertion mismatch across these tests";
  }
  if (failure.signal === "locator_not_found") {
    return "Same missing or changed locator across these tests";
  }
  if (failure.signal === "actionability") {
    return "Same element actionability problem across these tests";
  }
  if (failure.signal === "infra") {
    return "Same browser/CI instability affected these tests";
  }
  return describeCluster(cluster);
};

const compactIssueTitle = (cluster: FailureCluster) => {
  const failure = cluster.sample;
  const locator = compactLocator(failure.locator);
  switch (failure.signal) {
    case "assertion_mismatch":
      return failure.locator ? `Assertion mismatch (${locator})` : "Assertion mismatch";
    case "locator_not_found":
      return failure.locator ? `Missing locator (${locator})` : "Missing locator";
    case "actionability":
      return failure.locator ? `Blocked interaction (${locator})` : "Blocked interaction";
    case "network":
      return failure.apiHint ? `Network/API failure (${truncateValue(failure.apiHint, 28)})` : "Network/API failure";
    case "timeout":
      return failure.locator ? `Timeout waiting on ${locator}` : "Timeout waiting for state change";
    case "runtime":
      return /retry|flaky/i.test(failure.message) ? "Test-side throw" : "Runtime error";
    case "infra":
      return "Browser/CI instability";
    default:
      return rootCauseLabel(failure);
  }
};

const clusterCauseLine = (cluster: FailureCluster) => {
  const failure = cluster.sample;
  if (failure.signal === "assertion_mismatch") {
    return failure.locator
      ? `Same assertion mismatch on ${compactLocator(failure.locator)}`
      : "Same assertion mismatch across these tests";
  }
  if (failure.signal === "locator_not_found") {
    return failure.locator
      ? `${compactLocator(failure.locator)} is missing or changed in each failure`
      : "Same missing or changed locator across these tests";
  }
  if (failure.signal === "actionability") {
    return failure.locator
      ? `${compactLocator(failure.locator)} is present but blocked in each failure`
      : "Same actionability problem across these tests";
  }
  return compactRootCauseSummary(cluster);
};

const strongerClusterNext = (cluster: FailureCluster) => {
  const failure = cluster.sample;
  if (failure.signal === "assertion_mismatch") {
    if (failure.locator && failure.apiHint) {
      return `check ${compactLocator(failure.locator)} or the data returned by ${truncateValue(failure.apiHint, 36)}`;
    }
    if (failure.locator) {
      return `check ${compactLocator(failure.locator)} or the data source behind it`;
    }
  }
  if (failure.signal === "locator_not_found" && failure.locator) {
    return `check whether ${compactLocator(failure.locator)} changed or no longer renders`;
  }
  if (failure.signal === "actionability" && failure.locator) {
    return `check what blocks ${compactLocator(failure.locator)} from becoming actionable`;
  }
  return clusterCheckFirst(cluster);
};

const compactErrorLine = (failure: FailureFacts) => {
  if (!failure.firstErrorLine) return null;
  return withoutPrefix(failure.firstErrorLine, "Error:");
};

export const parseFailureFacts = (
  title: string,
  titlePath: string[],
  message: string,
  status: string,
  file: string | null = null,
  options?: {
    projectName?: string | null;
    timeoutBudgetMs?: number | null;
    codeContext?: CodeContextCapture | null;
    domCapture?: DomCapture | null;
    errorLocation?: { file?: string | null; line?: number | null; column?: number | null } | null;
    errorSnippet?: string | null;
  }
): FailureFacts => {
  const signal = classifySignal(message);
  const fallbackLocation = options?.errorLocation || extractStackLocation(message);
  const fallbackCodeContext: CodeContextCapture | null = fallbackLocation || options?.errorSnippet
    ? {
        file: fallbackLocation?.file || file || null,
        line: typeof fallbackLocation?.line === "number" ? fallbackLocation.line : null,
        column: typeof fallbackLocation?.column === "number" ? fallbackLocation.column : null,
        action: null,
        locator: null,
        expectedText: null,
        timeoutMs: null,
        apiCall: null,
        assertion: null,
        methodName: null,
        focusLine: extractFocusLineFromSnippet(options?.errorSnippet),
        previousActionLine: null,
        found: Boolean(fallbackLocation?.file || options?.errorSnippet)
      }
    : null;
  const codeContext: CodeContextCapture | null = options?.codeContext
    ? {
        ...fallbackCodeContext,
        ...options.codeContext,
        file: options.codeContext.file || fallbackCodeContext?.file || null,
        line: options.codeContext.line ?? fallbackCodeContext?.line ?? null,
        column: options.codeContext.column ?? fallbackCodeContext?.column ?? null,
        focusLine: options.codeContext.focusLine || fallbackCodeContext?.focusLine || extractFocusLineFromMessage(message) || null,
        found: options.codeContext.found ?? fallbackCodeContext?.found ?? false
      }
    : fallbackCodeContext
      ? {
          ...fallbackCodeContext,
          focusLine: fallbackCodeContext.focusLine || extractFocusLineFromMessage(message) || null
        }
      : {
          file: fallbackLocation?.file || file || null,
          line: typeof fallbackLocation?.line === "number" ? fallbackLocation.line : null,
          column: typeof fallbackLocation?.column === "number" ? fallbackLocation.column : null,
          action: null,
          locator: null,
          expectedText: null,
          timeoutMs: null,
          apiCall: null,
          assertion: null,
          methodName: null,
          focusLine: extractFocusLineFromMessage(message),
          previousActionLine: null,
          found: Boolean(fallbackLocation?.file || extractFocusLineFromMessage(message))
        };
  const domCapture = options?.domCapture || null;
  const locator = extractLocator(message) || codeContext?.locator || domCapture?.locator || null;
  const expected = extractExpected(message) || codeContext?.expectedText || domCapture?.expectedText || null;
  const received = extractReceived(message) || domCapture?.observedText || domCapture?.textContent || null;
  const likelyFile = inferLikelyFile(file, codeContext);
  const likelyModule = inferLikelyModule(file, locator, codeContext);
  const apiHint = extractApiHint(message, codeContext);
  return {
    title,
    titlePath,
    projectName: options?.projectName || null,
    message,
    firstErrorLine: stripAnsi(message).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null,
    signal,
    locator,
    expected,
    received,
    timeoutMs: extractTimeoutMs(message) || codeContext?.timeoutMs || options?.timeoutBudgetMs || null,
    timeoutBudgetMs: options?.timeoutBudgetMs || codeContext?.timeoutMs || null,
    lastUrl: extractLastUrl(message),
    status,
    file,
    likelyFile,
    likelyModule,
    apiHint,
    codeContext,
    domCapture
  };
};

export const collectFailureFacts = (playwrightJsonPath: string): FailureFacts[] => {
  if (!fs.existsSync(playwrightJsonPath)) return [];
  try {
    const raw = fs.readFileSync(playwrightJsonPath, "utf8");
    const parsed = JSON.parse(raw) as PlaywrightNode;
    return flattenFailedCases(parsed);
  } catch {
    return [];
  }
};

export const buildDebugSummary = (failure: FailureFacts) => {
  const lines = [`Test: ${failure.title}`, `Diagnosis: ${describeFailure(failure)}`];
  for (const line of buildEvidenceLines(failure)) lines.push(line);
  if (failure.expected) lines.push(`Expected: ${failure.expected}`);
  if (failure.received) lines.push(`Observed: ${failure.received}`);
  if (failure.timeoutMs) lines.push(`Timeout: ${failure.timeoutMs}ms`);
  return lines.join("\n");
};

export const buildSimilarityKey = (failure: FailureFacts) => {
  const locationKey = failure.codeContext?.line ? `${basename(failure.codeContext.file)}:${failure.codeContext.line}` : basename(failure.likelyFile) || "unknown-file";
  if (failure.signal === 'runtime' || failure.signal === 'unknown') {
    return [
      failure.signal,
      normalizeMessageFingerprint(failure.message),
      locationKey
    ].join('|');
  }
  if (failure.signal === "assertion_mismatch") {
    return [
      failure.signal,
      failure.locator || failure.likelyModule || basename(failure.likelyFile) || "unknown-target",
      basename(failure.likelyFile) || "unknown-file"
    ].join("|");
  }
  if (failure.signal === "timeout" || failure.signal === "actionability" || failure.signal === "locator_not_found") {
    return [
      failure.signal,
      failure.locator || failure.codeContext?.action || failure.likelyModule || "unknown-target",
      basename(failure.likelyFile) || "unknown-file"
    ].join("|");
  }
  if (failure.signal === "network") {
    return [
      failure.signal,
      failure.apiHint || failure.likelyModule || "unknown-api",
      basename(failure.likelyFile) || "unknown-file"
    ].join("|");
  }
  if (failure.locator || failure.expected || failure.received || failure.apiHint) {
    return [
      failure.signal,
      failure.locator || failure.apiHint || "unknown-target",
      failure.expected || "unknown-expected",
      failure.received || "unknown-received",
      locationKey
    ].join("|");
  }
  return `${failure.signal}|${normalizeMessageFingerprint(failure.message)}|${locationKey}`;
};

export const summarizeSignal = (signal: DiagnosisSignal) => {
  switch (signal) {
    case "timeout":
      return "timeout while waiting for UI or network conditions";
    case "assertion_mismatch":
      return "assertion mismatch between expected and rendered UI state";
    case "locator_not_found":
      return "missing or changed locator";
    case "actionability":
      return "target element was not actionable";
    case "network":
      return "network or API failure";
    case "runtime":
      return "runtime error thrown before the flow completed";
    case "infra":
      return "browser or CI infrastructure failure";
    default:
      return "failure signal could not be classified cleanly";
  }
};

const buildClusterSuspects = (clusterFailures: FailureFacts[], window: CommitWindow) => {
  return window.commits
    .map((commit) => {
      const combined = clusterFailures.map((failure) => commitTouchedFailure(commit, failure));
      const score = combined.reduce((sum, item) => sum + item.score, 0);
      const reasons = Array.from(new Set(combined.flatMap((item) => item.reasons))).slice(0, 3);
      const touchedFiles = Array.from(new Set(combined.flatMap((item) => item.touchedFiles))).slice(0, 3);
      return { commit, score, reasons, touchedFiles } satisfies CommitMatch;
    })
    .filter((entry) => entry.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
};

export const buildQuickDiagnosis = (playwrightJsonPath: string): QuickDiagnosis | null => {
  const failures = collectFailureFacts(playwrightJsonPath);
  if (!failures.length) return null;
  const commitWindow = getCommitWindow();

  if (failures.length === 1) {
    const failed = failures[0];
    const suspects = commitWindow.trusted ? rankCommitsForFailure(failed, commitWindow) : [];
    const top = suspects[0];
    const lines = [`What broke: ${shortenTitle(failed.title)}`, `Why: ${describeFailure(failed)}`];
    const primaryLocation = buildLocationLine(failed);
    const confidence = top ? confidenceLabel(top.score).toLowerCase() : "medium";
    if (primaryLocation) lines.push(`Where: ${withoutPrefix(withoutPrefix(primaryLocation, "Error location:"), "Likely file:")}`);
    if (failed.codeContext?.action) lines.push(`Failing step: ${failed.codeContext.action}`);
    if (failed.expected) lines.push(`Expected: ${truncateValue(failed.expected)}`);
    if (failed.received) lines.push(`Received: ${truncateValue(failed.received)}`);
    if (top && top.score >= 0.62) {
      lines.push(`What changed: "${top.commit.message}"`);
      if (top.reasons.length) {
        lines.push(`Reason: ${compactWhyLine(top)}.`);
      }
    }
    lines.push(`Confidence: ${confidence}`);
    lines.push("Next:");
    lines.push(`- ${checkFirst(failed)}`);
    return {
      lines,
      footer: []
    };
  }


  const clusterMap = new Map<string, FailureFacts[]>();
  for (const failure of failures) {
    const key = buildSimilarityKey(failure);
    const bucket = clusterMap.get(key) || [];
    bucket.push(failure);
    clusterMap.set(key, bucket);
  }

  const clusters: FailureCluster[] = Array.from(clusterMap.entries())
    .map(([key, clusterFailures]) => ({
      key,
      count: clusterFailures.length,
      sample: clusterFailures[0],
      titles: clusterFailures.map((item) => item.title),
      suspects: commitWindow.trusted ? buildClusterSuspects(clusterFailures, commitWindow) : [],
      failures: clusterFailures
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        ((b.suspects[0]?.score || 0) - (a.suspects[0]?.score || 0)) ||
        (b.sample.signal === "assertion_mismatch" ? 1 : 0) - (a.sample.signal === "assertion_mismatch" ? 1 : 0)
    )
    .slice(0, 2);

  const topCluster = clusters[0];
  const lines = [
    `${failures.length} tests failed`,
    `Collapsed into ${clusters.length} real issue${clusters.length === 1 ? "" : "s"}`
  ];

  for (const [index, cluster] of clusters.entries()) {
    const clusterFailures = clusterMap.get(cluster.key) || [cluster.sample];
    const clusterLocation = buildClusterLocationLine(clusterFailures);
    const top = cluster.suspects[0];
    const locationValue = clusterLocation
      ? withoutPrefix(clusterLocation, clusterLocation.startsWith("Error locations:") ? "Error locations:" : "Error location:")
      : null;
    const rootCause = cluster.count === 1 ? describeFailure(cluster.sample) : clusterCauseLine(cluster);
    lines.push(`Issue ${index + 1}: ${compactIssueTitle(cluster)} (${cluster.count} test${cluster.count === 1 ? "" : "s"})`);
    lines.push(`  Cause: ${rootCause}`);
    if (locationValue) {
      lines.push(`  Where: ${locationValue}`);
    }
    for (const evidenceLine of buildClusterEvidenceLines(cluster)) {
      lines.push(`  ${evidenceLine}`);
    }
    if (cluster.sample.expected) {
      lines.push(`  Expected: ${truncateValue(cluster.sample.expected)}`);
    }
    if (cluster.sample.received) {
      lines.push(`  Received: ${truncateValue(cluster.sample.received)}`);
    }
    if (top && top.score >= 0.62) {
      lines.push(`  What changed: "${top.commit.message}"`);
      if (top.reasons.length) {
        lines.push(`  Reason: ${compactWhyLine(top)}.`);
      }
    }
    lines.push(`  Next: ${strongerClusterNext(cluster)}.`);
    lines.push(`  Impact: ${cluster.count} test${cluster.count === 1 ? "" : "s"} failing with ${cluster.count === 1 ? "this" : "same"} root cause`);
    lines.push(`  Clears: fixing this likely clears ${cluster.count} of ${failures.length} failures`);
    if (index < clusters.length - 1) lines.push("");
  }


  return {
    lines,
    footer: topCluster?.suspects[0] ? [`Confidence: ${confidenceLabel(topCluster.suspects[0].score).toLowerCase()}`] : []
  };
};
