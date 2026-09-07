import {
  DEFAULT_SLICE_SIZE_POLICY,
  assessSliceSize,
} from './slice-sizing.js';

describe('assessSliceSize', () => {
  it('keeps a small slice within the default execution budget', () => {
    expect(assessSliceSize({
      useCases: 1,
      requiredCriteria: 2,
      tests: 3,
      repositories: 1,
    })).toEqual({
      status: 'OK',
      score: 0,
      metrics: {
        useCases: 1,
        requiredCriteria: 2,
        tests: 3,
        repositories: 1,
      },
      policy: DEFAULT_SLICE_SIZE_POLICY,
      violations: [],
      suggestions: [],
    });
  });

  it('recommends splitting a slice when it exceeds one or more limits', () => {
    const result = assessSliceSize({
      useCases: 3,
      requiredCriteria: 6,
      tests: 5,
      repositories: 2,
    });

    expect(result.status).toBe('SPLIT_RECOMMENDED');
    expect(result.score).toBe(4);
    expect(result.violations.map((violation) => violation.dimension)).toEqual([
      'useCases',
      'requiredCriteria',
      'tests',
      'repositories',
    ]);
    expect(result.suggestions).toEqual([
      'Divida por resultado primário ou caso de uso.',
      'Mantenha critérios de um único resultado primário na mesma fatia.',
      'Separe testes de implementação, regressão ampla e validação manual.',
      'Separe as camadas; mantenha no máximo um repositório em uma fatia de implementação.',
    ]);
  });

  it('requires an explicit exception for a slice far above the policy', () => {
    const result = assessSliceSize({
      useCases: 5,
      requiredCriteria: 2,
      tests: 1,
      repositories: 1,
    });

    expect(result.status).toBe('EXCEPTION_REQUIRED');
    expect(result.violations).toEqual([{
      dimension: 'useCases',
      actual: 5,
      limit: DEFAULT_SLICE_SIZE_POLICY.maxUseCases,
      severity: 'ERROR',
      message: '5 casos de uso excedem o limite de 2.',
    }]);
  });

  it('accepts a project policy and produces deterministic results', () => {
    const input = {
      useCases: 2,
      requiredCriteria: 3,
      tests: 4,
      repositories: 2,
    };
    const policy = {
      maxUseCases: 2,
      maxRequiredCriteria: 3,
      maxTests: 4,
      maxRepositories: 2,
    };

    expect(assessSliceSize(input, policy)).toEqual(assessSliceSize(input, policy));
    expect(assessSliceSize(input, policy).status).toBe('OK');
  });
});
