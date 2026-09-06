import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ConnectionsPanel } from "@/components/ConnectionsPanel";
import { Nav } from "@/components/Nav";
import { listConnections } from "@/lib/connections";
import { windowFor } from "@/lib/feed";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ConnectPage() {
  const user = await currentUser();
  if (!user) redirect("/?next=/connect");
  const connections = listConnections(user.id);
  const win = windowFor(user.id);
  return (
    <main className="shell">
      <Nav signedIn />
      <section className="hero" style={{ paddingTop: 16 }}>
        <h1 style={{ fontSize: 32 }}>Connections</h1>
        <p>Everything you connect feeds one curated hour. Disconnect any time.</p>
      </section>
      <Suspense>
        <ConnectionsPanel initial={connections} window={win} />
      </Suspense>
    </main>
  );
}
