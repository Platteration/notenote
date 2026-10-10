/** Keep media silent when its slide or the page is no longer visible. */
export function bindScrollPlayback(
  video: Pick<HTMLVideoElement, "play" | "pause" | "muted">,
  page: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">,
  active: boolean,
  soundOn: boolean,
): () => void {
  const sync = () => {
    video.muted = !soundOn;
    if (active && !page.hidden) void video.play().catch(() => {});
    else video.pause();
  };
  page.addEventListener("visibilitychange", sync);
  sync();
  return () => {
    page.removeEventListener("visibilitychange", sync);
    video.pause();
  };
}

/** One observer tracks clips and the completion screen within the scrolling viewport. */
export function observeScrollPosition(root: HTMLElement, onPosition: (index: number) => void): () => void {
  const observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.6)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    const index = Number((visible.target as HTMLElement).dataset.index);
    if (Number.isInteger(index) && index >= 0) onPosition(index);
  }, { root, threshold: [0.6] });
  root.querySelectorAll<HTMLElement>("[data-index]").forEach((slide) => observer.observe(slide));
  return () => observer.disconnect();
}
