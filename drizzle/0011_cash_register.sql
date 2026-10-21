CREATE TYPE "public"."cash_closure_kind" AS ENUM('day', 'month', 'year');--> statement-breakpoint
CREATE TYPE "public"."cash_ticket_kind" AS ENUM('sale', 'refund');--> statement-breakpoint
CREATE TABLE "cash_archives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"file_name" text NOT NULL,
	"sha256" text NOT NULL,
	"signature" text NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"kind" "cash_closure_kind" NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"seq" integer NOT NULL,
	"ticket_count" integer NOT NULL,
	"first_ticket_seq" integer,
	"last_ticket_seq" integer,
	"last_ticket_hash" text,
	"total_excl_tax" numeric(15, 2) NOT NULL,
	"total_vat" numeric(15, 2) NOT NULL,
	"grand_total" numeric(15, 2) NOT NULL,
	"perpetual_total" numeric(15, 2) NOT NULL,
	"perpetual_absolute_total" numeric(15, 2) NOT NULL,
	"vat_breakdown" jsonb NOT NULL,
	"payment_breakdown" jsonb NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"closed_by" uuid,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	"signature" text NOT NULL,
	"key_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_registers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"cash_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "cash_registers_code_ck" CHECK ("cash_registers"."code" ~ '^[A-Z0-9]{1,6}$')
);
--> statement-breakpoint
CREATE TABLE "cash_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"opened_by" uuid NOT NULL,
	"opening_float" numeric(15, 2) NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"expected_cash" numeric(15, 2),
	"counted_cash" numeric(15, 2),
	"difference" numeric(15, 2),
	"note" text,
	CONSTRAINT "cash_sessions_float_ck" CHECK ("cash_sessions"."opening_float" >= 0)
);
--> statement-breakpoint
CREATE TABLE "cash_ticket_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"product_id" uuid,
	"label" text NOT NULL,
	"kind" "product_kind" NOT NULL,
	"quantity" numeric(15, 3) NOT NULL,
	"unit_price_incl_tax" numeric(15, 4) NOT NULL,
	"vat_rate" numeric(5, 2) NOT NULL,
	"total_incl_tax" numeric(15, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_ticket_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"method" "payment_method" NOT NULL,
	"amount" numeric(15, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"number" text NOT NULL,
	"kind" "cash_ticket_kind" NOT NULL,
	"refund_of_id" uuid,
	"recorded_at" timestamp with time zone NOT NULL,
	"business_date" text NOT NULL,
	"operator_id" uuid NOT NULL,
	"third_party_id" uuid,
	"training" boolean DEFAULT false NOT NULL,
	"total_excl_tax" numeric(15, 2) NOT NULL,
	"total_vat" numeric(15, 2) NOT NULL,
	"total_incl_tax" numeric(15, 2) NOT NULL,
	"reason" text,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "cash_tickets_sign_ck" CHECK (("cash_tickets"."kind" = 'sale' and "cash_tickets"."total_incl_tax" >= 0) or ("cash_tickets"."kind" = 'refund' and "cash_tickets"."total_incl_tax" <= 0)),
	CONSTRAINT "cash_tickets_refund_ck" CHECK (("cash_tickets"."kind" = 'refund') = ("cash_tickets"."refund_of_id" is not null) and ("cash_tickets"."kind" = 'sale' or "cash_tickets"."reason" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cash_closures_period_uq" ON "cash_closures" USING btree ("register_id","kind","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_closures_seq_uq" ON "cash_closures" USING btree ("register_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_registers_id_company_uq" ON "cash_registers" USING btree ("id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_registers_code_uq" ON "cash_registers" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_sessions_id_company_uq" ON "cash_sessions" USING btree ("id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_sessions_one_open_uq" ON "cash_sessions" USING btree ("register_id") WHERE "cash_sessions"."closed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_ticket_lines_position_uq" ON "cash_ticket_lines" USING btree ("ticket_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_tickets_id_company_uq" ON "cash_tickets" USING btree ("id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_tickets_seq_uq" ON "cash_tickets" USING btree ("register_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_tickets_number_uq" ON "cash_tickets" USING btree ("company_id","number");--> statement-breakpoint
ALTER TABLE "cash_archives" ADD CONSTRAINT "cash_archives_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_archives" ADD CONSTRAINT "cash_archives_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_archives" ADD CONSTRAINT "cash_archives_register_company_fk" FOREIGN KEY ("register_id","company_id") REFERENCES "public"."cash_registers"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_closures" ADD CONSTRAINT "cash_closures_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_closures" ADD CONSTRAINT "cash_closures_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_closures" ADD CONSTRAINT "cash_closures_register_company_fk" FOREIGN KEY ("register_id","company_id") REFERENCES "public"."cash_registers"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_account_company_fk" FOREIGN KEY ("cash_account_id","company_id") REFERENCES "public"."bank_accounts"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_register_company_fk" FOREIGN KEY ("register_id","company_id") REFERENCES "public"."cash_registers"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_ticket_lines" ADD CONSTRAINT "cash_ticket_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_ticket_lines" ADD CONSTRAINT "cash_ticket_lines_ticket_company_fk" FOREIGN KEY ("ticket_id","company_id") REFERENCES "public"."cash_tickets"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_ticket_payments" ADD CONSTRAINT "cash_ticket_payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_ticket_payments" ADD CONSTRAINT "cash_ticket_payments_ticket_company_fk" FOREIGN KEY ("ticket_id","company_id") REFERENCES "public"."cash_tickets"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_tickets" ADD CONSTRAINT "cash_tickets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_tickets" ADD CONSTRAINT "cash_tickets_operator_id_users_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_tickets" ADD CONSTRAINT "cash_tickets_register_company_fk" FOREIGN KEY ("register_id","company_id") REFERENCES "public"."cash_registers"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_tickets" ADD CONSTRAINT "cash_tickets_session_company_fk" FOREIGN KEY ("session_id","company_id") REFERENCES "public"."cash_sessions"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_tickets" ADD CONSTRAINT "cash_tickets_refund_company_fk" FOREIGN KEY ("refund_of_id","company_id") REFERENCES "public"."cash_tickets"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_tickets" ADD CONSTRAINT "cash_tickets_party_company_fk" FOREIGN KEY ("third_party_id","company_id") REFERENCES "public"."third_parties"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_ticket_payments_ticket_idx" ON "cash_ticket_payments" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "cash_tickets_date_idx" ON "cash_tickets" USING btree ("register_id","business_date");
