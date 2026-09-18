import type { PrismaClient } from '@prisma/client';

import { ExecutionMapService } from './execution-map.js';
import { createTestDatabase, type TestDatabase } from '../infrastructure/db/test-database.js';

describe('execution map', () => {
  let database: TestDatabase;
  let client: PrismaClient;
  let service: ExecutionMapService;
  let featureId: string;

  beforeEach(async () => {
    database = createTestDatabase();
    client = database.client;
    service = new ExecutionMapService(client);

    const project = await client.project.create({
      data: { key: 'map', name: 'Execution map', rootPath: '/tmp/execution-map' },
    });
    const template = await client.workflowTemplateVersion.create({
      data: {
        projectId: project.id,
        key: 'default',
        version: 1,
        name: 'Default',
        definitionJson: JSON.stringify({}),
      },
    });
    const feature = await client.feature.create({
      data: {
        projectId: project.id,
        templateId: template.id,
        key: 'F1',
        name: 'Feature one',
        summary: 'Parallel feature',
      },
    });
    featureId = feature.id;

    const createItem = (key: string, title: string, state: string, position: number) => client.workItem.create({
      data: {
        featureId,
        key,
        phaseKey: 'G3',
        position,
        title,
        state,
        requirementsComplete: true,
        tddPolicy: 'OPTIONAL',
        ...(key === 'A' ? { riskTagsJson: '["API_WRITE"]' } : {}),
      },
    });
    const first = await createItem('A', 'Base A', 'IMPLEMENTING', 1);
    const second = await createItem('B', 'Base B', 'IMPLEMENTING', 2);
    const third = await createItem('C', 'Depois de A', 'AUTHORIZED', 3);
    const fourth = await createItem('D', 'Depois de B', 'AUTHORIZED', 4);
    await client.workItemDependency.createMany({
      data: [
        { workItemId: third.id, dependsOnItemId: first.id },
        { workItemId: fourth.id, dependsOnItemId: second.id },
      ],
    });
    await client.workItemLease.create({
      data: {
        workItemId: second.id,
        holder: 'agent:second',
        generation: 1,
        acquiredAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
  });

  afterEach(async () => {
    await database.close();
  });

  it('groups independent waves and exposes the active agent unlock', async () => {
    const result = await service.getExecutionMap({ projectKey: 'map', featureKey: 'F1' });

    expect(result).toMatchObject({
      classification: 'PARALLEL',
      summary: {
        totalItems: 4,
        openItems: 4,
        closedItems: 0,
        activeAgents: 1,
        waveCount: 2,
        maxParallelism: 2,
      },
    });
    expect(result.waves.map((wave) => wave.items.map((item) => item.itemKey))).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    expect(result.agents).toEqual([expect.objectContaining({
      holder: 'agent:second',
      itemKey: 'B',
      unlocks: [expect.objectContaining({ itemKey: 'D' })],
    })]);
    expect(result.items.find((item) => item.itemKey === 'A')).toMatchObject({
      riskTags: ['API_WRITE'],
      requiredCapabilities: ['API_INTEGRATION', 'READ_AFTER_WRITE'],
      validationStatus: 'BLOCKED',
      missingCapabilities: ['API_INTEGRATION', 'READ_AFTER_WRITE'],
    });
  });
});
