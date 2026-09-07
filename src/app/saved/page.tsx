import { redirect } from "next/navigation";
import { Nav } from "@/components/Nav";
import { SavedShelf } from "@/components/SavedShelf";
import { listMuted, listSaved } from "@/lib/library";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function SavedPage() {
  const user = await currentUser();
  if (!user) redirect("/?next=/saved");
  return (
    <main className="shell">
      <Nav signedIn />
      <section className="hero" style={{ paddingTop: 16 }}>
        <h1 style={{ fontSize: 32 }}>Saved</h1>
        <p>Clips you kept. These stay here whether or not the scroll is open.</p>
      </section>
      <SavedShelf initial={listSaved(user.id)} initialMuted={listMuted(user.id)} />
    </main>
  );
}
