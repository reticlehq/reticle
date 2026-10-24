/** How long `reticle open` waits for the launched page to register before reporting on it. */
const OPEN_SESSION_WAIT_MS = 8000;

/** The slice of `/status` this wait reads. The probe stays with the caller. */
export interface OpenWaitStatus {
  sessions: readonly unknown[];
  whyLead?: string;
}

/**
 * Poll until a NEW session shows up, or the wait runs out.
 *
 * Compares against the count taken before launching rather than against zero, so opening a second
 * app while one is already connected is not reported as an instant success. The last no-session
 * lead rides back with a miss, so the note can quote a refusal the daemon recorded during the wait.
 */
export async function waitForNewSession(
  before: number,
  read: () => Promise<OpenWaitStatus>,
): Promise<{ connected: boolean; whyLead?: string }> {
  const deadline = Date.now() + OPEN_SESSION_WAIT_MS;
  let whyLead: string | undefined;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const status = await read();
    if (status.sessions.length > before) return { connected: true };
    if (status.whyLead !== undefined) whyLead = status.whyLead;
  }
  return whyLead === undefined ? { connected: false } : { connected: false, whyLead };
}
