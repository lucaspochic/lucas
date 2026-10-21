CREATE TABLE "payment_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"level" smallint NOT NULL,
	"channel" text NOT NULL,
	"recipient" text,
	"amount_due" numeric(15, 2) NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "payment_reminders_level_ck" CHECK ("payment_reminders"."level" between 1 and 3),
	CONSTRAINT "payment_reminders_channel_ck" CHECK ("payment_reminders"."channel" in ('email', 'letter', 'other'))
);
--> statement-breakpoint
ALTER TABLE "sales_document_lines" DROP CONSTRAINT "sales_document_lines_qty_ck";--> statement-breakpoint
ALTER TABLE "sales_document_lines" ADD COLUMN "deducted_document_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_documents" ADD COLUMN "is_deposit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_reminders" ADD CONSTRAINT "payment_reminders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reminders" ADD CONSTRAINT "payment_reminders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reminders" ADD CONSTRAINT "payment_reminders_document_company_fk" FOREIGN KEY ("document_id","company_id") REFERENCES "public"."sales_documents"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_reminders_document_idx" ON "payment_reminders" USING btree ("company_id","document_id");--> statement-breakpoint
ALTER TABLE "sales_document_lines" ADD CONSTRAINT "sales_document_lines_deducted_company_fk" FOREIGN KEY ("deducted_document_id","company_id") REFERENCES "public"."sales_documents"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_document_lines" ADD CONSTRAINT "sales_document_lines_qty_ck" CHECK ("sales_document_lines"."quantity" > 0 or ("sales_document_lines"."deducted_document_id" is not null and "sales_document_lines"."quantity" < 0));--> statement-breakpoint
ALTER TABLE "sales_documents" ADD CONSTRAINT "sales_documents_deposit_ck" CHECK (not "sales_documents"."is_deposit" or ("sales_documents"."type" in ('invoice', 'credit_note') and "sales_documents"."source_document_id" is not null));