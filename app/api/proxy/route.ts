import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }

  const res = await fetch(url, {
    headers: { Accept: "text/plain", "X-Return-Format": "markdown" },
  });
  const text = await res.text();

  return new NextResponse(text, {
    headers: {
      "Content-Type": "text/plain",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
    status: res.status,
  });
}
