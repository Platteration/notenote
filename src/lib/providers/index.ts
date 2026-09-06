import { bluesky } from "./bluesky";
import { facebook } from "./facebook";
import { instagram } from "./instagram";
import { pinterest } from "./pinterest";
import { reddit } from "./reddit";
import { snapchat } from "./snapchat";
import { threads } from "./threads";
import { tiktok } from "./tiktok";
import { twitch } from "./twitch";
import { twitter } from "./twitter";
import { youtube } from "./youtube";
import { PROVIDER_IDS, type ProviderCredentials, type ProviderId, type SocialProvider } from "./types";

export const PROVIDERS: Record<ProviderId, SocialProvider> = {
  tiktok,
  instagram,
  youtube,
  twitter,
  facebook,
  threads,
  reddit,
  pinterest,
  twitch,
  snapchat,
  bluesky,
};

/**
 * Platforms the operator allows in this deployment. `ENABLED_PROVIDERS` is a comma-separated
 * allow-list of provider ids; unset (or "all") enables every platform.
 */
export function enabledProviderIds(env: Record<string, string | undefined> = process.env): ProviderId[] {
  const raw = (env.ENABLED_PROVIDERS ?? "").trim();
  if (!raw || raw.toLowerCase() === "all") return [...PROVIDER_IDS];
  const wanted = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return PROVIDER_IDS.filter((id) => wanted.has(id));
}

export function enabledProviders(): SocialProvider[] {
  return enabledProviderIds().map((id) => PROVIDERS[id]);
}

/** Look up an *enabled* provider by id; disabled or unknown ids return null. */
export function getProvider(id: string): SocialProvider | null {
  const provider = (PROVIDERS as Record<string, SocialProvider>)[id] ?? null;
  if (!provider) return null;
  return enabledProviderIds().includes(provider.id) ? provider : null;
}

export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/** Real OAuth credentials for a provider, or null when the app should run it in demo mode. */
export function credentialsFor(provider: SocialProvider): ProviderCredentials | null {
  if (provider.demoOnly || provider.credentialConnect) return null;
  const clientId = process.env[provider.envVars.clientId];
  const clientSecret = process.env[provider.envVars.clientSecret];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: `${appBaseUrl()}/api/connect/${provider.id}/callback` };
}

/** Whether a live (non-demo) connection is possible for this provider in this deployment. */
export function liveAvailable(provider: SocialProvider): boolean {
  if (provider.demoOnly) return false;
  if (provider.credentialConnect) return true;
  return credentialsFor(provider) !== null;
}
