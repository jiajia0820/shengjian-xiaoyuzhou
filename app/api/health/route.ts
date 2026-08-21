export async function GET() {
  return Response.json({ ok: true }, {
    headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}
