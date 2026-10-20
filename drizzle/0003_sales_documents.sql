CREATE TYPE "public"."operation_category" AS ENUM('goods', 'services', 'mixed');--> statement-breakpoint
CREATE TYPE "public"."sales_document_status" AS ENUM('draft', 'issued', 'accepted', 'refused');--> statement-breakpoint
CREATE TYPE "public"."sales_document_type" AS ENUM('quote', 'invoice', 'credit_note');--> statement-breakpoint
CREATE TABLE "sales_document_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"product_id" uuid,
	"reference" text,
	"description" text NOT NULL,
	"kind" "product_kind" NOT NULL,
	"quantity" numeric(15, 3) NOT NULL,
	"unit" text NOT NULL,
	"unit_price_excl_tax" numeric(15, 4) NOT NULL,
	"discount_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"vat_rate" numeric(5, 2) NOT NULL,
	"vat_exemption_reason" text,
	"total_excl_tax" numeric(15, 2) NOT NULL,
	CONSTRAINT "sales_document_lines_qty_ck" CHECK ("sales_document_lines"."quantity" > 0),
	CONSTRAINT "sales_document_lines_price_ck" CHECK ("sales_document_lines"."unit_price_excl_tax" >= 0),
	CONSTRAINT "sales_document_lines_discount_ck" CHECK ("sales_document_lines"."discount_percent" between 0 and 100),
	CONSTRAINT "sales_document_lines_vat_ck" CHECK ("sales_document_lines"."vat_rate" > 0 or "sales_document_lines"."vat_exemption_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "sales_document_vat" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"vat_rate" numeric(5, 2) NOT NULL,
	"vat_exemption_reason" text,
	"base_excl_tax" numeric(15, 2) NOT NULL,
	"vat_amount" numeric(15, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" "sales_document_type" NOT NULL,
	"status" "sales_document_status" DEFAULT 'draft' NOT NULL,
	"number" text,
	"fiscal_year" integer,
	"third_party_id" uuid NOT NULL,
	"source_document_id" uuid,
	"issue_date" text,
	"due_date" text,
	"delivery_date" text,
	"operation_category" "operation_category",
	"global_discount_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"total_excl_tax" numeric(15, 2) DEFAULT '0' NOT NULL,
	"total_vat" numeric(15, 2) DEFAULT '0' NOT NULL,
	"total_incl_tax" numeric(15, 2) DEFAULT '0' NOT NULL,
	"amount_paid" numeric(15, 2) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"notes" text,
	"seller_snapshot" jsonb,
	"customer_snapshot" jsonb,
	"content_hash" text,
	"issued_at" timestamp with time zone,
	"issued_by" uuid,
	"responded_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_documents_number_ck" CHECK (("sales_documents"."status" = 'draft') = ("sales_documents"."number" is null)),
	CONSTRAINT "sales_documents_issued_ck" CHECK ("sales_documents"."status" = 'draft' or ("sales_documents"."issue_date" is not null and "sales_documents"."content_hash" is not null and "sales_documents"."issued_at" is not null and "sales_documents"."fiscal_year" is not null)),
	CONSTRAINT "sales_documents_response_ck" CHECK ("sales_documents"."status" not in ('accepted', 'refused') or "sales_documents"."type" = 'quote'),
	CONSTRAINT "sales_documents_credit_source_ck" CHECK ("sales_documents"."type" <> 'credit_note' or "sales_documents"."source_document_id" is not null),
	CONSTRAINT "sales_documents_discount_ck" CHECK ("sales_documents"."global_discount_percent" between 0 and 100),
	CONSTRAINT "sales_documents_paid_ck" CHECK ("sales_documents"."amount_paid" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sales_documents_id_company_uq" ON "sales_documents" USING btree ("id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_id_company_uq" ON "products" USING btree ("id","company_id");--> statement-breakpoint
ALTER TABLE "sales_document_lines" ADD CONSTRAINT "sales_document_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_document_lines" ADD CONSTRAINT "sales_document_lines_document_company_fk" FOREIGN KEY ("document_id","company_id") REFERENCES "public"."sales_documents"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_document_lines" ADD CONSTRAINT "sales_document_lines_product_company_fk" FOREIGN KEY ("product_id","company_id") REFERENCES "public"."products"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_document_vat" ADD CONSTRAINT "sales_document_vat_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_document_vat" ADD CONSTRAINT "sales_document_vat_document_company_fk" FOREIGN KEY ("document_id","company_id") REFERENCES "public"."sales_documents"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_documents" ADD CONSTRAINT "sales_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_documents" ADD CONSTRAINT "sales_documents_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_documents" ADD CONSTRAINT "sales_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_documents" ADD CONSTRAINT "sales_documents_third_party_company_fk" FOREIGN KEY ("third_party_id","company_id") REFERENCES "public"."third_parties"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_documents" ADD CONSTRAINT "sales_documents_source_company_fk" FOREIGN KEY ("source_document_id","company_id") REFERENCES "public"."sales_documents"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_document_lines_position_uq" ON "sales_document_lines" USING btree ("document_id","position");--> statement-breakpoint
CREATE INDEX "sales_document_vat_document_idx" ON "sales_document_vat" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_documents_number_uq" ON "sales_documents" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "sales_documents_list_idx" ON "sales_documents" USING btree ("company_id","type","status","issue_date");--> statement-breakpoint
CREATE INDEX "sales_documents_party_idx" ON "sales_documents" USING btree ("company_id","third_party_id");--> statement-breakpoint
CREATE INDEX "sales_documents_source_idx" ON "sales_documents" USING btree ("company_id","source_document_id");
