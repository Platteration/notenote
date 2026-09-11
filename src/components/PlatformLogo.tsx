import { providerMeta } from "@/lib/providers/meta";
import type { ProviderId } from "@/lib/providers/types";

/**
 * Brand logo on a brand-coloured tile, so the source of a clip is recognisable at a glance.
 * Colours are passed as custom properties rather than concrete styles, so a theme can
 * restyle the mark entirely — the wireframe theme draws it as an outline instead of a fill.
 */
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
  const meta = providerMeta(provider);
  if (!meta) return null;
  return (
    <span
      className={`platform-logo${className ? ` ${className}` : ""}`}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.28),
        ["--brand" as string]: meta.color,
        ["--brand-wire" as string]: meta.wireColor,
        ["--logo-ink" as string]: meta.logoColor,
      }}
      role="img"
      aria-label={title ?? meta.name}
      title={title ?? meta.name}
    >
      <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55} aria-hidden>
        <path d={meta.logoPath} />
      </svg>
    </span>
  );
}
