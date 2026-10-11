import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { bindScrollPlayback, observeScrollPosition } from "@/lib/scroll-playback";

afterEach(() => vi.unstubAllGlobals());

class Visibility extends EventTarget {
  hidden = false;
  show(visible: boolean) {
    this.hidden = !visible;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

describe("scroll playback lifecycle", () => {
  function media() { return { muted: false, play: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }; }

  it("pauses on tab hide, resumes only the active clip, and detaches on cleanup", () => {
    const page = new Visibility();
    const video = media();
    const dispose = bindScrollPlayback(video, page, true, false);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.muted).toBe(true);
    page.show(false);
    expect(video.pause).toHaveBeenCalledTimes(1);
    page.show(true);
    expect(video.play).toHaveBeenCalledTimes(2);
    dispose();
    expect(video.pause).toHaveBeenCalledTimes(2);
    page.show(true);
    expect(video.play).toHaveBeenCalledTimes(2);
  });

  it("never starts a hidden or inactive clip, including on return to the page", () => {
    const page = new Visibility();
    page.hidden = true;
    const video = media();
    const dispose = bindScrollPlayback(video, page, true, true);
    expect(video.play).not.toHaveBeenCalled();
    expect(video.muted).toBe(false);
    dispose();
    const stop = bindScrollPlayback(video, page, false, true);
    page.show(true);
    expect(video.play).not.toHaveBeenCalled();
    stop();
  });

  it("handles browsers refusing autoplay without an unhandled rejection", async () => {
    const video = media();
    video.play.mockRejectedValue(new Error("NotAllowedError"));
    const dispose = bindScrollPlayback(video, new Visibility(), true, false);
    await Promise.resolve();
    expect(video.play).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("keeps an explicitly paused clip paused across visibility changes and reactivation", () => {
    const page = new Visibility();
    const video = media();
    const dispose = bindScrollPlayback(video, page, true, true, true);
    page.show(false);
    page.show(true);
    expect(video.play).not.toHaveBeenCalled();
    dispose();
    const stop = bindScrollPlayback(video, page, true, true, true);
    expect(video.play).not.toHaveBeenCalled();
    stop();
    const resume = bindScrollPlayback(video, page, true, true, false);
    expect(video.play).toHaveBeenCalledTimes(1);
    resume();
  });
});

describe("tracking the completion screen", () => {
  it("observes all positions through one viewport observer and reports the end", () => {
    let deliver!: IntersectionObserverCallback;
    const observe = vi.fn();
    const disconnect = vi.fn();
    const factory = vi.fn(function (callback: IntersectionObserverCallback) {
      deliver = callback;
      return { observe, disconnect };
    });
    vi.stubGlobal("IntersectionObserver", factory);
    const slides = [0, 1, 2].map((index) => ({ dataset: { index: String(index) } }));
    const root = { querySelectorAll: () => slides } as unknown as HTMLElement;
    const position = vi.fn();
    const stop = observeScrollPosition(root, position);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(expect.any(Function), { root, threshold: [0.6] });
    expect(observe).toHaveBeenCalledTimes(3);
    const send = (index: number, ratio: number) => deliver([
      { target: slides[index], isIntersecting: ratio > 0, intersectionRatio: ratio } as unknown as IntersectionObserverEntry,
    ], {} as IntersectionObserver);
    send(1, 0.3);
    expect(position).not.toHaveBeenCalled();
    send(1, 0.8);
    send(2, 1);
    expect(position.mock.calls).toEqual([[1], [2]]);
    stop();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("wires the end position and background focus guard into the view", () => {
    const source = readFileSync("src/components/ScrollView.tsx", "utf8");
    expect(source).toContain('className="slide end-slide" data-index={items.length}');
    expect(source).toContain('className="scroll-top" inert={closed}');
    expect(source).toContain('disabled={current === items.length}');
    expect(source).toContain('active={!closed && i === current}');
    expect(source).toContain('observeScrollPosition(list, onVisible)');
    expect(source).toContain('bindScrollPlayback(v, document, active, soundOn, paused)');
    expect(source).toContain('aria-label={playing ? "Pause clip" : "Play clip"}');
  });
});
