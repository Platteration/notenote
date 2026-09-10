/**
 * Turning a curation record into a sentence a person would actually say.
 *
 * Deliberately a leaf module — types only, no imports with side effects — so the scroll can
 * render explanations without pulling the database layer into the browser bundle.
 *
 * Two rules keep this honest. It only ever describes numbers the scorer really used, and it
 * never says anything disparaging about a clip: a low-engagement clip is simply not commented
 * on rather than being called unpopular. Explaining the algorithm is the point; ranking the
 * creators for the viewer is not.
 */
import type { CurationReason } from "./curation";

/** Highest engagement decile phrasing. Below the lower bound we say nothing at all. */
const STRONG_ENGAGEMENT = 0.7;
const NOTABLE_ENGAGEMENT = 0.4;

function age(hours: number): string | null {
  if (hours < 3) return "Posted in the last few hours";
  if (hours < 24) return "Posted today";
  if (hours < 72) return "From the last couple of days";
  if (hours < 24 * 7) return "From this week";
  return null;
}

/**
 * Up to three phrases, strongest first, explaining why this clip is in the feed.
 * `platformName` is passed in rather than looked up so this stays free of icon imports.
 */
export function explainReason(reason: CurationReason, platformName: string): string[] {
  const notes: string[] = [];

  if (reason.rankInPlatform === 1) {
    notes.push(`The strongest ${platformName} clip left when your feed was built`);
  } else if (reason.engagement >= STRONG_ENGAGEMENT) {
    notes.push(`Among the most watched on ${platformName} right now`);
  } else if (reason.engagement >= NOTABLE_ENGAGEMENT) {
    notes.push(`Doing well on ${platformName}`);
  }

  const when = age(reason.ageHours);
  if (when) notes.push(when);

  if (reason.divertedForDiversity) {
    notes.push("Chosen over a higher-scoring clip to vary who you hear from");
  } else if (reason.creatorAlreadyPicked > 0) {
    const n = reason.creatorAlreadyPicked + 1;
    notes.push(`${n === 2 ? "Second" : "Third"} clip from this creator today`);
  }

  return notes.slice(0, 3);
}

/**
 * A one-line summary for the collapsed state, so the affordance says something useful before
 * anyone taps it.
 */
export function summariseReason(reason: CurationReason, platformName: string): string {
  return explainReason(reason, platformName)[0] ?? `Picked from ${platformName}`;
}

/** Percentages for the small bars in the expanded panel. */
export function reasonBars(reason: CurationReason): Array<{ label: string; percent: number }> {
  return [
    { label: "Engagement on its platform", percent: Math.round(reason.engagement * 100) },
    { label: "Freshness", percent: Math.round(reason.recency * 100) },
  ];
}
