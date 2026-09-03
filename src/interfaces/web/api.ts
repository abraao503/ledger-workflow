import path from 'node:path';

import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { isWorkflowApplicationError } from '../../application/workflow-ledger.js';
import { isDashboardView, type DashboardView } from '../../application/dashboard.js';
import type { WorkflowApp } from '../../application/workflow-app.js';

const optionalKey = z.string().trim().min(1).optional();
const selectionSchema = z.object({
  projectKey: optionalKey,
  featureKey: optionalKey,
  itemKey: optionalKey,
});

const actionSchema = z.object({
  action: z.enum([
    'MARK_READY', 'AUTHORIZE', 'MARK_TESTS_DEFINED', 'RUN_RED',
    'APPROVE_TDD_EXCEPTION', 'START_IMPLEMENTING', 'RUN_GREEN',
    'MARK_READY_FOR_REVIEW', 'SUBMIT_REVIEW', 'RETURN_TO_TESTS',
    'CLOSE', 'BLOCK', 'REOPEN', 'RUN_CHECK', 'REINSPECT', 'COMPACT_HISTORY',
  ]),
  projectKey: z.string().trim().min(1),
  featureKey: z.string().trim().min(1),
  itemKey: z.string().trim().min(1),
  expectedState: z.string().trim().min(1).optional(),
  repositoryKey: z.string().trim().min(1).optional(),
  profileKey: z.string().trim().min(1).optional(),
  purpose: z.enum(['RED', 'GREEN', 'CHECK']).optional(),
  reason: z.string().optional(),
  actor: z.string().optional(),
  instruction: z.string().optional(),
  allowedEffects: z.array(z.string()).optional(),
  forbiddenEffects: z.array(z.string()).optional(),
  repositoryKeys: z.array(z.string()).optional(),
  reviewer: z.string().optional(),
  reviewMode: z.enum(['SELF', 'INDEPENDENT']).optional(),
  verdict: z.enum(['APPROVED', 'CHANGES_REQUIRED', 'BLOCKED']).optional(),
  summary: z.string().optional(),
  findings: z.array(z.object({
    severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
    location: z.string(),
    evidence: z.string(),
    risk: z.string(),
    correction: z.string(),
    testNeeded: z.string(),
    resolved: z.boolean().optional(),
  })).optional(),
  commitSha: z.string().optional(),
  keepRecent: z.number().int().min(0).max(20).optional(),
});

const activeActions = new Set<string>();

export function createWebApp(app: WorkflowApp) {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  router.get('/health', asyncRoute(async (_request, response) => {
    response.json(await app.dashboard.getHealth());
  }));

  router.get('/catalog', asyncRoute(async (_request, response) => {
    response.json({ projects: await app.dashboard.getCatalog() });
  }));

  router.get('/dashboard', asyncRoute(async (request, response) => {
    const query = request.query as Record<string, string | string[] | undefined>;
    const viewValue = firstQuery(query.view);
    const view: DashboardView = isDashboardView(viewValue) ? viewValue : 'dashboard';
    const snapshot = await app.dashboard.getDashboard({
      projectKey: firstQuery(query.projectKey),
      featureKey: firstQuery(query.featureKey),
      itemKey: firstQuery(query.itemKey),
    }, view);
    response.json(snapshot);
  }));

  router.get('/validations/:validationId/log', asyncRoute(async (request, response) => {
    const query = request.query as Record<string, string | string[] | undefined>;
    const result = await app.ledger.getValidationLog({
      projectKey: requiredQuery(query, 'projectKey'),
      featureKey: requiredQuery(query, 'featureKey'),
      itemKey: requiredQuery(query, 'itemKey'),
      validationId: String(request.params.validationId),
    });
    response.type('text/plain').send(result.text);
  }));

  router.post('/actions', asyncRoute(async (request, response) => {
    const input = actionSchema.parse(request.body);
    const actionKey = `${input.projectKey}:${input.featureKey}:${input.itemKey}:${input.action}`;
    if (activeActions.has(actionKey)) {
      throw new WebError(409, 'ACTION_IN_PROGRESS', 'Ação já está em execução para esta fatia');
    }

    activeActions.add(actionKey);
    try {
      const current = await app.dashboard.getDashboard({
        projectKey: input.projectKey,
        featureKey: input.featureKey,
        itemKey: input.itemKey,
      });
      if (input.expectedState && current.item.state !== input.expectedState) {
        throw new WebError(409, 'STALE_DASHBOARD', 'A fatia mudou desde a última atualização');
      }

      const result = await executeAction(app, input);
      const snapshot = await app.dashboard.getDashboard({
        projectKey: input.projectKey,
        featureKey: input.featureKey,
        itemKey: input.itemKey,
      });
      response.json({ result, snapshot });
    } finally {
      activeActions.delete(actionKey);
    }
  }));

  return router;
}

async function executeAction(app: WorkflowApp, input: z.infer<typeof actionSchema>) {
  const selection = {
    projectKey: input.projectKey,
    featureKey: input.featureKey,
    itemKey: input.itemKey,
  };
  const transition = (to: string) => app.ledger.transitionWorkItem({
    ...selection,
    to,
    reason: input.reason,
    commitSha: input.commitSha,
  });

  switch (input.action) {
    case 'MARK_READY': return transition('READY');
    case 'AUTHORIZE':
      return app.ledger.authorizeWorkItem({
        ...selection,
        instruction: requireField(input.instruction, 'instruction'),
        actor: requireField(input.actor, 'actor'),
        allowedEffects: input.allowedEffects ?? [],
        forbiddenEffects: input.forbiddenEffects ?? [],
        repositoryKeys: input.repositoryKeys ?? [],
      });
    case 'MARK_TESTS_DEFINED': return transition('TESTS_DEFINED');
    case 'RUN_RED':
    case 'RUN_GREEN':
    case 'RUN_CHECK':
      return app.validation.run({
        ...selection,
        repositoryKey: requireField(input.repositoryKey, 'repositoryKey'),
        profileKey: requireField(input.profileKey, 'profileKey'),
        purpose: input.action === 'RUN_RED' ? 'RED' : input.action === 'RUN_GREEN' ? 'GREEN' : 'CHECK',
        reason: input.reason,
      });
    case 'APPROVE_TDD_EXCEPTION': return transition('TDD_EXCEPTION_APPROVED');
    case 'START_IMPLEMENTING': return transition('IMPLEMENTING');
    case 'MARK_READY_FOR_REVIEW': return transition('READY_FOR_REVIEW');
    case 'SUBMIT_REVIEW':
      return app.ledger.submitReview({
        ...selection,
        reviewer: requireField(input.reviewer, 'reviewer'),
        reviewMode: input.reviewMode ?? 'SELF',
        verdict: input.verdict ?? 'APPROVED',
        summary: requireField(input.summary, 'summary'),
        findings: input.findings ?? [],
      });
    case 'RETURN_TO_TESTS': return transition('TESTS_DEFINED');
    case 'CLOSE': return transition('CLOSED');
    case 'BLOCK': return transition('BLOCKED');
    case 'REOPEN':
      return app.ledger.reopenWorkItem({
        ...selection,
        actor: requireField(input.actor, 'actor'),
        reason: requireField(input.reason, 'reason'),
      });
    case 'REINSPECT': {
      const repositoryKey = input.repositoryKey ?? (await app.dashboard.getDashboard(selection)).repositories[0]?.key;
      if (!repositoryKey) {
        throw new WebError(422, 'REPOSITORY_REQUIRED', 'Nenhum repositório registrado para reinspeção');
      }
      const project = await app.db.project.findUnique({ where: { key: input.projectKey } });
      const repository = project
        ? await app.db.repository.findFirst({ where: { projectId: project.id, key: repositoryKey } })
        : undefined;
      if (!repository) {
        throw new WebError(404, 'REPOSITORY_NOT_FOUND', 'Repositório não encontrado');
      }
      return { repository: repository.key, snapshot: await app.git.capture(path.resolve(repository.path)) };
    }
    case 'COMPACT_HISTORY':
      return app.ledger.compactHistory({
        projectKey: input.projectKey,
        featureKey: input.featureKey,
        activeItemKey: input.itemKey,
        keepRecent: input.keepRecent,
      });
  }
}

function requireField(value: string | undefined, field: string): string {
  if (!value?.trim()) {
    throw new WebError(400, 'FIELD_REQUIRED', `Campo obrigatório: ${field}`);
  }
  return value.trim();
}

function firstQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requiredQuery(query: Record<string, string | string[] | undefined>, key: string): string {
  return requireField(firstQuery(query[key]), key);
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    Promise.resolve(handler(request, response)).catch(next);
  };
}

export class WebError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WebError';
  }
}

export function webErrorHandler(error: unknown, _request: Request, response: Response, _next: NextFunction) {
  if (error instanceof z.ZodError) {
    response.status(400).json({ code: 'INVALID_REQUEST', message: error.issues.map((issue) => issue.message).join('; ') });
    return;
  }

  if (error instanceof WebError) {
    response.status(error.status).json({ code: error.code, message: error.message });
    return;
  }

  if (isWorkflowApplicationError(error)) {
    const status = error.code === 'VALIDATION_LOG_EXPIRED'
      ? 410
      : error.code.includes('NOT_FOUND')
        ? 404
        : 422;
    response.status(status).json({ code: error.code, message: error.message });
    return;
  }

  response.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno no servidor do ledger' });
}

export function createWebServer(app: WorkflowApp) {
  const server = express();
  server.disable('x-powered-by');
  server.use((request, response, next) => {
    const host = request.headers.host?.split(':')[0];
    const origin = request.headers.origin;
    if (host && !['127.0.0.1', 'localhost'].includes(host)) {
      response.status(403).json({ code: 'LOCAL_ONLY', message: 'O ledger web aceita somente conexões locais' });
      return;
    }
    if (origin && !origin.startsWith('http://127.0.0.1') && !origin.startsWith('http://localhost')) {
      response.status(403).json({ code: 'ORIGIN_REJECTED', message: 'Origem não autorizada' });
      return;
    }
    next();
  });
  server.use('/api', createWebApp(app));
  server.use(webErrorHandler);
  return server;
}
