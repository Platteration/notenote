import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AuthForm } from "@/components/AuthForm";
import { Nav } from "@/components/Nav";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await currentUser();
  if (user) redirect("/feed");
  return (
    <main className="shell">
      <Nav signedIn={false} />
      <section className="hero">
        <h1>
          One hour. <span>Every platform.</span> Then it&apos;s gone.
        </h1>
        <p>
          The Daily Scroll pulls short-form video from the TikTok, Instagram, YouTube and X accounts you connect,
          curates the best of it into a single feed, and opens that feed for exactly sixty minutes a day.
        </p>
        <p>Outside the hour there is nothing to scroll. That&apos;s the point.</p>
      </section>
      <Suspense>
        <AuthForm />
      </Suspense>
      <div className="grid-2" style={{ marginTop: 24 }}>
        <div className="card">
          <h2>Curated, not endless</h2>
          <p>Engagement is normalised per platform, creators are capped, cross-posts are merged, and anything you&apos;ve already seen never comes back.</p>
        </div>
        <div className="card">
          <h2>Your hour, your clock</h2>
          <p>Pick the time of day the scroll opens. It closes sixty minutes later, mid-swipe if it has to.</p>
        </div>
      </div>
      <p className="footer-note">
        Platform APIs only expose what they allow third parties to read. Add OAuth credentials to pull real content, or
        explore with the built-in demo catalogue.
      </p>
    </main>
  );
}
