import type { PrismaClient } from '@prisma/client';

import { GitReadAdapter } from './git-read-adapter.js';
import { ValidationExecutor } from './validation-executor.js';
import { WorkflowImporter } from './workflow-importer.js';
import { WorkflowLedger } from './workflow-ledger.js';
import { DashboardService } from './dashboard.js';
import { prisma } from '../infrastructure/db/client.js';

export type WorkflowApp = {
  db: PrismaClient;
  git: GitReadAdapter;
  ledger: WorkflowLedger;
  validation: ValidationExecutor;
  importer: WorkflowImporter;
  dashboard: DashboardService;
};

export function createWorkflowApp(db: PrismaClient = prisma): WorkflowApp {
  const git = new GitReadAdapter();
  const ledger = new WorkflowLedger(db, git);

  const validation = new ValidationExecutor(db, ledger, git);

  return {
    db,
    git,
    ledger,
    validation,
    importer: new WorkflowImporter(db),
    dashboard: new DashboardService(db, ledger),
  };
}
