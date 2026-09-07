-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_WorkItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "featureId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "phaseKey" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'CODE',
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "summary" TEXT,
    "requirementsComplete" BOOLEAN NOT NULL DEFAULT false,
    "tddPolicy" TEXT NOT NULL DEFAULT 'REQUIRED',
    "currentSha" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "parentItemId" TEXT,
    CONSTRAINT "WorkItem_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkItem_parentItemId_fkey" FOREIGN KEY ("parentItemId") REFERENCES "WorkItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_WorkItem" ("createdAt", "currentSha", "featureId", "id", "key", "kind", "phaseKey", "position", "requirementsComplete", "state", "summary", "tddPolicy", "title", "updatedAt") SELECT "createdAt", "currentSha", "featureId", "id", "key", "kind", "phaseKey", "position", "requirementsComplete", "state", "summary", "tddPolicy", "title", "updatedAt" FROM "WorkItem";
DROP TABLE "WorkItem";
ALTER TABLE "new_WorkItem" RENAME TO "WorkItem";
CREATE INDEX "WorkItem_featureId_position_idx" ON "WorkItem"("featureId", "position");
CREATE INDEX "WorkItem_parentItemId_idx" ON "WorkItem"("parentItemId");
CREATE UNIQUE INDEX "WorkItem_featureId_key_key" ON "WorkItem"("featureId", "key");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
