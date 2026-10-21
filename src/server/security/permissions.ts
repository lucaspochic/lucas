import type { Role } from "../db/schema";
import { forbidden } from "../errors";

/**
 * Matrice rôles × permissions (documentée dans docs/03-roles-permissions.md).
 * Toute vérification d'autorisation est faite côté serveur, dans les services.
 */
export const PERMISSIONS = [
  "company.read",
  "company.update",
  "members.read",
  "members.manage",
  "audit.read",
  "audit.verify",
  "thirdparties.read",
  "thirdparties.write",
  "catalog.read",
  "catalog.write",
  "sales.read",
  "sales.write",
  "sales.issue",
  "payments.write",
  "purchases.read",
  "purchases.write",
  "treasury.read",
  "treasury.write",
  "accounting.read",
  "accounting.write",
  "accounting.close",
  "cash.operate",
  "cash.close",
  "exports.run",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);
const READ_ONLY: Permission[] = [
  "company.read",
  "thirdparties.read",
  "catalog.read",
  "sales.read",
  "accounting.read",
  "purchases.read",
  "treasury.read",
];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: ALL,
  admin: new Set([...PERMISSIONS].filter((p) => p !== "accounting.close")),
  accountant: new Set<Permission>([
    ...READ_ONLY,
    "members.read",
    "audit.read",
    "audit.verify",
    "payments.write",
    "purchases.write",
    "treasury.write",
    "accounting.write",
    "accounting.close",
    "exports.run",
  ]),
  sales: new Set<Permission>([
    ...READ_ONLY,
    "thirdparties.write",
    "catalog.write",
    "sales.write",
    "sales.issue",
    "payments.write",
  ]),
  cashier: new Set<Permission>(["company.read", "catalog.read", "thirdparties.read", "cash.operate"]),
  viewer: new Set<Permission>(READ_ONLY),
};

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Propriétaire",
  admin: "Administrateur",
  accountant: "Comptable",
  sales: "Commercial",
  cashier: "Caissier",
  viewer: "Lecture seule",
};

export interface CompanyContext {
  userId: string;
  companyId: string;
  role: Role;
}

export function can(ctx: Pick<CompanyContext, "role">, permission: Permission): boolean {
  return ROLE_PERMISSIONS[ctx.role].has(permission);
}

export function assertPermission(ctx: Pick<CompanyContext, "role">, permission: Permission): void {
  if (!can(ctx, permission)) throw forbidden();
}
