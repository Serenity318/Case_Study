/**
 * CRM types, constants and formatting shared by the API routes and the browser.
 *
 * Client-safe: this module must not import anything server-only (Supabase,
 * Gemini, secrets). Server-side validation lives in src/lib/crm-server.ts.
 */

// ---------------------------------------------------------------------------
// Enums (must match the CHECK constraints in supabase/migrations/0001_init.sql)
// ---------------------------------------------------------------------------
export const CONTACT_STATUSES = ["lead", "prospect", "customer"] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const CONTACT_STATUS_LABELS: Record<ContactStatus, string> = {
  lead: "Lead",
  prospect: "Prospect",
  customer: "Customer",
};

export const OPPORTUNITY_STAGES = ["new", "contacted", "qualified", "proposal", "won", "lost"] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

export const STAGE_LABELS: Record<OpportunityStage, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  proposal: "Proposal",
  won: "Won",
  lost: "Lost",
};

/** "Open" = still in the pipeline, i.e. not won or lost. */
export function isOpenStage(stage: OpportunityStage): boolean {
  return stage !== "won" && stage !== "lost";
}

export function isContactStatus(value: unknown): value is ContactStatus {
  return typeof value === "string" && (CONTACT_STATUSES as readonly string[]).includes(value);
}

export function isOpportunityStage(value: unknown): value is OpportunityStage {
  return typeof value === "string" && (OPPORTUNITY_STAGES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// API shapes (camelCase JSON returned by /api/contacts, /api/opportunities, /api/dashboard)
// ---------------------------------------------------------------------------
export interface Contact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  status: ContactStatus;
  opportunityCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Body for POST /api/contacts (PATCH accepts any subset). */
export interface ContactInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  status?: ContactStatus;
}

export interface Opportunity {
  id: string;
  contactId: string;
  contact: { id: string; name: string; company: string | null } | null;
  title: string;
  valueRm: number;
  stage: OpportunityStage;
  createdAt: string;
  updatedAt: string;
}

/** Body for POST /api/opportunities (PATCH accepts any subset). */
export interface OpportunityInput {
  contactId: string;
  title: string;
  valueRm?: number;
  stage?: OpportunityStage;
}

export interface ActivityItem {
  type: "contact" | "opportunity";
  action: "created" | "updated";
  id: string;
  label: string; // contact name or opportunity title
  detail: string; // e.g. "Prospect · Syarikat Maju Jaya" or "RM 12,000.00 · Proposal · Aisyah Rahman"
  at: string; // ISO timestamp of the change
}

export interface DashboardData {
  totals: {
    contacts: number;
    opportunities: number;
    openOpportunities: number;
    totalValueRm: number;
    openValueRm: number;
    wonValueRm: number;
  };
  byStage: { stage: OpportunityStage; count: number; valueRm: number }[];
  recentActivity: ActivityItem[];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const RM = new Intl.NumberFormat("en-MY", {
  style: "currency",
  currency: "MYR",
  currencyDisplay: "narrowSymbol",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** 12500 -> "RM 12,500.00" */
export function formatRM(value: number): string {
  // en-MY renders "RM12,500.00"; add the conventional space after the symbol.
  return RM.format(value).replace(/^RM\s?/, "RM ").replace(/^-RM\s?/, "-RM ");
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "just now", "5 minutes ago", "yesterday", "3 days ago", then a date. */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return RELATIVE.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return RELATIVE.format(Math.round(seconds / 3600), "hour");
  if (abs < 30 * 86_400) return RELATIVE.format(Math.round(seconds / 86_400), "day");
  return new Date(iso).toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" });
}
