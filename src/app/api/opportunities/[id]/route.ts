// TODO: GET - fetch a single opportunity by id.
// TODO: PATCH - validate the request body and update an opportunity (e.g. move it to another stage).
// TODO: DELETE - delete an opportunity by id.

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
