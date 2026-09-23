import path from 'node:path';

import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { workItemStates } from '../domain/workflow-state.js';
import { validateWorkItemScope } from '../domain/work-item-scope.js';
import { fail } from './errors.js';
import { decodeJson, encodeJson } from './json.js';
import { validationParserValues } from './types.js';

const repositorySchema = z.object({
  key: z.string().min(1),
  path: z.string().min(1),
  expectedBranch: z.string().optional(),
});

const templateSchema = z.object({
  key: z.string().min(1),
  version: z.number().int().positive().default(1),
  name: z.string().min(1),
  definition: z.record(z.unknown()),
});

const useCaseSchema = z.object({
  key: z.string().min(1),
  title: z.string(),
  actor: z.string(),
  preconditions: z.string(),
  trigger: z.string(),
  expectedOutcome: z.string(),
  invariants: z.array(z.string()).default([]),
});

const criterionSchema = z.object({
  key: z.string().min(1),
  statement: z.string(),
  useCaseKey: z.string().optional(),
  required: z.boolean().default(true),
  evidenceKind: z.enum(['GENERAL', 'HTTP_RESPONSE', 'PERSISTENCE', 'READ_MODEL', 'UI', 'RELOAD', 'SECURITY_NEGATIVE']).default('GENERAL'),
  polarity: z.enum(['EXPECTED', 'FORBIDDEN']).default('EXPECTED'),
});

const testSchema = z.object({
  key: z.string().min(1),
  name: z.string(),
  purpose: z.enum(['RED', 'GREEN', 'CHECK']),
  runnerProfileKey: z.string().optional(),
  testSelector: z.string().min(1).optional(),
  criterionKey: z.string().optional(),
});

const baselineSchema = z.object({
  repositoryKey: z.string().min(1),
  branch: z.string(),
  sha: z.string(),
  dirty: z.boolean(),
  changedFiles: z.array(z.string()).default([]),
});

const scopeSchema = z.object({
  repositories: z.array(z.object({
    repositoryKey: z.string().min(1),
    paths: z.array(z.string()),
  })),
}).superRefine((scope, context) => {
  for (const issue of validateWorkItemScope(scope)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: issue.code });
  }
});

const dependencySchema = z.object({
  featureKey: z.string().min(1),
  itemKey: z.string().min(1),
});

const authorizationSchema = z.object({
  instruction: z.string(),
  actor: z.string(),
  allowedEffects: z.array(z.string()).default([]),
  forbiddenEffects: z.array(z.string()).default([]),
  baselines: z.array(baselineSchema).default([]),
  executionMode: z.enum(['SHARED', 'MANAGED_WORKTREE']).default('SHARED'),
});

const validationSchema = z.object({
  repositoryKey: z.string().min(1),
  profileKey: z.string().min(1),
  purpose: z.enum(['RED', 'GREEN', 'CHECK']),
  status: z.enum(['COMPLETED', 'TIMED_OUT', 'FAILED_TO_START']),
  resultKind: z.enum(['PASS', 'TEST_FAILURE', 'INFRASTRUCTURE_ERROR', 'TIMEOUT']),
  exitCode: z.number().int().nullable().optional(),
  sha: z.string(),
  durationMs: z.number().int().nonnegative(),
  summary: z.record(z.unknown()).default({}),
});

const itemSchema = z.object({
  key: z.string().min(1),
  phaseKey: z.string().min(1),
  position: z.number().int(),
  title: z.string(),
  kind: z.enum(['CODE', 'DOCUMENTATION', 'VALIDATION', 'OTHER']).default('CODE'),
  state: z.enum(workItemStates).default('DRAFT'),
  summary: z.string().optional(),
  tddPolicy: z.enum(['REQUIRED', 'OPTIONAL', 'EXEMPT']).default('REQUIRED'),
  requirementsComplete: z.boolean().optional(),
  currentSha: z.string().optional(),
  scope: scopeSchema.optional(),
  riskTags: z.array(z.enum(['FRONTEND', 'API_READ', 'API_WRITE', 'DATABASE', 'MIGRATION', 'PRIVATE_DATA', 'MULTI_TENANT', 'REALTIME', 'ASYNC_JOB', 'EXTERNAL_INTEGRATION', 'VISUAL_ONLY'])).default([]),
  dependsOn: z.array(dependencySchema).default([]),
  useCases: z.array(useCaseSchema).default([]),
  criteria: z.array(criterionSchema).default([]),
  tests: z.array(testSchema).default([]),
  authorization: authorizationSchema.optional(),
  validations: z.array(validationSchema).default([]),
});

const featureSchema = z.object({
  key: z.string().min(1),
  templateKey: z.string().min(1),
  templateVersion: z.number().int().positive().optional(),
  name: z.string(),
  summary: z.string(),
  status: z.string().default('ACTIVE'),
  currentPhaseKey: z.string().optional(),
  items: z.array(itemSchema).default([]),
});

const planSchema = z.object({
  featureKey: z.string().optional(),
  key: z.string().min(1),
  version: z.number().int().positive().default(1),
  title: z.string(),
  summary: z.string(),
  constraints: z.array(z.string()).default([]),
  outOfScope: z.array(z.string()).default([]),
  sourceRef: z.string().optional(),
});

const decisionSchema = z.object({
  featureKey: z.string().optional(),
  itemKey: z.string().optional(),
  key: z.string().min(1),
  title: z.string(),
  content: z.string(),
  durable: z.boolean().default(true),
  pinned: z.boolean().default(false),
});

const pendingSchema = z.object({
  featureKey: z.string().optional(),
  itemKey: z.string().optional(),
  key: z.string().min(1),
  description: z.string(),
  blocking: z.boolean().default(false),
  resolved: z.boolean().default(false),
  pinned: z.boolean().default(false),
});

const summarySchema = z.object({
  featureKey: z.string().optional(),
  itemKey: z.string().optional(),
  scopeKey: z.string().min(1),
  state: z.string(),
  result: z.string(),
  delivered: z.record(z.unknown()).default({}),
  commits: z.array(z.string()).default([]),
  validations: z.array(z.record(z.unknown())).default([]),
  limitations: z.array(z.string()).default([]),
  pinned: z.boolean().default(false),
});

const validationProfileSchema = z.object({
  repositoryKey: z.string().min(1),
  key: z.string().min(1),
  program: z.enum(['npm', 'npx', 'node', 'pnpm', 'yarn']),
  args: z.array(z.string()).default([]),
  cwd: z.string().default('.'),
  parser: z.enum(validationParserValues),
  capabilities: z.array(z.enum(['BUILD', 'LINT', 'API_INTEGRATION', 'API_READ', 'READ_AFTER_WRITE', 'DATABASE_PERSISTENCE', 'MIGRATION', 'UI_INTERACTION', 'UI_RELOAD', 'PRIVACY_NEGATIVE', 'TENANT_ISOLATION', 'REALTIME_RECONCILIATION', 'ASYNC_CONSISTENCY', 'EXTERNAL_CONTRACT'])).default([]),
  timeoutSeconds: z.number().int().positive().default(60),
  maxOutputBytes: z.number().int().min(1_024).max(2_000_000).default(2_000_000),
}).refine(
  (profile) => !path.isAbsolute(profile.cwd) && !profile.cwd.split(/[\\/]/).includes('..'),
  { message: 'VALIDATION_CWD_INVALID' },
).refine(
  (profile) => profile.timeoutSeconds >= 1 && profile.timeoutSeconds <= 3_600,
  { message: 'VALIDATION_TIMEOUT_INVALID' },
);

export const workflowImportSchema = z.object({
  schemaVersion: z.literal(1),
  importKey: z.string().min(1),
  project: z.object({
    key: z.string().min(1),
    name: z.string(),
    rootPath: z.string().min(1),
    status: z.string().default('ACTIVE'),
  }),
  repositories: z.array(repositorySchema).default([]),
  templates: z.array(templateSchema).default([]),
  plans: z.array(planSchema).default([]),
  features: z.array(featureSchema).default([]),
  validationProfiles: z.array(validationProfileSchema).default([]),
  decisions: z.array(decisionSchema).default([]),
  pendingItems: z.array(pendingSchema).default([]),
  summaries: z.array(summarySchema).default([]),
});

export type WorkflowImport = z.infer<typeof workflowImportSchema>;

export type ImportResult = {
  imported: boolean;
  importKey: string;
  projectKey: string;
  featureCount: number;
  itemCount: number;
  summaryCount: number;
};

export class WorkflowImporter {
  constructor(private readonly db: PrismaClient) {}

  async import(input: WorkflowImport): Promise<ImportResult> {
    const document = workflowImportSchema.parse(input);

    return this.db.$transaction(async (transaction) => {
      const projectRoot = path.resolve(document.project.rootPath);
      const project = await transaction.project.upsert({
        where: { key: document.project.key },
        create: {
          key: document.project.key,
          name: document.project.name,
          rootPath: projectRoot,
          status: document.project.status,
        },
        update: {
          name: document.project.name,
          rootPath: projectRoot,
          status: document.project.status,
        },
      });

      const previousImports = await transaction.workflowEvent.findMany({
        where: { projectId: project.id, type: 'IMPORT_APPLIED' },
        select: { payloadJson: true },
      });
      const alreadyImported = previousImports.some(
        (event) => decodeJson<{ importKey?: string }>(event.payloadJson, {}).importKey === document.importKey,
      );

      if (alreadyImported) {
        return {
          imported: false,
          importKey: document.importKey,
          projectKey: document.project.key,
          featureCount: document.features.length,
          itemCount: document.features.reduce((count, feature) => count + feature.items.length, 0),
          summaryCount: document.summaries.length,
        };
      }

      const repositories = new Map<string, { id: string; key: string }>();
      for (const repositoryInput of document.repositories) {
        const repositoryPath = path.resolve(repositoryInput.path);
        assertInside(projectRoot, repositoryPath, 'REPOSITORY_PATH_INVALID');
        const repository = await transaction.repository.upsert({
          where: { projectId_key: { projectId: project.id, key: repositoryInput.key } },
          create: {
            projectId: project.id,
            key: repositoryInput.key,
            path: repositoryPath,
            expectedBranch: repositoryInput.expectedBranch,
          },
          update: {
            path: repositoryPath,
            expectedBranch: repositoryInput.expectedBranch,
          },
        });
        repositories.set(repository.key, repository);
      }

      const templates = new Map<string, { id: string; key: string; version: number }>();
      for (const templateInput of document.templates) {
        const template = await transaction.workflowTemplateVersion.upsert({
          where: {
            projectId_key_version: {
              projectId: project.id,
              key: templateInput.key,
              version: templateInput.version,
            },
          },
          create: {
            projectId: project.id,
            key: templateInput.key,
            version: templateInput.version,
            name: templateInput.name,
            definitionJson: encodeJson(templateInput.definition),
          },
          update: {
            name: templateInput.name,
            definitionJson: encodeJson(templateInput.definition),
          },
        });
        templates.set(`${template.key}:${template.version}`, template);
      }

      const features = new Map<string, { id: string; key: string }>();
      for (const featureInput of document.features) {
        const template = templateFor(templates, featureInput.templateKey, featureInput.templateVersion);
        const feature = await transaction.feature.upsert({
          where: { projectId_key: { projectId: project.id, key: featureInput.key } },
          create: {
            projectId: project.id,
            templateId: template.id,
            key: featureInput.key,
            name: featureInput.name,
            summary: featureInput.summary,
            status: featureInput.status,
            currentPhaseKey: featureInput.currentPhaseKey,
          },
          update: {
            templateId: template.id,
            name: featureInput.name,
            summary: featureInput.summary,
            status: featureInput.status,
            currentPhaseKey: featureInput.currentPhaseKey,
          },
        });
        features.set(feature.key, feature);
      }

      const items = new Map<string, { id: string; key: string; featureId: string }>();
      for (const featureInput of document.features) {
        const feature = featureFor(features, featureInput.key);
        for (const itemInput of featureInput.items) {
          const requirementsComplete = itemInput.requirementsComplete ?? hasRequirements(itemInput);
          const item = await transaction.workItem.upsert({
            where: { featureId_key: { featureId: feature.id, key: itemInput.key } },
            create: {
              featureId: feature.id,
              key: itemInput.key,
              phaseKey: itemInput.phaseKey,
              position: itemInput.position,
              title: itemInput.title,
              kind: itemInput.kind,
              state: itemInput.state,
              summary: itemInput.summary,
              requirementsComplete,
              tddPolicy: itemInput.tddPolicy,
              currentSha: itemInput.currentSha,
              riskTagsJson: encodeJson(itemInput.riskTags),
              scopeJson: itemInput.scope ? encodeJson(itemInput.scope) : undefined,
            },
            update: {
              phaseKey: itemInput.phaseKey,
              position: itemInput.position,
              title: itemInput.title,
              kind: itemInput.kind,
              state: itemInput.state,
              summary: itemInput.summary,
              requirementsComplete,
              tddPolicy: itemInput.tddPolicy,
              currentSha: itemInput.currentSha,
              riskTagsJson: encodeJson(itemInput.riskTags),
              scopeJson: itemInput.scope ? encodeJson(itemInput.scope) : null,
            },
          });
          items.set(`${feature.key}:${item.key}`, item);

          const useCases = new Map<string, { id: string }>();
          for (const useCaseInput of itemInput.useCases) {
            const useCase = await transaction.useCase.upsert({
              where: { workItemId_key: { workItemId: item.id, key: useCaseInput.key } },
              create: {
                workItemId: item.id,
                key: useCaseInput.key,
                title: useCaseInput.title,
                actor: useCaseInput.actor,
                preconditions: useCaseInput.preconditions,
                trigger: useCaseInput.trigger,
                expectedOutcome: useCaseInput.expectedOutcome,
                invariantsJson: encodeJson(useCaseInput.invariants),
              },
              update: {
                title: useCaseInput.title,
                actor: useCaseInput.actor,
                preconditions: useCaseInput.preconditions,
                trigger: useCaseInput.trigger,
                expectedOutcome: useCaseInput.expectedOutcome,
                invariantsJson: encodeJson(useCaseInput.invariants),
              },
            });
            useCases.set(useCase.key, useCase);
          }

          const criteria = new Map<string, { id: string }>();
          for (const criterionInput of itemInput.criteria) {
            if (criterionInput.useCaseKey && !useCases.has(criterionInput.useCaseKey)) {
              fail('CRITERION_USE_CASE_NOT_FOUND');
            }
            const criterion = await transaction.acceptanceCriterion.upsert({
              where: { workItemId_key: { workItemId: item.id, key: criterionInput.key } },
              create: {
                workItemId: item.id,
                useCaseId: criterionInput.useCaseKey
                  ? useCases.get(criterionInput.useCaseKey)?.id
                  : undefined,
                key: criterionInput.key,
                statement: criterionInput.statement,
                required: criterionInput.required,
                evidenceKind: criterionInput.evidenceKind,
                polarity: criterionInput.polarity,
              },
              update: {
                useCaseId: criterionInput.useCaseKey
                  ? useCases.get(criterionInput.useCaseKey)?.id
                  : undefined,
                statement: criterionInput.statement,
                required: criterionInput.required,
                evidenceKind: criterionInput.evidenceKind,
                polarity: criterionInput.polarity,
              },
            });
            criteria.set(criterion.key, criterion);
          }

          for (const testInput of itemInput.tests) {
            if (testInput.criterionKey && !criteria.has(testInput.criterionKey)) {
              fail('TEST_CRITERION_NOT_FOUND');
            }
            await transaction.testSpecification.upsert({
              where: { workItemId_key: { workItemId: item.id, key: testInput.key } },
              create: {
                workItemId: item.id,
                criterionId: testInput.criterionKey
                  ? criteria.get(testInput.criterionKey)?.id
                  : undefined,
                key: testInput.key,
                name: testInput.name,
                purpose: testInput.purpose,
                runnerProfileKey: testInput.runnerProfileKey,
                testSelector: testInput.testSelector,
              },
              update: {
                criterionId: testInput.criterionKey
                  ? criteria.get(testInput.criterionKey)?.id
                  : undefined,
                name: testInput.name,
                purpose: testInput.purpose,
                runnerProfileKey: testInput.runnerProfileKey,
                testSelector: testInput.testSelector,
              },
            });
          }

          if (itemInput.authorization) {
            const authorization = await transaction.authorization.findFirst({
              where: { workItemId: item.id },
              orderBy: { createdAt: 'desc' },
            });
            const authorizationData = {
              instruction: itemInput.authorization.instruction,
              actor: itemInput.authorization.actor,
              executionMode: itemInput.authorization.executionMode,
              allowedEffectsJson: encodeJson(itemInput.authorization.allowedEffects),
              forbiddenEffectsJson: encodeJson(itemInput.authorization.forbiddenEffects),
            };
            if (authorization) {
              await transaction.authorization.update({ where: { id: authorization.id }, data: authorizationData });
            } else {
              await transaction.authorization.create({ data: { workItemId: item.id, ...authorizationData } });
            }

            await transaction.repositorySnapshot.deleteMany({ where: { workItemId: item.id } });
            for (const baseline of itemInput.authorization.baselines) {
              const repository = repositories.get(baseline.repositoryKey);
              if (!repository) {
                fail('BASELINE_REPOSITORY_NOT_FOUND');
              }
              await transaction.repositorySnapshot.create({
                data: {
                  workItemId: item.id,
                  repositoryId: (repository as NonNullable<typeof repository>).id,
                  branch: baseline.branch,
                  sha: baseline.sha,
                  dirty: baseline.dirty,
                  changedFilesJson: encodeJson(baseline.changedFiles),
                },
              });
            }
          }

          for (const validationInput of itemInput.validations) {
            const profileInput = document.validationProfiles.find(
              (candidate) => candidate.repositoryKey === validationInput.repositoryKey &&
                candidate.key === validationInput.profileKey,
            );
            if (!profileInput) {
              fail('VALIDATION_PROFILE_NOT_FOUND');
            }
            const profile = profileInput as NonNullable<typeof profileInput>;
            const profileRepository = repositories.get(validationInput.repositoryKey);
            if (!profileRepository) {
              fail('REPOSITORY_NOT_FOUND');
            }
            const importedProfile = await transaction.validationProfile.upsert({
              where: {
                repositoryId_key: {
                  repositoryId: (profileRepository as NonNullable<typeof profileRepository>).id,
                  key: profile.key,
                },
              },
              create: {
                repositoryId: (profileRepository as NonNullable<typeof profileRepository>).id,
                key: profile.key,
                program: profile.program,
                argsJson: encodeJson(profile.args),
                cwd: profile.cwd,
                parser: profile.parser,
                capabilitiesJson: encodeJson(profile.capabilities),
                timeoutSeconds: profile.timeoutSeconds,
                maxOutputBytes: profile.maxOutputBytes,
              },
              update: {
                program: profile.program,
                argsJson: encodeJson(profile.args),
                cwd: profile.cwd,
                parser: profile.parser,
                capabilitiesJson: encodeJson(profile.capabilities),
                timeoutSeconds: profile.timeoutSeconds,
                maxOutputBytes: profile.maxOutputBytes,
              },
            });
            await transaction.validationRun.create({
              data: {
                workItemId: item.id,
                profileId: importedProfile.id,
                purpose: validationInput.purpose,
                status: validationInput.status,
                resultKind: validationInput.resultKind,
                exitCode: validationInput.exitCode,
                sha: validationInput.sha,
                durationMs: validationInput.durationMs,
                summaryJson: encodeJson(validationInput.summary),
              },
            });
          }
        }
      }

      const importedItemIds = [...items.values()].map((item) => item.id);
      if (importedItemIds.length > 0) {
        await transaction.workItemDependency.deleteMany({
          where: { workItemId: { in: importedItemIds } },
        });
      }
      const dependencyEdges = (await transaction.workItemDependency.findMany({
        select: { workItemId: true, dependsOnItemId: true },
      })).map((dependency) => ({ from: dependency.workItemId, to: dependency.dependsOnItemId }));
      for (const featureInput of document.features) {
        for (const itemInput of featureInput.items) {
          const item = items.get(`${featureInput.key}:${itemInput.key}`);
          if (!item) {
            fail('WORK_ITEM_NOT_FOUND');
          }
          const currentItem = item as NonNullable<typeof item>;
          const dependencyKeys = new Set<string>();
          for (const dependencyInput of itemInput.dependsOn) {
            const dependencyKey = `${dependencyInput.featureKey}:${dependencyInput.itemKey}`;
            if (dependencyKeys.has(dependencyKey)) {
              fail('DUPLICATE_WORK_ITEM_DEPENDENCY');
            }
            dependencyKeys.add(dependencyKey);
            const dependencyFeature = await transaction.feature.findFirst({
              where: { projectId: project.id, key: dependencyInput.featureKey },
            });
            if (!dependencyFeature) {
              fail('DEPENDENCY_FEATURE_NOT_FOUND');
            }
            const dependencyItem = await transaction.workItem.findFirst({
              where: {
                featureId: (dependencyFeature as NonNullable<typeof dependencyFeature>).id,
                key: dependencyInput.itemKey,
              },
            });
            if (!dependencyItem) {
              fail('DEPENDENCY_ITEM_NOT_FOUND');
            }
            const currentDependency = dependencyItem as NonNullable<typeof dependencyItem>;
            if (currentDependency.id === currentItem.id || hasDependencyPath(dependencyEdges, currentDependency.id, currentItem.id)) {
              fail('WORK_ITEM_DEPENDENCY_CYCLE');
            }
            await transaction.workItemDependency.create({
              data: { workItemId: currentItem.id, dependsOnItemId: currentDependency.id },
            });
            dependencyEdges.push({ from: currentItem.id, to: currentDependency.id });
          }
        }
      }

      for (const profileInput of document.validationProfiles) {
        const repository = repositories.get(profileInput.repositoryKey);
        if (!repository) {
          fail('REPOSITORY_NOT_FOUND');
        }
        await transaction.validationProfile.upsert({
          where: { repositoryId_key: { repositoryId: (repository as NonNullable<typeof repository>).id, key: profileInput.key } },
          create: {
            repositoryId: (repository as NonNullable<typeof repository>).id,
            key: profileInput.key,
            program: profileInput.program,
            argsJson: encodeJson(profileInput.args),
            cwd: profileInput.cwd,
            parser: profileInput.parser,
            timeoutSeconds: profileInput.timeoutSeconds,
            maxOutputBytes: profileInput.maxOutputBytes,
          },
          update: {
            program: profileInput.program,
            argsJson: encodeJson(profileInput.args),
            cwd: profileInput.cwd,
            parser: profileInput.parser,
            timeoutSeconds: profileInput.timeoutSeconds,
            maxOutputBytes: profileInput.maxOutputBytes,
          },
        });
      }

      for (const planInput of document.plans) {
        const feature = planInput.featureKey ? featureFor(features, planInput.featureKey) : undefined;
        await transaction.planVersion.upsert({
          where: { projectId_key_version: { projectId: project.id, key: planInput.key, version: planInput.version } },
          create: {
            projectId: project.id,
            featureId: feature?.id,
            key: planInput.key,
            version: planInput.version,
            title: planInput.title,
            summary: planInput.summary,
            constraintsJson: encodeJson(planInput.constraints),
            outOfScopeJson: encodeJson(planInput.outOfScope),
            sourceRef: planInput.sourceRef,
          },
          update: {
            featureId: feature?.id,
            title: planInput.title,
            summary: planInput.summary,
            constraintsJson: encodeJson(planInput.constraints),
            outOfScopeJson: encodeJson(planInput.outOfScope),
            sourceRef: planInput.sourceRef,
          },
        });
      }

      for (const decisionInput of document.decisions) {
        const feature = decisionInput.featureKey ? featureFor(features, decisionInput.featureKey) : undefined;
        const item = decisionInput.itemKey && feature
          ? items.get(`${feature.key}:${decisionInput.itemKey}`)
          : undefined;
        await transaction.decision.upsert({
          where: { projectId_key: { projectId: project.id, key: decisionInput.key } },
          create: {
            projectId: project.id,
            featureId: feature?.id,
            workItemId: item?.id,
            key: decisionInput.key,
            title: decisionInput.title,
            content: decisionInput.content,
            durable: decisionInput.durable,
            pinned: decisionInput.pinned,
          },
          update: {
            featureId: feature?.id,
            workItemId: item?.id,
            title: decisionInput.title,
            content: decisionInput.content,
            durable: decisionInput.durable,
            pinned: decisionInput.pinned,
          },
        });
      }

      for (const pendingInput of document.pendingItems) {
        const feature = pendingInput.featureKey ? featureFor(features, pendingInput.featureKey) : undefined;
        const item = pendingInput.itemKey && feature
          ? items.get(`${feature.key}:${pendingInput.itemKey}`)
          : undefined;
        await transaction.pendingItem.upsert({
          where: { projectId_key: { projectId: project.id, key: pendingInput.key } },
          create: {
            projectId: project.id,
            featureId: feature?.id,
            workItemId: item?.id,
            key: pendingInput.key,
            description: pendingInput.description,
            blocking: pendingInput.blocking,
            resolved: pendingInput.resolved,
            pinned: pendingInput.pinned,
          },
          update: {
            featureId: feature?.id,
            workItemId: item?.id,
            description: pendingInput.description,
            blocking: pendingInput.blocking,
            resolved: pendingInput.resolved,
            pinned: pendingInput.pinned,
          },
        });
      }

      for (const summaryInput of document.summaries) {
        const feature = summaryInput.featureKey ? featureFor(features, summaryInput.featureKey) : undefined;
        const item = summaryInput.itemKey && feature
          ? items.get(`${feature.key}:${summaryInput.itemKey}`)
          : undefined;
        await transaction.historySummary.upsert({
          where: { projectId_scopeKey: { projectId: project.id, scopeKey: summaryInput.scopeKey } },
          create: {
            projectId: project.id,
            featureId: feature?.id,
            workItemId: item?.id,
            scopeKey: summaryInput.scopeKey,
            state: summaryInput.state,
            result: summaryInput.result,
            deliveredJson: encodeJson(summaryInput.delivered),
            commitsJson: encodeJson(summaryInput.commits),
            validationsJson: encodeJson(summaryInput.validations),
            limitationsJson: encodeJson(summaryInput.limitations),
            pinned: summaryInput.pinned,
          },
          update: {
            featureId: feature?.id,
            workItemId: item?.id,
            state: summaryInput.state,
            result: summaryInput.result,
            deliveredJson: encodeJson(summaryInput.delivered),
            commitsJson: encodeJson(summaryInput.commits),
            validationsJson: encodeJson(summaryInput.validations),
            limitationsJson: encodeJson(summaryInput.limitations),
            pinned: summaryInput.pinned,
          },
        });
      }

      await transaction.workflowEvent.create({
        data: {
          projectId: project.id,
          type: 'IMPORT_APPLIED',
          payloadJson: encodeJson({
            importKey: document.importKey,
            featureCount: document.features.length,
            itemCount: document.features.reduce((count, feature) => count + feature.items.length, 0),
            summaryCount: document.summaries.length,
          }),
        },
      });

      return {
        imported: true,
        importKey: document.importKey,
        projectKey: project.key,
        featureCount: document.features.length,
        itemCount: document.features.reduce((count, feature) => count + feature.items.length, 0),
        summaryCount: document.summaries.length,
      };
    });
  }
}

export function parseWorkflowImport(value: unknown): WorkflowImport {
  return workflowImportSchema.parse(value);
}

function templateFor(
  templates: Map<string, { id: string; key: string; version: number }>,
  key: string,
  version?: number,
) {
  const candidates = [...templates.values()].filter((template) => template.key === key);
  const template = version
    ? candidates.find((candidate) => candidate.version === version)
    : candidates.sort((left, right) => right.version - left.version)[0];
  if (!template) {
    fail('TEMPLATE_NOT_FOUND');
  }
  return template as NonNullable<typeof template>;
}

function featureFor(features: Map<string, { id: string; key: string }>, key: string) {
  const feature = features.get(key);
  if (!feature) {
    fail('FEATURE_NOT_FOUND');
  }
  return feature as NonNullable<typeof feature>;
}

function assertInside(root: string, candidate: string, code: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(code);
  }
}

function hasRequirements(item: z.infer<typeof itemSchema>): boolean {
  return item.useCases.length > 0 &&
    item.criteria.some((criterion) => criterion.required) &&
    (item.kind !== 'CODE' || item.tddPolicy !== 'REQUIRED' || item.tests.length > 0);
}

function hasDependencyPath(
  edges: Array<{ from: string; to: string }>,
  start: string,
  target: string,
): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const next = adjacency.get(edge.from) ?? [];
    next.push(edge.to);
    adjacency.set(edge.from, next);
  }
  const pending = [start];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift() as string;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(adjacency.get(current) ?? []));
  }
  return false;
}
