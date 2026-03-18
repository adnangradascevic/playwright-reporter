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
  if (/timeout|timed out|waiting for/.test(lower)) return "timeout";
  if (/expected substring|expected string|received string|tohavetext|tocontaintext/.test(lower)) {
    return "assertion_mismatch";
  }
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

export const buildQuickDiagnosis = (playwrightJsonPath: string): QuickDiagnosis | null => {
  if (!fs.existsSync(playwrightJsonPath)) return null;
  try {
    const raw = fs.readFileSync(playwrightJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    const failedCases = flattenFailedCases(parsed as PlaywrightNode);
    if (!failedCases.length) return null;

    if (failedCases.length === 1) {
      const failed = failedCases[0];
      return {
        lines: [
          `Test "${shortenTitle(failed.title)}" likely failed due to ${signalSummary(failed.signal)}.`
        ]
      };
    }

    const counts = new Map<DiagnosisSignal, number>();
    for (const failed of failedCases) {
      counts.set(failed.signal, (counts.get(failed.signal) || 0) + 1);
    }
    const topSignal =
      Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";

    return {
      lines: [
        `${failedCases.length} tests failed.`,
        `Most common signal: ${signalSummary(topSignal)}.`
      ]
    };
  } catch {
    return null;
  }
};
