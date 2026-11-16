import { CONTACT_SELECT, parseContactInput, toContact, type ContactRow } from "@/lib/crm-server";
import { dbErrorResponse, errorResponse, handle, isUuid, readJsonObject } from "@/lib/http";
import { getSupabase } from "@/lib/supabase";

/**
 * GET    /api/contacts/:id                                   -> { contact }
 * PATCH  /api/contacts/:id  { any of name, email, phone, company, status } -> { contact }
 * DELETE /api/contacts/:id                                   -> { id }
 *        Deleting a contact also deletes its opportunities (ON DELETE CASCADE).
 */

export async function GET(_request: Request, ctx: RouteContext<"/api/contacts/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidId();

    const { data, error } = await getSupabase().from("contacts").select(CONTACT_SELECT).eq("id", id).maybeSingle();
    if (error) return dbErrorResponse(error);
    if (!data) return notFound();
    return Response.json({ contact: toContact(data as unknown as ContactRow) });
  });
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/contacts/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidId();

    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const parsed = parseContactInput(body, "update");
    if (!parsed.ok) return errorResponse(400, "invalid_input", parsed.message);

    const { data, error } = await getSupabase()
      .from("contacts")
      .update(parsed.data)
      .eq("id", id)
      .select(CONTACT_SELECT)
      .maybeSingle();
    if (error) return dbErrorResponse(error, { uniqueViolation: "A contact with this email address already exists." });
    if (!data) return notFound();
    return Response.json({ contact: toContact(data as unknown as ContactRow) });
  });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/contacts/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    if (!isUuid(id)) return invalidId();

    const { data, error } = await getSupabase().from("contacts").delete().eq("id", id).select("id").maybeSingle();
    if (error) return dbErrorResponse(error);
    if (!data) return notFound();
    return Response.json({ id });
  });
}

function invalidId() {
  return errorResponse(400, "invalid_id", "The contact id in the URL must be a UUID.");
}

function notFound() {
  return errorResponse(404, "not_found", "Contact not found. It may have been deleted.");
}
