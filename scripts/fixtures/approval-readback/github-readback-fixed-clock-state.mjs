const NO_FIXED_CLOCK_OWNER = Symbol('NO_FIXED_CLOCK_OWNER');

let fixedClockOwner = NO_FIXED_CLOCK_OWNER;

export const acquireFixedClockOwner = (ownerToken) => {
  if (fixedClockOwner !== NO_FIXED_CLOCK_OWNER) {
    throw new Error('APPROVAL_TEST_CLOCK_CONCURRENT');
  }
  fixedClockOwner = ownerToken;
};

export const releaseFixedClockOwner = (ownerToken) => {
  if (fixedClockOwner !== ownerToken) {
    throw new Error('APPROVAL_TEST_CLOCK_STATE_INVALID');
  }
  fixedClockOwner = NO_FIXED_CLOCK_OWNER;
};
