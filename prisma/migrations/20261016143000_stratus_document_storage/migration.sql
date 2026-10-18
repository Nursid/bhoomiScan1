ALTER TABLE "uploaded_documents"
ADD COLUMN "storage_object_key" TEXT;

CREATE UNIQUE INDEX "uploaded_documents_storage_object_key_key"
ON "uploaded_documents"("storage_object_key");
