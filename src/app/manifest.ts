import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "The Daily Scroll",
    short_name: "Daily Scroll",
    description: "One curated hour of short-form video from your connected social accounts.",
    start_url: "/feed",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0b0b10",
    theme_color: "#0b0b10",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
