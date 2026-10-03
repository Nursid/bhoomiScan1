-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "PlanInterval" AS ENUM ('MONTHLY', 'QUARTERLY');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'SUCCESS', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "VerificationFrequency" AS ENUM ('WEEKLY', 'MONTHLY', 'QUARTERLY');

-- CreateEnum
CREATE TYPE "LandVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'UNCHANGED', 'CHANGED', 'FAILED');

-- CreateEnum
CREATE TYPE "SnapshotStatus" AS ENUM ('INITIAL', 'UNCHANGED', 'CHANGED');

-- CreateEnum
CREATE TYPE "VerificationTrigger" AS ENUM ('MANUAL', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "ChangeType" AS ENUM ('ADD', 'REMOVE', 'UPDATE');

-- CreateEnum
CREATE TYPE "SmartContractStatus" AS ENUM ('PENDING', 'PROCESSING', 'STORED', 'ALREADY_STORED', 'FAILED', 'PERMANENTLY_FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('LAND_RECORD_CHANGED', 'VERIFICATION_FAILED', 'SMART_CONTRACT_FAILED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('UNREAD', 'READ');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "mobile" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "interval" "PlanInterval" NOT NULL,
    "duration_months" INTEGER NOT NULL,
    "allowed_frequencies" "VerificationFrequency"[],
    "max_monitored_lands" INTEGER,
    "features" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "amount" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'RAZORPAY',
    "receipt" TEXT NOT NULL,
    "provider_order_id" TEXT NOT NULL,
    "provider_payment_id" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "method" TEXT,
    "failure_reason" TEXT,
    "provider_data" JSONB,
    "verified_via" TEXT,
    "verified_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhook_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'RAZORPAY',
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processed_at" TIMESTAMP(3),
    "result" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "land_verifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "state_code" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "parcel_key" TEXT NOT NULL,
    "locator" JSONB NOT NULL,
    "display_name" TEXT,
    "status" "LandVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "latest_snapshot_id" UUID,
    "verification_count" INTEGER NOT NULL DEFAULT 0,
    "change_count" INTEGER NOT NULL DEFAULT 0,
    "first_verified_at" TIMESTAMP(3),
    "last_verified_at" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3),
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "monitoring_enabled" BOOLEAN NOT NULL DEFAULT false,
    "verification_frequency" "VerificationFrequency",
    "next_verification_at" TIMESTAMP(3),
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "land_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "land_record_snapshots" (
    "id" UUID NOT NULL,
    "land_verification_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_reference" TEXT,
    "provider_request_id" TEXT,
    "raw_response" JSONB NOT NULL,
    "normalized_data" JSONB NOT NULL,
    "normalizer_version" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "status" "SnapshotStatus" NOT NULL,
    "trigger" "VerificationTrigger" NOT NULL DEFAULT 'MANUAL',
    "previous_snapshot_id" UUID,
    "change_count" INTEGER NOT NULL DEFAULT 0,
    "verified_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "land_record_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "land_record_changes" (
    "id" UUID NOT NULL,
    "land_verification_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "previous_snapshot_id" UUID NOT NULL,
    "type" "ChangeType" NOT NULL,
    "field" TEXT NOT NULL,
    "old_value" JSONB,
    "new_value" JSONB,
    "is_critical" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "land_record_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "smart_contract_records" (
    "id" UUID NOT NULL,
    "land_verification_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "data_hash" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "status" "SmartContractStatus" NOT NULL DEFAULT 'PENDING',
    "request_reference" TEXT,
    "external_reference" TEXT,
    "transaction_hash" TEXT,
    "network" TEXT,
    "contract_address" TEXT,
    "block_number" INTEGER,
    "response" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 8,
    "next_retry_at" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3),
    "locked_until" TIMESTAMP(3),
    "stored_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "smart_contract_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "land_verification_id" UUID,
    "snapshot_id" UUID,
    "type" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "status" "AlertStatus" NOT NULL DEFAULT 'UNREAD',
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_request_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "request_id" TEXT,
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_body" JSONB,
    "response_status" INTEGER,
    "response_body" JSONB,
    "provider_reference" TEXT,
    "success" BOOLEAN NOT NULL,
    "error_code" TEXT,
    "error_message" TEXT,
    "duration_ms" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_request_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_mobile_key" ON "users"("mobile");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_code_key" ON "subscription_plans"("code");

-- CreateIndex
CREATE INDEX "subscriptions_user_id_status_idx" ON "subscriptions"("user_id", "status");

-- CreateIndex
CREATE INDEX "subscriptions_status_ends_at_idx" ON "subscriptions"("status", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_receipt_key" ON "payments"("receipt");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_order_id_key" ON "payments"("provider_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_payment_id_key" ON "payments"("provider_payment_id");

-- CreateIndex
CREATE INDEX "payments_user_id_created_at_idx" ON "payments"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "payments_subscription_id_idx" ON "payments"("subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_webhook_events_provider_event_id_key" ON "payment_webhook_events"("provider", "event_id");

-- CreateIndex
CREATE INDEX "land_verifications_monitoring_enabled_next_verification_at_idx" ON "land_verifications"("monitoring_enabled", "next_verification_at");

-- CreateIndex
CREATE UNIQUE INDEX "land_verifications_user_id_state_code_parcel_key_key" ON "land_verifications"("user_id", "state_code", "parcel_key");

-- CreateIndex
CREATE INDEX "land_record_snapshots_land_verification_id_verified_at_idx" ON "land_record_snapshots"("land_verification_id", "verified_at");

-- CreateIndex
CREATE INDEX "land_record_snapshots_hash_idx" ON "land_record_snapshots"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "land_record_snapshots_land_verification_id_sequence_key" ON "land_record_snapshots"("land_verification_id", "sequence");

-- CreateIndex
CREATE INDEX "land_record_changes_land_verification_id_created_at_idx" ON "land_record_changes"("land_verification_id", "created_at");

-- CreateIndex
CREATE INDEX "land_record_changes_snapshot_id_idx" ON "land_record_changes"("snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "smart_contract_records_snapshot_id_key" ON "smart_contract_records"("snapshot_id");

-- CreateIndex
CREATE INDEX "smart_contract_records_status_next_retry_at_idx" ON "smart_contract_records"("status", "next_retry_at");

-- CreateIndex
CREATE INDEX "smart_contract_records_data_hash_idx" ON "smart_contract_records"("data_hash");

-- CreateIndex
CREATE INDEX "smart_contract_records_land_verification_id_idx" ON "smart_contract_records"("land_verification_id");

-- CreateIndex
CREATE INDEX "alerts_user_id_status_created_at_idx" ON "alerts"("user_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "api_request_logs_provider_created_at_idx" ON "api_request_logs"("provider", "created_at");

-- CreateIndex
CREATE INDEX "api_request_logs_user_id_created_at_idx" ON "api_request_logs"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "land_verifications" ADD CONSTRAINT "land_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "land_record_snapshots" ADD CONSTRAINT "land_record_snapshots_land_verification_id_fkey" FOREIGN KEY ("land_verification_id") REFERENCES "land_verifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "land_record_changes" ADD CONSTRAINT "land_record_changes_land_verification_id_fkey" FOREIGN KEY ("land_verification_id") REFERENCES "land_verifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "land_record_changes" ADD CONSTRAINT "land_record_changes_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "land_record_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smart_contract_records" ADD CONSTRAINT "smart_contract_records_land_verification_id_fkey" FOREIGN KEY ("land_verification_id") REFERENCES "land_verifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smart_contract_records" ADD CONSTRAINT "smart_contract_records_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "land_record_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_land_verification_id_fkey" FOREIGN KEY ("land_verification_id") REFERENCES "land_verifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_request_logs" ADD CONSTRAINT "api_request_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
