// TODO: GET - list contacts (leads), with optional filtering by status (lead/prospect/customer).
// TODO: POST - validate the request body and create a new contact.

const notImplemented = () =>
  Response.json({ error: "Not implemented" }, { status: 501 });

export async function GET() {
  return notImplemented();
}

export async function POST() {
  return notImplemented();
}
