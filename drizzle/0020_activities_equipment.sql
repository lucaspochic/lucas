CREATE TABLE "equipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"third_party_id" uuid NOT NULL,
	"category" text NOT NULL,
	"brand" text NOT NULL,
	"model" text NOT NULL,
	"serial_number" text,
	"registration" text,
	"year" smallint,
	"meter_value" integer,
	"meter_unit" text,
	"sold_on" text,
	"sales_document_id" uuid,
	"warranty_ends_on" text,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "equipment_category_ck" CHECK ("equipment"."category" in ('vehicle', 'agricultural', 'construction', 'other')),
	CONSTRAINT "equipment_year_ck" CHECK ("equipment"."year" is null or "equipment"."year" between 1900 and 2100),
	CONSTRAINT "equipment_meter_ck" CHECK (("equipment"."meter_value" is null) = ("equipment"."meter_unit" is null) and ("equipment"."meter_value" is null or "equipment"."meter_value" >= 0)),
	CONSTRAINT "equipment_meter_unit_ck" CHECK ("equipment"."meter_unit" is null or "equipment"."meter_unit" in ('km', 'h')),
	CONSTRAINT "equipment_sold_on_ck" CHECK ("equipment"."sold_on" is null or "equipment"."sold_on" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
	CONSTRAINT "equipment_warranty_ck" CHECK ("equipment"."warranty_ends_on" is null or "equipment"."warranty_ends_on" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_entity_ck";--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "activities" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "modules" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_third_party_company_fk" FOREIGN KEY ("third_party_id","company_id") REFERENCES "public"."third_parties"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_sales_document_company_fk" FOREIGN KEY ("sales_document_id","company_id") REFERENCES "public"."sales_documents"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "equipment_id_company_uq" ON "equipment" USING btree ("id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "equipment_company_serial_uq" ON "equipment" USING btree ("company_id",upper("serial_number")) WHERE "equipment"."serial_number" is not null;--> statement-breakpoint
CREATE INDEX "equipment_company_party_idx" ON "equipment" USING btree ("company_id","third_party_id");--> statement-breakpoint
CREATE INDEX "equipment_company_registration_idx" ON "equipment" USING btree ("company_id","registration");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_entity_ck" CHECK ("attachments"."entity_type" in ('expense', 'sales_document', 'third_party', 'equipment'));--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_activities_ck" CHECK ("companies"."activities" <@ array['vente_vehicules', 'materiel_agricole_tp', 'reparation_entretien', 'commerce_detail', 'restauration', 'artisanat_btp', 'negoce', 'services']::text[]);--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_modules_ck" CHECK ("companies"."modules" <@ array['caisse', 'parc']::text[]);--> statement-breakpoint
-- Entreprises existantes : la caisse était proposée à toutes, elle reste visible.
UPDATE "companies" SET "modules" = array['caisse']::text[];
