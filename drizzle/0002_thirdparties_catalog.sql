CREATE TYPE "public"."party_type" AS ENUM('individual', 'business', 'public_entity');--> statement-breakpoint
CREATE TYPE "public"."product_kind" AS ENUM('good', 'service');--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"third_party_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"job_title" text,
	"email" text,
	"phone" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text,
	"kind" "product_kind" NOT NULL,
	"unit" text NOT NULL,
	"unit_price_excl_tax" numeric(15, 4) NOT NULL,
	"purchase_price_excl_tax" numeric(15, 4),
	"vat_rate_id" uuid NOT NULL,
	"barcode" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_price_ck" CHECK ("products"."unit_price_excl_tax" >= 0),
	CONSTRAINT "products_purchase_ck" CHECK ("products"."purchase_price_excl_tax" is null or "products"."purchase_price_excl_tax" >= 0)
);
--> statement-breakpoint
CREATE TABLE "third_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"is_customer" boolean DEFAULT true NOT NULL,
	"is_supplier" boolean DEFAULT false NOT NULL,
	"party_type" "party_type" NOT NULL,
	"name" text NOT NULL,
	"legal_form" text,
	"siren" text,
	"siret" text,
	"vat_number" text,
	"email" text,
	"phone" text,
	"billing_line1" text,
	"billing_line2" text,
	"billing_postal_code" text,
	"billing_city" text,
	"billing_country" text DEFAULT 'FR' NOT NULL,
	"shipping_line1" text,
	"shipping_line2" text,
	"shipping_postal_code" text,
	"shipping_city" text,
	"shipping_country" text,
	"payment_terms_days" smallint,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "third_parties_role_ck" CHECK ("third_parties"."is_customer" or "third_parties"."is_supplier"),
	CONSTRAINT "third_parties_terms_ck" CHECK ("third_parties"."payment_terms_days" is null or "third_parties"."payment_terms_days" between 0 and 60)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "third_parties_id_company_uq" ON "third_parties" USING btree ("id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vat_rates_id_company_uq" ON "vat_rates" USING btree ("id","company_id");--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_third_party_company_fk" FOREIGN KEY ("third_party_id","company_id") REFERENCES "public"."third_parties"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_vat_rate_company_fk" FOREIGN KEY ("vat_rate_id","company_id") REFERENCES "public"."vat_rates"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "third_parties" ADD CONSTRAINT "third_parties_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contacts_third_party_idx" ON "contacts" USING btree ("company_id","third_party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_company_reference_uq" ON "products" USING btree ("company_id",lower("reference"));--> statement-breakpoint
CREATE INDEX "products_company_name_idx" ON "products" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE INDEX "products_company_barcode_idx" ON "products" USING btree ("company_id","barcode");--> statement-breakpoint
CREATE UNIQUE INDEX "third_parties_company_code_uq" ON "third_parties" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "third_parties_company_name_idx" ON "third_parties" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE INDEX "third_parties_company_siren_idx" ON "third_parties" USING btree ("company_id","siren");
