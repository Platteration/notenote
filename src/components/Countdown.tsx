"use client";

import { useEffect, useRef, useState } from "react";
import { formatCountdown } from "@/lib/window";

/** Live countdown to an absolute instant. Calls onZero once the target is reached. */
export function Countdown({ target, onZero }: { target: number; onZero?: () => void }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.ceil((target - Date.now()) / 1000)));
  const callback = useRef(onZero);
  const fired = useRef<number | null>(null);
  useEffect(() => { callback.current = onZero; }, [onZero]);

  useEffect(() => {
    const tick = () => {
      const next = Math.max(0, Math.ceil((target - Date.now()) / 1000));
      setRemaining(next);
      if (next === 0 && fired.current !== target) {
        fired.current = target;
        callback.current?.();
      }
    };
    // Synchronize the external clock immediately when the target changes or the tab resumes.
    tick();
    const id = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [target]);

  return <span suppressHydrationWarning>{formatCountdown(remaining)}</span>;
}
