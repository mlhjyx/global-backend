import { mock } from 'node:test';

let fixedClockActive = false;

export const withFixedSystemTime = async (instant, operation) => {
  const millis = Date.parse(instant);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== instant) {
    throw new Error('APPROVAL_TEST_CLOCK_INVALID');
  }
  if (typeof operation !== 'function') {
    throw new Error('APPROVAL_TEST_CLOCK_OPERATION_REQUIRED');
  }
  if (fixedClockActive) {
    throw new Error('APPROVAL_TEST_CLOCK_CONCURRENT');
  }
  fixedClockActive = true;
  const tracker = mock.method(Date, 'now', () => millis);
  try {
    return await operation();
  } finally {
    tracker.mock.restore();
    fixedClockActive = false;
  }
};
