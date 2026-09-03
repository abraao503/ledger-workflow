import {
  buildWorkflowContext,
  type WorkflowContextInput,
} from './workflow-context.js';

const input = (): WorkflowContextInput => ({
  current: {
    projectKey: 'carara',
    featureKey: 'E6',
    phaseKey: 'G3',
    itemKey: '05',
    state: 'AUTHORIZED',
    nextAllowedTransition: 'TESTS_DEFINED',
  },
  currentEvidence: {
    outcome: 'tools do núcleo concluídas',
    commitRef: 'commit-05',
    validations: [{
      purpose: 'GREEN',
      result: 'PASS',
      profileKey: 'related-tests',
      durationMs: 200,
      reused: false,
    }],
    review: {
      verdict: 'APPROVED',
      mode: 'SELF',
      reviewer: 'Codex',
      summary: 'critérios atendidos',
    },
  },
  authorization: {
    instruction: 'vamos para a próxima fatia',
    allowedEffects: ['api local'],
    forbiddenEffects: ['provider real', 'migration aplicada'],
  },
  baselines: [
    { repository: 'api', branch: 'dev', sha: '60c0a81', dirty: false },
  ],
  acceptanceCriteria: [
    { key: 'AC-01', statement: 'tool de transferência valida ownership' },
  ],
  durableDecisions: [
    { key: 'D-01', title: 'runtime operacional não usa Deal/Pipeline' },
  ],
  unresolvedItems: [
    { key: 'P-01', description: 'provider real ainda pendente', blocking: false },
  ],
  recentSlices: [
    {
      key: '04',
      state: 'CLOSED',
      result: 'PASS_LOCAL',
      summary: 'runtime, buffer e execution',
      commitRefs: ['60c0a81'],
    },
  ],
  olderSummaries: [
    { key: 'E5', summary: 'inbox humana e realtime concluídos' },
  ],
  requiredChecks: [
    { key: 'test-modified', description: 'testes relacionados da API' },
  ],
});

describe('buildWorkflowContext', () => {
  it('returns the current item and durable information without raw logs', () => {
    const result = buildWorkflowContext(input());

    expect(result.current.itemKey).toBe('05');
    expect(result.durableDecisions).toEqual(input().durableDecisions);
    expect(result.unresolvedItems).toEqual(input().unresolvedItems);
    expect(result.currentEvidence).toEqual(input().currentEvidence);
    expect(JSON.stringify(result)).not.toContain('log');
  });

  it('keeps the response under the configured character budget', () => {
    const result = buildWorkflowContext(
      {
        ...input(),
        acceptanceCriteria: Array.from({ length: 100 }, (_, index) => ({
          key: `AC-${index}`,
          statement: 'x'.repeat(500),
        })),
      },
      1_000,
    );

    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_000);
    expect(result.truncated).toBe(true);
    expect(result.current.itemKey).toBe('05');
  });
});
