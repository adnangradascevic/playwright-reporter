import crypto from "crypto";
import http from "http";
import https from "https";
import { execFileSync } from "child_process";

const DEFAULT_APP_URL = "https://app.sentinelqa.com";
const PACKAGE_VERSION = (() => {
  try {
    return require("../package.json").version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

type TelemetryPayload = {
  repoHash: string;
  eventType: "seen" | "failed_run";
  environment: "ci" | "local";
  ciProvider: "github" | "gitlab" | "circleci" | "local";
  mode: "public" | "workspace";
  version: string;
};

const globalState = globalThis as typeof globalThis & {
  __sentinelReporterTelemetrySent?: boolean;
  __sentinelReporterFailedTelemetrySent?: boolean;
  __sentinelTelemetryPending?: Promise<void>[];
};

const readEnv = (key: string) => {
  const value = process.env[key];
  return value && value.trim().length > 0 ? value.trim() : null;
};

const isTruthyEnv = (key: string) => {
  const value = readEnv(key);
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const debugLog = (message: string) => {
  if (!isTruthyEnv("SENTINEL_TELEMETRY_DEBUG")) return;
  console.log(`[sentinel-telemetry] ${message}`);
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

const getCiProvider = (): TelemetryPayload["ciProvider"] => {
  if (readEnv("GITHUB_ACTIONS") === "true") return "github";
  if (readEnv("GITLAB_CI") === "true" || readEnv("CI_PROJECT_ID")) return "gitlab";
  if (readEnv("CIRCLECI") === "true") return "circleci";
  return "local";
};

const detectRepoIdentity = (provider: TelemetryPayload["ciProvider"]) => {
  if (provider === "github") {
    const repo = readEnv("GITHUB_REPOSITORY");
    if (repo) return repo.toLowerCase();
  }
  if (provider === "gitlab") {
    const repo = readEnv("CI_PROJECT_PATH") || readEnv("CI_PROJECT_URL");
    if (repo) return repo.toLowerCase();
  }
  if (provider === "circleci") {
    const user = readEnv("CIRCLE_PROJECT_USERNAME");
    const repo = readEnv("CIRCLE_PROJECT_REPONAME");
    if (user && repo) return `${user}/${repo}`.toLowerCase();
  }
  const remote =
    gitOutput(["config", "--get", "remote.origin.url"]) ||
    gitOutput(["remote", "get-url", "origin"]);
  if (remote) return remote.toLowerCase();
  return process.cwd().toLowerCase();
};

const buildPayload = (eventType: TelemetryPayload["eventType"]): TelemetryPayload => {
  const ciProvider = getCiProvider();
  const repoHash = crypto
    .createHash("sha256")
    .update(detectRepoIdentity(ciProvider))
    .digest("hex");
  return {
    repoHash,
    eventType,
    environment: ciProvider === "local" ? "local" : "ci",
    ciProvider,
    mode: readEnv("SENTINEL_TOKEN") ? "workspace" : "public",
    version: PACKAGE_VERSION
  };
};

const getPendingTelemetry = () => {
  if (!globalState.__sentinelTelemetryPending) {
    globalState.__sentinelTelemetryPending = [];
  }
  return globalState.__sentinelTelemetryPending;
};

const postJson = (url: string, payload: TelemetryPayload) =>
  new Promise<void>((resolve) => {
  const target = new URL(url);
  const client = target.protocol === "https:" ? https : http;
  const body = JSON.stringify(payload);
  const req = client.request(
    {
      method: "POST",
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body).toString()
      }
    },
    (res) => {
      debugLog(`POST ${target.origin}${target.pathname} -> ${res.statusCode || 0}`);
      res.resume();
      res.on("end", () => resolve());
    }
  );

  req.setTimeout(1200, () => {
    debugLog(`timeout posting to ${target.origin}${target.pathname}`);
    req.destroy();
    resolve();
  });
  req.on("error", (error) => {
    debugLog(`error posting to ${target.origin}${target.pathname}: ${error.message}`);
    resolve();
  });
  req.write(body);
  req.end();
  });

const emitTelemetry = (eventType: TelemetryPayload["eventType"]) => {
  if (isTruthyEnv("SENTINEL_TELEMETRY_DISABLED")) return;
  const appUrl = readEnv("SENTINEL_APP_URL") || DEFAULT_APP_URL;
  const payload = buildPayload(eventType);
  debugLog(
    `event=${eventType} dest=${appUrl}/api/telemetry/uploader env=${payload.environment} provider=${payload.ciProvider} mode=${payload.mode} version=${payload.version} repo=${payload.repoHash.slice(0, 12)}`
  );
  try {
    const pending = getPendingTelemetry();
    const request = postJson(`${appUrl}/api/telemetry/uploader`, payload).finally(() => {
      const index = pending.indexOf(request);
      if (index !== -1) pending.splice(index, 1);
    });
    pending.push(request);
  } catch {
    // Telemetry must never affect test execution.
  }
};

export const emitReporterTelemetry = () => {
  if (globalState.__sentinelReporterTelemetrySent) return;
  globalState.__sentinelReporterTelemetrySent = true;
  emitTelemetry("seen");
};

export const emitFailedRunTelemetry = () => {
  if (globalState.__sentinelReporterFailedTelemetrySent) return;
  globalState.__sentinelReporterFailedTelemetrySent = true;
  emitTelemetry("failed_run");
};

export const flushTelemetry = async (timeoutMs = 1500) => {
  const pending = [...getPendingTelemetry()];
  if (pending.length === 0) return;
  await Promise.race([
    Promise.allSettled(pending).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  ]);
};
