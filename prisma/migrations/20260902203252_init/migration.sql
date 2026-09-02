-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rootPath" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "expectedBranch" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Repository_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkflowTemplateVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "definitionJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkflowTemplateVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlanVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "featureId" TEXT,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "constraintsJson" TEXT NOT NULL,
    "outOfScopeJson" TEXT NOT NULL,
    "sourceRef" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlanVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlanVersion_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Feature" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "currentPhaseKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Feature_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Feature_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "WorkflowTemplateVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkItem" (
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
    CONSTRAINT "WorkItem_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UseCase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workItemId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "preconditions" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "expectedOutcome" TEXT NOT NULL,
    "invariantsJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UseCase_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AcceptanceCriterion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workItemId" TEXT NOT NULL,
    "useCaseId" TEXT,
    "key" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AcceptanceCriterion_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AcceptanceCriterion_useCaseId_fkey" FOREIGN KEY ("useCaseId") REFERENCES "UseCase" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TestSpecification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workItemId" TEXT NOT NULL,
    "criterionId" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "runnerProfileKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TestSpecification_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TestSpecification_criterionId_fkey" FOREIGN KEY ("criterionId") REFERENCES "AcceptanceCriterion" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Authorization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workItemId" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "allowedEffectsJson" TEXT NOT NULL,
    "forbiddenEffectsJson" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Authorization_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RepositorySnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workItemId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "dirty" BOOLEAN NOT NULL,
    "changedFilesJson" TEXT NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RepositorySnapshot_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RepositorySnapshot_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ValidationProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repositoryId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "program" TEXT NOT NULL,
    "argsJson" TEXT NOT NULL,
    "cwd" TEXT NOT NULL,
    "parser" TEXT NOT NULL,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 60,
    "maxOutputBytes" INTEGER NOT NULL DEFAULT 2000000,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ValidationProfile_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ValidationRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workItemId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "resultKind" TEXT NOT NULL,
    "exitCode" INTEGER,
    "sha" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "summaryJson" TEXT NOT NULL,
    "logBlob" BLOB,
    "logExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ValidationRun_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ValidationRun_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "ValidationProfile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workItemId" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "reviewer" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Review_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReviewFinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reviewId" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "correction" TEXT NOT NULL,
    "testNeeded" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewFinding_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "featureId" TEXT,
    "workItemId" TEXT,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "durable" BOOLEAN NOT NULL DEFAULT true,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Decision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Decision_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Decision_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PendingItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "featureId" TEXT,
    "workItemId" TEXT,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "blocking" BOOLEAN NOT NULL DEFAULT false,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PendingItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PendingItem_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PendingItem_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkflowEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "featureId" TEXT,
    "workItemId" TEXT,
    "type" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkflowEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkflowEvent_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "WorkflowEvent_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HistorySummary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "featureId" TEXT,
    "workItemId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "deliveredJson" TEXT NOT NULL,
    "commitsJson" TEXT NOT NULL,
    "validationsJson" TEXT NOT NULL,
    "limitationsJson" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HistorySummary_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HistorySummary_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "HistorySummary_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_key_key" ON "Project"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_projectId_key_key" ON "Repository"("projectId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowTemplateVersion_projectId_key_version_key" ON "WorkflowTemplateVersion"("projectId", "key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PlanVersion_projectId_key_version_key" ON "PlanVersion"("projectId", "key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Feature_projectId_key_key" ON "Feature"("projectId", "key");

-- CreateIndex
CREATE INDEX "WorkItem_featureId_position_idx" ON "WorkItem"("featureId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "WorkItem_featureId_key_key" ON "WorkItem"("featureId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "UseCase_workItemId_key_key" ON "UseCase"("workItemId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "AcceptanceCriterion_workItemId_key_key" ON "AcceptanceCriterion"("workItemId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "TestSpecification_workItemId_key_key" ON "TestSpecification"("workItemId", "key");

-- CreateIndex
CREATE INDEX "Authorization_workItemId_createdAt_idx" ON "Authorization"("workItemId", "createdAt");

-- CreateIndex
CREATE INDEX "RepositorySnapshot_workItemId_capturedAt_idx" ON "RepositorySnapshot"("workItemId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ValidationProfile_repositoryId_key_key" ON "ValidationProfile"("repositoryId", "key");

-- CreateIndex
CREATE INDEX "ValidationRun_workItemId_createdAt_idx" ON "ValidationRun"("workItemId", "createdAt");

-- CreateIndex
CREATE INDEX "Review_workItemId_createdAt_idx" ON "Review"("workItemId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Decision_projectId_key_key" ON "Decision"("projectId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "PendingItem_projectId_key_key" ON "PendingItem"("projectId", "key");

-- CreateIndex
CREATE INDEX "WorkflowEvent_projectId_createdAt_idx" ON "WorkflowEvent"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowEvent_workItemId_createdAt_idx" ON "WorkflowEvent"("workItemId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "HistorySummary_projectId_scopeKey_key" ON "HistorySummary"("projectId", "scopeKey");
