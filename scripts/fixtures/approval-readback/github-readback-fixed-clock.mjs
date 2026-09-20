import { mock } from 'node:test';

import { acquireFixedClockOwner, releaseFixedClockOwner } from './github-readback-fixed-clock-state.mjs';

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
  const ownerToken = Object.freeze(Object.create(null));
  acquireFixedClockOwner(ownerToken);
  let tracker;
  try {
    tracker = mock.method(Date, 'now', () => millis);
    return await operation();
  } finally {
    try {
      if (tracker !== undefined) tracker.mock.restore();
    } finally {
      releaseFixedClockOwner(ownerToken);
    }
  }
};
