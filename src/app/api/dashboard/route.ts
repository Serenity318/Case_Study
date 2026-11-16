import { connection } from "next/server";

import {
  CONTACT_STATUS_LABELS,
  OPPORTUNITY_STAGES,
  STAGE_LABELS,
  formatRM,
  isOpenStage,
  type ActivityItem,
  type DashboardData,
  type OpportunityStage,
} from "@/lib/crm";
import { dbErrorResponse, handle } from "@/lib/http";
import { getSupabase } from "@/lib/supabase";

/**
 * GET /api/dashboard -> DashboardData
 *
 * Totals are computed from all opportunities (paged, so the 1,000-row API cap
 * cannot silently truncate the sums). There is no activity table, so the feed is
 * the latest created/updated contacts and opportunities merged by time: it cannot
 * show deletions or say which field changed.
 */

const PAGE = 1000;
const FEED_SIZE = 10;

export async function GET() {
  // This handler reads no request data; without this, Cache Components could
  // prerender it at build time and serve stale numbers.
  await connection();

  return handle(async () => {
    const db = getSupabase();

    const [contactCount, recentContacts, recentOpportunities] = await Promise.all([
      db.from("contacts").select("id", { count: "exact", head: true }),
      db
        .from("contacts")
        .select("id, name, company, status, created_at, updated_at")
        .order("updated_at", { ascending: false })
        .limit(FEED_SIZE),
      db
        .from("opportunities")
        .select("id, title, value_rm, stage, created_at, updated_at, contact:contacts(name)")
        .order("updated_at", { ascending: false })
        .limit(FEED_SIZE),
    ]);
    const failed = contactCount.error ?? recentContacts.error ?? recentOpportunities.error;
    if (failed) return dbErrorResponse(failed);

    // All opportunities' stage and value, a page at a time.
    const rows: { stage: OpportunityStage; value_rm: number | string }[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from("opportunities")
        .select("stage, value_rm")
        .order("id")
        .range(from, from + PAGE - 1);
      if (error) return dbErrorResponse(error);
      rows.push(...(data as typeof rows));
      if (data.length < PAGE) break;
    }

    const byStage = OPPORTUNITY_STAGES.map((stage) => ({ stage, count: 0, valueRm: 0 }));
    for (const row of rows) {
      const bucket = byStage.find((b) => b.stage === row.stage);
      if (!bucket) continue;
      bucket.count += 1;
      bucket.valueRm += Number(row.value_rm);
    }
    const sum = (filter: (stage: OpportunityStage) => boolean) =>
      round2(byStage.filter((b) => filter(b.stage)).reduce((total, b) => total + b.valueRm, 0));

    const activity: ActivityItem[] = [
      ...(recentContacts.data as ContactFeedRow[]).map(
        (c): ActivityItem => ({
          type: "contact",
          action: wasUpdated(c) ? "updated" : "created",
          id: c.id,
          label: c.name,
          detail: [CONTACT_STATUS_LABELS[c.status], c.company].filter(Boolean).join(" · "),
          at: c.updated_at,
        }),
      ),
      ...(recentOpportunities.data as unknown as OpportunityFeedRow[]).map(
        (o): ActivityItem => ({
          type: "opportunity",
          action: wasUpdated(o) ? "updated" : "created",
          id: o.id,
          label: o.title,
          detail: [formatRM(Number(o.value_rm)), STAGE_LABELS[o.stage], o.contact?.name].filter(Boolean).join(" · "),
          at: o.updated_at,
        }),
      ),
    ]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, FEED_SIZE);

    const body: DashboardData = {
      totals: {
        contacts: contactCount.count ?? 0,
        opportunities: rows.length,
        openOpportunities: byStage.filter((b) => isOpenStage(b.stage)).reduce((n, b) => n + b.count, 0),
        totalValueRm: sum(() => true),
        openValueRm: sum(isOpenStage),
        wonValueRm: sum((stage) => stage === "won"),
      },
      byStage: byStage.map((b) => ({ ...b, valueRm: round2(b.valueRm) })),
      recentActivity: activity,
    };
    return Response.json(body);
  });
}

interface ContactFeedRow {
  id: string;
  name: string;
  company: string | null;
  status: keyof typeof CONTACT_STATUS_LABELS;
  created_at: string;
  updated_at: string;
}

interface OpportunityFeedRow {
  id: string;
  title: string;
  value_rm: number | string;
  stage: OpportunityStage;
  created_at: string;
  updated_at: string;
  contact: { name: string } | null;
}

/** Rows are inserted with created_at = updated_at; the trigger moves updated_at on every UPDATE. */
function wasUpdated(row: { created_at: string; updated_at: string }) {
  return Date.parse(row.updated_at) - Date.parse(row.created_at) > 1000;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
