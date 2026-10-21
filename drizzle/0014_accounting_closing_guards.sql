-- Clôture d'exercice et lettrage : protections en base.
--  * Exercice clôturé : la clôture est définitive (ajout seul) et aucune écriture ne peut
--    plus être enregistrée sur cet exercice.
--  * Lettrage : un groupe ne peut qu'être délettré (une fois) ; ses lignes appartiennent au
--    même compte et compte auxiliaire, et leur somme est nulle (contrôle différé en fin de
--    transaction) ; une ligne n'est retirée d'un groupe qu'après délettrage.

CREATE TRIGGER fiscal_year_closures_append_only BEFORE UPDATE OR DELETE ON fiscal_year_closures
  FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER fiscal_year_closures_no_truncate BEFORE TRUNCATE ON fiscal_year_closures
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION journal_entries_closed_year_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM fiscal_year_closures WHERE company_id = NEW.company_id AND fiscal_year = NEW.fiscal_year) THEN
    RAISE EXCEPTION 'Exercice % clôturé : aucune écriture ne peut y être enregistrée', NEW.fiscal_year USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_closed_year BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_closed_year_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION letterings_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Lettrage : suppression interdite (utiliser le délettrage)' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.unlettered_at IS NOT NULL THEN
    RAISE EXCEPTION 'Lettrage déjà annulé : modification interdite' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - 'unlettered_at' - 'unlettered_by') <> (to_jsonb(OLD) - 'unlettered_at' - 'unlettered_by')
     OR NEW.unlettered_at IS NULL OR NEW.unlettered_by IS NULL THEN
    RAISE EXCEPTION 'Lettrage : seul le délettrage est autorisé' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER letterings_guard BEFORE UPDATE OR DELETE ON letterings
  FOR EACH ROW EXECUTE FUNCTION letterings_guard();
--> statement-breakpoint
CREATE TRIGGER letterings_no_truncate BEFORE TRUNCATE ON letterings
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION lettering_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  grp letterings%ROWTYPE;
  ln journal_lines%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Lettrage : modification d''un lien interdite' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT * INTO grp FROM letterings WHERE id = OLD.lettering_id;
    IF grp.unlettered_at IS NULL THEN
      RAISE EXCEPTION 'Lettrage actif : délettrer avant de retirer une ligne' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  SELECT * INTO grp FROM letterings WHERE id = NEW.lettering_id;
  SELECT * INTO ln FROM journal_lines WHERE id = NEW.line_id;
  IF grp.unlettered_at IS NOT NULL THEN
    RAISE EXCEPTION 'Lettrage annulé : ajout de ligne interdit' USING ERRCODE = 'P0001';
  END IF;
  IF ln.company_id <> NEW.company_id OR ln.account_number <> grp.account_number
     OR ln.aux_number IS DISTINCT FROM grp.aux_number THEN
    RAISE EXCEPTION 'Lettrage : ligne d''un autre compte' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lettering_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON lettering_lines
  FOR EACH ROW EXECUTE FUNCTION lettering_lines_guard();
--> statement-breakpoint
CREATE TRIGGER lettering_lines_no_truncate BEFORE TRUNCATE ON lettering_lines
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION lettering_balance_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  balance numeric;
  line_count integer;
BEGIN
  SELECT coalesce(sum(l.debit - l.credit), 0), count(*) INTO balance, line_count
    FROM lettering_lines ll JOIN journal_lines l ON l.id = ll.line_id
    WHERE ll.lettering_id = NEW.lettering_id;
  IF line_count < 2 OR balance <> 0 THEN
    RAISE EXCEPTION 'Lettrage déséquilibré (solde %, % ligne(s))', balance, line_count USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER lettering_balanced AFTER INSERT ON lettering_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION lettering_balance_check();
