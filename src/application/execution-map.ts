import type { PrismaClient } from '@prisma/client';

import { fail } from './errors.js';
import { decodeJson } from './json.js';
import type {
  ExecutionMapDependency,
  ExecutionMapItem,
  ExecutionMapRequest,
  ExecutionMapResult,
} from './types.js';
import { assessValidationCoverage } from '../domain/validation-requirements.js';

type ExecutionMapRow = {
  id: string;
  key: string;
  title: string;
  state: string;
  position: number;
  riskTagsJson: string;
  tests: Array<{ runnerProfileKey: string | null }>;
  featureKey: string;
  parentItemId: string | null;
  childItems: Array<{ id: string }>;
  dependencies: Array<{
    dependsOnItem: {
      key: string;
      title: string;
      state: string;
      feature: { key: string };
    };
  }>;
  dependents: Array<{
    workItem: {
      key: string;
      title: string;
      state: string;
      feature: { key: string };
    };
  }>;
  leases: Array<{
    holder: string;
    generation: number;
    expiresAt: Date;
  }>;
};

/**
 * Read model used by agents and the dashboard to understand current execution
 * waves without loading full item records, validations or logs.
 */
export class ExecutionMapService {
  constructor(private readonly db: PrismaClient) {}

  async getExecutionMap(input: ExecutionMapRequest): Promise<ExecutionMapResult> {
    const project = await this.db.project.findUnique({
      where: { key: input.projectKey },
      select: { id: true, key: true, name: true },
    });
    if (!project) {
      fail('PROJECT_NOT_FOUND');
    }
    const currentProject = project as NonNullable<typeof project>;

    const [features, profiles] = await Promise.all([
      this.db.feature.findMany({
        where: { projectId: currentProject.id },
        orderBy: { key: 'asc' },
        select: {
          key: true,
          items: {
            orderBy: { position: 'asc' },
            select: {
              id: true,
              key: true,
              title: true,
              state: true,
              position: true,
              riskTagsJson: true,
              tests: { select: { runnerProfileKey: true } },
              parentItemId: true,
              childItems: { select: { id: true } },
              dependencies: {
                orderBy: { createdAt: 'asc' },
                select: {
                  dependsOnItem: {
                    select: {
                      key: true,
                      title: true,
                      state: true,
                      feature: { select: { key: true } },
                    },
                  },
                },
              },
              dependedOnBy: {
                orderBy: { createdAt: 'asc' },
                select: {
                  workItem: {
                    select: {
                      key: true,
                      title: true,
                      state: true,
                      feature: { select: { key: true } },
                    },
                  },
                },
              },
              leases: {
                where: { releasedAt: null },
                orderBy: { generation: 'desc' },
                take: 1,
                select: { holder: true, generation: true, expiresAt: true },
              },
            },
          },
        },
      }),
      this.db.validationProfile.findMany({
        where: { active: true, repository: { projectId: currentProject.id } },
        select: { key: true, capabilitiesJson: true },
        orderBy: { key: 'asc' },
      }),
    ]);
    const validationProfiles = profiles.map((profile) => ({
      key: profile.key,
      capabilities: decodeJson<string[]>(profile.capabilitiesJson, []),
    }));

    if (input.featureKey && !features.some((feature) => feature.key === input.featureKey)) {
      fail('FEATURE_NOT_FOUND');
    }

    const rows = features.flatMap((feature) => feature.items.map((item) => ({
      ...item,
      featureKey: feature.key,
      dependents: item.dependedOnBy,
    }))) as ExecutionMapRow[];
    const parentIds = new Set(rows.flatMap((row) => row.childItems.map((child) => child.id)));
    const effectiveRows = rows.filter((row) => !parentIds.has(row.id) && row.state !== 'SUPERSEDED');
    const effectiveById = new Map(effectiveRows.map((row) => [row.id, row]));
    const selectedRows = effectiveRows.filter((row) => !input.featureKey || row.featureKey === input.featureKey);
    const openRows = selectedRows.filter((row) => row.state !== 'CLOSED');
    const openIds = new Set(openRows.map((row) => row.id));
    const rowByKey = new Map(effectiveRows.map((row) => [`${row.featureKey}:${row.key}`, row]));

    const waveCache = new Map<string, number>();
    const visiting = new Set<string>();
    const getWave = (row: ExecutionMapRow): number => {
      const cached = waveCache.get(row.id);
      if (cached !== undefined) {
        return cached;
      }
      if (visiting.has(row.id)) {
        // Cycles are rejected by the ledger. Keeping a deterministic fallback
        // here prevents a stale/corrupt graph from taking down the dashboard.
        return 0;
      }
      visiting.add(row.id);
      const wave = row.dependencies.reduce((highest, dependency) => {
        const dependencyRow = rowByKey.get(
          `${dependency.dependsOnItem.feature.key}:${dependency.dependsOnItem.key}`,
        );
        if (!dependencyRow || dependencyRow.state === 'CLOSED' || !openIds.has(dependencyRow.id)) {
          return highest;
        }
        return Math.max(highest, getWave(dependencyRow) + 1);
      }, 0);
      visiting.delete(row.id);
      waveCache.set(row.id, wave);
      return wave;
    };

    const dependencyRef = (
      dependency: {
        key: string;
        title: string;
        state: string;
        feature: { key: string };
      },
    ): ExecutionMapDependency => ({
      featureKey: dependency.feature.key,
      itemKey: dependency.key,
      title: dependency.title,
      state: dependency.state,
      ...(input.featureKey && dependency.feature.key !== input.featureKey ? { external: true } : {}),
    });

    const now = new Date();
    const itemById = new Map<string, ExecutionMapItem>();
    for (const row of selectedRows) {
      const lease = row.leases[0];
      const expired = Boolean(lease && lease.expiresAt <= now);
      const validation = assessValidationCoverage({
        riskTags: decodeJson<string[]>(row.riskTagsJson, []),
        tests: row.tests,
        profiles: validationProfiles,
      });
      itemById.set(row.id, {
        featureKey: row.featureKey,
        itemKey: row.key,
        title: row.title,
        state: row.state,
        position: row.position,
        wave: row.state === 'CLOSED' ? null : getWave(row),
        dependencies: row.dependencies.map((dependency) => dependencyRef(dependency.dependsOnItem)),
        dependents: row.dependents.map((dependent) => dependencyRef(dependent.workItem)),
        riskTags: validation.riskTags,
        requiredCapabilities: validation.requiredCapabilities,
        coveredCapabilities: validation.coveredCapabilities,
        missingCapabilities: validation.missingCapabilities,
        validationStatus: validation.status,
        ...(lease ? {
          lease: {
            holder: lease.holder,
            generation: lease.generation,
            expiresAt: lease.expiresAt.toISOString(),
            expired,
            active: !expired,
          },
        } : {}),
      });
    }

    const items = selectedRows
      .map((row) => itemById.get(row.id) as ExecutionMapItem)
      .sort((left, right) => left.position - right.position || left.itemKey.localeCompare(right.itemKey));
    const openSelectedItems = items.filter((item) => item.state !== 'CLOSED');
    const waveGroups = new Map<number, ExecutionMapItem[]>();
    for (const item of openSelectedItems) {
      const wave = item.wave ?? 0;
      const group = waveGroups.get(wave) ?? [];
      group.push(item);
      waveGroups.set(wave, group);
    }
    const waves = [...waveGroups.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, waveItems]) => ({
        index,
        items: waveItems.sort((left, right) => left.position - right.position || left.itemKey.localeCompare(right.itemKey)),
      }));
    const hasEdges = openSelectedItems.some((item) => item.dependencies.some((dependency) => {
      const dependencyRow = rowByKey.get(`${dependency.featureKey}:${dependency.itemKey}`);
      return dependencyRow ? openIds.has(dependencyRow.id) : false;
    }));
    const maxParallelism = waves.reduce((maximum, wave) => Math.max(maximum, wave.items.length), 0);
    const classification = openRows.length === 0
      ? 'EMPTY'
      : !hasEdges
        ? 'UNCLASSIFIED'
        : maxParallelism > 1
          ? 'PARALLEL'
          : 'LINEAR';

    const agents = selectedRows.flatMap((row) => {
      const lease = row.leases[0];
      if (!lease || lease.expiresAt <= now) {
        return [];
      }
      const item = itemById.get(row.id) as ExecutionMapItem;
      return [{
        holder: lease.holder,
        featureKey: row.featureKey,
        itemKey: row.key,
        title: row.title,
        state: row.state,
        generation: lease.generation,
        expiresAt: lease.expiresAt.toISOString(),
        unlocks: row.dependents
          .filter((dependent) => {
            const dependentRow = rowByKey.get(`${dependent.workItem.feature.key}:${dependent.workItem.key}`);
            return Boolean(dependentRow && effectiveById.has(dependentRow.id) && dependentRow.state !== 'CLOSED');
          })
          .map((dependent) => dependencyRef(dependent.workItem)),
      }];
    });

    return {
      project: { key: currentProject.key, name: currentProject.name },
      selection: { ...(input.featureKey ? { featureKey: input.featureKey } : {}) },
      classification,
      summary: {
        totalItems: items.length,
        openItems: openSelectedItems.length,
        closedItems: items.length - openSelectedItems.length,
        activeAgents: agents.length,
        waveCount: waves.length,
        maxParallelism,
      },
      waves,
      items,
      agents,
    };
  }
}
