import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright';
import { takeScreenshot } from './scraper';

test('diagnostic screenshots are disabled by default', async () => {
  const previous = process.env.PARTSLINK_SCREENSHOTS;
  delete process.env.PARTSLINK_SCREENSHOTS;
  let screenshotCalls = 0;

  try {
    await takeScreenshot({
      async screenshot() {
        screenshotCalls += 1;
      },
    } as unknown as Page, 'privacy-default');
    assert.equal(screenshotCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.PARTSLINK_SCREENSHOTS;
    else process.env.PARTSLINK_SCREENSHOTS = previous;
  }
});

test('diagnostic screenshots reject path-like names when explicitly enabled', async () => {
  const previous = process.env.PARTSLINK_SCREENSHOTS;
  process.env.PARTSLINK_SCREENSHOTS = 'true';
  let screenshotCalls = 0;

  try {
    await takeScreenshot({
      async screenshot() {
        screenshotCalls += 1;
      },
    } as unknown as Page, '../../credential-copy');
    assert.equal(screenshotCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.PARTSLINK_SCREENSHOTS;
    else process.env.PARTSLINK_SCREENSHOTS = previous;
  }
});
