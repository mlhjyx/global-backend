import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, isAtOrPast, isTerminal } from './deletion-state';

describe('deletion-state', () => {
  it('allows the happy-path forward transitions', () => {
    expect(canTransition('RECEIVED', 'FROZEN')).toBe(true);
    expect(canTransition('FROZEN', 'ERASING')).toBe(true);
    expect(canTransition('ERASING', 'COMPLETED')).toBe(true);
  });

  it('allows any non-terminal state to FAILED', () => {
    expect(canTransition('RECEIVED', 'FAILED')).toBe(true);
    expect(canTransition('FROZEN', 'FAILED')).toBe(true);
    expect(canTransition('ERASING', 'FAILED')).toBe(true);
  });

  it('rejects skips and backward moves', () => {
    expect(canTransition('RECEIVED', 'ERASING')).toBe(false);
    expect(canTransition('RECEIVED', 'COMPLETED')).toBe(false);
    expect(canTransition('FROZEN', 'RECEIVED')).toBe(false);
    expect(canTransition('ERASING', 'FROZEN')).toBe(false);
  });

  it('treats COMPLETED and FAILED as terminal', () => {
    expect(canTransition('COMPLETED', 'ERASING')).toBe(false);
    expect(canTransition('FAILED', 'ERASING')).toBe(false);
    expect(isTerminal('COMPLETED')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('ERASING')).toBe(false);
  });

  it('assertTransition throws only on invalid moves', () => {
    expect(() => assertTransition('RECEIVED', 'FROZEN')).not.toThrow();
    expect(() => assertTransition('RECEIVED', 'COMPLETED')).toThrow(/invalid deletion status/);
  });

  it('isAtOrPast reflects happy-path progress; FAILED is never past', () => {
    expect(isAtOrPast('ERASING', 'FROZEN')).toBe(true);
    expect(isAtOrPast('FROZEN', 'FROZEN')).toBe(true);
    expect(isAtOrPast('RECEIVED', 'FROZEN')).toBe(false);
    expect(isAtOrPast('COMPLETED', 'ERASING')).toBe(true);
    expect(isAtOrPast('FAILED', 'RECEIVED')).toBe(false);
  });
});
