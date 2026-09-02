import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createWorkflowApp } from '../../application/workflow-app.js';
import { configureDatabase } from '../../infrastructure/db/client.js';
import { createMcpServer } from './server.js';

const app = createWorkflowApp();
const server = createMcpServer(app);
const transport = new StdioServerTransport();

try {
  await configureDatabase(app.db);
  await server.connect(transport);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  await app.db.$disconnect();
  process.exitCode = 1;
}
