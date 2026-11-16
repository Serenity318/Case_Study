import { OPPORTUNITY_STAGES, isOpportunityStage } from "@/lib/crm";
import { OPPORTUNITY_SELECT, parseOpportunityInput, toOpportunity, type OpportunityRow } from "@/lib/crm-server";
import { dbErrorResponse, errorResponse, handle, isUuid, readJsonObject } from "@/lib/http";
import { getSupabase } from "@/lib/supabase";

/**
 * GET  /api/opportunities?stage=proposal&contactId=<uuid>  -> { opportunities: Opportunity[] }
 *        most recently updated first, max 1000; each includes { contact: { id, name, company } }
 * POST /api/opportunities  { contactId, title, valueRm?, stage? }  -> 201 { opportunity }
 */

const LIST_LIMIT = 1000;

export async function GET(request: Request) {
  return handle(async () => {
    const params = new URL(request.url).searchParams;
    const stage = params.get("stage") || null;
    const contactId = params.get("contactId") || null;

    if (stage !== null && !isOpportunityStage(stage)) {
      return errorResponse(400, "invalid_stage", `"stage" must be one of: ${OPPORTUNITY_STAGES.join(", ")}.`);
    }
    if (contactId !== null && !isUuid(contactId)) {
      return errorResponse(400, "invalid_contact_id", `"contactId" must be a UUID.`);
    }

    let query = getSupabase()
      .from("opportunities")
      .select(OPPORTUNITY_SELECT)
      .order("updated_at", { ascending: false })
      .limit(LIST_LIMIT);
    if (stage) query = query.eq("stage", stage);
    if (contactId) query = query.eq("contact_id", contactId);

    const { data, error } = await query;
    if (error) return dbErrorResponse(error);
    return Response.json({ opportunities: (data as unknown as OpportunityRow[]).map(toOpportunity) });
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;

    const parsed = parseOpportunityInput(body, "create");
    if (!parsed.ok) return errorResponse(400, "invalid_input", parsed.message);

    const { data, error } = await getSupabase()
      .from("opportunities")
      .insert(parsed.data)
      .select(OPPORTUNITY_SELECT)
      .single();
    if (error) {
      return dbErrorResponse(error, { foreignKeyViolation: "The selected contact does not exist. It may have been deleted." });
    }
    return Response.json({ opportunity: toOpportunity(data as unknown as OpportunityRow) }, { status: 201 });
  });
}
