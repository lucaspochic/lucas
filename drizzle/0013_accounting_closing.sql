CREATE TABLE "fiscal_year_closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"fiscal_year" integer NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"result" numeric(15, 2) NOT NULL,
	"total_debit" numeric(15, 2) NOT NULL,
	"total_credit" numeric(15, 2) NOT NULL,
	"entry_count" integer NOT NULL,
	"opening_entry_id" uuid,
	"closed_at" timestamp with time zone NOT NULL,
	"closed_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lettering_lines" (
	"company_id" uuid NOT NULL,
	"lettering_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	CONSTRAINT "lettering_lines_line_id_pk" PRIMARY KEY("line_id")
);
--> statement-breakpoint
CREATE TABLE "letterings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"account_number" text NOT NULL,
	"aux_number" text,
	"code" text NOT NULL,
	"method" text NOT NULL,
	"lettered_at" timestamp with time zone NOT NULL,
	"lettered_by" uuid NOT NULL,
	"unlettered_at" timestamp with time zone,
	"unlettered_by" uuid,
	CONSTRAINT "letterings_method_ck" CHECK ("letterings"."method" in ('auto', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "letterings_id_company_uq" ON "letterings" USING btree ("id","company_id");--> statement-breakpoint
ALTER TABLE "fiscal_year_closures" ADD CONSTRAINT "fiscal_year_closures_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_year_closures" ADD CONSTRAINT "fiscal_year_closures_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lettering_lines" ADD CONSTRAINT "lettering_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lettering_lines" ADD CONSTRAINT "lettering_lines_group_company_fk" FOREIGN KEY ("lettering_id","company_id") REFERENCES "public"."letterings"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lettering_lines" ADD CONSTRAINT "lettering_lines_line_fk" FOREIGN KEY ("line_id") REFERENCES "public"."journal_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letterings" ADD CONSTRAINT "letterings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letterings" ADD CONSTRAINT "letterings_lettered_by_users_id_fk" FOREIGN KEY ("lettered_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "letterings" ADD CONSTRAINT "letterings_unlettered_by_users_id_fk" FOREIGN KEY ("unlettered_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_year_closures_uq" ON "fiscal_year_closures" USING btree ("company_id","fiscal_year");--> statement-breakpoint
CREATE INDEX "lettering_lines_group_idx" ON "lettering_lines" USING btree ("lettering_id");--> statement-breakpoint
CREATE UNIQUE INDEX "letterings_code_uq" ON "letterings" USING btree ("company_id","account_number","code");