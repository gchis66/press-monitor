/**
 * POST /api/preview
 *
 * Body: { url: string }
 *
 * Runs the full monitoring pipeline against one newsroom URL and returns the
 * email that would have been sent, plus the verification gates and the measured
 * cost evidence.
 *
 * Keys are server-side only. The browser never sees a Firecrawl or OpenRouter
 * credential.
 */

import { NextResponse } from "next/server";
import { previewLatestRelease, PipelineError } from "@/lib/pipeline";
import { checkRateLimit, clientIp } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  let body: { url?: unknown };
  try {
    body = (await req.json()) as { url?: unknown };
  } catch {
    return NextResponse.json(
      { error: "Malformed request body.", kind: "bad-request" },
      { status: 400 },
    );
  }

  const url = typeof body.url === "string" ? body.url : "";
  if (!url.trim()) {
    return NextResponse.json(
      { error: "Please enter a newsroom URL.", kind: "empty" },
      { status: 400 },
    );
  }

  const limit = checkRateLimit(clientIp(req));
  if (!limit.ok) {
    const mins = Math.ceil(limit.retryAfterSeconds / 60);
    return NextResponse.json(
      {
        error: `Demo rate limit reached. Try again in about ${mins} minute${mins === 1 ? "" : "s"}.`,
        kind: "rate-limited",
      },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  try {
    const result = await previewLatestRelease(url);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof PipelineError) {
      return NextResponse.json(
        { error: err.message, kind: err.kind },
        { status: err.status },
      );
    }
    console.error(`[api/preview] unexpected: ${String(err)}`);
    return NextResponse.json(
      { error: "Something went wrong. Please try again.", kind: "error" },
      { status: 500 },
    );
  }
}
