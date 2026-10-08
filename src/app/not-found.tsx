import Link from "next/link";
import { Nav } from "@/components/Nav";
import { currentUser } from "@/lib/session";

/**
 * The page for an address the app does not have, in the app's own look.
 *
 * The framework's default not-found page styles itself with an inline `<style>` element, which
 * the content security policy refuses (`style-src 'self'`), so it drew unstyled and reported a
 * violation on every mistyped address. This one uses the stylesheet every page loads, and its
 * links work before (or without) any script.
 */
export default async function NotFound() {
  const user = await currentUser();
  return (
    <main className="shell">
      <Nav signedIn={Boolean(user)} email={user?.email} />
      <section className="hero hero-page">
        <h1>That page isn&apos;t here</h1>
        <p>The address may be mistyped, or the page may have moved.</p>
      </section>
      <p>
        <Link className="btn btn-primary" href={user ? "/feed" : "/"}>
          {user ? "Back to the scroll" : "Open The Daily Scroll"}
        </Link>
      </p>
    </main>
  );
}
