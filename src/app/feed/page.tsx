import { redirect } from "next/navigation";
import { Nav } from "@/components/Nav";
import { ScrollView } from "@/components/ScrollView";
import { LockedView } from "@/components/LockedView";
import { getFeed } from "@/lib/feed";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function FeedPage() {
  const user = await currentUser();
  if (!user) redirect("/?next=/feed");
  const feed = await getFeed(user.id);

  if (feed.status === "locked") {
    return (
      <main className="shell">
        <Nav signedIn />
        <LockedView initial={feed} />
      </main>
    );
  }
  return <ScrollView initial={feed} />;
}
