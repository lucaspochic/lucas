-- Comptabilité : intangibilité et équilibre des écritures.
--  * Écritures et lignes en ajout seul (une correction = une écriture inverse).
--  * Toute écriture est équilibrée (Σ débit = Σ crédit), contrôlé en fin de transaction
--    par un trigger de contrainte différé : une écriture déséquilibrée fait échouer la
--    transaction entière (l'événement métier qui l'a produite est annulé avec elle).

CREATE TRIGGER journal_entries_append_only
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER journal_entries_no_truncate
  BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER journal_lines_append_only
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER journal_lines_no_truncate
  BEFORE TRUNCATE ON journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION journal_entry_balance_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total_debit numeric;
  total_credit numeric;
  line_count integer;
BEGIN
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    INTO total_debit, total_credit, line_count
    FROM journal_lines WHERE entry_id = NEW.entry_id;
  IF line_count < 2 OR total_debit <> total_credit THEN
    RAISE EXCEPTION 'Écriture déséquilibrée (débit %, crédit %, % ligne(s))', total_debit, total_credit, line_count
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entry_balance_check();
--> statement-breakpoint
-- Une écriture sans ligne est également refusée en fin de transaction.
CREATE OR REPLACE FUNCTION journal_entry_has_lines_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journal_lines WHERE entry_id = NEW.id) THEN
    RAISE EXCEPTION 'Écriture % sans ligne', NEW.entry_seq USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entries_has_lines
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entry_has_lines_check();
