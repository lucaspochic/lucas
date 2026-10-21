-- Caisse : inaltérabilité (BOFiP BOI-TVA-DECLA-30-10-30 §80-150).
--  * Tickets, lignes, paiements, clôtures et archives : ajout seul.
--  * Session de caisse : seule la fermeture (une fois) est autorisée ; ensuite figée.
-- Toute altération contournant ces protections est détectée par le chaînage et les
-- signatures (npm run audit:verify).

CREATE TRIGGER cash_tickets_append_only BEFORE UPDATE OR DELETE ON cash_tickets
  FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER cash_tickets_no_truncate BEFORE TRUNCATE ON cash_tickets
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER cash_ticket_lines_append_only BEFORE UPDATE OR DELETE ON cash_ticket_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER cash_ticket_lines_no_truncate BEFORE TRUNCATE ON cash_ticket_lines
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER cash_ticket_payments_append_only BEFORE UPDATE OR DELETE ON cash_ticket_payments
  FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER cash_ticket_payments_no_truncate BEFORE TRUNCATE ON cash_ticket_payments
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER cash_closures_append_only BEFORE UPDATE OR DELETE ON cash_closures
  FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER cash_closures_no_truncate BEFORE TRUNCATE ON cash_closures
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER cash_archives_append_only BEFORE UPDATE OR DELETE ON cash_archives
  FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION cash_sessions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Session de caisse : suppression interdite' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Session de caisse fermée : modification interdite' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.register_id <> OLD.register_id OR NEW.opened_at <> OLD.opened_at
     OR NEW.opened_by <> OLD.opened_by OR NEW.opening_float <> OLD.opening_float THEN
    RAISE EXCEPTION 'Session de caisse : données d''ouverture non modifiables' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cash_sessions_guard BEFORE UPDATE OR DELETE ON cash_sessions
  FOR EACH ROW EXECUTE FUNCTION cash_sessions_guard();
