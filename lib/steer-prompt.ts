/**
 * What a steer's text is sent as (this fork's choice).
 *
 * A steer joins the run already in progress, so the model reads it in the
 * middle of its own work. The words below say so: the text is a remark about
 * that work ("by the way"), not a new task that replaces it. Only the text on
 * the wire carries them — the composer's draft comes back as it was when a
 * send fails (`restoreSubmission`).
 *
 * Left alone: an empty steer (images only) and a command, which pi and Pi Web
 * read by their first character — `/…` (a slash command steered into the run)
 * and `!…` (a shell command, which never steers anyway).
 */

export const STEER_PREFIX = "BTW:\n";

/** A steer's text as it goes to the model: prefixed when it is plain text. */
export function steerPromptText(message: string): string {
  if (!message.trim()) return message;
  if (message.startsWith("/") || message.startsWith("!")) return message;
  return `${STEER_PREFIX}${message}`;
}
