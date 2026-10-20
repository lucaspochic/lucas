-- Inaltérabilité : les tables en ajout seul refusent toute modification ou suppression.
-- Les corrections se font par de nouveaux enregistrements (contre-passation, avoir).
-- Voir docs/06-conformite-caisse-nf525.md.

CREATE OR REPLACE FUNCTION forbid_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table % en ajout seul : opération % interdite', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
-- Les compteurs de numérotation ne peuvent qu'avancer, d'une unité à la fois, et ne sont jamais supprimés.
CREATE OR REPLACE FUNCTION document_sequences_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Suppression d''un compteur de numérotation interdite' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.document_type <> OLD.document_type OR NEW.fiscal_year <> OLD.fiscal_year THEN
    RAISE EXCEPTION 'Modification de la clé d''un compteur interdite' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.last_value <> OLD.last_value + 1 THEN
    RAISE EXCEPTION 'Un compteur de numérotation ne peut avancer que d''une unité (% -> %)', OLD.last_value, NEW.last_value
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER document_sequences_forward_only
  BEFORE UPDATE OR DELETE ON document_sequences
  FOR EACH ROW EXECUTE FUNCTION document_sequences_forward_only();
