"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const LINKS = [
  { href: "/feed", label: "Scroll" },
  { href: "/saved", label: "Saved" },
  { href: "/connect", label: "Connections" },
  { href: "/settings", label: "Settings" },
];

/**
 * `email` is shown, not just the display name, because which account you are in is the one
 * thing a sign-in CSRF would change without you noticing.
 */
export function Nav({ signedIn, email }: { signedIn: boolean; email?: string }) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  }

  return (
    <nav className="nav">
      <Link href={signedIn ? "/feed" : "/"} className="brand">
        <span className="brand-mark" aria-hidden />
        The Daily Scroll
      </Link>
      {signedIn && (
        <div className="nav-links">
          {email && (
            <span className="nav-account" title={`Signed in as ${email}`}>
              {email}
            </span>
          )}
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} aria-current={pathname === l.href ? "page" : undefined}>
              {l.label}
            </Link>
          ))}
          <button type="button" onClick={logout}>
            Sign out
          </button>
        </div>
      )}
    </nav>
  );
}
