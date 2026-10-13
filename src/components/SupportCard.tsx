"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { requestJson } from "@/lib/client-api";
import { BUY, formatPrice, isCheckoutUrl, OWNED, PAYMENT_PENDING, thanks } from "@/lib/site-config";
import { loadSiteConfig, useForgetParam, useSiteConfig } from "@/lib/site-config-client";

/** The one thing for sale, and what it grants. */
const PRODUCT = "supporter";
const ENTITLEMENT = "supporter";
/** After a payment: ask this many times, this far apart, for the webhook to have landed. */
const POLLS = 5;
const POLL_EVERY_MS = 3_750;

/**
 * "Support this app", in Settings: a one-time payment through Stripe's own Checkout page that
 * puts a supporter badge beside the account. Drawn only when the deployment's shop is on and
 * the product has a price. Buy only ever sends the browser to `https://checkout.stripe.com/`;
 * the badge appears when Stripe's signed webhook has said the payment went through, which
 * `/api/auth/me` then reports, never because the page came back from Checkout.
 */
export function SupportCard({ supporter }: { supporter: boolean }) {
  const router = useRouter();
  const site = useSiteConfig();
  const params = useSearchParams();
  // Back from Checkout: the word is read once, here, and the address put back below.
  const [purchase] = useState(() => params.get("purchase"));
  const [owned, setOwned] = useState(supporter);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err" | "wait"; text: string } | null>(() =>
    purchase === "success" ? { kind: "wait", text: "Confirming your payment with Stripe…" } : null,
  );
  const product = site?.products.find((p) => p.id === PRODUCT) ?? null;

  useForgetParam("purchase", purchase !== null);

  // Cancelled: nothing is said. Paid: ask until the webhook has recorded it, up to five times
  // over fifteen seconds.
  useEffect(() => {
    if (purchase !== "success") return;
    let live = true;
    void (async () => {
      for (let attempt = 0; attempt < POLLS && live; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, POLL_EVERY_MS));
        if (!live) return;
        try {
          const me = await requestJson<{ entitlements?: unknown }>("/api/auth/me");
          if (Array.isArray(me.entitlements) && me.entitlements.includes(ENTITLEMENT)) {
            setOwned(true);
            const listed = (await loadSiteConfig()).products.find((p) => p.id === PRODUCT);
            setMessage({ kind: "ok", text: thanks(listed?.name ?? "Support this app") });
            // The badge in the navigation is drawn by the server.
            router.refresh();
            return;
          }
        } catch {
          /* asked again on the next round */
        }
      }
      if (live) setMessage({ kind: "ok", text: PAYMENT_PENDING });
    })();
    return () => {
      live = false;
    };
  }, [purchase, router]);

  async function buy() {
    if (!product) return;
    setBusy(true);
    setMessage(null);
    try {
      const { url } = await requestJson<{ url?: unknown }>("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product: product.id }),
      });
      if (!isCheckoutUrl(url)) throw new Error("Checkout didn't start. Try again.");
      window.location.assign(url);
    } catch (err) {
      setMessage({ kind: "err", text: (err as Error).message });
      setBusy(false);
    }
  }

  if (!product) return null;
  return (
    <div className="card">
      <h2>{product.name}</h2>
      <p>{product.description}</p>
      <div className="cred-actions" style={{ marginTop: 14 }}>
        {owned ? (
          <span className="badge badge-live">{OWNED}</span>
        ) : (
          <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => void buy()}>
            {busy ? "Opening Checkout…" : product.price ? `${BUY} · ${formatPrice(product.price)}` : BUY}
          </button>
        )}
      </div>
      {owned && !message && <p className="hint" style={{ marginTop: 10 }}>Thank you for supporting The Daily Scroll.</p>}
      {message && <p className={message.kind === "err" ? "error" : message.kind === "ok" ? "success" : "hint"} role="status">{message.text}</p>}
      <p className="hint" style={{ marginTop: 10 }}>
        Paid on Stripe&apos;s own page; this site never sees your card. Stripe tells this server the payment went through, and it keeps
        what was bought and Stripe&apos;s customer id with your account.
      </p>
    </div>
  );
}
