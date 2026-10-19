-- Unverified contact number for Google sign-ups (entered without OTP). Not unique and
-- never used for login. Nullable, so existing rows are unaffected.
ALTER TABLE "users" ADD COLUMN "contact_mobile" TEXT;
