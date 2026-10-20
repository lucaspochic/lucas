CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'accountant', 'sales', 'cashier', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."vat_regime" AS ENUM('reel_normal', 'reel_simplifie', 'franchise_en_base', 'mini_reel');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" uuid,
	"chain_seq" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_name" text NOT NULL,
	"trade_name" text,
	"legal_form" text,
	"siren" text,
	"siret" text,
	"vat_number" text,
	"naf_code" text,
	"share_capital" numeric(15, 2),
	"rcs_city" text,
	"address_line1" text,
	"address_line2" text,
	"postal_code" text,
	"city" text,
	"country" text DEFAULT 'FR' NOT NULL,
	"email" text,
	"phone" text,
	"website" text,
	"iban" text,
	"bic" text,
	"fiscal_year_start_month" smallint DEFAULT 1 NOT NULL,
	"vat_regime" "vat_regime" DEFAULT 'reel_normal' NOT NULL,
	"vat_on_debits" boolean DEFAULT false NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"locale" text DEFAULT 'fr-FR' NOT NULL,
	"payment_terms_days" smallint DEFAULT 30 NOT NULL,
	"late_penalty_text" text,
	"legal_mentions" text,
	"invoice_prefix" text DEFAULT 'FA' NOT NULL,
	"credit_note_prefix" text DEFAULT 'AV' NOT NULL,
	"quote_prefix" text DEFAULT 'DE' NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_fy_month_ck" CHECK ("companies"."fiscal_year_start_month" between 1 and 12),
	CONSTRAINT "companies_terms_ck" CHECK ("companies"."payment_terms_days" between 0 and 60),
	CONSTRAINT "companies_currency_ck" CHECK ("companies"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "document_sequences" (
	"company_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"fiscal_year" integer NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_sequences_company_id_document_type_fiscal_year_pk" PRIMARY KEY("company_id","document_type","fiscal_year"),
	CONSTRAINT "document_sequences_positive_ck" CHECK ("document_sequences"."last_value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"operation" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_company_id_key_pk" PRIMARY KEY("company_id","key")
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email_key" text NOT NULL,
	"ip_address" text,
	"success" boolean NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"user_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"role" "member_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_user_id_company_id_pk" PRIMARY KEY("user_id","company_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"active_company_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vat_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"label" text NOT NULL,
	"rate" numeric(5, 2) NOT NULL,
	"exemption_reason" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vat_rates_range_ck" CHECK ("vat_rates"."rate" >= 0 and "vat_rates"."rate" <= 100),
	CONSTRAINT "vat_rates_zero_reason_ck" CHECK ("vat_rates"."rate" > 0 or "vat_rates"."exemption_reason" is not null)
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_company_id_companies_id_fk" FOREIGN KEY ("active_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_rates" ADD CONSTRAINT "vat_rates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_chain_uq" ON "audit_events" USING btree (coalesce("company_id", '00000000-0000-0000-0000-000000000000'::uuid),"chain_seq");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("company_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_time_idx" ON "audit_events" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "login_attempts_email_idx" ON "login_attempts" USING btree ("email_key","attempted_at");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_idx" ON "login_attempts" USING btree ("ip_address","attempted_at");--> statement-breakpoint
CREATE INDEX "memberships_company_idx" ON "memberships" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "vat_rates_company_rate_reason_uq" ON "vat_rates" USING btree ("company_id","rate",coalesce("exemption_reason", ''));