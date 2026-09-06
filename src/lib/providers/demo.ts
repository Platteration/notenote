/**
 * Demo catalogue. When a platform has no OAuth credentials configured we still want the
 * product to be fully explorable, so each provider can serve a deterministic set of
 * plausible items. Posters are generated SVG data URIs so nothing is fetched externally.
 */
import { seededRandom } from "../curation";
import type { MediaItem, ProviderId } from "./types";

const CREATORS: Record<ProviderId, Array<{ name: string; handle: string }>> = {
  tiktok: [
    { name: "Mara Lin", handle: "maracooks" },
    { name: "Devon Okafor", handle: "devon.builds" },
    { name: "Sasha Petrov", handle: "sasha.moves" },
    { name: "Kit Alvarez", handle: "kitplants" },
    { name: "Noor Haddad", handle: "noorexplains" },
    { name: "Theo Brandt", handle: "theo.woodwork" },
  ],
  instagram: [
    { name: "Ivy Nakamura", handle: "ivy.frames" },
    { name: "Ravi Menon", handle: "ravi.runs" },
    { name: "Léa Dubois", handle: "lea.bakes" },
    { name: "Jonah Reyes", handle: "jonahclimbs" },
    { name: "Amara Osei", handle: "amara.knits" },
  ],
  youtube: [
    { name: "Two Minute Physics", handle: "TwoMinutePhysics" },
    { name: "Studio Bench", handle: "StudioBench" },
    { name: "Ada Loops", handle: "AdaLoops" },
    { name: "Trail Notes", handle: "TrailNotes" },
    { name: "Pocket Chef", handle: "PocketChef" },
  ],
  twitter: [
    { name: "Priya Sethi", handle: "priyasethi" },
    { name: "Marcus Hale", handle: "marcushale" },
    { name: "Bea Costa", handle: "beacosta" },
    { name: "Owen Park", handle: "owenpark" },
  ],
  facebook: [
    { name: "Harbor Kitchen", handle: "harborkitchen" },
    { name: "Nia Wallace", handle: "nia.wallace" },
    { name: "Peak District Trails", handle: "peaktrails" },
    { name: "Sam Ortega", handle: "samortega" },
  ],
  threads: [
    { name: "Juno Park", handle: "junopark" },
    { name: "Elliot Marsh", handle: "elliotmarsh" },
    { name: "Wren Adeyemi", handle: "wren.adeyemi" },
    { name: "Tomas Lindqvist", handle: "tomaslq" },
  ],
  reddit: [
    { name: "r/oddlysatisfying", handle: "quietloops" },
    { name: "r/woodworking", handle: "benchdog" },
    { name: "r/aww", handle: "smallmammalfan" },
    { name: "r/BeAmazed", handle: "everydayphysics" },
    { name: "r/cooking", handle: "panfriedjoy" },
  ],
  pinterest: [
    { name: "Fern & Fold", handle: "fernandfold" },
    { name: "Matteo Ricci", handle: "matteo.ricci" },
    { name: "Studio Ochre", handle: "studioochre" },
    { name: "Hazel Byrne", handle: "hazelbyrne" },
  ],
  twitch: [
    { name: "pixelpanic", handle: "pixelpanic" },
    { name: "LunaSpeedruns", handle: "lunaspeedruns" },
    { name: "chef_kv", handle: "chef_kv" },
    { name: "Orbital_Ollie", handle: "orbital_ollie" },
  ],
  snapchat: [
    { name: "Dani Flores", handle: "daniflores" },
    { name: "Kai Morrison", handle: "kaimorrison" },
    { name: "Zara Quinn", handle: "zaraquinn" },
    { name: "Milo Tan", handle: "milotan" },
  ],
  bluesky: [
    { name: "Rosa Lindgren", handle: "rosa.bsky.social" },
    { name: "Field Notes", handle: "fieldnotes.bsky.social" },
    { name: "Idris Bello", handle: "idris.bsky.social" },
    { name: "Clay & Kiln", handle: "clayandkiln.bsky.social" },
  ],
};

const TOPICS = [
  "the 20-second knife trick every home cook should know",
  "why bridges hum in the wind",
  "one-pan weeknight dinner, start to finish",
  "the fastest way to fold a fitted sheet",
  "POV: your plant finally blooms after two years",
  "three chords, one song, no excuses",
  "how a mechanical keyboard switch actually works",
  "a tiny apartment that fits a workshop",
  "the trail at golden hour, unedited",
  "first attempt at hand-pulled noodles",
  "the sound a 3D printer makes when it's happy",
  "a sourdough crumb shot that deserves applause",
  "the physics of a perfect skipping stone",
  "restoring a 1970s desk lamp in a minute",
  "what happens when you drop a magnet through copper",
  "morning stretch you can do at your desk",
  "sketching a face in under a minute",
  "the quietest street in the city at 6am",
  "ten seconds of a cat discovering snow",
  "a bench made from a single board",
  "solving a 3x3 cube blindfolded, real time",
  "the frosting swirl that took a hundred tries",
  "espresso extraction, slowed way down",
  "one trick for cleaner code reviews",
  "harvesting honey without gloves (don't)",
  "the exact moment the dough springs",
  "how to read a subway map like a local",
  "bike lane time-lapse through the rain",
  "the best 40 seconds of the marathon",
  "a lamp that turns on when you whistle",
];

const PALETTES = [
  ["#ff5e7e", "#7a1fff"],
  ["#00d4ff", "#0a3d91"],
  ["#ffb347", "#ff2d55"],
  ["#00e5a0", "#005f73"],
  ["#c084fc", "#1e1b4b"],
  ["#f97316", "#7c2d12"],
  ["#22d3ee", "#164e63"],
  ["#facc15", "#78350f"],
];

function poster(seedNum: number, provider: ProviderId, title: string): string {
  const [a, b] = PALETTES[seedNum % PALETTES.length];
  const angle = (seedNum * 37) % 360;
  const words = title.split(" ").slice(0, 4).join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="960" viewBox="0 0 540 960">
<defs><linearGradient id="g" gradientTransform="rotate(${angle})"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
<rect width="540" height="960" fill="url(#g)"/>
<circle cx="${(seedNum * 97) % 540}" cy="${(seedNum * 53) % 960}" r="${120 + (seedNum % 5) * 40}" fill="rgba(255,255,255,0.12)"/>
<circle cx="${(seedNum * 31) % 540}" cy="${(seedNum * 71) % 960}" r="${60 + (seedNum % 7) * 30}" fill="rgba(0,0,0,0.15)"/>
<text x="270" y="120" text-anchor="middle" font-family="system-ui, sans-serif" font-size="26" font-weight="700" fill="rgba(255,255,255,0.9)">${escapeXml(words)}</text>
<text x="270" y="156" text-anchor="middle" font-family="system-ui, sans-serif" font-size="20" fill="rgba(255,255,255,0.7)">${provider} · demo</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

function permalinkFor(provider: ProviderId, handle: string, id: string): string {
  switch (provider) {
    case "tiktok":
      return `https://www.tiktok.com/@${handle}/video/${id}`;
    case "instagram":
      return `https://www.instagram.com/reel/${id}/`;
    case "youtube":
      return `https://www.youtube.com/shorts/${id}`;
    case "twitter":
      return `https://x.com/${handle}/status/${id}`;
    case "facebook":
      return `https://www.facebook.com/reel/${id}`;
    case "threads":
      return `https://www.threads.net/@${handle}/post/${id}`;
    case "reddit":
      return `https://www.reddit.com/r/${handle}/comments/${id}/`;
    case "pinterest":
      return `https://www.pinterest.com/pin/${id}/`;
    case "twitch":
      return `https://clips.twitch.tv/${id}`;
    case "snapchat":
      return `https://www.snapchat.com/spotlight/${id}`;
    case "bluesky":
      return `https://bsky.app/profile/${handle}/post/${id}`;
  }
}

/**
 * Generate a deterministic set of demo items for a provider. The seed includes the user
 * id and the current UTC date so each day brings "new" content, mimicking a live feed.
 */
export function demoItems(provider: ProviderId, userId: string, now: number, count = 24): MediaItem[] {
  const dateKey = new Date(now).toISOString().slice(0, 10);
  const rand = seededRandom(`${provider}:${userId}:${dateKey}`);
  const creators = CREATORS[provider];
  const items: MediaItem[] = [];
  for (let i = 0; i < count; i++) {
    const creator = creators[Math.floor(rand() * creators.length)];
    const topic = TOPICS[Math.floor(rand() * TOPICS.length)];
    const seedNum = Math.floor(rand() * 1_000_000);
    const externalId = `${dateKey.replace(/-/g, "")}${String(seedNum).padStart(6, "0")}`;
    const ageHours = rand() * 24 * 6; // within the last six days
    const isLong = rand() < 0.12; // a few long-form items that curation must drop
    const duration = isLong ? 240 + Math.floor(rand() * 600) : 8 + Math.floor(rand() * 70);
    const views = Math.floor(Math.pow(10, 2.5 + rand() * 4));
    items.push({
      key: `${provider}:${externalId}`,
      provider,
      externalId,
      title: topic.charAt(0).toUpperCase() + topic.slice(1),
      creator: creator.name,
      creatorHandle: creator.handle,
      permalink: permalinkFor(provider, creator.handle, externalId),
      thumbnailUrl: poster(seedNum, provider, topic),
      videoUrl: null,
      durationSeconds: duration,
      publishedAt: now - ageHours * 3_600_000,
      metrics: {
        views,
        likes: Math.floor(views * (0.02 + rand() * 0.08)),
        comments: Math.floor(views * (0.001 + rand() * 0.004)),
        shares: Math.floor(views * rand() * 0.01),
      },
    });
  }
  return items;
}
