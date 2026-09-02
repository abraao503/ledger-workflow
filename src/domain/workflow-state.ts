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
  'CLOSED',
] as const;

export type WorkItemState = (typeof workItemStates)[number];

export type TransitionContext = {
  requirementsComplete?: boolean;
  authorized?: boolean;
  testsDefined?: boolean;
  redEvidence?: boolean;
  redEvidenceSha?: string;
  currentSha?: string;
  tddExceptionReason?: string;
  greenEvidence?: boolean;
  greenEvidenceSha?: string;
  reviewApproved?: boolean;
  hasBlockingFindings?: boolean;
  changesRequired?: boolean;
  commitSha?: string;
  blockReason?: string;
};

export class WorkflowTransitionError extends Error {
  constructor(
    public readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'WorkflowTransitionError';
  }
}

const transitionError = (code: string): never => {
  throw new WorkflowTransitionError(code);
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

    if (to === 'BLOCKED') {
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

      if (
        !context.currentSha ||
        !context.redEvidenceSha ||
        context.redEvidenceSha !== context.currentSha
      ) {
        transitionError('RED_EVIDENCE_STALE');
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
      if (!context.greenEvidence) {
        transitionError('GREEN_EVIDENCE_REQUIRED');
      }

      if (
        !context.currentSha ||
        !context.greenEvidenceSha ||
        context.greenEvidenceSha !== context.currentSha
      ) {
        transitionError('GREEN_EVIDENCE_STALE');
      }

      return;
    }

    if (from === 'GREEN_CONFIRMED' && to === 'READY_FOR_REVIEW') {
      return;
    }

    if (from === 'READY_FOR_REVIEW' && to === 'APPROVED') {
      if (!context.reviewApproved) {
        transitionError('REVIEW_REQUIRED');
      }

      if (context.hasBlockingFindings) {
        transitionError('BLOCKING_FINDINGS');
      }

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

      return;
    }

    transitionError(`INVALID_TRANSITION:${from}:${to}`);
  }
}
