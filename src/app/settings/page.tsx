import { redirect } from "next/navigation";
import { AboutCard } from "@/components/AboutCard";
import { Nav } from "@/components/Nav";
import { SettingsForm } from "@/components/SettingsForm";
import { SupportCard } from "@/components/SupportCard";
import { hasPassword } from "@/lib/auth";
import { windowFor } from "@/lib/feed";
import { googleIdentityFor } from "@/lib/google-accounts";
import { isSupporter } from "@/lib/integrations";
import { currentUser, sessionCountFor } from "@/lib/session";
import { getSettings, MAX_FEED_SIZE, MIN_FEED_SIZE } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await currentUser();
  if (!user) redirect("/?next=/settings");
  const settings = getSettings(user.id);
  const win = windowFor(user.id);
  const google = googleIdentityFor(user.id);
  const supporter = isSupporter(user.id);
  return (
    <main className="shell">
      <Nav signedIn email={user.email} supporter={supporter} />
      <section className="hero hero-page">
        <h1>Settings</h1>
        <p>Signed in as {user.display_name}. Choose when your hour begins.</p>
      </section>
      <SettingsForm
        initial={settings}
        initialWindow={win}
        min={MIN_FEED_SIZE}
        max={MAX_FEED_SIZE}
        email={user.email}
        sessions={sessionCountFor(user.id)}
        google={{ linked: google !== null, email: google?.email ?? null }}
        hasPassword={hasPassword(user)}
        supporter={supporter}
      />
      <SupportCard supporter={supporter} />
      <AboutCard />
    </main>
  );
}
