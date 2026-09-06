const LETTERS: Record<string, string> = { tiktok: "Tt", instagram: "Ig", youtube: "Yt", twitter: "X" };

export function ProviderMark({ provider, color, size = 40 }: { provider: string; color: string; size?: number }) {
  return (
    <span
      className="provider-dot"
      style={{ background: color, width: size, height: size, fontSize: size * 0.38 }}
      aria-hidden
    >
      {LETTERS[provider] ?? provider.slice(0, 2)}
    </span>
  );
}
