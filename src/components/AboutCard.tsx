import { APP_NAME, APP_VERSION, SOURCE_URL } from "@/lib/version";

/**
 * A server component: the version comes from package.json at build time, and nothing here
 * changes after the page is drawn.
 */
export function AboutCard() {
  return (
    <div className="card">
      <h2>About</h2>
      <p>
        <strong>{APP_NAME}</strong> {APP_VERSION}
      </p>
      <p style={{ marginTop: 6 }}>One curated hour of short-form video from the accounts you connect, once a day; then it&apos;s gone.</p>
      <p style={{ marginTop: 6 }}>
        <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
          MIT licence · source
        </a>
      </p>
      <p className="hint" style={{ marginTop: 10 }}>
        Your account, connections and watch history live on this server only, with platform tokens encrypted at rest; the
        server talks to the platforms you connected to build your hour, clips and thumbnails load from those platforms
        directly, and if you turn notifications on it sends your browser one push a day saying only that the hour is open —
        Export takes all of it as JSON and Delete removes it at once.
      </p>
    </div>
  );
}
