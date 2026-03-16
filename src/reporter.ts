import path from "path";
import { pathToFileURL } from "url";
import {
  hasSupportedCiEnv,
  isLocalUploadEnabled,
  runSentinelUpload
} from "@sentinelqa/uploader/node";
import { loadSentinelEnv } from "./env";
import { generateLocalDebugReport } from "./localReport";

type ReporterOptions = {
  project?: string | null;
  playwrightJsonPath: string;
  playwrightReportDir: string;
  testResultsDir: string;
  artifactDirs?: string[];
  verbose?: boolean;
  localReportDir?: string;
  localReportFileName?: string;
  localRedirectFileName?: string;
};

const pluralize = (count: number, singular: string, plural: string) => {
  return count === 1 ? singular : plural;
};

const formatTerminalLink = (label: string, target: string) => {
  if (!process.stdout.isTTY) return label;
  return `\u001B]8;;${target}\u0007${label}\u001B]8;;\u0007`;
};

const colorize = (value: string, code: string) => {
  if (!process.stdout.isTTY) return value;
  return `\u001b[${code}m${value}\u001b[0m`;
};

const bold = (value: string) => colorize(value, "1");
const green = (value: string) => colorize(value, "32");
const cyan = (value: string) => colorize(value, "36");
const yellow = (value: string) => colorize(value, "33");
const dim = (value: string) => colorize(value, "2");
const magenta = (value: string) => colorize(value, "35");

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

  onTestEnd(_test: any, result: any) {
    if (!result) return;
    if (["failed", "timedOut", "interrupted"].includes(result.status)) {
      this.failedCount += 1;
    }
  }

  private printLocalReport(localReportPath: string) {
    const relativeReportPath = path
      .relative(process.cwd(), localReportPath)
      .replace(/\\/g, "/");
    const displayPath = relativeReportPath.startsWith(".")
      ? relativeReportPath
      : `./${relativeReportPath}`;
    const openCommand = `open ${displayPath}`;

    console.log("");
    console.log(green("✔ Artifacts collected"));
    console.log(green("✔ Sentinel HTML debugging report created"));
    console.log("");
    console.log(bold("Report"));
    console.log(`  ${cyan(formatTerminalLink(displayPath, pathToFileURL(localReportPath).href))}`);
    console.log("");
    console.log(bold("Open"));
    console.log(`  ${cyan(openCommand)}`);
    console.log("");
    console.log(yellow("Tip"));
    console.log(`  ${dim("Upload runs to Sentinel Cloud for CI history,")}`);
    console.log(`  ${dim("shareable debugging links, and AI summaries.")}`);
    console.log("");
    console.log(`  ${cyan(formatTerminalLink("https://sentinelqa.com", "https://sentinelqa.com"))}`);
    console.log("");
    console.log(`  ${magenta("★ If this reporter helped you debug faster,")}`);
    console.log(`  ${dim("consider starring the project:")}`);
    console.log(
      `  ${cyan(
        formatTerminalLink(
          "https://github.com/sentinelqa/playwright-reporter",
          "https://github.com/sentinelqa/playwright-reporter"
        )
      )}`
    );
  }

  async onEnd() {
    const hasSentinelToken = Boolean(process.env.SENTINEL_TOKEN);
    if (!hasSentinelToken) {
      const localReport = generateLocalDebugReport({
        playwrightJsonPath: this.options.playwrightJsonPath,
        playwrightReportDir: this.options.playwrightReportDir,
        testResultsDir: this.options.testResultsDir,
        artifactDirs: this.options.artifactDirs || [],
        reportDir: this.options.localReportDir,
        reportFileName: this.options.localReportFileName,
        redirectFileName: this.options.localRedirectFileName
      });

      this.printLocalReport(localReport.htmlPath);
      console.log("");
      return;
    }

    const hasCiEnv = hasSupportedCiEnv(process.env);
    const localUploadEnabled = isLocalUploadEnabled(process.env);

    console.log("");
    console.log("Uploading failure artifacts to Sentinel...");
    console.log("");

    if (!hasCiEnv && !localUploadEnabled) {
      console.log("Local upload mode detected.");
      console.log(
        "If this run is outside CI, set SENTINEL_UPLOAD_LOCAL=1 and provide the required CI metadata."
      );
      console.log("");
      console.log("Typical local upload environment variables:");
      console.log("• SENTINEL_UPLOAD_LOCAL=1");
      console.log("• CI_COMMIT_SHA or GITHUB_SHA");
      console.log("• CI_COMMIT_REF_NAME or GITHUB_REF_NAME");
      console.log("• CI_JOB_URL or a matching run URL");
      console.log("• CI_PIPELINE_ID or GITHUB_RUN_ID");
      console.log("");
    }

    const exitCode = await runSentinelUpload({
      playwrightJsonPath: this.options.playwrightJsonPath,
      playwrightReportDir: this.options.playwrightReportDir,
      testResultsDir: this.options.testResultsDir,
      artifactDirs: this.options.artifactDirs || [],
      suppressSummaryJson: true,
      env: {
        SENTINEL_REPORTER_PROJECT: this.options.project || undefined
      }
    });

    if (exitCode !== 0) {
      throw new Error(`Sentinel upload failed with exit code ${exitCode}`);
    }

    console.log("");
    console.log("✔ Uploaded run to Sentinel");
  }
}

export = SentinelReporter;
