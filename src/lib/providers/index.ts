import { instagram } from "./instagram";
import { tiktok } from "./tiktok";
import { twitter } from "./twitter";
import { youtube } from "./youtube";
import type { ProviderCredentials, ProviderId, SocialProvider } from "./types";

export const PROVIDERS: Record<ProviderId, SocialProvider> = { tiktok, instagram, youtube, twitter };

export function getProvider(id: string): SocialProvider | null {
  return (PROVIDERS as Record<string, SocialProvider>)[id] ?? null;
}

export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/** Real OAuth credentials for a provider, or null when the app should run it in demo mode. */
export function credentialsFor(provider: SocialProvider): ProviderCredentials | null {
  const clientId = process.env[provider.envVars.clientId];
  const clientSecret = process.env[provider.envVars.clientSecret];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: `${appBaseUrl()}/api/connect/${provider.id}/callback` };
}

export function isDemoMode(provider: SocialProvider): boolean {
  return credentialsFor(provider) === null;
}
