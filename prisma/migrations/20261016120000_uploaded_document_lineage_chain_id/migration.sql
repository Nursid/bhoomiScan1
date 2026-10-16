ALTER TABLE "uploaded_documents"
    ADD COLUMN "document_series_id" UUID,
    ADD COLUMN "version_number" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "previous_version_id" UUID,
    ADD COLUMN "chain_id" INTEGER;

UPDATE "uploaded_documents"
SET "document_series_id" = "id"
WHERE "document_series_id" IS NULL;

ALTER TABLE "uploaded_documents"
    ALTER COLUMN "document_series_id" SET NOT NULL;

CREATE UNIQUE INDEX "uploaded_documents_user_id_series_version_key"
    ON "uploaded_documents"("user_id", "document_series_id", "version_number");
CREATE UNIQUE INDEX "uploaded_documents_previous_version_id_key"
    ON "uploaded_documents"("previous_version_id");
CREATE INDEX "uploaded_documents_user_id_series_idx"
    ON "uploaded_documents"("user_id", "document_series_id");

ALTER TABLE "uploaded_documents"
    ADD CONSTRAINT "uploaded_documents_previous_version_id_fkey"
    FOREIGN KEY ("previous_version_id") REFERENCES "uploaded_documents"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
