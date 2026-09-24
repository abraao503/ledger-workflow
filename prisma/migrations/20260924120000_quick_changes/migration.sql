CREATE TABLE "QuickChange" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "requestedBy" TEXT NOT NULL,
  "completedBy" TEXT,
  "eligibilityReason" TEXT NOT NULL,
  "guardReference" TEXT,
  "scopeJson" TEXT NOT NULL,
  "riskTagsJson" TEXT NOT NULL DEFAULT '[]',
  "baseBranch" TEXT NOT NULL,
  "baseSha" TEXT NOT NULL,
  "baseFingerprint" TEXT NOT NULL,
  "commitSha" TEXT,
  "changedFilesJson" TEXT NOT NULL DEFAULT '[]',
  "verificationKind" TEXT,
  "verificationSummary" TEXT,
  "promotedTaskKey" TEXT,
  "promotionReason" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "closedAt" DATETIME,
  CONSTRAINT "QuickChange_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "QuickChange_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "QuickChange_projectId_key_key" ON "QuickChange"("projectId", "key");
CREATE INDEX "QuickChange_projectId_status_createdAt_idx" ON "QuickChange"("projectId", "status", "createdAt");
CREATE INDEX "QuickChange_repositoryId_status_idx" ON "QuickChange"("repositoryId", "status");
