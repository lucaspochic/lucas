-- Règlements en ajout seul : aucun règlement ni aucune imputation ne peut être modifié
-- ou supprimé. Une erreur se corrige par une contre-passation (nouveau règlement de signe
-- opposé, motif obligatoire). Voir docs/11-conception-reglements.md.

CREATE TRIGGER payments_append_only
  BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER payments_no_truncate
  BEFORE TRUNCATE ON payments
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_allocations_append_only
  BEFORE UPDATE OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_allocations_no_truncate
  BEFORE TRUNCATE ON payment_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
-- Une imputation ne peut viser qu'une facture émise (jamais un brouillon, un devis ou un avoir).
CREATE OR REPLACE FUNCTION payment_allocations_target_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_type text;
  target_status text;
BEGIN
  SELECT type, status INTO target_type, target_status FROM sales_documents WHERE id = NEW.document_id;
  IF target_type IS DISTINCT FROM 'invoice' OR target_status = 'draft' THEN
    RAISE EXCEPTION 'Un règlement ne peut être imputé que sur une facture émise' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_allocations_target_guard
  BEFORE INSERT ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION payment_allocations_target_guard();
