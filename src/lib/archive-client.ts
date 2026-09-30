/**
 * Removing a clip from the archive, from the browser. Shared by the archive page and the
 * scroll's Save toggle so both ask the same question the same way.
 *
 * A clip with a note or a place in a collection holds the user's own writing, which cannot be
 * restored once it is gone, so it is removed only after a confirmation. The server enforces
 * that too: a plain DELETE of such a clip answers 409, which covers a clip annotated in another
 * tab or on another device since this page loaded.
 */
import { RequestError, requestJson } from "./client-api";

export const REMOVE_QUESTION = "Remove this clip from your archive? Its note and its collections go with it.";

/**
 * Resolves true when the clip was removed, false when the person chose to keep it.
 * `annotated` is what this page knows; `ask` is window.confirm in the browser.
 */
export async function removeFromArchive(key: string, annotated: boolean, ask: (question: string) => boolean): Promise<boolean> {
  const url = `/api/saved?key=${encodeURIComponent(key)}`;
  if (annotated) {
    if (!ask(REMOVE_QUESTION)) return false;
    await requestJson(`${url}&confirm=1`, { method: "DELETE" });
    return true;
  }
  try {
    await requestJson(url, { method: "DELETE" });
    return true;
  } catch (err) {
    if (!(err instanceof RequestError) || err.status !== 409 || err.body?.needsConfirm !== true) throw err;
    if (!ask(REMOVE_QUESTION)) return false;
    await requestJson(`${url}&confirm=1`, { method: "DELETE" });
    return true;
  }
}
