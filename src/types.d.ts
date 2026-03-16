declare module "@sentinelqa/uploader/node" {
  export function hasSupportedCiEnv(
    env?: NodeJS.ProcessEnv
  ): boolean;

  export function isLocalUploadEnabled(
    env?: NodeJS.ProcessEnv
  ): boolean;

  export function runSentinelUpload(options?: {
    playwrightJsonPath?: string;
    playwrightReportDir?: string;
    testResultsDir?: string;
    artifactDirs?: string[];
    suppressSummaryJson?: boolean;
    env?: Record<string, string | undefined>;
  }): Promise<number>;
}
