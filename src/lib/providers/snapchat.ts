/**
 * Snapchat — Spotlight.
 *
 * Snap's Login Kit only exposes identity (display name, Bitmoji); there is no third-party
 * API for Spotlight or Stories content. The platform is listed so the product is honest
 * about the gap, and the demo catalogue stands in for it.
 */
import type { SocialProvider } from "./types";

function unsupported(): never {
  throw new Error("Snapchat does not offer a content API; only demo mode is available.");
}

export const snapchat: SocialProvider = {
  id: "snapchat",
  name: "Snapchat",
  capability: "Spotlight has no third-party API; demo catalogue only.",
  color: "#fffc00",
  envVars: { clientId: "SNAPCHAT_CLIENT_ID", clientSecret: "SNAPCHAT_CLIENT_SECRET" },
  usesPkce: true,
  demoOnly: true,
  buildAuthorizeUrl: () => unsupported(),
  exchangeCode: async () => unsupported(),
  fetchItems: async () => [],
};
