export type SemanticStatus = 'OK' | 'REVIEW_REQUIRED' | 'BLOCKED';

export type SemanticIssue = {
  code:
    | 'NO_PRIMARY_OUTCOME'
    | 'MULTIPLE_PRIMARY_OUTCOMES'
    | 'CRITERION_NOT_TRACEABLE'
    | 'CRITERION_WITHOUT_TEST'
    | 'ORPHAN_TEST';
  severity: 'WARNING' | 'ERROR';
  message: string;
  suggestion: string;
};

export type SemanticPlanAssessment = {
  status: SemanticStatus;
  issues: SemanticIssue[];
};

export function assessPlanSemantics(input: {
  useCases: Array<{ key: string; expectedOutcome: string }>;
  criteria: Array<{ key: string; useCaseKey?: string }>;
  tests: Array<{ key: string; criterionKey?: string }>;
  requiresTests?: boolean;
}): SemanticPlanAssessment {
  const issues: SemanticIssue[] = [];
  const outcomes = new Set(
    input.useCases
      .map((useCase) => normalize(useCase.expectedOutcome))
      .filter(Boolean),
  );

  if (!outcomes.size) {
    issues.push({
      code: 'NO_PRIMARY_OUTCOME',
      severity: 'ERROR',
      message: 'A fatia precisa declarar um resultado primário observável.',
      suggestion: 'Defina um caso de uso com expectedOutcome explícito.',
    });
  } else if (outcomes.size > 1) {
    issues.push({
      code: 'MULTIPLE_PRIMARY_OUTCOMES',
      severity: 'ERROR',
      message: 'A fatia combina mais de um resultado primário.',
      suggestion: 'Divida a fatia por resultado primário antes de autorizar.',
    });
  }

  const criterionKeys = new Set(input.criteria.map((criterion) => criterion.key));
  const testedCriteria = new Set(
    input.tests
      .map((test) => test.criterionKey)
      .filter((criterionKey): criterionKey is string => Boolean(criterionKey)),
  );

  for (const criterion of input.criteria) {
    if (!criterion.useCaseKey) {
      issues.push({
        code: 'CRITERION_NOT_TRACEABLE',
        severity: 'ERROR',
        message: `O critério ${criterion.key} não está ligado a um caso de uso.`,
        suggestion: 'Associe o critério ao caso de uso que produz o resultado.',
      });
    }

    if (input.requiresTests !== false && !testedCriteria.has(criterion.key)) {
      issues.push({
        code: 'CRITERION_WITHOUT_TEST',
        severity: 'ERROR',
        message: `O critério ${criterion.key} não possui teste associado.`,
        suggestion: 'Associe ao menos um teste ao critério obrigatório.',
      });
    }
  }

  for (const test of input.tests) {
    if (test.criterionKey && !criterionKeys.has(test.criterionKey)) {
      issues.push({
        code: 'ORPHAN_TEST',
        severity: 'WARNING',
        message: `O teste ${test.key} aponta para um critério inexistente.`,
        suggestion: 'Associe o teste a um critério existente ou remova-o.',
      });
    }
  }

  return {
    status: issues.some((issue) => issue.severity === 'ERROR')
      ? 'BLOCKED'
      : issues.length
        ? 'REVIEW_REQUIRED'
        : 'OK',
    issues,
  };
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}
