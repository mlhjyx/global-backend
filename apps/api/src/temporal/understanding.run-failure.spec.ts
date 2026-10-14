import { describe, expect, it } from 'vitest';
import { ActivityFailure, ApplicationFailure } from '@temporalio/common';
import {
  describeUnderstandingFailure,
  understandingFailureLabel,
} from './understanding.run-failure';

function activityFailure(activityType: string, cause: Error): ActivityFailure {
  return new ActivityFailure('Activity task failed', activityType, '3', 'MAXIMUM_ATTEMPTS_REACHED', 'worker-1', cause);
}

describe('describeUnderstandingFailure', () => {
  it('names the stage and the failure type the shared classifier extracts, never a message', () => {
    const error = activityFailure(
      'crawlWebsite',
      ApplicationFailure.create({
        type: 'GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_INVALID',
        message: 'tool crawl4ai.fetch denied for https://acme.example/',
        nonRetryable: true,
      }),
    );

    const failure = describeUnderstandingFailure('crawlWebsite', error);

    expect(failure).toEqual({
      stage: 'crawlWebsite',
      errorType: 'GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_INVALID',
      control: true,
    });
    expect(JSON.stringify(failure)).not.toMatch(/acme|denied/u);
  });
});

describe('understandingFailureLabel', () => {
  it('joins a known stage and a closed failure type as the text the company row keeps', () => {
    expect(
      understandingFailureLabel({ stage: 'extract', errorType: 'ProviderOutputError', control: false }),
    ).toBe('extract:ProviderOutputError');
  });

  it.each([
    ['an unknown stage', { stage: 'crawl', errorType: 'Error', control: false }],
    ['free text as the type', { stage: 'crawlWebsite', errorType: 'person@example.com', control: false }],
    ['an overlong type', { stage: 'crawlWebsite', errorType: 'A'.repeat(65), control: false }],
    ['a missing type', { stage: 'crawlWebsite', control: true }],
    ['not an object', 'crawlWebsite:Error'],
  ])('refuses %s', (_label, failure) => {
    expect(understandingFailureLabel(failure)).toBeNull();
  });
});
