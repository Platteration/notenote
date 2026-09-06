/**
 * Bluesky — AT Protocol.
 * Docs: https://docs.bsky.app/docs/api/app-bsky-feed-get-timeline
 *       https://docs.bsky.app/docs/advanced-guides/api-directory
 *
 * Connects with an app password (Settings → Privacy and security → App passwords), so it
 * works live without registering a developer application. Reads the home timeline and
 * keeps posts with a native video embed. Videos on Bluesky are capped at three minutes;
 * the API doesn't report duration, so the curation treats them as short-form.
 */
import { getJson } from "./http";
import type { MediaItem, OAuthTokens, SocialProvider } from "./types";

const DEFAULT_SERVICE = "https://bsky.social";
const ACCESS_TTL_MS = 90 * 60 * 1000; // access JWTs live ~2h; refresh a little early

interface Session {
  accessJwt: string;
  refreshJwt: string;
  handle: string;
  did: string;
  error?: string;
  message?: string;
}
interface VideoView {
  $type: string;
  cid?: string;
  playlist?: string;
  thumbnail?: string;
  alt?: string;
}
interface Post {
  uri: string;
  cid: string;
  author: { did: string; handle: string; displayName?: string };
  record?: { text?: string; createdAt?: string };
  embed?: (VideoView & { media?: VideoView }) | null;
  likeCount?: number;
  replyCount?: number;
  repostCount?: number;
}
interface Timeline {
  feed?: Array<{ post: Post; reason?: { $type: string } }>;
}

function unsupported(): never {
  throw new Error("Bluesky connects with an app password, not OAuth.");
}

/** The service host is kept in the connection's scope column as "service=<url>". */
export function serviceFromScope(scope: string | null): string {
  const m = /service=(\S+)/.exec(scope ?? "");
  return m ? m[1] : DEFAULT_SERVICE;
}

function normaliseService(input: string | undefined): string {
  const raw = (input ?? "").trim();
  if (!raw) return DEFAULT_SERVICE;
  const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  if (url.protocol !== "https:") throw new Error("Service host must use https");
  return url.origin;
}

function rkeyOf(uri: string): string {
  return uri.split("/").pop() ?? uri;
}

export const bluesky: SocialProvider = {
  id: "bluesky",
  name: "Bluesky",
  capability: "Video posts from your home timeline (AT Protocol, via an app password).",
  color: "#1185fe",
  envVars: { clientId: "BLUESKY_UNUSED", clientSecret: "BLUESKY_UNUSED" },
  usesPkce: false,
  credentialConnect: {
    help: "Create an app password in the Bluesky app under Settings → Privacy and security → App passwords. Your main password is never needed.",
    fields: [
      { name: "identifier", label: "Handle", type: "text", placeholder: "you.bsky.social", required: true },
      { name: "password", label: "App password", type: "password", placeholder: "xxxx-xxxx-xxxx-xxxx", required: true },
      { name: "service", label: "Service host", type: "url", placeholder: DEFAULT_SERVICE, help: "Leave blank unless you self-host your PDS." },
    ],
    async authenticate(input) {
      const service = normaliseService(input.service);
      const identifier = (input.identifier ?? "").trim().replace(/^@/, "");
      const password = input.password ?? "";
      if (!identifier || !password) throw new Error("Handle and app password are required");
      const session = await getJson<Session>("bluesky", `${service}/xrpc/com.atproto.server.createSession`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      });
      if (session.error) throw new Error(`Bluesky: ${session.message ?? session.error}`);
      return {
        accessToken: session.accessJwt,
        refreshToken: session.refreshJwt,
        expiresAt: Date.now() + ACCESS_TTL_MS,
        scope: `service=${service}`,
        providerUserId: session.did,
        displayName: `@${session.handle}`,
      };
    },
  },
  buildAuthorizeUrl: () => unsupported(),
  exchangeCode: async () => unsupported(),

  async refresh(_creds, refreshToken, scope?: string | null): Promise<OAuthTokens | null> {
    const service = serviceFromScope(scope ?? null);
    const session = await getJson<Session>("bluesky", `${service}/xrpc/com.atproto.server.refreshSession`, {
      method: "POST",
      headers: { Authorization: `Bearer ${refreshToken}` },
    });
    if (session.error || !session.accessJwt) return null;
    return {
      accessToken: session.accessJwt,
      refreshToken: session.refreshJwt,
      expiresAt: Date.now() + ACCESS_TTL_MS,
      scope: `service=${service}`,
      providerUserId: session.did,
      displayName: `@${session.handle}`,
    };
  },

  async fetchItems(accessToken, _providerUserId, scope?: string | null): Promise<MediaItem[]> {
    const service = serviceFromScope(scope ?? null);
    const tl = await getJson<Timeline>("bluesky", `${service}/xrpc/app.bsky.feed.getTimeline?limit=100`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const out: MediaItem[] = [];
    for (const entry of tl.feed ?? []) {
      const p = entry.post;
      const embed = p.embed;
      if (!embed) continue;
      const video: VideoView | undefined =
        embed.$type === "app.bsky.embed.video#view"
          ? embed
          : embed.$type === "app.bsky.embed.recordWithMedia#view" && embed.media?.$type === "app.bsky.embed.video#view"
            ? embed.media
            : undefined;
      if (!video) continue;
      const rkey = rkeyOf(p.uri);
      out.push({
        key: `bluesky:${rkey}`,
        provider: "bluesky",
        externalId: rkey,
        title: (p.record?.text ?? "").split("\n")[0] || video.alt || "Video post",
        creator: p.author.displayName || `@${p.author.handle}`,
        creatorHandle: p.author.handle,
        permalink: `https://bsky.app/profile/${p.author.handle}/post/${rkey}`,
        thumbnailUrl: video.thumbnail ?? null,
        videoUrl: null, // playlist is HLS; the permalink hands off to the app/web player
        durationSeconds: null,
        publishedAt: p.record?.createdAt ? Date.parse(p.record.createdAt) : 0,
        metrics: { likes: p.likeCount, comments: p.replyCount, shares: p.repostCount },
      });
    }
    return out;
  },
};
