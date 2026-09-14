CREATE TABLE "node_keys" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,"node_device_id" uuid NOT NULL REFERENCES "arena_devices"("id") ON DELETE CASCADE,
 "algorithm" text DEFAULT 'ed25519' NOT NULL,"public_key" text NOT NULL,"fingerprint" text NOT NULL,"version" integer NOT NULL,
 "state" text DEFAULT 'pending' NOT NULL,"replaces_key_id" uuid REFERENCES "node_keys"("id") ON DELETE SET NULL,
 "enrollment_provenance" text NOT NULL,"activated_at" timestamp,"expires_at" timestamp,"revoked_at" timestamp,"revocation_reason" text,"created_at" timestamp DEFAULT now() NOT NULL,
 UNIQUE("node_device_id","version"),UNIQUE("fingerprint")
);
CREATE TABLE "node_protocol_responses" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,"request_id" uuid UNIQUE NOT NULL REFERENCES "node_protocol_requests"("id") ON DELETE CASCADE,
 "node_device_id" uuid NOT NULL REFERENCES "arena_devices"("id"),"node_key_id" uuid NOT NULL REFERENCES "node_keys"("id"),"response_nonce" text UNIQUE NOT NULL,
 "status" text NOT NULL,"result_digest" text NOT NULL,"issued_at" timestamp NOT NULL,"expires_at" timestamp NOT NULL,"signature" text NOT NULL,"accepted_at" timestamp,"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE "rate_limit_buckets" ("key" text PRIMARY KEY,"window_started_at" timestamp NOT NULL,"count" integer DEFAULT 0 NOT NULL,"bytes" integer DEFAULT 0 NOT NULL,"updated_at" timestamp DEFAULT now() NOT NULL);
ALTER TABLE "file_artifacts" ADD COLUMN "blob_key_version" integer, ADD COLUMN "blob_nonce" text, ADD COLUMN "blob_auth_tag" text, ADD COLUMN "encrypted_at" timestamp;
CREATE INDEX "node_keys_device_idx" ON "node_keys"("node_device_id","state");
