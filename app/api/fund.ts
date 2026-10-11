// Vercel Function for the game faucet (same logic as the dev server's, see server/faucet.ts).
import { fund } from "../server/faucet.js";

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "?";
  const [status, body] = await fund(new URL(request.url).searchParams.get("to"), ip);
  return Response.json(body, { status });
}
