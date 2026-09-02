import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';

const workflowRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const defaultDatabaseUrl = `file:${path.resolve(workflowRoot, '..', '.workflow', 'workflow.sqlite')}`;

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    process.env.WORKFLOW_DATABASE_URL ?? defaultDatabaseUrl;
}

export const prisma = new PrismaClient();

export async function configureDatabase(client: PrismaClient = prisma): Promise<void> {
  await client.$queryRawUnsafe('PRAGMA journal_mode = WAL');
  await client.$queryRawUnsafe('PRAGMA foreign_keys = ON');
  await client.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
}
