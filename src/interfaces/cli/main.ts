#!/usr/bin/env node

import { createWorkflowApp } from '../../application/workflow-app.js';
import { isWorkflowApplicationError } from '../../application/workflow-ledger.js';
import { configureDatabase } from '../../infrastructure/db/client.js';
import { createCli } from './cli.js';

const app = createWorkflowApp();

try {
  await configureDatabase(app.db);
  await createCli({ app }).parseAsync(process.argv);
} catch (error) {
  const message = isWorkflowApplicationError(error)
    ? `[${error.code}] ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
} finally {
  await app.db.$disconnect();
}
