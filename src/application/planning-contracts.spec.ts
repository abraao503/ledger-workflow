import type { PrismaClient } from '@prisma/client';

import { WorkflowLedger } from './workflow-ledger.js';
import type { GitReadPort } from './types.js';
import { createTestDatabase, type TestDatabase } from '../infrastructure/db/test-database.js';

describe('planning contracts for observable journeys and risk', () => {
  let database: TestDatabase;
  let client: PrismaClient;
  let ledger: WorkflowLedger;

  beforeEach(() => {
    database = createTestDatabase();
    client = database.client;
    const fakeGit: GitReadPort = {
      capture: async () => ({
        branch: 'main',
        sha: 'sha-contracts',
        dirty: false,
        changedFiles: [],
        fingerprint: 'fingerprint-contracts',
        contentFingerprint: 'content-contracts',
      }),
    };
    ledger = new WorkflowLedger(client, fakeGit);
  });

  afterEach(async () => {
    await database.close();
  });

  it('persists risk tags, observable criterion metadata, and profile capabilities', async () => {
    await ledger.createProject({
      key: 'contracts',
      name: 'Planning contracts',
      rootPath: '/tmp/planning-contracts',
    });
    await ledger.addRepository({
      projectKey: 'contracts',
      key: 'workflow',
      path: '/tmp/planning-contracts',
      expectedBranch: 'main',
    });
    await ledger.createTemplate({
      projectKey: 'contracts',
      key: 'default',
      name: 'Default',
      definition: {},
    });
    await ledger.createFeature({
      projectKey: 'contracts',
      templateKey: 'default',
      key: 'P7',
      name: 'Observable journeys',
      summary: 'Risk-aware planning',
    });

    await ledger.defineWorkItem({
      projectKey: 'contracts',
      featureKey: 'P7',
      key: '01',
      phaseKey: 'G3',
      position: 1,
      title: 'Persist planning metadata',
      summary: 'Persist observable planning contracts',
      riskTags: ['API_WRITE', 'PRIVATE_DATA'],
      useCases: [
        {
          key: 'UC-01',
          title: 'Plan a verifiable change',
          actor: 'Planner',
          preconditions: 'The project exists',
          trigger: 'The planner defines a slice',
          expectedOutcome: 'The ledger preserves the evidence contract',
        },
      ],
      criteria: [
        {
          key: 'AC-01',
          statement: 'The write is persisted',
          useCaseKey: 'UC-01',
          evidenceKind: 'PERSISTENCE',
          polarity: 'EXPECTED',
        },
        {
          key: 'AC-02',
          statement: 'Private data is not exposed',
          useCaseKey: 'UC-01',
          evidenceKind: 'SECURITY_NEGATIVE',
          polarity: 'FORBIDDEN',
        },
      ],
      tests: [
        {
          key: 'T-01',
          name: 'persists metadata',
          purpose: 'GREEN',
          criterionKey: 'AC-01',
        },
      ],
    } as never);

    const item = await client.workItem.findFirstOrThrow({
      where: { key: '01' },
      include: { criteria: true },
    });

    expect(JSON.parse((item as typeof item & { riskTagsJson?: string }).riskTagsJson ?? '[]'))
      .toEqual(['API_WRITE', 'PRIVATE_DATA']);
    expect(item.criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceKind: 'PERSISTENCE', polarity: 'EXPECTED' }),
      expect.objectContaining({ evidenceKind: 'SECURITY_NEGATIVE', polarity: 'FORBIDDEN' }),
    ]));

    const profile = await ledger.createValidationProfile({
      projectKey: 'contracts',
      repositoryKey: 'workflow',
      key: 'workflow-integration',
      program: 'npm',
      args: ['test'],
      parser: 'JEST',
      capabilities: ['API_INTEGRATION', 'READ_AFTER_WRITE'],
    } as never);

    expect(JSON.parse((profile as typeof profile & { capabilitiesJson?: string }).capabilitiesJson ?? '[]'))
      .toEqual(['API_INTEGRATION', 'READ_AFTER_WRITE']);

    const context = await ledger.getContext({
      projectKey: 'contracts',
      featureKey: 'P7',
      itemKey: '01',
    });
    const record = await ledger.getRecord({
      projectKey: 'contracts',
      featureKey: 'P7',
      itemKey: '01',
    });

    expect((context as typeof context & { riskTags?: string[] }).riskTags)
      .toEqual(['API_WRITE', 'PRIVATE_DATA']);
    expect((record as typeof record & { riskTags?: string[] }).riskTags)
      .toEqual(['API_WRITE', 'PRIVATE_DATA']);
  });
});
