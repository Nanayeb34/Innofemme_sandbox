import { kitSource } from "@/server/starter";

/** GET /docs/starter/{file}: one starter kit, as a file to save. Open to everyone: there is nothing secret in them. */
export async function GET(_req: Request, ctx: RouteContext<"/docs/starter/[file]">) {
  const { file } = await ctx.params;
  const source = kitSource(file);
  if (source === undefined) return new Response("No such starter kit", { status: 404 });
  return new Response(source, { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${file}"` } });
}
