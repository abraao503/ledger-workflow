export const workItemStates = [
  'DRAFT',
  'READY',
  'AUTHORIZED',
  'TESTS_DEFINED',
  'RED_CONFIRMED',
  'TDD_EXCEPTION_APPROVED',
  'IMPLEMENTING',
  'GREEN_CONFIRMED',
  'READY_FOR_REVIEW',
  'APPROVED',
  'CHANGES_REQUIRED',
  'BLOCKED',
  'SUPERSEDED',
  'CLOSED',
] as const;

export type WorkItemState = (typeof workItemStates)[number];

export type TransitionContext = {
  requirementsComplete?: boolean;
  authorized?: boolean;
  testsDefined?: boolean;
  redEvidence?: boolean;
  redEvidenceSha?: string;
  redEvidenceFingerprint?: string;
  redEvidenceContentFingerprint?: string;
  redEvidenceKind?: 'BEHAVIORAL' | 'STRUCTURAL';
  redEvidenceReason?: string;
  currentSha?: string;
  currentFingerprint?: string;
  currentContentFingerprint?: string;
  tddExceptionReason?: string;
  greenEvidence?: boolean;
  greenEvidenceSha?: string;
  greenEvidenceFingerprint?: string;
  greenEvidenceContentFingerprint?: string;
  greenEvidencePendingRepositories?: string[];
  reviewApproved?: boolean;
  hasBlockingFindings?: boolean;
  changesRequired?: boolean;
  commitSha?: string;
  blockReason?: string;
  replanReason?: string;
  sliceSizeStatus?: 'OK' | 'SPLIT_RECOMMENDED' | 'EXCEPTION_REQUIRED';
  sliceSizeApproved?: boolean;
};

export class WorkflowTransitionError extends Error {
  constructor(
    public readonly code: string,
    message = code,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WorkflowTransitionError';
  }
}

const transitionError = (
  code: string,
  message = code,
  details?: Record<string, unknown>,
): never => {
  throw new WorkflowTransitionError(code, message, details);
};

export class WorkflowStateMachine {
  assertTransition(
    from: WorkItemState,
    to: WorkItemState,
    context: TransitionContext = {},
  ): void {
    if (from === to) {
      transitionError('NO_STATE_CHANGE');
    }

    if (from === 'SUPERSEDED') {
      transitionError('SUPERSEDED_ITEM_IMMUTABLE');
    }

    if (to === 'SUPERSEDED') {
      if (from !== 'DRAFT') {
        transitionError(`INVALID_TRANSITION:${from}:${to}`);
      }

      if (!context.replanReason?.trim()) {
        transitionError('REPLAN_REASON_REQUIRED');
      }

      return;
    }

    if (to === 'BLOCKED') {
      if (from === 'CLOSED') {
        transitionError('CLOSED_ITEM_IMMUTABLE');
      }

      if (!context.blockReason?.trim()) {
        transitionError('BLOCK_REASON_REQUIRED');
      }

      return;
    }

    if (from === 'BLOCKED') {
      transitionError('BLOCKED_ITEM_REQUIRES_REOPENING');
    }

    if (from === 'DRAFT' && to === 'READY') {
      if (!context.requirementsComplete) {
        transitionError('REQUIREMENTS_INCOMPLETE');
      }

      if (
        context.sliceSizeStatus &&
        context.sliceSizeStatus !== 'OK' &&
        !context.sliceSizeApproved
      ) {
        transitionError('SLICE_SIZE_APPROVAL_REQUIRED');
      }

      return;
    }

    if (from === 'READY' && to === 'AUTHORIZED') {
      if (!context.authorized) {
        transitionError('AUTHORIZATION_REQUIRED');
      }

      return;
    }

    if (from === 'AUTHORIZED' && to === 'TESTS_DEFINED') {
      if (!context.testsDefined) {
        transitionError('TESTS_REQUIRED');
      }

      return;
    }

    if (from === 'TESTS_DEFINED' && to === 'RED_CONFIRMED') {
      if (!context.redEvidence) {
        transitionError('RED_EVIDENCE_REQUIRED');
      }

      if (!evidenceMatchesCurrent(
        context.redEvidenceContentFingerprint,
        context.currentContentFingerprint,
        context.redEvidenceFingerprint,
        context.currentFingerprint,
        context.redEvidenceSha,
        context.currentSha,
      )) {
        transitionError('RED_EVIDENCE_STALE');
      }

      if (
        context.redEvidenceKind === 'STRUCTURAL' &&
        !context.redEvidenceReason?.trim()
      ) {
        transitionError('STRUCTURAL_RED_REASON_REQUIRED');
      }

      return;
    }

    if (from === 'TESTS_DEFINED' && to === 'TDD_EXCEPTION_APPROVED') {
      if (!context.tddExceptionReason?.trim()) {
        transitionError('TDD_EXCEPTION_REASON_REQUIRED');
      }

      return;
    }

    if (
      (from === 'RED_CONFIRMED' || from === 'TDD_EXCEPTION_APPROVED') &&
      to === 'IMPLEMENTING'
    ) {
      return;
    }

    if (from === 'IMPLEMENTING' && to === 'GREEN_CONFIRMED') {
      assertGreenEvidenceCurrent(context);
      return;
    }

    if (from === 'GREEN_CONFIRMED' && to === 'READY_FOR_REVIEW') {
      assertGreenEvidenceCurrent(context);
      return;
    }

    if (from === 'READY_FOR_REVIEW' && to === 'APPROVED') {
      if (!context.reviewApproved) {
        transitionError('REVIEW_REQUIRED');
      }

      if (context.hasBlockingFindings) {
        transitionError('BLOCKING_FINDINGS');
      }

      assertGreenEvidenceCurrent(context);
      return;
    }

    if (from === 'READY_FOR_REVIEW' && to === 'CHANGES_REQUIRED') {
      if (!context.changesRequired) {
        transitionError('REVIEW_DECISION_REQUIRED');
      }

      return;
    }

    if (from === 'CHANGES_REQUIRED' && to === 'TESTS_DEFINED') {
      if (!context.testsDefined) {
        transitionError('TESTS_REQUIRED');
      }

      return;
    }

    if (from === 'APPROVED' && to === 'CLOSED') {
      if (!context.commitSha?.trim()) {
        transitionError('COMMIT_REQUIRED');
      }

      if (!context.greenEvidenceContentFingerprint || !context.currentContentFingerprint) {
        transitionError('GREEN_CONTENT_EVIDENCE_REQUIRED');
      }

      assertGreenEvidenceCurrent(context);
      return;
    }

    transitionError(`INVALID_TRANSITION:${from}:${to}`);
  }
}

function evidenceMatchesCurrent(
  evidenceContentFingerprint: string | undefined,
  currentContentFingerprint: string | undefined,
  evidenceFingerprint: string | undefined,
  currentFingerprint: string | undefined,
  evidenceSha: string | undefined,
  currentSha: string | undefined,
): boolean {
  if (evidenceContentFingerprint) {
    return Boolean(
      currentContentFingerprint &&
      evidenceContentFingerprint === currentContentFingerprint,
    );
  }

  if (evidenceFingerprint) {
    return Boolean(
      currentFingerprint &&
      evidenceFingerprint === currentFingerprint,
    );
  }

  return Boolean(evidenceSha && currentSha && evidenceSha === currentSha);
}

function assertGreenEvidenceCurrent(context: TransitionContext): void {
  if (!context.greenEvidence) {
    if (context.greenEvidencePendingRepositories?.length) {
      transitionError(
        'GREEN_EVIDENCE_INCOMPLETE',
        'GREEN ainda não foi confirmado em todos os repositórios autorizados',
        { pendingRepositoryKeys: context.greenEvidencePendingRepositories },
      );
    }

    transitionError('GREEN_EVIDENCE_REQUIRED');
  }

  if (!evidenceMatchesCurrent(
    context.greenEvidenceContentFingerprint,
    context.currentContentFingerprint,
    context.greenEvidenceFingerprint,
    context.currentFingerprint,
    context.greenEvidenceSha,
    context.currentSha,
  )) {
    transitionError('GREEN_EVIDENCE_STALE');
  }
}
