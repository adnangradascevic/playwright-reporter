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

declare module "@sentinelqa/uploader/playwright" {
  export function sentinelCaptureFailureContext(
    page: any,
    testInfo: any,
    options?: {
      failedLocator?: string | null;
      expectedText?: string | null;
    }
  ): Promise<any>;

  export function sentinelCaptureFailureContextFromReporter(
    test: any,
    result: any,
    options?: {
      failedLocator?: string | null;
      expectedText?: string | null;
    }
  ): Promise<any>;
}
