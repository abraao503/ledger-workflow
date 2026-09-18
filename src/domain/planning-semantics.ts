export type SemanticStatus = 'OK' | 'REVIEW_REQUIRED' | 'BLOCKED';

export type SemanticIssue = {
  code:
    | 'NO_PRIMARY_OUTCOME'
    | 'MULTIPLE_PRIMARY_OUTCOMES'
    | 'NO_ACTION_TRIGGER'
    | 'NO_OBSERVABLE_CRITERION'
    | 'FORBIDDEN_OUTCOME_WITHOUT_EXPECTED'
    | 'FORBIDDEN_CRITERION_NOT_TRACEABLE'
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
  useCases: Array<{ key: string; trigger?: string; expectedOutcome: string }>;
  criteria: Array<{
    key: string;
    useCaseKey?: string;
    evidenceKind?: string;
    polarity?: string;
  }>;
  tests: Array<{ key: string; criterionKey?: string }>;
  requiresTests?: boolean;
}): SemanticPlanAssessment {
  const issues: SemanticIssue[] = [];
  const useCaseKeys = new Set(input.useCases.map((useCase) => useCase.key));
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

  for (const useCase of input.useCases) {
    if (!normalize(useCase.trigger)) {
      issues.push({
        code: 'NO_ACTION_TRIGGER',
        severity: 'ERROR',
        message: `O caso de uso ${useCase.key} não declara a ação ou gatilho da jornada.`,
        suggestion: 'Descreva o evento ou ação que inicia a jornada observável.',
      });
    }
  }

  const expectedCriteria = input.criteria.filter((criterion) => criterion.polarity !== 'FORBIDDEN');
  const forbiddenCriteria = input.criteria.filter((criterion) => criterion.polarity === 'FORBIDDEN');
  const observableExpectedCriteria = expectedCriteria.filter((criterion) => (
    Boolean(normalize(criterion.evidenceKind))
  ));

  if (!observableExpectedCriteria.length) {
    issues.push({
      code: 'NO_OBSERVABLE_CRITERION',
      severity: 'ERROR',
      message: 'A jornada precisa de ao menos um critério EXPECTED com evidência observável.',
      suggestion: 'Associe um critério EXPECTED a uma categoria de evidência, como PERSISTENCE, UI ou HTTP_RESPONSE.',
    });
  }

  if (forbiddenCriteria.length && !expectedCriteria.length) {
    issues.push({
      code: 'FORBIDDEN_OUTCOME_WITHOUT_EXPECTED',
      severity: 'ERROR',
      message: 'Critérios FORBIDDEN não podem substituir o resultado esperado principal.',
      suggestion: 'Mantenha ao menos um critério EXPECTED para o resultado principal da jornada.',
    });
  }

  const criterionKeys = new Set(input.criteria.map((criterion) => criterion.key));
  const testedCriteria = new Set(
    input.tests
      .map((test) => test.criterionKey)
      .filter((criterionKey): criterionKey is string => Boolean(criterionKey)),
  );

  for (const criterion of input.criteria) {
    const isForbidden = criterion.polarity === 'FORBIDDEN';
    if (!criterion.useCaseKey || !useCaseKeys.has(criterion.useCaseKey)) {
      issues.push({
        code: isForbidden ? 'FORBIDDEN_CRITERION_NOT_TRACEABLE' : 'CRITERION_NOT_TRACEABLE',
        severity: 'ERROR',
        message: isForbidden
          ? `O critério FORBIDDEN ${criterion.key} não está ligado a um caso de uso existente.`
          : `O critério ${criterion.key} não está ligado a um caso de uso existente.`,
        suggestion: isForbidden
          ? 'Associe o critério FORBIDDEN ao caso de uso cujo efeito proibido deve ser observado.'
          : 'Associe o critério ao caso de uso que produz o resultado.',
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

function normalize(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase() ?? '';
}
