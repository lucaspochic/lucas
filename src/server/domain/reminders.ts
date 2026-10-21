import { formatEuro } from "./money";
import type { CustomerSnapshot, SellerSnapshot } from "./sales";

/**
 * Lettres de relance des factures impayées, en trois niveaux. Ce sont des modèles :
 * l'utilisateur relit le texte avant envoi (en particulier la mise en demeure, dont les
 * conséquences juridiques lui appartiennent). Fonction pure.
 */

export const REMINDER_LEVELS = {
  1: "Relance amiable",
  2: "Second rappel",
  3: "Mise en demeure de payer",
} as const;
export type ReminderLevel = keyof typeof REMINDER_LEVELS;

const date = (iso: string) => iso.split("-").reverse().join("/");

export function reminderLetter(input: {
  level: ReminderLevel;
  seller: SellerSnapshot;
  customer: Pick<CustomerSnapshot, "name" | "partyType">;
  invoice: { number: string; issueDate: string; dueDate: string | null; remaining: string };
  today: string;
}) {
  const { level, seller, customer, invoice } = input;
  const amount = formatEuro(invoice.remaining);
  const due = invoice.dueDate ? ` arrivée à échéance le ${date(invoice.dueDate)}` : "";
  const ref = `la facture n° ${invoice.number} du ${date(invoice.issueDate)}${due}`;
  const professional = customer.partyType !== "individual";
  const subject = `${REMINDER_LEVELS[level]} — facture ${invoice.number} (${amount})`;

  const paragraphs: string[] = [`Madame, Monsieur,`];
  if (level === 1) {
    paragraphs.push(
      `Sauf erreur ou omission de notre part, ${ref} reste impayée à ce jour pour un montant de ${amount}.`,
      `Il s'agit peut-être d'un simple oubli : nous vous remercions de bien vouloir procéder à son règlement dans les meilleurs délais. Si votre paiement a été effectué entre-temps, merci de ne pas tenir compte de ce message.`,
    );
  } else if (level === 2) {
    paragraphs.push(
      `Malgré notre précédente relance, ${ref} demeure impayée pour un montant de ${amount}.`,
      `Nous vous prions de bien vouloir régulariser cette situation sous huit jours. Pour toute difficulté, n'hésitez pas à nous contacter afin de convenir d'une solution.`,
    );
  } else {
    paragraphs.push(
      `Malgré nos relances, ${ref} reste impayée pour un montant de ${amount}.`,
      `Par la présente, nous vous mettons en demeure de régler cette somme dans un délai de huit jours à compter de la réception de ce courrier. À défaut, nous nous réservons le droit d'engager toute procédure utile au recouvrement de notre créance.`,
    );
  }
  if (professional) {
    // Indemnité forfaitaire de 40 € : rappelée seulement si le texte de l'entreprise ne la mentionne pas déjà.
    const indemnity = /40\s*(€|euros?)/i.test(seller.latePenaltyText ?? "") ? null : "Une indemnité forfaitaire pour frais de recouvrement de 40 € est due de plein droit en cas de retard de paiement (C. com., art. L. 441-10).";
    const penalties = [seller.latePenaltyText, indemnity].filter(Boolean);
    paragraphs.push(penalties.join(" "));
  }
  if (seller.iban) paragraphs.push(`Règlement par virement : IBAN ${seller.iban}${seller.bic ? ` — BIC ${seller.bic}` : ""}, en rappelant la référence ${invoice.number}.`);
  paragraphs.push(`Veuillez agréer, Madame, Monsieur, nos salutations distinguées.`, seller.tradeName || seller.legalName);
  return { subject, title: REMINDER_LEVELS[level], body: paragraphs.join("\n\n") };
}
