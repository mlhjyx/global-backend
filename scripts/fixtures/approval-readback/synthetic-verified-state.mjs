import {
  buildSyntheticVerifiedApprovalStateFixture,
} from './merge-authorization/task4-round4-state-fixture.mjs';

export const buildSyntheticVerifiedApprovalStateForTests = (options = {}) => Object.freeze({
  synthetic: true,
  state: buildSyntheticVerifiedApprovalStateFixture(options),
});
