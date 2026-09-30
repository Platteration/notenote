import { redirect } from "next/navigation";
import { Nav } from "@/components/Nav";
import { SavedShelf } from "@/components/SavedShelf";
import { listCollections } from "@/lib/archive";
import { listMuted, listSaved } from "@/lib/library";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function SavedPage() {
  const user = await currentUser();
  if (!user) redirect("/?next=/saved");
  return (
    <main className="shell">
      <Nav signedIn email={user.email} />
      <section className="hero hero-page">
        <h1>The Archive</h1>
        <p>Everything you kept, with your notes and collections. It stays here whether or not the scroll is open.</p>
      </section>
      <SavedShelf initial={listSaved(user.id)} initialMuted={listMuted(user.id)} initialCollections={listCollections(user.id)} />
    </main>
  );
}
