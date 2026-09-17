"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { requestJson } from "@/lib/client-api";

const LINKS = [
  { href: "/feed", label: "Scroll" },
  { href: "/saved", label: "Saved" },
  { href: "/connect", label: "Connections" },
  { href: "/settings", label: "Settings" },
];

export function Nav({ signedIn }: { signedIn: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    setError(null);
    try {
    await requestJson("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
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
          <button type="button" onClick={logout} disabled={busy}>
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </nav>
  );
}
