import { and, asc, eq, sql } from "drizzle-orm";
import type { Db, Executor } from "../db/client";
import { companies, memberships, sessions, users, vatRates, type Company, type Role } from "../db/schema";
import { AppError, forbidden, notFound } from "../errors";
import { assertPermission, type CompanyContext } from "../security/permissions";
import { appendAuditEvent } from "./audit";
import { createDefaultTreasuryAccounts } from "./treasury";
import { seedChartOfAccounts } from "./accounting";
import { todayInParis } from "../domain/numbering";
import { addMemberSchema, companySchema, createCompanySchema } from "@/lib/schemas";
import { suggestedModules } from "@/lib/activities";

/**
 * Entreprises, adhésions et contexte d'entreprise.
 * Règle d'isolation : toute lecture/écriture de données d'entreprise passe par un
 * CompanyContext obtenu via resolveCompanyContext(), qui vérifie l'adhésion en base.
 */

/** Taux de TVA applicables en France métropolitaine (CGI art. 278 à 281 nonies), créés par défaut. */
export const DEFAULT_VAT_RATES = [
  { label: "Taux normal 20 %", rate: "20.00", exemptionReason: null },
  { label: "Taux intermédiaire 10 %", rate: "10.00", exemptionReason: null },
  { label: "Taux réduit 5,5 %", rate: "5.50", exemptionReason: null },
  { label: "Taux particulier 2,1 %", rate: "2.10", exemptionReason: null },
] as const;

const FRANCHISE_RATE = {
  label: "Franchise en base",
  rate: "0.00",
  exemptionReason: "TVA non applicable, art. 293 B du CGI",
};

export async function resolveCompanyContext(
  db: Executor,
  userId: string,
  companyId: string | null | undefined,
): Promise<CompanyContext | null> {
  if (!companyId) return null;
  const [m] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.companyId, companyId)))
    .limit(1);
  return m ? { userId, companyId, role: m.role } : null;
}

export async function listUserCompanies(db: Executor, userId: string) {
  return db
    .select({ id: companies.id, legalName: companies.legalName, tradeName: companies.tradeName, role: memberships.role, isDemo: companies.isDemo })
    .from(memberships)
    .innerJoin(companies, eq(companies.id, memberships.companyId))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(companies.legalName));
}

export async function createCompany(db: Db, userId: string, raw: unknown, opts: { isDemo?: boolean } = {}) {
  const input = createCompanySchema.parse(raw);
  return db.transaction(async (tx) => {
    const [company] = await tx
      .insert(companies)
      .values({
        legalName: input.legalName,
        siren: input.siren ?? null,
        vatRegime: input.vatRegime,
        activities: input.activities,
        modules: suggestedModules(input.activities),
        isDemo: opts.isDemo ?? false,
      })
      .returning();
    await tx.insert(memberships).values({ userId, companyId: company!.id, role: "owner" });
    const rates = input.vatRegime === "franchise_en_base" ? [FRANCHISE_RATE] : DEFAULT_VAT_RATES;
    await tx.insert(vatRates).values(rates.map((r) => ({ ...r, companyId: company!.id })));
    await createDefaultTreasuryAccounts(tx, company!.id, todayInParis());
    await seedChartOfAccounts(tx, company!.id);
    await appendAuditEvent(tx, {
      companyId: company!.id,
      actorUserId: userId,
      action: "company.created",
      entityType: "company",
      entityId: company!.id,
      payload: { legalName: company!.legalName, siren: company!.siren, vatRegime: company!.vatRegime, activities: company!.activities, modules: company!.modules },
    });
    return company!;
  });
}

export async function getCompany(db: Executor, ctx: CompanyContext): Promise<Company> {
  assertPermission(ctx, "company.read");
  const [company] = await db.select().from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  if (!company) throw notFound("Entreprise introuvable.");
  return company;
}

const AUDITED_FIELDS = [
  "legalName", "tradeName", "legalForm", "siren", "siret", "vatNumber", "nafCode", "shareCapital", "rcsCity",
  "addressLine1", "addressLine2", "postalCode", "city", "country", "email", "phone", "website", "iban", "bic",
  "fiscalYearStartMonth", "vatRegime", "vatOnDebits", "paymentTermsDays", "latePenaltyText", "legalMentions",
  "invoicePrefix", "creditNotePrefix", "quotePrefix", "activities", "modules",
] as const;

export async function updateCompany(db: Db, ctx: CompanyContext, raw: unknown) {
  assertPermission(ctx, "company.update");
  const input = companySchema.parse(raw);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(companies).where(eq(companies.id, ctx.companyId)).for("update").limit(1);
    if (!before) throw notFound("Entreprise introuvable.");

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const field of AUDITED_FIELDS) {
      const from = before[field] ?? null;
      const to = (input as Record<string, unknown>)[field] ?? null;
      if (String(from) !== String(to)) changes[field] = { from: from === null ? null : String(from), to: to === null ? null : String(to) };
    }
    if (Object.keys(changes).length === 0) return before;

    const [after] = await tx
      .update(companies)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(companies.id, ctx.companyId))
      .returning();
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "company.updated",
      entityType: "company",
      entityId: ctx.companyId,
      payload: { changes },
    });
    return after!;
  });
}

export async function switchActiveCompany(db: Db, sessionId: string, userId: string, companyId: string) {
  const ctx = await resolveCompanyContext(db, userId, companyId);
  if (!ctx) throw forbidden("Vous n'avez pas accès à cette entreprise.");
  await db.update(sessions).set({ activeCompanyId: companyId }).where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
  return ctx;
}

export async function listMembers(db: Executor, ctx: CompanyContext) {
  assertPermission(ctx, "members.read");
  return db
    .select({ userId: users.id, fullName: users.fullName, email: users.email, role: memberships.role, since: memberships.createdAt })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.companyId, ctx.companyId))
    .orderBy(asc(users.fullName));
}

/** Rattache un utilisateur existant (l'invitation par e-mail nécessite un service d'envoi, non encore branché). */
export async function addMember(db: Db, ctx: CompanyContext, raw: unknown) {
  assertPermission(ctx, "members.manage");
  const input = addMemberSchema.parse(raw);
  if (input.role === "owner" && ctx.role !== "owner") throw forbidden("Seul un propriétaire peut nommer un propriétaire.");
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${input.email}`).limit(1);
    if (!user) {
      throw new AppError("NOT_FOUND", "Aucun compte n'existe avec cette adresse. La personne doit d'abord créer son compte.", {
        email: "Compte introuvable.",
      });
    }
    const existing = await resolveCompanyContext(tx, user.id, ctx.companyId);
    if (existing) throw new AppError("CONFLICT", "Cette personne est déjà membre de l'entreprise.");
    await tx.insert(memberships).values({ userId: user.id, companyId: ctx.companyId, role: input.role });
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "member.added",
      entityType: "membership",
      entityId: user.id,
      payload: { role: input.role },
    });
  });
}

export async function changeMemberRole(db: Db, ctx: CompanyContext, targetUserId: string, role: Role) {
  assertPermission(ctx, "members.manage");
  if (role === "owner" && ctx.role !== "owner") throw forbidden("Seul un propriétaire peut nommer un propriétaire.");
  return db.transaction(async (tx) => {
    const target = await resolveCompanyContext(tx, targetUserId, ctx.companyId);
    if (!target) throw notFound("Membre introuvable.");
    if (target.role === "owner" && ctx.role !== "owner") throw forbidden("Seul un propriétaire peut modifier un propriétaire.");
    if (target.role === "owner" && role !== "owner") {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(memberships)
        .where(and(eq(memberships.companyId, ctx.companyId), eq(memberships.role, "owner")));
      if (n <= 1) throw new AppError("CONFLICT", "L'entreprise doit conserver au moins un propriétaire.");
    }
    await tx
      .update(memberships)
      .set({ role })
      .where(and(eq(memberships.companyId, ctx.companyId), eq(memberships.userId, targetUserId)));
    await appendAuditEvent(tx, {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: "member.role_changed",
      entityType: "membership",
      entityId: targetUserId,
      payload: { from: target.role, to: role },
    });
  });
}

export async function listVatRates(db: Executor, ctx: CompanyContext) {
  assertPermission(ctx, "company.read");
  return db.select().from(vatRates).where(eq(vatRates.companyId, ctx.companyId)).orderBy(sql`${vatRates.rate} desc`);
}
