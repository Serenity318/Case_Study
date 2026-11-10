// TODO: POST - accept a tax question, embed it, retrieve the top-k matching chunks from
// pgvector, apply the hallucination guard (reply "not found in documents" if no chunk
// scores above the threshold), otherwise prompt Gemini with the retrieved chunks and
// return the answer with citations (document name and page).

export async function POST() {
  return Response.json({ error: "Not implemented" }, { status: 501 });
}
