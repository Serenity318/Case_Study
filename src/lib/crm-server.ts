import "server-only";

import {
  CONTACT_STATUSES,
  OPPORTUNITY_STAGES,
  isContactStatus,
  isOpportunityStage,
  type Contact,
  type ContactStatus,
  type Opportunity,
  type OpportunityStage,
} from "@/lib/crm";
import { isUuid } from "@/lib/http";

/**
 * Server-side CRM helpers: input validation (API camelCase -> DB snake_case) and
 * row mappers (DB -> API). Limits mirror sensible UI limits; the database CHECK
 * constraints remain the last line of defence.
 */

// ---------------------------------------------------------------------------
// Column lists
// ---------------------------------------------------------------------------
export const CONTACT_SELECT = "id, name, email, phone, company, status, created_at, updated_at, opportunities(count)";
export const OPPORTUNITY_SELECT =
  "id, contact_id, title, value_rm, stage, created_at, updated_at, contact:contacts(id, name, company)";

const MAX = { name: 200, email: 254, phone: 40, company: 200, title: 200 };
/** numeric(12,2) holds up to 9,999,999,999.99 */
export const MAX_VALUE_RM = 9_999_999_999.99;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
type Parsed<T> = { ok: true; data: T } | { ok: false; message: string };

export interface ContactRowInput {
  name?: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  status?: ContactStatus;
}

export interface OpportunityRowInput {
  contact_id?: string;
  title?: string;
  value_rm?: number;
  stage?: OpportunityStage;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9+()\-.\s]+$/;

/** create: name required, defaults applied by the DB. update: any subset, at least one field. */
export function parseContactInput(body: Record<string, unknown>, mode: "create" | "update"): Parsed<ContactRowInput> {
  const allowed = ["name", "email", "phone", "company", "status"];
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) return fail(`Unknown field(s): ${unknown.join(", ")}. Allowed: ${allowed.join(", ")}.`);
  if (mode === "update" && Object.keys(body).length === 0) return fail("Provide at least one field to update.");

  const data: ContactRowInput = {};

  if (mode === "create" || "name" in body) {
    const name = requiredText(body.name, "name", MAX.name);
    if (typeof name !== "string") return name;
    data.name = name;
  }
  for (const field of ["email", "phone", "company"] as const) {
    if (!(field in body)) continue;
    const value = optionalText(body[field], field, MAX[field]);
    if (value !== null && typeof value !== "string") return value;
    data[field] = value;
  }
  if (data.email && !EMAIL.test(data.email)) return fail(`"email" is not a valid email address.`);
  if (data.phone && !PHONE.test(data.phone)) {
    return fail(`"phone" may contain only digits, spaces and + ( ) - . characters.`);
  }
  if ("status" in body) {
    if (!isContactStatus(body.status)) return fail(`"status" must be one of: ${CONTACT_STATUSES.join(", ")}.`);
    data.status = body.status;
  }
  return { ok: true, data };
}

/** create: contactId and title required. update: any subset, at least one field. */
export function parseOpportunityInput(
  body: Record<string, unknown>,
  mode: "create" | "update",
): Parsed<OpportunityRowInput> {
  const allowed = ["contactId", "title", "valueRm", "stage"];
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) return fail(`Unknown field(s): ${unknown.join(", ")}. Allowed: ${allowed.join(", ")}.`);
  if (mode === "update" && Object.keys(body).length === 0) return fail("Provide at least one field to update.");

  const data: OpportunityRowInput = {};

  if (mode === "create" || "contactId" in body) {
    if (!isUuid(body.contactId)) return fail(`"contactId" is required and must be a contact id (UUID).`);
    data.contact_id = body.contactId;
  }
  if (mode === "create" || "title" in body) {
    const title = requiredText(body.title, "title", MAX.title);
    if (typeof title !== "string") return title;
    data.title = title;
  }
  if ("valueRm" in body) {
    const raw = typeof body.valueRm === "string" && body.valueRm.trim() !== "" ? Number(body.valueRm) : body.valueRm;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return fail(`"valueRm" must be a number.`);
    if (raw < 0 || raw > MAX_VALUE_RM) return fail(`"valueRm" must be between 0 and ${MAX_VALUE_RM}.`);
    if (Math.abs(raw * 100 - Math.round(raw * 100)) > 1e-6) return fail(`"valueRm" can have at most 2 decimal places.`);
    data.value_rm = Math.round(raw * 100) / 100;
  }
  if ("stage" in body) {
    if (!isOpportunityStage(body.stage)) return fail(`"stage" must be one of: ${OPPORTUNITY_STAGES.join(", ")}.`);
    data.stage = body.stage;
  }
  return { ok: true, data };
}

function requiredText(value: unknown, field: string, max: number): string | { ok: false; message: string } {
  if (typeof value !== "string" || value.trim() === "") return fail(`"${field}" is required.`);
  const text = value.trim();
  if (text.length > max) return fail(`"${field}" must be at most ${max} characters.`);
  return text;
}

/** null, undefined or "" -> null; otherwise a trimmed string within the limit. */
function optionalText(value: unknown, field: string, max: number): string | null | { ok: false; message: string } {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return fail(`"${field}" must be a string or null.`);
  const text = value.trim();
  if (text === "") return null;
  if (text.length > max) return fail(`"${field}" must be at most ${max} characters.`);
  return text;
}

function fail(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------
export interface ContactRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  status: ContactStatus;
  created_at: string;
  updated_at: string;
  opportunities?: { count: number }[];
}

export interface OpportunityRow {
  id: string;
  contact_id: string;
  title: string;
  value_rm: number | string; // numeric may arrive as a string
  stage: OpportunityStage;
  created_at: string;
  updated_at: string;
  contact: { id: string; name: string; company: string | null } | null;
}

export function toContact(row: ContactRow): Contact {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    company: row.company,
    status: row.status,
    opportunityCount: row.opportunities?.[0]?.count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toOpportunity(row: OpportunityRow): Opportunity {
  return {
    id: row.id,
    contactId: row.contact_id,
    contact: row.contact,
    title: row.title,
    valueRm: Number(row.value_rm),
    stage: row.stage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * PostgREST filter value for a case-insensitive "contains" search inside .or(...).
 * The value is double-quoted so commas, dots and parentheses typed by the user
 * cannot break out of the filter; backslashes and quotes are escaped.
 */
export function ilikeContains(term: string): string {
  return `"*${term.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}*"`;
}
