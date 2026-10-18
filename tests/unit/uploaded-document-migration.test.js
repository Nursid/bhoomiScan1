const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(path.join(__dirname, '../../prisma/migrations/20261016100000_uploaded_document_hashes/migration.sql'), 'utf8');
const lineageMigration = fs.readFileSync(path.join(__dirname, '../../prisma/migrations/20261016120000_uploaded_document_lineage_chain_id/migration.sql'), 'utf8');
const storageMigration = fs.readFileSync(path.join(__dirname, '../../prisma/migrations/20261016143000_stratus_document_storage/migration.sql'), 'utf8');
const schema = fs.readFileSync(path.join(__dirname, '../../prisma/schema.prisma'), 'utf8');

describe('uploaded document migration', () => {
  test('creates the retry, signer, ownership, and idempotency fields used by the Prisma model', () => {
    for (const column of [
      'user_id', 'data_hash', 'transaction_hash', 'contract_address', 'signer_address', 'attempts', 'max_attempts',
      'next_retry_at', 'last_attempt_at', 'locked_until',
    ]) {
      expect(migration).toContain(`"${column}"`);
    }
    expect(migration).toContain('FOREIGN KEY ("user_id") REFERENCES "users"("id")');
    expect(migration).toContain('UNIQUE INDEX "uploaded_documents_user_id_data_hash_key"');
    expect(migration).toContain('INDEX "uploaded_documents_status_next_retry_at_idx"');
    expect(schema).toContain('model UploadedDocument');
  });

  test('adds version lineage and chain ID safely for existing document rows', () => {
    expect(lineageMigration).toContain('ADD COLUMN "document_series_id" UUID');
    expect(lineageMigration).toContain('ADD COLUMN "version_number" INTEGER NOT NULL DEFAULT 1');
    expect(lineageMigration).toContain('ADD COLUMN "previous_version_id" UUID');
    expect(lineageMigration).toContain('ADD COLUMN "chain_id" INTEGER');
    expect(lineageMigration).toContain('SET "document_series_id" = "id"');
    expect(lineageMigration).toContain('ALTER COLUMN "document_series_id" SET NOT NULL');
    expect(lineageMigration).toContain('UNIQUE INDEX "uploaded_documents_user_id_series_version_key"');
    expect(lineageMigration).toContain('UNIQUE INDEX "uploaded_documents_previous_version_id_key"');
    expect(lineageMigration).toContain('FOREIGN KEY ("previous_version_id") REFERENCES "uploaded_documents"("id")');
    // The schema names the index exactly as the migration created it (no drift).
    expect(schema).toContain('@@unique([userId, documentSeriesId, versionNumber], map: "uploaded_documents_user_id_series_version_key")');
    expect(schema).toContain('previousVersionId String? @unique');
  });

  test('adds a nullable unique Stratus object reference without changing existing records', () => {
    expect(storageMigration).toContain('ADD COLUMN "storage_object_key" TEXT');
    expect(storageMigration).toContain('UNIQUE INDEX "uploaded_documents_storage_object_key_key"');
    expect(schema).toContain('storageObjectKey String?  @unique @map("storage_object_key")');
  });
});
