import { PROVIDER_META } from "@/lib/providers/meta";
import type { ProviderId } from "@/lib/providers/types";

/** Brand logo on a brand-coloured tile, so the source of a clip is recognisable at a glance. */
export function PlatformLogo({
  provider,
  size = 40,
  className,
  title,
}: {
  provider: ProviderId | string;
  size?: number;
  className?: string;
  title?: string;
}) {
  const meta = PROVIDER_META[provider as ProviderId];
  if (!meta) return null;
  return (
    <span
      className={`platform-logo${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size, background: meta.color, borderRadius: Math.round(size * 0.28) }}
      role="img"
      aria-label={title ?? meta.name}
      title={title ?? meta.name}
    >
      <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55} aria-hidden>
        <path d={meta.logoPath} fill={meta.logoColor} />
      </svg>
    </span>
  );
}
