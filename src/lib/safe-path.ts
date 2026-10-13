/**
 * Where the app is willing to send a browser after a sign-in.
 *
 * `?next=` used to be accepted whenever it started with a slash, and that is not the same
 * question as "is this a path on this site". `//evil.example` is protocol-relative, and
 * `/\evil.example` is normalised by the URL parser into the same thing, because a backslash
 * counts as a solidus for special schemes. Either one resolves to a foreign origin, the router
 * falls back to a full document navigation, and a link to the genuine sign-in page lands the
 * visitor on someone else's site the moment they have typed their password.
 *
 * So the test is the real one: resolve it against this origin and insist the origin survived.
 * The parsed path is what gets returned, so the value used is the value that was checked —
 * characters the parser strips (tab, newline) cannot reappear afterwards.
 *
 * That returned path is read a second time, by the router, as an address relative to the page,
 * so it must not start with two slashes either. Dot segments get there without starting with
 * them: `/.//evil.example`, `/x/..//evil.example` and `/%2e//evil.example` all keep this origin
 * when resolved, to the path `//evil.example`, which `router.push` then took for another host
 * (a sign-up from `/?next=/.//evil.example/` landed on `http://evil.example/`). `returnPath` in
 * `src/lib/integrations/google.ts` refuses the same thing for the Google flow.
 */
export function safeNextPath(value: string | null | undefined, fallback: string): string {
  if (!value || !value.startsWith("/")) return fallback;
  // Cheap and first: nothing legitimate here begins with two slashes or a slash-backslash.
  if (/^\/[/\\]/.test(value)) return fallback;
  const origin = "https://daily-scroll.invalid";
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return fallback;
  }
  if (url.origin !== origin || url.pathname.startsWith("//")) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}
