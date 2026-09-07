"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const LINKS = [
  { href: "/feed", label: "Scroll" },
  { href: "/saved", label: "Saved" },
  { href: "/connect", label: "Connections" },
  { href: "/settings", label: "Settings" },
];

export function Nav({ signedIn }: { signedIn: boolean }) {
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
