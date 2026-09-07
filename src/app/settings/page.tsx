import { redirect } from "next/navigation";
import { Nav } from "@/components/Nav";
import { SettingsForm } from "@/components/SettingsForm";
import { windowFor } from "@/lib/feed";
import { currentUser, sessionCountFor } from "@/lib/session";
import { getSettings, MAX_FEED_SIZE, MIN_FEED_SIZE } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await currentUser();
  if (!user) redirect("/?next=/settings");
  const settings = getSettings(user.id);
  const win = windowFor(user.id);
  return (
    <main className="shell">
      <Nav signedIn />
      <section className="hero" style={{ paddingTop: 16 }}>
        <h1 style={{ fontSize: 32 }}>Settings</h1>
        <p>Signed in as {user.display_name}. Choose when your hour begins.</p>
      </section>
      <SettingsForm initial={settings} initialWindow={win} min={MIN_FEED_SIZE} max={MAX_FEED_SIZE} email={user.email} sessions={sessionCountFor(user.id)} />
    </main>
  );
}
