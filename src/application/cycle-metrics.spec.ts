import {
  calculateCycleMetrics,
  createE2EPreflight,
  parsePersistedCycleMetrics,
} from './cycle-metrics.js';

describe('cycle metrics', () => {
  it('separates elapsed state time from validation command duration', () => {
    const metrics = calculateCycleMetrics({
      item: {
        state: 'IMPLEMENTING',
        createdAt: '2026-01-01T10:00:00.000Z',
        updatedAt: '2026-01-01T10:08:00.000Z',
      },
      events: [
        {
          type: 'ITEM_TRANSITIONED',
          payloadJson: JSON.stringify({ from: 'DRAFT', to: 'READY' }),
          createdAt: '2026-01-01T10:01:00.000Z',
        },
        {
          type: 'ITEM_TRANSITIONED',
          payloadJson: JSON.stringify({ from: 'READY', to: 'IMPLEMENTING' }),
          createdAt: '2026-01-01T10:03:00.000Z',
        },
      ],
      validations: [
        {
          purpose: 'GREEN', resultKind: 'PASS', durationMs: 250,
          summaryJson: '{}', createdAt: '2026-01-01T10:04:00.000Z',
        },
        {
          purpose: 'CHECK', resultKind: 'PASS', durationMs: 0,
          summaryJson: JSON.stringify({ reusedFromPurpose: 'GREEN' }),
          createdAt: '2026-01-01T10:05:00.000Z',
        },
      ],
      asOf: '2026-01-01T10:08:00.000Z',
    });

    expect(metrics).toMatchObject({
      totalElapsedMs: 480_000,
      transitions: 2,
      stateDurationsMs: {
        DRAFT: 60_000,
        READY: 120_000,
        IMPLEMENTING: 300_000,
      },
      validations: {
        attempts: 2,
        executed: 1,
        reused: 1,
        commandDurationMs: 250,
      },
    });
    expect(metrics.validations.byPurpose.CHECK).toMatchObject({ attempts: 1, reused: 1 });
  });

  it('round-trips the compacted metric summary without validation logs', () => {
    const metrics = calculateCycleMetrics({
      item: {
        state: 'CLOSED',
        createdAt: '2026-01-01T10:00:00.000Z',
        updatedAt: '2026-01-01T10:01:00.000Z',
      },
      events: [],
      validations: [{
        purpose: 'GREEN', resultKind: 'PASS', durationMs: 100,
        summaryJson: '{}', createdAt: '2026-01-01T10:00:30.000Z',
      }],
    });
    const restored = parsePersistedCycleMetrics(JSON.stringify({ cycleMetrics: metrics }));

    expect(restored).toEqual(metrics);
  });

  it('creates a read-only E2E checklist and explicitly forbids automatic migrations', () => {
    const preflight = createE2EPreflight('chat checklist');

    expect(preflight.checks.map((check) => check.key)).toEqual([
      'environment', 'database', 'migrations', 'session', 'target',
    ]);
    expect(preflight.checks.every((check) => check.readOnly)).toBe(true);
    expect(preflight.safety).toEqual({ automaticMigrations: false, destructiveOperations: false });
    expect(preflight.checks.find((check) => check.key === 'migrations')?.action)
      .toContain('não execute migration');
  });
});
