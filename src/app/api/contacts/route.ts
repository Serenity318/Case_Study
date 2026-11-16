import { CONTACT_STATUSES, isContactStatus } from "@/lib/crm";
import { CONTACT_SELECT, ilikeContains, parseContactInput, toContact, type ContactRow } from "@/lib/crm-server";
import { dbErrorResponse, errorResponse, handle, readJsonObject } from "@/lib/http";
import { getSupabase } from "@/lib/supabase";

/**
 * GET  /api/contacts?status=lead&q=maju   -> { contacts: Contact[] }  newest first, max 500
 *        status: lead | prospect | customer (optional)
 *        q: case-insensitive match on name, email or company (optional, max 100 chars)
 * POST /api/contacts  { name, email?, phone?, company?, status? }  -> 201 { contact }
 */

const LIST_LIMIT = 500;
const MAX_QUERY_CHARS = 100;

export async function GET(request: Request) {
  return handle(async () => {
    const params = new URL(request.url).searchParams;
    const status = params.get("status") || null;
    const q = params.get("q")?.trim() ?? "";

    if (status !== null && !isContactStatus(status)) {
      return errorResponse(400, "invalid_status", `"status" must be one of: ${CONTACT_STATUSES.join(", ")}.`);
    }
    if (q.length > MAX_QUERY_CHARS) {
      return errorResponse(400, "invalid_query", `"q" must be at most ${MAX_QUERY_CHARS} characters.`);
    }

    let query = getSupabase()
      .from("contacts")
      .select(CONTACT_SELECT)
      .order("created_at", { ascending: false })
      .limit(LIST_LIMIT);
    if (status) query = query.eq("status", status);
    if (q) {
      const v = ilikeContains(q);
      query = query.or(`name.ilike.${v},email.ilike.${v},company.ilike.${v}`);
    }

    const { data, error } = await query;
    if (error) return dbErrorResponse(error);
    return Response.json({ contacts: (data as unknown as ContactRow[]).map(toContact) });
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;

    const parsed = parseContactInput(body, "create");
    if (!parsed.ok) return errorResponse(400, "invalid_input", parsed.message);

    const { data, error } = await getSupabase().from("contacts").insert(parsed.data).select(CONTACT_SELECT).single();
    if (error) return dbErrorResponse(error, { uniqueViolation: "A contact with this email address already exists." });
    return Response.json({ contact: toContact(data as unknown as ContactRow) }, { status: 201 });
  });
}
