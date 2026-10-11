-- Google login (Firebase Auth): Google-only accounts have no mobile number, and the
-- verified Firebase UID identifies them. Both columns stay unique; PostgreSQL allows
-- any number of NULLs in a unique index, so existing mobile users are unaffected.

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "mobile" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN "firebase_uid" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_firebase_uid_key" ON "users"("firebase_uid");
