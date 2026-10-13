import { NextResponse } from "next/server";

/**
 * A 302 to an address on this site or Google's, never stored, with the cookies given. A sign-in
 * redirect carries a one-time cookie, so it must not be cached by anything on the way.
 */
export function redirectTo(location: string, cookies: string[]): NextResponse {
  const res = new NextResponse(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
  for (const cookie of cookies) res.headers.append("Set-Cookie", cookie);
  return res;
}
