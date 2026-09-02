export type WorkflowContextInput = {
  current: {
    projectKey: string;
    featureKey: string;
    phaseKey: string;
    itemKey: string;
    state: string;
    nextAllowedTransition?: string;
  };
  authorization?: {
    instruction: string;
    allowedEffects: string[];
    forbiddenEffects: string[];
  };
  baselines: Array<{
    repository: string;
    branch: string;
    sha: string;
    dirty: boolean;
  }>;
  acceptanceCriteria: Array<{ key: string; statement: string }>;
  durableDecisions: Array<{ key: string; title: string }>;
  unresolvedItems: Array<{
    key: string;
    description: string;
    blocking: boolean;
  }>;
  recentSlices: Array<{
    key: string;
    state: string;
    result: string;
    summary: string;
    commitRefs: string[];
  }>;
  olderSummaries: Array<{ key: string; summary: string }>;
  requiredChecks: Array<{ key: string; description: string }>;
};

export type WorkflowContext = WorkflowContextInput & {
  truncated?: boolean;
};

const serializedLength = (value: WorkflowContext): number =>
  JSON.stringify(value).length;

export function buildWorkflowContext(
  input: WorkflowContextInput,
  maxChars = 12_000,
): WorkflowContext {
  if (maxChars < 512) {
    throw new Error('CONTEXT_BUDGET_TOO_SMALL');
  }

  const complete: WorkflowContext = { ...input };

  if (serializedLength(complete) <= maxChars) {
    return complete;
  }

  const compact: WorkflowContext = {
    current: input.current,
    authorization: input.authorization
      ? {
          instruction: input.authorization.instruction,
          allowedEffects: input.authorization.allowedEffects,
          forbiddenEffects: input.authorization.forbiddenEffects,
        }
      : undefined,
    baselines: input.baselines,
    acceptanceCriteria: [],
    durableDecisions: [],
    unresolvedItems: [],
    recentSlices: [],
    olderSummaries: [],
    requiredChecks: [],
    truncated: true,
  };

  const collections: Array<keyof Pick<
    WorkflowContext,
    | 'durableDecisions'
    | 'unresolvedItems'
    | 'requiredChecks'
    | 'recentSlices'
    | 'acceptanceCriteria'
    | 'olderSummaries'
  >> = [
    'durableDecisions',
    'unresolvedItems',
    'requiredChecks',
    'recentSlices',
    'acceptanceCriteria',
    'olderSummaries',
  ];

  for (const collection of collections) {
    const entries = input[collection] as Array<unknown>;

    for (const entry of entries) {
      const currentEntries = compact[collection] as Array<unknown>;
      currentEntries.push(entry);

      if (serializedLength(compact) > maxChars) {
        currentEntries.pop();
        break;
      }
    }
  }

  while (serializedLength(compact) > maxChars) {
    const removableCollection = [
      'acceptanceCriteria',
      'olderSummaries',
      'recentSlices',
      'requiredChecks',
      'unresolvedItems',
      'durableDecisions',
    ].find((key) => (compact[key as keyof WorkflowContext] as Array<unknown>).length);

    if (!removableCollection) {
      throw new Error('CONTEXT_BUDGET_TOO_SMALL');
    }

    (compact[removableCollection as keyof WorkflowContext] as Array<unknown>).pop();
  }

  return compact;
}
