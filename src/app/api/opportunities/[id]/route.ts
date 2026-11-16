import { OPPORTUNITY_SELECT, parseOpportunityInput, toOpportunity, type OpportunityRow } from "@/lib/crm-server";
import { dbErrorResponse, errorResponse, handle, isUuid, readJsonObject } from "@/lib/http";
import { getSupabase } from "@/lib/supabase";

/**
 * GET    /api/opportunities/:id                                         -> { opportunity }
 * PATCH  /api/opportunities/:id  { any of contactId, title, valueRm, stage } -> { opportunity }
 * DELETE /api/opportunities/:id                                         -> { id }
 */

export async function GET(_request: Request, ctx: RouteContext<"/api/opportunities/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidId();

    const { data, error } = await getSupabase()
      .from("opportunities")
      .select(OPPORTUNITY_SELECT)
      .eq("id", id)
      .maybeSingle();
    if (error) return dbErrorResponse(error);
    if (!data) return notFound();
    return Response.json({ opportunity: toOpportunity(data as unknown as OpportunityRow) });
  });
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/opportunities/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidId();

    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const parsed = parseOpportunityInput(body, "update");
    if (!parsed.ok) return errorResponse(400, "invalid_input", parsed.message);

    const { data, error } = await getSupabase()
      .from("opportunities")
      .update(parsed.data)
      .eq("id", id)
      .select(OPPORTUNITY_SELECT)
      .maybeSingle();
    if (error) {
      return dbErrorResponse(error, { foreignKeyViolation: "The selected contact does not exist. It may have been deleted." });
    }
    if (!data) return notFound();
    return Response.json({ opportunity: toOpportunity(data as unknown as OpportunityRow) });
  });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/opportunities/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidId();

    const { data, error } = await getSupabase().from("opportunities").delete().eq("id", id).select("id").maybeSingle();
    if (error) return dbErrorResponse(error);
    if (!data) return notFound();
    return Response.json({ id });
  });
}

function invalidId() {
  return errorResponse(400, "invalid_id", "The opportunity id in the URL must be a UUID.");
}

function notFound() {
  return errorResponse(404, "not_found", "Opportunity not found. It may have been deleted.");
}
