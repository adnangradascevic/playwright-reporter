declare module "@sentinelqa/uploader/node" {
  export type SentinelUploadResult = {
    exitCode: number;
    runId: string | null;
    internalRunUrl: string | null;
    internalWorkflowUrl: string | null;
    shareRunUrl: string | null;
    shareFirstFailureUrl: string | null;
    shareLabel: string | null;
  };

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
  }): Promise<SentinelUploadResult>;
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
