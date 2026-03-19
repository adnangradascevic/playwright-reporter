import {
  hasSupportedCiEnv,
  isLocalUploadEnabled,
  runSentinelUpload
} from "@sentinelqa/uploader/node";
import { loadSentinelEnv } from "./env";
import { buildQuickDiagnosis } from "./quickDiagnosis";

const { sentinelCaptureFailureContextFromReporter } = require("@sentinelqa/uploader/playwright");

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

const green = (value: string) => colorize(value, "32");
const yellow = (value: string) => colorize(value, "33");
const dim = (value: string) => colorize(value, "2");

class SentinelReporter {
  private failedCount = 0;
  private totalCount = 0;
  private options: ReporterOptions;

  constructor(options: ReporterOptions) {
    loadSentinelEnv();
    this.options = options;
  }

  onBegin(config: any, suite: any) {
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
    const usingImplicitLocalPublicMode =
      !hasWorkspaceToken &&
      !hasSupportedCiEnv(process.env) &&
      !isLocalUploadEnabled(process.env);
    const quickDiagnosis = buildQuickDiagnosis(this.options.playwrightJsonPath);
    console.log("");
    if (quickDiagnosis?.lines.length) {
      console.log(yellow("Quick diagnosis"));
      for (const line of quickDiagnosis.lines) {
        console.log(`  ${dim(line)}`);
      }
      console.log("");
    }

    if (hasWorkspaceToken) {
      console.log("");
      console.log(green("✔ Artifacts collected"));
    }
    console.log("");
    console.log("Uploading hosted debugging report to Sentinel...");
    if (usingImplicitLocalPublicMode) {
      console.log(dim("Local upload env not set. Falling back to local metadata for a public hosted report."));
    }
    console.log("");

    const upload = await runSentinelUpload({
      playwrightJsonPath: this.options.playwrightJsonPath,
      playwrightReportDir: this.options.playwrightReportDir,
      testResultsDir: this.options.testResultsDir,
      artifactDirs: this.options.artifactDirs || [],
      suppressSummaryJson: true,
      env: {
        SENTINEL_REPORTER_PROJECT: this.options.project || undefined,
        SENTINEL_REPORTER_SILENT: "1"
      }
    });

    if (upload.exitCode !== 0) {
      throw new Error(`Sentinel upload failed with exit code ${upload.exitCode}`);
    }

    console.log("");
    console.log("Sentinel report");
    console.log(`  ${upload.shareRunUrl || upload.internalRunUrl}`);
    if (upload.shareLabel) {
      console.log(`  ${dim(upload.shareLabel)}`);
    }
    if (!hasWorkspaceToken) {
      console.log("");
      console.log("Upgrade for free to get full AI debugging suggestions");
      console.log(`  ${dim("https://app.sentinelqa.com/register")}`);
    }
  }
}

export = SentinelReporter;
