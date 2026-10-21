CREATE TYPE "public"."payment_kind" AS ENUM('receipt', 'refund', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'check', 'card', 'transfer', 'direct_debit', 'other');--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	CONSTRAINT "payment_allocations_nonzero_ck" CHECK ("payment_allocations"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"fiscal_year" integer NOT NULL,
	"kind" "payment_kind" NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"payment_date" text NOT NULL,
	"third_party_id" uuid NOT NULL,
	"party_type_snapshot" "party_type" NOT NULL,
	"method" "payment_method" NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"reference" text,
	"reverses_payment_id" uuid,
	"reason" text,
	"chain_seq" integer NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "payments_amount_nonzero_ck" CHECK ("payments"."amount" <> 0),
	CONSTRAINT "payments_kind_sign_ck" CHECK (("payments"."kind" = 'receipt' and "payments"."amount" > 0) or ("payments"."kind" = 'refund' and "payments"."amount" < 0) or "payments"."kind" = 'reversal'),
	CONSTRAINT "payments_reversal_ck" CHECK (("payments"."kind" = 'reversal') = ("payments"."reverses_payment_id" is not null) and ("payments"."kind" <> 'reversal' or "payments"."reason" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_id_company_uq" ON "payments" USING btree ("id","company_id");--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_company_fk" FOREIGN KEY ("payment_id","company_id") REFERENCES "public"."payments"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_document_company_fk" FOREIGN KEY ("document_id","company_id") REFERENCES "public"."sales_documents"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_third_party_company_fk" FOREIGN KEY ("third_party_id","company_id") REFERENCES "public"."third_parties"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reverses_company_fk" FOREIGN KEY ("reverses_payment_id","company_id") REFERENCES "public"."payments"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_allocations_payment_idx" ON "payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_document_idx" ON "payment_allocations" USING btree ("company_id","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocations_pair_uq" ON "payment_allocations" USING btree ("payment_id","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_number_uq" ON "payments" USING btree ("company_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_chain_uq" ON "payments" USING btree ("company_id","chain_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_reverses_uq" ON "payments" USING btree ("reverses_payment_id");--> statement-breakpoint
CREATE INDEX "payments_party_idx" ON "payments" USING btree ("company_id","third_party_id");--> statement-breakpoint
CREATE INDEX "payments_date_idx" ON "payments" USING btree ("company_id","payment_date");
