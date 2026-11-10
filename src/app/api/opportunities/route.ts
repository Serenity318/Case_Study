// TODO: GET - list opportunities (for the Kanban board), with optional filtering by stage or contact.
// TODO: POST - validate the request body and create a new opportunity linked to a contact.

const notImplemented = () =>
  Response.json({ error: "Not implemented" }, { status: 501 });

export async function GET() {
  return notImplemented();
}

export async function POST() {
  return notImplemented();
}
