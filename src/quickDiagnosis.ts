import fs from "node:fs";

type PlaywrightErrorShape = {
  message?: string | null;
  stack?: string | null;
  value?: string | null;
};

type PlaywrightResultShape = {
  status?: string;
  error?: PlaywrightErrorShape | null;
  errors?: PlaywrightErrorShape[] | null;
};

type PlaywrightTestShape = {
  title?: string;
  results?: PlaywrightResultShape[] | null;
};

type PlaywrightNode = {
  title?: string;
  specs?: PlaywrightNode[] | null;
  tests?: PlaywrightTestShape[] | null;
  suites?: PlaywrightNode[] | null;
};

type FailedCase = {
  title: string;
  message: string;
  signal: DiagnosisSignal;
};

type DiagnosisSignal =
  | "timeout"
  | "assertion_mismatch"
  | "locator_not_found"
  | "actionability"
  | "network"
  | "runtime"
  | "unknown";

type QuickDiagnosis = {
  lines: string[];
};

export type FailureFacts = {
  title: string;
  titlePath: string[];
  message: string;
  signal: DiagnosisSignal;
  locator: string | null;
  expected: string | null;
  received: string | null;
  timeoutMs: number | null;
  lastUrl: string | null;
  status: string;
};

const normalizeMessageFingerprint = (message: string) =>
  stripAnsi(message)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ")
    .replace(/\b\d+ms\b/gi, "<ms>")
    .replace(/:\d+:\d+/g, ":<line>:<col>")
    .replace(/\s+/g, " ")
    .slice(0, 200);

const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, "");

const toMessage = (result: PlaywrightResultShape) => {
  const direct =
    result.error?.message ||
    result.error?.stack ||
    result.error?.value ||
    null;
  if (direct) return stripAnsi(String(direct));
  const first = result.errors?.find(Boolean);
  return first ? stripAnsi(String(first.message || first.stack || first.value || "")) : "";
};

const classifySignal = (message: string): DiagnosisSignal => {
  const lower = message.toLowerCase();
  if (/expected substring|expected string|received string|tohavetext|tocontaintext/.test(lower)) {
    return "assertion_mismatch";
  }
  if (/timeout|timed out|waiting for/.test(lower)) return "timeout";
  if (/resolved to 0 elements|locator.*not found|never appeared|strict mode violation/.test(lower)) {
    return "locator_not_found";
  }
  if (/not visible|not enabled|not stable|intercepts pointer events|not actionable/.test(lower)) {
    return "actionability";
  }
  if (/status\s*[45]\d{2}|net::|failed to fetch|network|request failed/.test(lower)) {
    return "network";
  }
  if (/typeerror|referenceerror|syntaxerror|unhandled/.test(lower)) return "runtime";
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

const signalSummary = (signal: DiagnosisSignal) => {
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
      return "frontend runtime error";
    default:
      return "failure signal could not be classified cleanly";
  }
};

const flattenFailedCases = (node: PlaywrightNode, titlePath: string[] = []): FailedCase[] => {
  const currentTitlePath = node.title ? [...titlePath, node.title] : titlePath;
  const failedCases: FailedCase[] = [];

  for (const test of node.tests || []) {
    const title = [...currentTitlePath, test.title || "Unnamed test"].join(" > ");
    for (const result of test.results || []) {
      if (!["failed", "timedOut", "interrupted"].includes(result.status || "")) continue;
      const message = toMessage(result);
      failedCases.push({
        title,
        message,
        signal: classifySignal(message)
      });
    }
  }

  for (const child of node.specs || []) {
    failedCases.push(...flattenFailedCases(child, currentTitlePath));
  }
  for (const child of node.suites || []) {
    failedCases.push(...flattenFailedCases(child, currentTitlePath));
  }

  return failedCases;
};

const shortenTitle = (value: string) => {
  const parts = value.split(" > ").filter(Boolean);
  return parts[parts.length - 1] || value;
};

export const collectFailureFacts = (
  playwrightJsonPath: string
): FailureFacts[] => {
  if (!fs.existsSync(playwrightJsonPath)) return [];
  try {
    const raw = fs.readFileSync(playwrightJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    const failedCases = flattenFailedCases(parsed as PlaywrightNode);
    return failedCases.map((failed) =>
      parseFailureFacts(
        shortenTitle(failed.title),
        failed.title.split(" > ").filter(Boolean),
        failed.message,
        "failed"
      )
    );
  } catch {
    return [];
  }
};

export const parseFailureFacts = (
  title: string,
  titlePath: string[],
  message: string,
  status: string
): FailureFacts => ({
  title,
  titlePath,
  message,
  signal: classifySignal(message),
  locator: extractLocator(message),
  expected: extractExpected(message),
  received: extractReceived(message),
  timeoutMs: extractTimeoutMs(message),
  lastUrl: extractLastUrl(message),
  status
});

export const describeFailure = (failure: FailureFacts) => {
  if (failure.signal === "assertion_mismatch" && failure.locator && failure.expected && failure.received) {
    return `${failure.locator} showed "${failure.received}" instead of "${failure.expected}" before timeout.`;
  }
  if (failure.signal === "locator_not_found" && failure.locator) {
    return `${failure.locator} was not found when the test expected it to be available.`;
  }
  if (failure.signal === "actionability" && failure.locator) {
    return `${failure.locator} was found but was not actionable when the interaction ran.`;
  }
  if (failure.signal === "network") {
    return `The test likely failed because a network or API request did not complete successfully.`;
  }
  if (failure.signal === "timeout") {
    return `The expected UI or network condition did not complete before timeout.`;
  }
  if (failure.signal === "runtime") {
    return `A frontend runtime error interrupted the test flow.`;
  }
  return `The failure signal could not be classified cleanly from the captured error.`;
};

export const buildDebugSummary = (failure: FailureFacts) => {
  const lines = [
    `Test: ${failure.title}`,
    `Diagnosis: ${describeFailure(failure)}`
  ];
  if (failure.locator) lines.push(`Locator: ${failure.locator}`);
  if (failure.expected) lines.push(`Expected: ${failure.expected}`);
  if (failure.received) lines.push(`Observed: ${failure.received}`);
  if (failure.timeoutMs) lines.push(`Timeout: ${failure.timeoutMs}ms`);
  if (failure.lastUrl) lines.push(`URL: ${failure.lastUrl}`);
  return lines.join("\n");
};

export const buildSimilarityKey = (failure: FailureFacts) => {
  if (failure.locator || failure.expected || failure.received) {
    return [
      failure.signal,
      failure.locator || "unknown-locator",
      failure.expected || "unknown-expected",
      failure.received || "unknown-received"
    ].join("|");
  }
  return `${failure.signal}|${normalizeMessageFingerprint(failure.message)}`;
};

export const summarizeSignal = signalSummary;

export const buildQuickDiagnosis = (playwrightJsonPath: string): QuickDiagnosis | null => {
  const failures = collectFailureFacts(playwrightJsonPath);
  if (!failures.length) return null;

  if (failures.length === 1) {
    const failed = failures[0];
    return {
      lines: [`Test "${failed.title}" likely failed due to ${signalSummary(failed.signal)}.`]
    };
  }

  const counts = new Map<DiagnosisSignal, number>();
  for (const failed of failures) {
    counts.set(failed.signal, (counts.get(failed.signal) || 0) + 1);
  }
  const topSignal =
    Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";

  return {
    lines: [
      `${failures.length} tests failed.`,
      `Most common signal: ${signalSummary(topSignal)}.`
    ]
  };
};
