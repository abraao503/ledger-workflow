-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AcceptanceCriterion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workItemId" TEXT NOT NULL,
    "useCaseId" TEXT,
    "key" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "evidenceKind" TEXT NOT NULL DEFAULT 'GENERAL',
    "polarity" TEXT NOT NULL DEFAULT 'EXPECTED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AcceptanceCriterion_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AcceptanceCriterion_useCaseId_fkey" FOREIGN KEY ("useCaseId") REFERENCES "UseCase" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AcceptanceCriterion" ("createdAt", "id", "key", "required", "statement", "useCaseId", "workItemId") SELECT "createdAt", "id", "key", "required", "statement", "useCaseId", "workItemId" FROM "AcceptanceCriterion";
DROP TABLE "AcceptanceCriterion";
ALTER TABLE "new_AcceptanceCriterion" RENAME TO "AcceptanceCriterion";
CREATE UNIQUE INDEX "AcceptanceCriterion_workItemId_key_key" ON "AcceptanceCriterion"("workItemId", "key");
CREATE TABLE "new_ValidationProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repositoryId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "program" TEXT NOT NULL,
    "argsJson" TEXT NOT NULL,
    "cwd" TEXT NOT NULL,
    "parser" TEXT NOT NULL,
    "capabilitiesJson" TEXT NOT NULL DEFAULT '[]',
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 60,
    "maxOutputBytes" INTEGER NOT NULL DEFAULT 2000000,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ValidationProfile_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ValidationProfile" ("active", "argsJson", "createdAt", "cwd", "id", "key", "maxOutputBytes", "parser", "program", "repositoryId", "timeoutSeconds", "updatedAt") SELECT "active", "argsJson", "createdAt", "cwd", "id", "key", "maxOutputBytes", "parser", "program", "repositoryId", "timeoutSeconds", "updatedAt" FROM "ValidationProfile";
DROP TABLE "ValidationProfile";
ALTER TABLE "new_ValidationProfile" RENAME TO "ValidationProfile";
CREATE UNIQUE INDEX "ValidationProfile_repositoryId_key_key" ON "ValidationProfile"("repositoryId", "key");
CREATE TABLE "new_WorkItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "featureId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "phaseKey" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'CODE',
    "taskType" TEXT NOT NULL DEFAULT 'FEATURE',
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "summary" TEXT,
    "requirementsComplete" BOOLEAN NOT NULL DEFAULT false,
    "tddPolicy" TEXT NOT NULL DEFAULT 'REQUIRED',
    "currentSha" TEXT,
    "scopeJson" TEXT,
    "riskTagsJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "parentItemId" TEXT,
    CONSTRAINT "WorkItem_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkItem_parentItemId_fkey" FOREIGN KEY ("parentItemId") REFERENCES "WorkItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_WorkItem" ("createdAt", "currentSha", "featureId", "id", "key", "kind", "parentItemId", "phaseKey", "position", "requirementsComplete", "scopeJson", "state", "summary", "taskType", "tddPolicy", "title", "updatedAt") SELECT "createdAt", "currentSha", "featureId", "id", "key", "kind", "parentItemId", "phaseKey", "position", "requirementsComplete", "scopeJson", "state", "summary", "taskType", "tddPolicy", "title", "updatedAt" FROM "WorkItem";
DROP TABLE "WorkItem";
ALTER TABLE "new_WorkItem" RENAME TO "WorkItem";
CREATE INDEX "WorkItem_featureId_position_idx" ON "WorkItem"("featureId", "position");
CREATE INDEX "WorkItem_parentItemId_idx" ON "WorkItem"("parentItemId");
CREATE UNIQUE INDEX "WorkItem_featureId_key_key" ON "WorkItem"("featureId", "key");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
