-- Pièces jointes : jamais supprimées ni modifiées ; seul le retrait (marquage, une fois) est permis.

CREATE OR REPLACE FUNCTION attachments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Pièce jointe : suppression interdite (utiliser le retrait)' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Pièce jointe déjà retirée : modification interdite' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - 'removed_at' - 'removed_by') <> (to_jsonb(OLD) - 'removed_at' - 'removed_by')
     OR NEW.removed_at IS NULL OR NEW.removed_by IS NULL THEN
    RAISE EXCEPTION 'Pièce jointe : seul le retrait est autorisé' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attachments_guard BEFORE UPDATE OR DELETE ON attachments
  FOR EACH ROW EXECUTE FUNCTION attachments_guard();
--> statement-breakpoint
CREATE TRIGGER attachments_no_truncate BEFORE TRUNCATE ON attachments
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
