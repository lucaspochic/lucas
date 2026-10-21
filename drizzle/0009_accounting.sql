CREATE TYPE "public"."journal_kind" AS ENUM('sales', 'purchases', 'bank', 'cash', 'misc');--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"journal_code" text NOT NULL,
	"fiscal_year" integer NOT NULL,
	"entry_seq" integer NOT NULL,
	"entry_date" text NOT NULL,
	"piece_ref" text NOT NULL,
	"piece_date" text NOT NULL,
	"label" text NOT NULL,
	"source_key" text NOT NULL,
	"validated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_number" text NOT NULL,
	"aux_number" text,
	"aux_label" text,
	"label" text NOT NULL,
	"debit" numeric(15, 2) DEFAULT '0' NOT NULL,
	"credit" numeric(15, 2) DEFAULT '0' NOT NULL,
	CONSTRAINT "journal_lines_amounts_ck" CHECK ("journal_lines"."debit" >= 0 and "journal_lines"."credit" >= 0 and ("journal_lines"."debit" = 0) <> ("journal_lines"."credit" = 0))
);
--> statement-breakpoint
CREATE TABLE "journals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"kind" "journal_kind" NOT NULL,
	"bank_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_number_ck" CHECK ("ledger_accounts"."number" ~ '^[1-7][0-9]{2,7}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_id_company_uq" ON "journal_entries" USING btree ("id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_seq_uq" ON "journal_entries" USING btree ("company_id","fiscal_year","entry_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_source_uq" ON "journal_entries" USING btree ("company_id","source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_lines_no_uq" ON "journal_lines" USING btree ("entry_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "journals_code_uq" ON "journals" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "journals_bank_account_uq" ON "journals" USING btree ("bank_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_number_uq" ON "ledger_accounts" USING btree ("company_id","number");--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_journal_fk" FOREIGN KEY ("company_id","journal_code") REFERENCES "public"."journals"("company_id","code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_company_fk" FOREIGN KEY ("entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_fk" FOREIGN KEY ("company_id","account_number") REFERENCES "public"."ledger_accounts"("company_id","number") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_bank_account_company_fk" FOREIGN KEY ("bank_account_id","company_id") REFERENCES "public"."bank_accounts"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_entries_date_idx" ON "journal_entries" USING btree ("company_id","entry_date");--> statement-breakpoint
CREATE INDEX "journal_lines_account_idx" ON "journal_lines" USING btree ("company_id","account_number");
