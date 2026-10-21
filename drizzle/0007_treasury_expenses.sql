CREATE TYPE "public"."expense_status" AS ENUM('draft', 'validated');--> statement-breakpoint
CREATE TYPE "public"."treasury_account_kind" AS ENUM('bank', 'cash');--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" "treasury_account_kind" NOT NULL,
	"name" text NOT NULL,
	"bank_name" text,
	"iban" text,
	"opening_balance" numeric(15, 2) DEFAULT '0' NOT NULL,
	"opening_date" text NOT NULL,
	"ledger_account" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_accounts_ledger_ck" CHECK ("bank_accounts"."ledger_account" ~ '^(512|530)[0-9]{0,5}$')
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"operation_date" text NOT NULL,
	"label" text NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"fingerprint" text NOT NULL,
	"import_id" uuid NOT NULL,
	"matched_payment_id" uuid,
	"matched_expense_payment_id" uuid,
	"reconciled_at" timestamp with time zone,
	"reconciled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transactions_single_match_ck" CHECK ("bank_transactions"."matched_payment_id" is null or "bank_transactions"."matched_expense_payment_id" is null)
);
--> statement-breakpoint
CREATE TABLE "expense_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"category" text NOT NULL,
	"ledger_account" text NOT NULL,
	"description" text NOT NULL,
	"amount_excl_tax" numeric(15, 2) NOT NULL,
	"vat_rate" numeric(5, 2) NOT NULL,
	"vat_amount" numeric(15, 2) NOT NULL,
	CONSTRAINT "expense_lines_amount_ck" CHECK ("expense_lines"."amount_excl_tax" > 0 and "expense_lines"."vat_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "expense_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"expense_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"payment_date" text NOT NULL,
	"method" "payment_method" NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"reference" text,
	"reverses_id" uuid,
	"reason" text,
	"recorded_at" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "expense_payments_amount_ck" CHECK ("expense_payments"."amount" <> 0),
	CONSTRAINT "expense_payments_reversal_ck" CHECK (("expense_payments"."reverses_id" is null) = ("expense_payments"."amount" > 0) and ("expense_payments"."reverses_id" is null or "expense_payments"."reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"status" "expense_status" DEFAULT 'draft' NOT NULL,
	"number" text,
	"fiscal_year" integer,
	"third_party_id" uuid NOT NULL,
	"supplier_reference" text,
	"invoice_date" text NOT NULL,
	"due_date" text,
	"total_excl_tax" numeric(15, 2) DEFAULT '0' NOT NULL,
	"total_vat" numeric(15, 2) DEFAULT '0' NOT NULL,
	"total_incl_tax" numeric(15, 2) DEFAULT '0' NOT NULL,
	"amount_paid" numeric(15, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"validated_at" timestamp with time zone,
	"validated_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_number_ck" CHECK (("expenses"."status" = 'draft') = ("expenses"."number" is null)),
	CONSTRAINT "expenses_paid_ck" CHECK ("expenses"."amount_paid" >= 0)
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "bank_account_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_id_company_uq" ON "bank_accounts" USING btree ("id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_payments_id_company_uq" ON "expense_payments" USING btree ("id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_id_company_uq" ON "expenses" USING btree ("id","company_id");--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_reconciled_by_users_id_fk" FOREIGN KEY ("reconciled_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_account_company_fk" FOREIGN KEY ("bank_account_id","company_id") REFERENCES "public"."bank_accounts"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_payment_company_fk" FOREIGN KEY ("matched_payment_id","company_id") REFERENCES "public"."payments"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_expense_payment_company_fk" FOREIGN KEY ("matched_expense_payment_id","company_id") REFERENCES "public"."expense_payments"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_lines" ADD CONSTRAINT "expense_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_lines" ADD CONSTRAINT "expense_lines_expense_company_fk" FOREIGN KEY ("expense_id","company_id") REFERENCES "public"."expenses"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_expense_company_fk" FOREIGN KEY ("expense_id","company_id") REFERENCES "public"."expenses"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_account_company_fk" FOREIGN KEY ("bank_account_id","company_id") REFERENCES "public"."bank_accounts"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_validated_by_users_id_fk" FOREIGN KEY ("validated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_third_party_company_fk" FOREIGN KEY ("third_party_id","company_id") REFERENCES "public"."third_parties"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_name_uq" ON "bank_accounts" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_ledger_uq" ON "bank_accounts" USING btree ("company_id","ledger_account");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transactions_fingerprint_uq" ON "bank_transactions" USING btree ("bank_account_id","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transactions_payment_uq" ON "bank_transactions" USING btree ("matched_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transactions_expense_payment_uq" ON "bank_transactions" USING btree ("matched_expense_payment_id");--> statement-breakpoint
CREATE INDEX "bank_transactions_account_idx" ON "bank_transactions" USING btree ("company_id","bank_account_id","operation_date");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_lines_position_uq" ON "expense_lines" USING btree ("expense_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_payments_number_uq" ON "expense_payments" USING btree ("company_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_payments_reverses_uq" ON "expense_payments" USING btree ("reverses_id");--> statement-breakpoint
CREATE INDEX "expense_payments_expense_idx" ON "expense_payments" USING btree ("company_id","expense_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_number_uq" ON "expenses" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "expenses_list_idx" ON "expenses" USING btree ("company_id","status","invoice_date");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_bank_account_company_fk" FOREIGN KEY ("bank_account_id","company_id") REFERENCES "public"."bank_accounts"("id","company_id") ON DELETE restrict ON UPDATE no action;
