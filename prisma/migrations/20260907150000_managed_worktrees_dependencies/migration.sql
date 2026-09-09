ALTER TABLE "Authorization" ADD COLUMN "executionMode" TEXT NOT NULL DEFAULT 'SHARED';

CREATE TABLE "WorkItemDependency" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workItemId" TEXT NOT NULL,
    "dependsOnItemId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkItemDependency_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkItemDependency_dependsOnItemId_fkey" FOREIGN KEY ("dependsOnItemId") REFERENCES "WorkItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "WorkItemDependency_workItemId_dependsOnItemId_key" ON "WorkItemDependency"("workItemId", "dependsOnItemId");
CREATE INDEX "WorkItemDependency_workItemId_idx" ON "WorkItemDependency"("workItemId");
CREATE INDEX "WorkItemDependency_dependsOnItemId_idx" ON "WorkItemDependency"("dependsOnItemId");

CREATE TABLE "WorkItemWorkspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workItemId" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "baseSha" TEXT NOT NULL,
    "targetBaseSha" TEXT,
    "candidateSha" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "cleanupError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" DATETIME,
    CONSTRAINT "WorkItemWorkspace_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkItemWorkspace_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "WorkItemLease" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkItemWorkspace_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "WorkItemWorkspace_leaseId_repositoryId_key" ON "WorkItemWorkspace"("leaseId", "repositoryId");
CREATE INDEX "WorkItemWorkspace_workItemId_status_idx" ON "WorkItemWorkspace"("workItemId", "status");
CREATE INDEX "WorkItemWorkspace_repositoryId_status_idx" ON "WorkItemWorkspace"("repositoryId", "status");

CREATE TABLE "WorkItemIntegrationApproval" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workItemId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "candidatesJson" TEXT NOT NULL,
    "targetBasesJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AUTHORIZED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" DATETIME,
    CONSTRAINT "WorkItemIntegrationApproval_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "WorkItemIntegrationApproval_workItemId_createdAt_idx" ON "WorkItemIntegrationApproval"("workItemId", "createdAt");
