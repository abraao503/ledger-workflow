import {
  WorkflowStateMachine,
  type TransitionContext,
} from './workflow-state.js';

describe('WorkflowStateMachine edge cases', () => {
  const machine = new WorkflowStateMachine();
  const complete: TransitionContext = {
    requirementsComplete: true,
    authorized: true,
    testsDefined: true,
    redEvidence: true,
    redEvidenceSha: 'sha-1',
    currentSha: 'sha-1',
    redEvidenceFingerprint: 'fingerprint-1',
    currentFingerprint: 'fingerprint-1',
    greenEvidence: true,
    greenEvidenceSha: 'sha-1',
    greenEvidenceFingerprint: 'fingerprint-1',
    reviewApproved: true,
    hasBlockingFindings: false,
    commitSha: 'commit-1',
  };

  it.each([
    ['DRAFT', 'AUTHORIZED', 'INVALID_TRANSITION:DRAFT:AUTHORIZED'],
    ['READY', 'IMPLEMENTING', 'INVALID_TRANSITION:READY:IMPLEMENTING'],
    ['GREEN_CONFIRMED', 'CLOSED', 'INVALID_TRANSITION:GREEN_CONFIRMED:CLOSED'],
  ] as const)('rejects a skipped transition %s -> %s', (from, to, error) => {
    expect(() => machine.assertTransition(from, to, complete)).toThrow(error);
  });

  it('rejects no-op and reopening a blocked item', () => {
    expect(() => machine.assertTransition('IMPLEMENTING', 'IMPLEMENTING', complete))
      .toThrow('NO_STATE_CHANGE');
    expect(() => machine.assertTransition('BLOCKED', 'READY', complete))
      .toThrow('BLOCKED_ITEM_REQUIRES_REOPENING');
  });

  it('allows blocking only with a non-empty reason from any active state', () => {
    expect(() => machine.assertTransition('IMPLEMENTING', 'BLOCKED', {}))
      .toThrow('BLOCK_REASON_REQUIRED');
    expect(() => machine.assertTransition('IMPLEMENTING', 'BLOCKED', {
      blockReason: 'aguardando contrato externo',
    })).not.toThrow();
  });

  it('rejects RED evidence without a baseline or with a stale SHA', () => {
    expect(() => machine.assertTransition('TESTS_DEFINED', 'RED_CONFIRMED', {
      redEvidence: true,
      redEvidenceSha: 'sha-1',
    })).toThrow('RED_EVIDENCE_STALE');
    expect(() => machine.assertTransition('TESTS_DEFINED', 'RED_CONFIRMED', {
      ...complete,
      redEvidenceFingerprint: undefined,
      currentFingerprint: undefined,
      redEvidenceSha: 'sha-2',
    })).toThrow('RED_EVIDENCE_STALE');
  });

  it('rejects GREEN evidence without a result and distinguishes stale output', () => {
    expect(() => machine.assertTransition('IMPLEMENTING', 'GREEN_CONFIRMED', {
      ...complete,
      greenEvidence: false,
    })).toThrow('GREEN_EVIDENCE_REQUIRED');
    expect(() => machine.assertTransition('IMPLEMENTING', 'GREEN_CONFIRMED', {
      ...complete,
      greenEvidenceFingerprint: undefined,
      currentFingerprint: undefined,
      greenEvidenceSha: 'sha-2',
    })).toThrow('GREEN_EVIDENCE_STALE');
  });

  it('requires an approved review and no unresolved blocking finding', () => {
    expect(() => machine.assertTransition('READY_FOR_REVIEW', 'APPROVED', {
      ...complete,
      reviewApproved: false,
    })).toThrow('REVIEW_REQUIRED');
    expect(() => machine.assertTransition('READY_FOR_REVIEW', 'APPROVED', {
      ...complete,
      hasBlockingFindings: true,
    })).toThrow('BLOCKING_FINDINGS');
  });

  it('requires a reason for the TDD exception and a non-empty commit to close', () => {
    expect(() => machine.assertTransition('TESTS_DEFINED', 'TDD_EXCEPTION_APPROVED', {
      ...complete,
      tddExceptionReason: '   ',
    })).toThrow('TDD_EXCEPTION_REASON_REQUIRED');
    expect(() => machine.assertTransition('APPROVED', 'CLOSED', {
      ...complete,
      commitSha: '  ',
    })).toThrow('COMMIT_REQUIRED');
  });

  it('allows returning from changes required only after tests are defined', () => {
    expect(() => machine.assertTransition('CHANGES_REQUIRED', 'TESTS_DEFINED', {
      ...complete,
      testsDefined: false,
    })).toThrow('TESTS_REQUIRED');
    expect(() => machine.assertTransition('CHANGES_REQUIRED', 'TESTS_DEFINED', complete))
      .not.toThrow();
  });
});
