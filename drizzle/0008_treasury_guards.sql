-- Achats et trésorerie : protections en base.
--  * Une dépense validée est figée (seul le montant payé évolue) ; ses lignes aussi.
--  * Les paiements fournisseurs sont en ajout seul (contre-passation pour corriger).
--  * Les lignes de relevé importées ne sont ni supprimées ni modifiées, sauf les colonnes
--    de rapprochement (état de travail, tracé dans le journal d'audit).

CREATE OR REPLACE FUNCTION expenses_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tracking text[] := ARRAY['amount_paid', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Dépense validée % : suppression interdite', OLD.number USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - tracking) IS DISTINCT FROM (to_jsonb(OLD) - tracking) THEN
    RAISE EXCEPTION 'Dépense validée % : modification interdite', OLD.number USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER expenses_guard
  BEFORE UPDATE OR DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION expenses_guard();
--> statement-breakpoint
CREATE TRIGGER expenses_no_truncate
  BEFORE TRUNCATE ON expenses
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION expense_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO parent_status FROM expenses WHERE id = OLD.expense_id;
    IF parent_status IS NOT NULL AND parent_status <> 'draft' THEN
      RAISE EXCEPTION 'Dépense validée : lignes non modifiables' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status INTO parent_status FROM expenses WHERE id = NEW.expense_id;
    IF parent_status IS NOT NULL AND parent_status <> 'draft' THEN
      RAISE EXCEPTION 'Dépense validée : lignes non modifiables' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER expense_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON expense_lines
  FOR EACH ROW EXECUTE FUNCTION expense_lines_guard();
--> statement-breakpoint
CREATE TRIGGER expense_payments_append_only
  BEFORE UPDATE OR DELETE ON expense_payments
  FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER expense_payments_no_truncate
  BEFORE TRUNCATE ON expense_payments
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bank_transactions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  workflow text[] := ARRAY['matched_payment_id', 'matched_expense_payment_id', 'reconciled_at', 'reconciled_by'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Ligne de relevé importée : suppression interdite' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - workflow) IS DISTINCT FROM (to_jsonb(OLD) - workflow) THEN
    RAISE EXCEPTION 'Ligne de relevé importée : seules les informations de rapprochement sont modifiables' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER bank_transactions_guard
  BEFORE UPDATE OR DELETE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION bank_transactions_guard();
--> statement-breakpoint
-- Comptes de trésorerie par défaut pour les entreprises existantes.
INSERT INTO bank_accounts (company_id, kind, name, opening_date, ledger_account, is_default)
SELECT id, 'bank', 'Compte courant', to_char(created_at, 'YYYY-MM-DD'), '512000', true FROM companies;
--> statement-breakpoint
INSERT INTO bank_accounts (company_id, kind, name, opening_date, ledger_account, is_default)
SELECT id, 'cash', 'Caisse', to_char(created_at, 'YYYY-MM-DD'), '530000', true FROM companies;
