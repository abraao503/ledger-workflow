export type SliceSizePolicy = {
  maxUseCases: number;
  maxRequiredCriteria: number;
  maxTests: number;
  maxRepositories: number;
};

export const DEFAULT_SLICE_SIZE_POLICY: Readonly<SliceSizePolicy> = Object.freeze({
  maxUseCases: 2,
  maxRequiredCriteria: 4,
  maxTests: 3,
  maxRepositories: 1,
});

export type SliceSizeMetrics = {
  useCases: number;
  requiredCriteria: number;
  tests: number;
  repositories: number;
};

export type SliceSizeDimension = keyof SliceSizeMetrics;

export type SliceSizeInput = SliceSizeMetrics;

export type SliceSizeViolation = {
  dimension: SliceSizeDimension;
  actual: number;
  limit: number;
  severity: 'WARNING' | 'ERROR';
  message: string;
};

export type SliceSizeAssessment = {
  status: 'OK' | 'SPLIT_RECOMMENDED' | 'EXCEPTION_REQUIRED';
  score: number;
  metrics: SliceSizeMetrics;
  policy: SliceSizePolicy | Readonly<SliceSizePolicy>;
  violations: SliceSizeViolation[];
  suggestions: string[];
};

const dimensions: Array<{
  key: SliceSizeDimension;
  policyKey: keyof SliceSizePolicy;
  suggestion: string;
  message: (actual: number, limit: number) => string;
}> = [
  {
    key: 'useCases',
    policyKey: 'maxUseCases',
    suggestion: 'Divida por resultado primário ou caso de uso.',
    message: (actual, limit) => `${actual} casos de uso excedem o limite de ${limit}.`,
  },
  {
    key: 'requiredCriteria',
    policyKey: 'maxRequiredCriteria',
    suggestion: 'Mantenha critérios de um único resultado primário na mesma fatia.',
    message: (actual, limit) => `${actual} critérios obrigatórios excedem o limite de ${limit}.`,
  },
  {
    key: 'tests',
    policyKey: 'maxTests',
    suggestion: 'Separe testes de implementação, regressão ampla e validação manual.',
    message: (actual, limit) => `${actual} testes excedem o limite de ${limit}.`,
  },
  {
    key: 'repositories',
    policyKey: 'maxRepositories',
    suggestion: 'Separe as camadas; mantenha no máximo um repositório em uma fatia de implementação.',
    message: (actual, limit) => `${actual} repositórios excedem o limite de ${limit}.`,
  },
];

export function assessSliceSize(
  input: SliceSizeInput,
  policy: SliceSizePolicy | Readonly<SliceSizePolicy> = DEFAULT_SLICE_SIZE_POLICY,
): SliceSizeAssessment {
  validateMetrics(input);
  validatePolicy(policy);

  const violations = dimensions
    .map(({ key, policyKey, message }) => {
      const actual = input[key];
      const limit = policy[policyKey];

      if (actual <= limit) {
        return undefined;
      }

      return {
        dimension: key,
        actual,
        limit,
        severity: actual > limit * 2 ? 'ERROR' as const : 'WARNING' as const,
        message: message(actual, limit),
      } satisfies SliceSizeViolation;
    })
    .filter((violation): violation is SliceSizeViolation => Boolean(violation));

  return {
    status: violations.some((violation) => violation.severity === 'ERROR')
      ? 'EXCEPTION_REQUIRED'
      : violations.length > 0
        ? 'SPLIT_RECOMMENDED'
        : 'OK',
    score: violations.length,
    metrics: { ...input },
    policy,
    violations,
    suggestions: violations.map((violation) => (
      dimensions.find((dimension) => dimension.key === violation.dimension)?.suggestion
    )).filter((suggestion): suggestion is string => Boolean(suggestion)),
  };
}

function validateMetrics(input: SliceSizeInput): void {
  for (const dimension of dimensions) {
    const value = input[dimension.key];
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`SLICE_SIZE_METRIC_INVALID:${dimension.key}`);
    }
  }
}

function validatePolicy(policy: SliceSizePolicy | Readonly<SliceSizePolicy>): void {
  for (const dimension of dimensions) {
    const value = policy[dimension.policyKey];
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`SLICE_SIZE_POLICY_INVALID:${dimension.policyKey}`);
    }
  }
}
