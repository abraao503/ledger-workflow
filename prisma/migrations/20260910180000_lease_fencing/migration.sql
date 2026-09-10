ALTER TABLE "WorkItemLease" ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WorkItemLease" ADD COLUMN "lastRenewedAt" DATETIME;
ALTER TABLE "WorkItemLease" ADD COLUMN "endReason" TEXT;

WITH ranked AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "workItemId"
            ORDER BY "acquiredAt" ASC, "id" ASC
        ) AS "generation"
    FROM "WorkItemLease"
)
UPDATE "WorkItemLease"
SET "generation" = (
    SELECT ranked."generation"
    FROM ranked
    WHERE ranked."id" = "WorkItemLease"."id"
);

CREATE UNIQUE INDEX "WorkItemLease_workItemId_generation_key"
ON "WorkItemLease"("workItemId", "generation");
