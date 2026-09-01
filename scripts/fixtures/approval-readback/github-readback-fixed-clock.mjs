import { mock } from 'node:test';

let fixedClockActive = false;

export const withFixedSystemTime = async (instant, operation) => {
  if (typeof instant !== 'string') {
    throw new Error('APPROVAL_TEST_CLOCK_INVALID');
  }
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
  const tracker = mock.method(Date, 'now', () => millis);
  fixedClockActive = true;
  try {
    return await operation();
  } finally {
    try {
      tracker.mock.restore();
    } finally {
      fixedClockActive = false;
    }
  }
};
