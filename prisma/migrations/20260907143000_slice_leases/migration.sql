CREATE TABLE "WorkItemLease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workItemId" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "acquiredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "releasedAt" DATETIME,
    "recoveredFromId" TEXT,
    CONSTRAINT "WorkItemLease_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkItemLease_recoveredFromId_fkey" FOREIGN KEY ("recoveredFromId") REFERENCES "WorkItemLease" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "WorkItemLease_workItemId_expiresAt_idx" ON "WorkItemLease"("workItemId", "expiresAt");
CREATE INDEX "WorkItemLease_workItemId_releasedAt_idx" ON "WorkItemLease"("workItemId", "releasedAt");
CREATE INDEX "WorkItemLease_recoveredFromId_idx" ON "WorkItemLease"("recoveredFromId");
CREATE UNIQUE INDEX "WorkItemLease_active_workItemId_key" ON "WorkItemLease"("workItemId") WHERE "releasedAt" IS NULL;
