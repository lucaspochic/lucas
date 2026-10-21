-- Relances : historique en ajout seul.
CREATE TRIGGER payment_reminders_append_only BEFORE UPDATE OR DELETE ON payment_reminders
  FOR EACH ROW EXECUTE FUNCTION forbid_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_reminders_no_truncate BEFORE TRUNCATE ON payment_reminders
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_append_only_mutation();
