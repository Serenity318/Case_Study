// TODO: GET - fetch a single contact by id.
// TODO: PATCH - validate the request body and update a contact (e.g. details or status).
// TODO: DELETE - delete a contact by id.

const notImplemented = () =>
  Response.json({ error: "Not implemented" }, { status: 501 });

export async function GET() {
  return notImplemented();
}

export async function PATCH() {
  return notImplemented();
}

export async function DELETE() {
  return notImplemented();
}
