CREATE TABLE "uploaded_documents" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "data_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "transaction_hash" TEXT,
    "network" TEXT,
    "contract_address" TEXT,
    "signer_address" TEXT,
    "block_number" INTEGER,
    "verification_id" TEXT,
    "error_code" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 8,
    "next_retry_at" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3),
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "uploaded_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uploaded_documents_user_id_data_hash_key" ON "uploaded_documents"("user_id", "data_hash");
CREATE INDEX "uploaded_documents_user_id_created_at_idx" ON "uploaded_documents"("user_id", "created_at");
CREATE INDEX "uploaded_documents_status_next_retry_at_idx" ON "uploaded_documents"("status", "next_retry_at");

ALTER TABLE "uploaded_documents" ADD CONSTRAINT "uploaded_documents_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
