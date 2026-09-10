import {
  WorkflowStateMachine,
  WorkflowTransitionError,
  type TransitionContext,
  type WorkItemState,
} from './workflow-state.js';

const baseContext = (): TransitionContext => ({
  requirementsComplete: true,
  authorized: true,
  testsDefined: true,
  redEvidence: true,
  redEvidenceSha: 'sha-1',
  currentSha: 'sha-1',
  redEvidenceFingerprint: 'fingerprint-1',
  currentFingerprint: 'fingerprint-1',
  redEvidenceContentFingerprint: 'content-1',
  currentContentFingerprint: 'content-1',
  greenEvidence: true,
  greenEvidenceSha: 'sha-1',
  greenEvidenceFingerprint: 'fingerprint-1',
  greenEvidenceContentFingerprint: 'content-1',
  reviewApproved: true,
  hasBlockingFindings: false,
  commitSha: 'sha-1',
});

describe('WorkflowStateMachine', () => {
  const machine = new WorkflowStateMachine();

  it('allows the happy path from planning to closure', () => {
    const path: WorkItemState[] = [
      'DRAFT',
      'READY',
      'AUTHORIZED',
      'TESTS_DEFINED',
      'RED_CONFIRMED',
      'IMPLEMENTING',
      'GREEN_CONFIRMED',
      'READY_FOR_REVIEW',
      'APPROVED',
      'CLOSED',
    ];
    const context = baseContext();

    for (let index = 0; index < path.length - 1; index += 1) {
      expect(() =>
        machine.assertTransition(path[index], path[index + 1], context),
      ).not.toThrow();
    }
  });

  it('rejects implementation before explicit authorization', () => {
    const context = { ...baseContext(), authorized: false };

    expect(() => machine.assertTransition('READY', 'AUTHORIZED', context))
      .toThrow(WorkflowTransitionError);
    expect(() => machine.assertTransition('READY', 'AUTHORIZED', context))
      .toThrow('AUTHORIZATION_REQUIRED');
  });

  it('rejects a coding item without tests or RED evidence', () => {
    expect(() =>
      machine.assertTransition('AUTHORIZED', 'TESTS_DEFINED', {
        ...baseContext(),
        testsDefined: false,
      }),
    ).toThrow('TESTS_REQUIRED');

    expect(() =>
      machine.assertTransition('TESTS_DEFINED', 'RED_CONFIRMED', {
        ...baseContext(),
        redEvidence: false,
      }),
    ).toThrow('RED_EVIDENCE_REQUIRED');
  });

  it('allows a documented TDD exception but requires a reason', () => {
    expect(() =>
      machine.assertTransition('TESTS_DEFINED', 'TDD_EXCEPTION_APPROVED', {
        ...baseContext(),
        tddExceptionReason: 'Document-only phase',
      }),
    ).not.toThrow();

    expect(() =>
      machine.assertTransition('TESTS_DEFINED', 'TDD_EXCEPTION_APPROVED', {
        ...baseContext(),
      }),
    ).toThrow('TDD_EXCEPTION_REASON_REQUIRED');
  });

  it('rejects GREEN evidence recorded against another SHA', () => {
    const legacyContext = {
      ...baseContext(),
      currentFingerprint: undefined,
      greenEvidenceFingerprint: undefined,
      currentContentFingerprint: undefined,
      greenEvidenceContentFingerprint: undefined,
    };
    expect(() =>
      machine.assertTransition('IMPLEMENTING', 'GREEN_CONFIRMED', {
        ...legacyContext,
        currentSha: 'sha-2',
      }),
    ).toThrow('GREEN_EVIDENCE_STALE');
  });

  it('rejects evidence from another worktree even when HEAD is unchanged', () => {
    expect(() =>
      machine.assertTransition('IMPLEMENTING', 'GREEN_CONFIRMED', {
        ...baseContext(),
        currentContentFingerprint: 'content-2',
      }),
    ).toThrow('GREEN_EVIDENCE_STALE');

    expect(() =>
      machine.assertTransition('GREEN_CONFIRMED', 'READY_FOR_REVIEW', {
        ...baseContext(),
        currentContentFingerprint: 'content-2',
      }),
    ).toThrow('GREEN_EVIDENCE_STALE');
  });

  it('reports repositories that are still missing GREEN evidence', () => {
    let error: unknown;
    try {
      machine.assertTransition('IMPLEMENTING', 'GREEN_CONFIRMED', {
        ...baseContext(),
        greenEvidence: false,
        greenEvidencePendingRepositories: ['front'],
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: 'GREEN_EVIDENCE_INCOMPLETE',
      details: { pendingRepositoryKeys: ['front'] },
    });
  });

  it('requires content evidence to close and rejects content changed after approval', () => {
    expect(() =>
      machine.assertTransition('APPROVED', 'CLOSED', {
        ...baseContext(),
        greenEvidenceContentFingerprint: undefined,
        currentContentFingerprint: undefined,
      }),
    ).toThrow('GREEN_CONTENT_EVIDENCE_REQUIRED');

    expect(() =>
      machine.assertTransition('APPROVED', 'CLOSED', {
        ...baseContext(),
        currentContentFingerprint: 'content-2',
      }),
    ).toThrow('GREEN_EVIDENCE_STALE');
  });

  it('requires an explanation for a structural RED', () => {
    expect(() =>
      machine.assertTransition('TESTS_DEFINED', 'RED_CONFIRMED', {
        ...baseContext(),
        redEvidenceKind: 'STRUCTURAL',
      }),
    ).toThrow('STRUCTURAL_RED_REASON_REQUIRED');

    expect(() =>
      machine.assertTransition('TESTS_DEFINED', 'RED_CONFIRMED', {
        ...baseContext(),
        redEvidenceKind: 'STRUCTURAL',
        redEvidenceReason: 'o módulo ainda não existe',
      }),
    ).not.toThrow();
  });

  it('does not approve a review with blocking findings', () => {
    expect(() =>
      machine.assertTransition('READY_FOR_REVIEW', 'APPROVED', {
        ...baseContext(),
        hasBlockingFindings: true,
      }),
    ).toThrow('BLOCKING_FINDINGS');
  });

  it('requires a commit before closing an approved item', () => {
    expect(() =>
      machine.assertTransition('APPROVED', 'CLOSED', {
        ...baseContext(),
        commitSha: undefined,
      }),
    ).toThrow('COMMIT_REQUIRED');
  });

  it('keeps a closed item immutable even when a block reason is supplied', () => {
    expect(() => machine.assertTransition('CLOSED', 'BLOCKED', {
      blockReason: 'regressão detectada',
    })).toThrow('CLOSED_ITEM_IMMUTABLE');
  });

  it('keeps a superseded item immutable', () => {
    expect(() => machine.assertTransition('SUPERSEDED', 'DRAFT', {
      blockReason: 'não deve reabrir',
    })).toThrow('SUPERSEDED_ITEM_IMMUTABLE');
  });
});
