export function GET() {
  return Response.json({ items: [] });
}

export function POST() {
  return Response.json(
    {
      error: {
        code: "ONLINE_STORAGE_NOT_CONFIGURED",
        message: "当前线上版本未迁移本地作品库，请在本地编辑器中保存作品。",
      },
    },
    { status: 503 },
  );
}
