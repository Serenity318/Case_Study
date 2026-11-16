/**
 * Inserts sample CRM data: 10 contacts and 12 opportunities with fictional
 * Malaysian companies.
 *
 *   npm.cmd run seed              # insert; rows that already exist are skipped
 *   npm.cmd run seed -- --reset   # delete the sample contacts (and their opportunities) first
 *
 * Safe to re-run: contacts are matched by email and opportunities by
 * (contact, title), so nothing is duplicated. Only the sample rows below are
 * touched; contacts you created yourself are never deleted.
 *
 * Emails use the reserved .example domain (RFC 2606) so they can never reach a
 * real inbox. Created/updated dates are spread over the last few weeks so the
 * dashboard activity feed looks realistic.
 */
import { parseArgs } from "node:util";

import { loadEnvConfig } from "@next/env";

import type { ContactStatus, OpportunityStage } from "../src/lib/crm";
import { getSupabase } from "../src/lib/supabase";

loadEnvConfig(process.cwd());

interface SeedContact {
  name: string;
  email: string;
  phone: string;
  company: string;
  status: ContactStatus;
  createdDaysAgo: number;
  updatedDaysAgo?: number;
}

interface SeedOpportunity {
  contactEmail: string;
  title: string;
  valueRm: number;
  stage: OpportunityStage;
  createdDaysAgo: number;
  updatedDaysAgo?: number;
}

const CONTACTS: SeedContact[] = [
  { name: "Aisyah Rahman", email: "aisyah.rahman@majujaya.example", phone: "+60 12-338 4721", company: "Maju Jaya Trading Sdn. Bhd.", status: "customer", createdDaysAgo: 41, updatedDaysAgo: 9 },
  { name: "Tan Wei Ming", email: "weiming.tan@sinarlogistik.example", phone: "+60 16-772 1098", company: "Sinar Logistik (M) Sdn. Bhd.", status: "prospect", createdDaysAgo: 33, updatedDaysAgo: 4 },
  { name: "Muthu Krishnan", email: "muthu@krishnanpartners.example", phone: "+60 3-7956 2210", company: "Krishnan & Partners Chartered Accountants PLT", status: "customer", createdDaysAgo: 58, updatedDaysAgo: 12 },
  { name: "Nurul Huda Ismail", email: "nurulhuda@hudaenterprise.example", phone: "+60 19-405 6632", company: "Huda Enterprise", status: "lead", createdDaysAgo: 3 },
  { name: "Lim Siew Ling", email: "siewling.lim@penangprecision.example", phone: "+60 4-641 8890", company: "Penang Precision Engineering Sdn. Bhd.", status: "prospect", createdDaysAgo: 21, updatedDaysAgo: 2 },
  { name: "Ahmad Faiz Zulkifli", email: "faiz@faizdigital.example", phone: "+60 11-2384 5517", company: "Faiz Digital Solutions Sdn. Bhd.", status: "lead", createdDaysAgo: 1 },
  { name: "Wong Kar Yee", email: "karyee.wong@borneotimber.example", phone: "+60 82-245 671", company: "Borneo Timber Resources Bhd.", status: "lead", createdDaysAgo: 14, updatedDaysAgo: 6 },
  { name: "Siti Aminah Abdullah", email: "siti.aminah@aminahcatering.example", phone: "+60 13-998 2045", company: "Aminah Catering Services", status: "customer", createdDaysAgo: 75, updatedDaysAgo: 18 },
  { name: "Rajesh Nair", email: "rajesh.nair@kvautoparts.example", phone: "+60 17-361 7804", company: "Klang Valley Auto Parts Sdn. Bhd.", status: "prospect", createdDaysAgo: 26, updatedDaysAgo: 5 },
  { name: "Chong Mei Fong", email: "meifong.chong@johorfreshmart.example", phone: "+60 7-355 1289", company: "Johor Fresh Mart Sdn. Bhd.", status: "lead", createdDaysAgo: 8 },
];

const OPPORTUNITIES: SeedOpportunity[] = [
  { contactEmail: "aisyah.rahman@majujaya.example", title: "taxPOD annual subscription (10 seats)", valueRm: 18000, stage: "won", createdDaysAgo: 40, updatedDaysAgo: 9 },
  { contactEmail: "aisyah.rahman@majujaya.example", title: "e-Invoice consolidated invoicing workshop", valueRm: 6500, stage: "proposal", createdDaysAgo: 7, updatedDaysAgo: 1 },
  { contactEmail: "weiming.tan@sinarlogistik.example", title: "e-Invoice implementation training (25 pax)", valueRm: 12500, stage: "qualified", createdDaysAgo: 30, updatedDaysAgo: 4 },
  { contactEmail: "muthu@krishnanpartners.example", title: "taxPOD firm licence renewal (30 seats)", valueRm: 45000, stage: "won", createdDaysAgo: 55, updatedDaysAgo: 12 },
  { contactEmail: "muthu@krishnanpartners.example", title: "CPD tax update webinar series 2027", valueRm: 9800, stage: "proposal", createdDaysAgo: 10, updatedDaysAgo: 3 },
  { contactEmail: "nurulhuda@hudaenterprise.example", title: "taxPOD starter plan (1 seat)", valueRm: 1200, stage: "new", createdDaysAgo: 2 },
  { contactEmail: "siewling.lim@penangprecision.example", title: "SST return and payment in-house training", valueRm: 8400, stage: "contacted", createdDaysAgo: 20, updatedDaysAgo: 2 },
  { contactEmail: "faiz@faizdigital.example", title: "e-Invoice MyInvois API integration briefing", valueRm: 3500, stage: "new", createdDaysAgo: 1 },
  { contactEmail: "karyee.wong@borneotimber.example", title: "Tax audit preparation course (12 pax)", valueRm: 22000, stage: "contacted", createdDaysAgo: 13, updatedDaysAgo: 6 },
  { contactEmail: "siti.aminah@aminahcatering.example", title: "taxPOD subscription renewal (3 seats)", valueRm: 3600, stage: "won", createdDaysAgo: 70, updatedDaysAgo: 18 },
  { contactEmail: "rajesh.nair@kvautoparts.example", title: "Small value assets special allowance briefing (PR 4/2026)", valueRm: 4200, stage: "qualified", createdDaysAgo: 24, updatedDaysAgo: 5 },
  { contactEmail: "meifong.chong@johorfreshmart.example", title: "e-Invoice training for retail outlets (40 pax)", valueRm: 7800, stage: "lost", createdDaysAgo: 8, updatedDaysAgo: 2 },
];

const DAY_MS = 86_400_000;
/** A time `days` ago, at a fixed working-hours-ish offset so rows don't all share the same minute. */
function daysAgo(days: number, salt: number): string {
  const offsetMinutes = (salt * 97) % 480; // up to 8 hours
  return new Date(Date.now() - days * DAY_MS - offsetMinutes * 60_000).toISOString();
}

async function main() {
  const { values } = parseArgs({ options: { reset: { type: "boolean", default: false } } });
  const db = getSupabase();
  const emails = CONTACTS.map((c) => c.email);

  if (values.reset) {
    const { data, error } = await db.from("contacts").delete().in("email", emails).select("id");
    if (error) throw new Error(`Reset failed: ${error.message}`);
    console.log(`Reset: deleted ${data.length} sample contact(s) and their opportunities.`);
  }

  // Contacts -------------------------------------------------------------------
  const { data: existing, error: existingError } = await db.from("contacts").select("id, email").in("email", emails);
  if (existingError) throw new Error(`Could not read contacts: ${existingError.message}`);
  const idByEmail = new Map((existing ?? []).map((c) => [String(c.email).toLowerCase(), c.id as string]));

  const newContacts = CONTACTS.filter((c) => !idByEmail.has(c.email)).map((c, i) => ({
    name: c.name,
    email: c.email,
    phone: c.phone,
    company: c.company,
    status: c.status,
    created_at: daysAgo(c.createdDaysAgo, i),
    updated_at: daysAgo(c.updatedDaysAgo ?? c.createdDaysAgo, i),
  }));
  if (newContacts.length) {
    const { data, error } = await db.from("contacts").insert(newContacts).select("id, email");
    if (error) throw new Error(`Inserting contacts failed: ${error.message}`);
    for (const c of data) idByEmail.set(String(c.email).toLowerCase(), c.id as string);
  }
  console.log(`Contacts: ${newContacts.length} inserted, ${CONTACTS.length - newContacts.length} already present.`);

  // Opportunities ------------------------------------------------------------------
  const contactIds = [...idByEmail.values()];
  const { data: existingOpps, error: oppsError } = await db
    .from("opportunities")
    .select("contact_id, title")
    .in("contact_id", contactIds);
  if (oppsError) throw new Error(`Could not read opportunities: ${oppsError.message}`);
  const existingKeys = new Set((existingOpps ?? []).map((o) => `${o.contact_id}|${o.title}`));

  const newOpps = OPPORTUNITIES.map((o, i) => {
    const contactId = idByEmail.get(o.contactEmail);
    if (!contactId) throw new Error(`Seed data error: no contact with email ${o.contactEmail}`);
    return {
      contact_id: contactId,
      title: o.title,
      value_rm: o.valueRm,
      stage: o.stage,
      created_at: daysAgo(o.createdDaysAgo, i + 20),
      updated_at: daysAgo(o.updatedDaysAgo ?? o.createdDaysAgo, i + 20),
    };
  }).filter((o) => !existingKeys.has(`${o.contact_id}|${o.title}`));

  if (newOpps.length) {
    const { error } = await db.from("opportunities").insert(newOpps);
    if (error) throw new Error(`Inserting opportunities failed: ${error.message}`);
  }
  console.log(
    `Opportunities: ${newOpps.length} inserted, ${OPPORTUNITIES.length - newOpps.length} already present.`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
