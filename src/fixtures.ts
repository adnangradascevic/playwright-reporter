const { sentinelCaptureFailureContext } = require("@sentinelqa/uploader/playwright");

export function attachSentinelFailureCapture(baseTest: any) {
  return baseTest.extend({
    _sentinelFailureCapture: [
      async ({ page }: { page: any }, use: () => Promise<void>, testInfo: any) => {
        await use();
        await sentinelCaptureFailureContext(page, testInfo).catch(() => null);
      },
      { auto: true }
    ]
  });
}
