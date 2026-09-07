export type WorkItemScopeRepository = {
  repositoryKey: string;
  paths: string[];
};

export type WorkItemScope = {
  repositories: WorkItemScopeRepository[];
};

export type ScopeIssue = {
  code: 'SCOPE_EMPTY' | 'SCOPE_REPOSITORY_DUPLICATE' | 'SCOPE_PATH_INVALID';
  message: string;
};

export function validateWorkItemScope(scope: WorkItemScope): ScopeIssue[] {
  const issues: ScopeIssue[] = [];

  if (!scope.repositories.length) {
    issues.push({
      code: 'SCOPE_EMPTY',
      message: 'A fatia deve declarar ao menos um repositório alvo.',
    });
  }

  const repositories = new Set<string>();
  for (const repository of scope.repositories) {
    if (repositories.has(repository.repositoryKey)) {
      issues.push({
        code: 'SCOPE_REPOSITORY_DUPLICATE',
        message: `O repositório ${repository.repositoryKey} foi declarado mais de uma vez.`,
      });
    }
    repositories.add(repository.repositoryKey);

    for (const pattern of repository.paths) {
      if (!pattern.trim() || pattern.startsWith('/') || /^[A-Za-z]:[\\/]/.test(pattern) || pattern.split(/[\\/]/).includes('..')) {
        issues.push({
          code: 'SCOPE_PATH_INVALID',
          message: `O padrão de caminho ${pattern || '<vazio>'} não é relativo ao repositório.`,
        });
      }
    }
  }

  return issues;
}

export function decodeWorkItemScope(value: string | null | undefined): WorkItemScope | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as WorkItemScope;
    return parsed && Array.isArray(parsed.repositories) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
