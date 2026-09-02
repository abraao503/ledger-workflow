import {
  buildWorkflowContext,
  type WorkflowContextInput,
} from './workflow-context.js';

const baseInput = (): WorkflowContextInput => ({
  current: {
    projectKey: 'carara',
    featureKey: 'E6',
    phaseKey: 'G3',
    itemKey: '05',
    state: 'IMPLEMENTING',
    nextAllowedTransition: 'GREEN_CONFIRMED',
  },
  authorization: {
    instruction: 'implementar a fatia',
    allowedEffects: ['código local'],
    forbiddenEffects: ['provider real'],
  },
  baselines: [{ repository: 'api', branch: 'dev', sha: 'sha-1', dirty: false }],
  acceptanceCriteria: [{ key: 'AC-01', statement: 'ownership vigente' }],
  durableDecisions: [{ key: 'D-01', title: 'runtime por workspace' }],
  unresolvedItems: [{ key: 'P-01', description: 'wire contract pendente', blocking: false }],
  recentSlices: [{
    key: '04', state: 'CLOSED', result: 'PASS', summary: 'runtime', commitRefs: ['sha-0'],
  }],
  olderSummaries: [{ key: 'E5', summary: 'resumo' }],
  requiredChecks: [{ key: 'T-01', description: 'testes relacionados' }],
});

describe('buildWorkflowContext edge cases', () => {
  it('rejects an impossible minimum budget', () => {
    expect(() => buildWorkflowContext(baseInput(), 511))
      .toThrow('CONTEXT_BUDGET_TOO_SMALL');
  });

  it('keeps current state, authorization and baseline while dropping optional collections', () => {
    const result = buildWorkflowContext({
      ...baseInput(),
      authorization: {
        instruction: 'x'.repeat(2_000),
        allowedEffects: ['local'],
        forbiddenEffects: ['external'],
      },
      acceptanceCriteria: Array.from({ length: 100 }, (_, index) => ({
        key: `AC-${index}`,
        statement: 'x'.repeat(500),
      })),
    }, 2_500);

    expect(result.truncated).toBe(true);
    expect(result.current.itemKey).toBe('05');
    expect(result.authorization?.instruction).toHaveLength(2_000);
    expect(result.baselines).toEqual(baseInput().baselines);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(2_500);
  });

  it('fails instead of violating the budget when the durable base cannot fit', () => {
    expect(() => buildWorkflowContext({
      ...baseInput(),
      authorization: {
        instruction: 'x'.repeat(10_000),
        allowedEffects: [],
        forbiddenEffects: [],
      },
    }, 2_000)).toThrow('CONTEXT_BUDGET_TOO_SMALL');
  });
});
