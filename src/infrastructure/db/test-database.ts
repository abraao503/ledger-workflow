import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';

export type TestDatabase = {
  client: PrismaClient;
  path: string;
  close: () => Promise<void>;
};

export function createTestDatabase(): TestDatabase {
  const dataDirectory = path.join(tmpdir(), '7agentes-workflow-tests');
  mkdirSync(dataDirectory, { recursive: true });
  const databasePath = path.join(
    dataDirectory,
    `workflow-test-${process.pid}-${Date.now()}.sqlite`,
  );
  const databaseUrl = `file:${databasePath}`;
  writeFileSync(databasePath, '');

  execFileSync(
    path.resolve(process.cwd(), 'node_modules/.bin/prisma'),
    ['migrate', 'deploy', '--schema=./prisma/schema.prisma'],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    },
  );

  const client = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });

  return {
    client,
    path: databasePath,
    close: async () => {
      await client.$disconnect();

      if (existsSync(databasePath)) {
        unlinkSync(databasePath);
      }

      for (const suffix of ['-shm', '-wal']) {
        const sidecar = `${databasePath}${suffix}`;

        if (existsSync(sidecar)) {
          unlinkSync(sidecar);
        }
      }
    },
  };
}
