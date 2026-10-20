-- Inaltérabilité des documents de vente émis.
--  * Un document émis (status <> 'draft') ne peut plus être supprimé.
--  * Seules restent modifiables les colonnes de suivi : statut (réponse à un devis),
--    montant réglé, date de réponse, date de mise à jour. Tout autre changement est refusé.
--  * Les lignes et la ventilation de TVA d'un document émis sont figées.
-- Les corrections passent par un avoir. Voir docs/06-conformite-caisse-nf525.md.

CREATE OR REPLACE FUNCTION sales_documents_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tracking text[] := ARRAY['status', 'amount_paid', 'responded_at', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Document émis % : suppression interdite', OLD.number USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - tracking) IS DISTINCT FROM (to_jsonb(OLD) - tracking) THEN
    RAISE EXCEPTION 'Document émis % : modification interdite, établissez un avoir', OLD.number USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status <> OLD.status
     AND NOT (OLD.type = 'quote' AND OLD.status = 'issued' AND NEW.status IN ('accepted', 'refused')) THEN
    RAISE EXCEPTION 'Document émis % : transition de statut % vers % interdite', OLD.number, OLD.status, NEW.status
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sales_documents_guard
  BEFORE UPDATE OR DELETE ON sales_documents
  FOR EACH ROW EXECUTE FUNCTION sales_documents_guard();
--> statement-breakpoint
CREATE TRIGGER sales_documents_no_truncate
  BEFORE TRUNCATE ON sales_documents
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sales_document_children_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO parent_status FROM sales_documents WHERE id = OLD.document_id;
    IF parent_status IS NOT NULL AND parent_status <> 'draft' THEN
      RAISE EXCEPTION 'Document émis : % de ses lignes interdite', lower(TG_OP) USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status INTO parent_status FROM sales_documents WHERE id = NEW.document_id;
    IF parent_status IS NOT NULL AND parent_status <> 'draft' THEN
      RAISE EXCEPTION 'Document émis : ajout ou modification de lignes interdit' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sales_document_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON sales_document_lines
  FOR EACH ROW EXECUTE FUNCTION sales_document_children_guard();
--> statement-breakpoint
CREATE TRIGGER sales_document_vat_guard
  BEFORE INSERT OR UPDATE OR DELETE ON sales_document_vat
  FOR EACH ROW EXECUTE FUNCTION sales_document_children_guard();
--> statement-breakpoint
CREATE TRIGGER sales_document_lines_no_truncate
  BEFORE TRUNCATE ON sales_document_lines
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER sales_document_vat_no_truncate
  BEFORE TRUNCATE ON sales_document_vat
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
