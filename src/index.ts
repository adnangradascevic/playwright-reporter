import path from "path";

type ReporterEntry = string | [string] | [string, Record<string, unknown>];

type PlaywrightUseOptions = {
  trace?: string;
  screenshot?: string;
  video?: string;
};

type PlaywrightConfig = {
  reporter?: ReporterEntry | ReporterEntry[];
  outputDir?: string;
  use?: PlaywrightUseOptions;
  [key: string]: unknown;
};

export type SentinelResolvedPaths = {
  playwrightJsonPath: string;
  playwrightReportDir: string;
  testResultsDir: string;
  artifactDirs: string[];
};

export type SentinelPlaywrightOptions = {
  project?: string;
  playwrightJsonPath?: string;
  playwrightReportDir?: string;
  testResultsDir?: string;
  artifactDirs?: string[];
  verbose?: boolean;
  localReportDir?: string;
  localReportFileName?: string;
  localRedirectFileName?: string;
};

const DEFAULT_REPORT_DIR = "playwright-report";
const DEFAULT_TEST_RESULTS_DIR = "test-results";

const cloneEntry = (entry: ReporterEntry): ReporterEntry => {
  if (!Array.isArray(entry)) return entry;
  const [name, options] = entry;
  return options ? [name, { ...options }] : [name];
};

const normalizeReporter = (reporter?: ReporterEntry | ReporterEntry[]) => {
  if (!reporter) return [] as ReporterEntry[];
  if (!Array.isArray(reporter)) return [cloneEntry(reporter)];
  if (reporter.length === 0) return [];

  const maybeTuple =
    typeof reporter[0] === "string" &&
    (reporter.length === 1 ||
      (reporter.length === 2 &&
        !Array.isArray(reporter[1]) &&
        typeof reporter[1] === "object"));

  if (maybeTuple) {
    return [cloneEntry(reporter as ReporterEntry)];
  }

  return (reporter as ReporterEntry[]).map(cloneEntry);
};

const getReporterName = (entry: ReporterEntry) => {
  return Array.isArray(entry) ? entry[0] : entry;
};

const getReporterOptions = (entry?: ReporterEntry) => {
  if (!entry || !Array.isArray(entry)) return {};
  return entry[1] || {};
};

const normalizePath = (value: string) => {
  return value.replace(/\\/g, "/");
};

const setReporterOptions = (
  reporters: ReporterEntry[],
  name: string,
  options: Record<string, unknown>
) => {
  const index = reporters.findIndex((entry) => getReporterName(entry) === name);
  if (index === -1) {
    reporters.push([name, options]);
    return;
  }

  const existing = reporters[index];
  if (Array.isArray(existing)) {
    reporters[index] = [name, { ...(existing[1] || {}), ...options }];
    return;
  }

  reporters[index] = [name, options];
};

export function withSentinel(
  config: PlaywrightConfig,
  options: SentinelPlaywrightOptions = {}
) {
  const nextConfig: PlaywrightConfig = {
    ...config,
    use: {
      ...config.use,
      trace: config.use?.trace || "retain-on-failure",
      screenshot: config.use?.screenshot || "only-on-failure",
      video: config.use?.video || "retain-on-failure"
    }
  };

  const reporters = normalizeReporter(config.reporter);
  const existingJsonReporter = reporters.find(
    (entry) => getReporterName(entry) === "json"
  );
  const existingHtmlReporter = reporters.find(
    (entry) => getReporterName(entry) === "html"
  );

  const existingJsonOutputFile = getReporterOptions(existingJsonReporter).outputFile;
  const existingHtmlOutputFolder =
    getReporterOptions(existingHtmlReporter).outputFolder;
  const shouldUsePlaywrightHtmlReporter =
    Boolean(process.env.SENTINEL_TOKEN) || typeof existingHtmlOutputFolder === "string";

  const testResultsDir = options.testResultsDir || config.outputDir || DEFAULT_TEST_RESULTS_DIR;
  const playwrightReportDir =
    options.playwrightReportDir ||
    (typeof existingHtmlOutputFolder === "string"
      ? existingHtmlOutputFolder
      : DEFAULT_REPORT_DIR);
  const playwrightJsonPath =
    options.playwrightJsonPath ||
    (typeof existingJsonOutputFile === "string"
      ? existingJsonOutputFile
      : path.join(playwrightReportDir, "report.json"));

  const artifactDirs = Array.from(
    new Set(
      (options.artifactDirs || [])
        .filter(Boolean)
        .map((entry) => normalizePath(entry))
    )
  );

  nextConfig.outputDir = testResultsDir;

  setReporterOptions(reporters, "json", { outputFile: playwrightJsonPath });
  if (shouldUsePlaywrightHtmlReporter) {
    setReporterOptions(reporters, "html", {
      outputFolder: playwrightReportDir,
      open: "never"
    });
  } else {
    const htmlReporterIndex = reporters.findIndex(
      (entry) => getReporterName(entry) === "html"
    );
    if (htmlReporterIndex !== -1) {
      reporters.splice(htmlReporterIndex, 1);
    }
  }

  const sentinelReporterPath = require.resolve("./reporter");
  const sentinelReporterOptions = {
    project: options.project || null,
    playwrightJsonPath,
    playwrightReportDir,
    testResultsDir,
    artifactDirs,
    verbose: options.verbose ?? false,
    localReportDir: options.localReportDir,
    localReportFileName: options.localReportFileName,
    localRedirectFileName: options.localRedirectFileName
  };

  const sentinelIndex = reporters.findIndex(
    (entry) => getReporterName(entry) === sentinelReporterPath
  );
  if (sentinelIndex !== -1) {
    reporters.splice(sentinelIndex, 1);
  }
  reporters.push([sentinelReporterPath, sentinelReporterOptions]);

  nextConfig.reporter = reporters;
  return nextConfig;
}

export function resolveSentinelPaths(
  config: PlaywrightConfig,
  options: SentinelPlaywrightOptions = {}
): SentinelResolvedPaths {
  const reporters = normalizeReporter(config.reporter);
  const existingJsonReporter = reporters.find(
    (entry) => getReporterName(entry) === "json"
  );
  const existingHtmlReporter = reporters.find(
    (entry) => getReporterName(entry) === "html"
  );

  const existingJsonOutputFile = getReporterOptions(existingJsonReporter).outputFile;
  const existingHtmlOutputFolder =
    getReporterOptions(existingHtmlReporter).outputFolder;

  const testResultsDir =
    options.testResultsDir || config.outputDir || DEFAULT_TEST_RESULTS_DIR;
  const playwrightReportDir =
    options.playwrightReportDir ||
    (typeof existingHtmlOutputFolder === "string"
      ? existingHtmlOutputFolder
      : DEFAULT_REPORT_DIR);
  const playwrightJsonPath =
    options.playwrightJsonPath ||
    (typeof existingJsonOutputFile === "string"
      ? existingJsonOutputFile
      : path.join(playwrightReportDir, "report.json"));

  const artifactDirs = Array.from(
    new Set(
      (options.artifactDirs || [])
        .filter(Boolean)
        .map((entry) => normalizePath(entry))
    )
  );

  return {
    playwrightJsonPath: normalizePath(playwrightJsonPath),
    playwrightReportDir: normalizePath(playwrightReportDir),
    testResultsDir: normalizePath(testResultsDir),
    artifactDirs
  };
}
