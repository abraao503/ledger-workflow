export const cycleMetricStates = [
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

export type CycleMetricState = (typeof cycleMetricStates)[number];

export type CycleValidationMetric = {
  attempts: number;
  executed: number;
  reused: number;
  commandDurationMs: number;
  results: Record<string, number>;
};

export type CycleMetrics = {
  schemaVersion: 1;
  asOf: string;
  totalElapsedMs: number;
  transitions: number;
  stateDurationsMs: Record<string, number>;
  validations: {
    attempts: number;
    executed: number;
    reused: number;
    commandDurationMs: number;
    byPurpose: Record<string, CycleValidationMetric>;
    lastAttemptAt?: string;
  };
};

export type CycleMetricsReport = CycleMetrics & {
  source: 'LIVE' | 'HISTORY';
  projectKey: string;
  featureKey: string;
  itemKey: string;
};

export type CycleMetricsInput = {
  item: {
    state: string;
    createdAt: Date | string;
    updatedAt: Date | string;
  };
  events: Array<{
    type: string;
    payloadJson: string;
    createdAt: Date | string;
  }>;
  validations: Array<{
    purpose: string;
    resultKind: string;
    durationMs: number;
    summaryJson: string;
    createdAt: Date | string;
  }>;
  asOf?: Date | string;
};

export type E2EPreflightCheck = {
  key: 'environment' | 'database' | 'migrations' | 'session' | 'target';
  label: string;
  action: string;
  readOnly: true;
};

export type E2EPreflight = {
  target: string;
  checks: E2EPreflightCheck[];
  safety: {
    automaticMigrations: false;
    destructiveOperations: false;
  };
};

export function calculateCycleMetrics(input: CycleMetricsInput): CycleMetrics {
  const createdAt = toTimestamp(input.item.createdAt);
  const defaultEnd = input.item.state === 'CLOSED'
    ? toTimestamp(input.item.updatedAt)
    : toTimestamp(input.asOf ?? new Date());
  const end = Math.max(createdAt, defaultEnd);
  const stateDurationsMs: Record<string, number> = Object.fromEntries(
    cycleMetricStates.map((state) => [state, 0]),
  );
  const events = input.events
    .map((event, index) => ({ event, index, at: toTimestamp(event.createdAt) }))
    .sort((left, right) => left.at - right.at || left.index - right.index);

  let currentState = 'DRAFT';
  let cursor = createdAt;
  let transitions = 0;

  for (const entry of events) {
    const at = Math.min(end, Math.max(createdAt, entry.at));
    if (at < cursor) continue;
    addDuration(stateDurationsMs, currentState, at - cursor);
    cursor = at;

    const transition = readTransition(entry.event.payloadJson);
    if (!transition || transition.to === transition.from) continue;
    currentState = transition.to;
    transitions += 1;
  }

  addDuration(stateDurationsMs, currentState, Math.max(0, end - cursor));

  const byPurpose: Record<string, CycleValidationMetric> = {};
  let attempts = 0;
  let executed = 0;
  let reused = 0;
  let commandDurationMs = 0;
  let lastAttemptAt: string | undefined;

  for (const validation of input.validations) {
    const purpose = validation.purpose || 'UNKNOWN';
    const bucket = byPurpose[purpose] ??= emptyValidationMetric();
    const summary = parseRecord(validation.summaryJson);
    const wasReused = typeof summary.reusedFromValidationId === 'string' ||
      typeof summary.reusedFromPurpose === 'string';
    bucket.attempts += 1;
    bucket.results[validation.resultKind] = (bucket.results[validation.resultKind] ?? 0) + 1;
    attempts += 1;
    if (wasReused) {
      bucket.reused += 1;
      reused += 1;
    } else {
      bucket.executed += 1;
      executed += 1;
      bucket.commandDurationMs += validation.durationMs;
      commandDurationMs += validation.durationMs;
    }
    const created = toDateString(validation.createdAt);
    if (!lastAttemptAt || created > lastAttemptAt) lastAttemptAt = created;
  }

  return {
    schemaVersion: 1,
    asOf: new Date(end).toISOString(),
    totalElapsedMs: Math.max(0, end - createdAt),
    transitions,
    stateDurationsMs,
    validations: {
      attempts,
      executed,
      reused,
      commandDurationMs,
      byPurpose,
      ...(lastAttemptAt ? { lastAttemptAt } : {}),
    },
  };
}

export function parsePersistedCycleMetrics(value: string): CycleMetrics | undefined {
  const candidate = parseRecord(value).cycleMetrics;
  if (!isCycleMetrics(candidate)) return undefined;
  return candidate;
}

export function createE2EPreflight(target: string): E2EPreflight {
  const normalizedTarget = target.trim();
  if (!normalizedTarget) throw new Error('E2E_TARGET_REQUIRED');

  return {
    target: normalizedTarget,
    checks: [
      {
        key: 'environment',
        label: 'Ambiente',
        action: 'confirme runtime, dependências e os processos necessários para o teste',
        readOnly: true,
      },
      {
        key: 'database',
        label: 'Banco',
        action: 'confirme conexão e disponibilidade do banco de teste sem alterar dados',
        readOnly: true,
      },
      {
        key: 'migrations',
        label: 'Migrations',
        action: 'consulte o status das migrations; não execute migration, reset ou seed automaticamente',
        readOnly: true,
      },
      {
        key: 'session',
        label: 'Sessão',
        action: 'confirme sessão, tenant/workspace e permissões do usuário de teste',
        readOnly: true,
      },
      {
        key: 'target',
        label: 'Alvo',
        action: `confirme que o alvo de teste ${normalizedTarget} corresponde à jornada esperada`,
        readOnly: true,
      },
    ],
    safety: {
      automaticMigrations: false,
      destructiveOperations: false,
    },
  };
}

function emptyValidationMetric(): CycleValidationMetric {
  return { attempts: 0, executed: 0, reused: 0, commandDurationMs: 0, results: {} };
}

function addDuration(target: Record<string, number>, state: string, duration: number): void {
  target[state] = (target[state] ?? 0) + Math.max(0, duration);
}

function readTransition(payloadJson: string): { from: string; to: string } | undefined {
  const payload = parseRecord(payloadJson);
  return typeof payload.from === 'string' && typeof payload.to === 'string'
    ? { from: payload.from, to: payload.to }
    : undefined;
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCycleMetrics(value: unknown): value is CycleMetrics {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.asOf !== 'string') return false;
  return typeof value.totalElapsedMs === 'number' &&
    typeof value.transitions === 'number' &&
    isRecord(value.stateDurationsMs) &&
    isRecord(value.validations);
}

function toTimestamp(value: Date | string): number {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function toDateString(value: Date | string): string {
  return new Date(toTimestamp(value)).toISOString();
}
