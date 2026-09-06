/**
 * Client-safe platform metadata: names, brand colours, logos and native deep links.
 * Nothing in here touches the network or Node APIs, so it can be imported by components.
 */
import {
  siBluesky,
  siFacebook,
  siInstagram,
  siPinterest,
  siReddit,
  siSnapchat,
  siThreads,
  siTiktok,
  siTwitch,
  siX,
  siYoutube,
} from "simple-icons";
import type { ProviderId } from "./types";

export interface ProviderMeta {
  name: string;
  /** Brand colour used behind the white logo. */
  color: string;
  /** Logo colour; most brands read best in white on their colour, a few need dark. */
  logoColor: string;
  /** SVG path in a 24x24 viewBox (Simple Icons, CC0). */
  logoPath: string;
}

export const PROVIDER_META: Record<ProviderId, ProviderMeta> = {
  tiktok: { name: "TikTok", color: "#010101", logoColor: "#ffffff", logoPath: siTiktok.path },
  instagram: { name: "Instagram", color: "#e1306c", logoColor: "#ffffff", logoPath: siInstagram.path },
  youtube: { name: "YouTube", color: "#ff0000", logoColor: "#ffffff", logoPath: siYoutube.path },
  twitter: { name: "X", color: "#000000", logoColor: "#ffffff", logoPath: siX.path },
  facebook: { name: "Facebook", color: "#0866ff", logoColor: "#ffffff", logoPath: siFacebook.path },
  threads: { name: "Threads", color: "#000000", logoColor: "#ffffff", logoPath: siThreads.path },
  reddit: { name: "Reddit", color: "#ff4500", logoColor: "#ffffff", logoPath: siReddit.path },
  pinterest: { name: "Pinterest", color: "#bd081c", logoColor: "#ffffff", logoPath: siPinterest.path },
  twitch: { name: "Twitch", color: "#9146ff", logoColor: "#ffffff", logoPath: siTwitch.path },
  snapchat: { name: "Snapchat", color: "#fffc00", logoColor: "#000000", logoPath: siSnapchat.path },
  bluesky: { name: "Bluesky", color: "#1185fe", logoColor: "#ffffff", logoPath: siBluesky.path },
};

export function providerName(id: string): string {
  return (PROVIDER_META as Record<string, ProviderMeta>)[id]?.name ?? id;
}

export type Platform = "ios" | "android" | "other";

export function detectPlatform(userAgent: string): Platform {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  return "other";
}

/**
 * Best-effort URL scheme that opens the item directly in the platform's installed app.
 * Returns null when the platform has no reliable scheme; its https permalink is then used,
 * which mobile OSes route to the app anyway through universal/app links.
 */
export function nativeUrl(
  item: { provider: ProviderId; externalId: string; permalink: string; creatorHandle: string },
  platform: Platform,
): string | null {
  const id = item.externalId;
  switch (item.provider) {
    case "youtube":
      return platform === "ios" ? `youtube://www.youtube.com/shorts/${id}` : `vnd.youtube://${id}`;
    case "twitter":
      return `twitter://status?id=${id}`;
    case "instagram":
      return `instagram://media?id=${id}`;
    case "tiktok":
      return `snssdk1233://aweme/detail/${id}`;
    case "pinterest":
      return `pinterest://pin/${id}`;
    case "reddit": {
      const path = safePath(item.permalink);
      return path ? `reddit://${path}` : null;
    }
    case "facebook":
      return `fb://video/${id}`;
    case "twitch":
      return `twitch://clip/${id}`;
    case "threads":
    case "snapchat":
    case "bluesky":
      return null;
    default:
      return null;
  }
}

function safePath(url: string): string | null {
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\//, "");
  } catch {
    return null;
  }
}
