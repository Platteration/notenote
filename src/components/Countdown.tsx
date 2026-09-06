"use client";

import { useEffect, useState } from "react";
import { formatCountdown } from "@/lib/window";

/** Live countdown to an absolute instant. Calls onZero once the target is reached. */
export function Countdown({ target, onZero }: { target: number; onZero?: () => void }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.ceil((target - Date.now()) / 1000)));

  useEffect(() => {
    const id = setInterval(() => {
      const next = Math.max(0, Math.ceil((target - Date.now()) / 1000));
      setRemaining(next);
      if (next === 0) {
        clearInterval(id);
        onZero?.();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [target, onZero]);

  return <span suppressHydrationWarning>{formatCountdown(remaining)}</span>;
}
