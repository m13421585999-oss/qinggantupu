export function GET() {
  return Response.json({
    ok: true,
    runtime: "vercel",
    storage: { configured: false },
  });
}
