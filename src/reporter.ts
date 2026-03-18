import path from "path";
import { pathToFileURL } from "url";
import {
  hasSupportedCiEnv,
  isLocalUploadEnabled,
  runSentinelUpload
} from "@sentinelqa/uploader/node";
import { loadSentinelEnv } from "./env";
import { generateLocalDebugReport } from "./localReport";
import { buildQuickDiagnosis } from "./quickDiagnosis";

const { sentinelCaptureFailureContextFromReporter } = require("@sentinelqa/uploader/playwright");

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

  async onTestEnd(test: any, result: any) {
    if (!result) return;
    if (["failed", "timedOut", "interrupted"].includes(result.status)) {
      await sentinelCaptureFailureContextFromReporter(test, result).catch(() => null);
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
    const quickDiagnosis = buildQuickDiagnosis(this.options.playwrightJsonPath);
    if (quickDiagnosis?.lines.length) {
      console.log(yellow("Quick diagnosis"));
      for (const line of quickDiagnosis.lines) {
        console.log(`  ${dim(line)}`);
      }
      console.log("");
    }
    console.log(yellow("Tip"));
    console.log(`  ${dim("Want full AI analysis, shareable run links, and CI history?")}`);
    console.log(
      `  ${dim("Try Sentinel Cloud Beta free:")} ${cyan(
        formatTerminalLink("https://sentinelqa.com", "https://sentinelqa.com")
      )}`
    );
    console.log("");
    console.log(`  ${magenta("★ If this reporter helped you debug faster,")}`);
    console.log(`  ${dim("consider starring the project:")}`);
    console.log(
      `  ${cyan(
        formatTerminalLink(
          "https://github.com/adnangradascevic/playwright-reporter",
          "https://github.com/adnangradascevic/playwright-reporter"
        )
      )}`
    );
  }

  async onEnd() {
    const hasSentinelToken = Boolean(process.env.SENTINEL_TOKEN);
    const hasCiEnv = hasSupportedCiEnv(process.env);
    const localUploadEnabled = isLocalUploadEnabled(process.env);

    if (!hasSentinelToken || (!hasCiEnv && !localUploadEnabled)) {
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

      if (hasSentinelToken && !hasCiEnv && !localUploadEnabled) {
        console.log("Sentinel upload skipped for this local run.");
        console.log(
          "To upload local runs, set SENTINEL_UPLOAD_LOCAL=1 and provide the required CI metadata."
        );
        console.log("");
      }

      return;
    }

    console.log("");
    console.log("Uploading failure artifacts to Sentinel...");
    console.log("");

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
