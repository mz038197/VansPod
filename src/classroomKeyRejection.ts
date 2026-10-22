/** Why Router no longer accepts a Classroom API Key: expired (401), or invalid or disabled (403). */
export type ClassroomKeyRejection = "expired" | "invalid";

/** Router refused this Classroom API Key: the student has to redeem a new invite code. */
export class ClassroomKeyRejectedError extends Error {
  constructor(readonly reason: ClassroomKeyRejection) { super(`Classroom API Key ${reason}`); }
}

/** Throws when a Router reply to a request made with a Classroom API Key refuses that key. */
export async function assertClassroomKeyAccepted(response: Response): Promise<void> {
  if (response.status === 401) throw new ClassroomKeyRejectedError("expired");
  // A school filter or proxy in front of Router also answers 403, with its own block page;
  // only Router's own JSON reply means the key itself was refused.
  if (response.status === 403 && await isRouterReply(response)) throw new ClassroomKeyRejectedError("invalid");
}

async function isRouterReply(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.clone().json();
    return !!body && typeof body === "object" && typeof (body as { detail?: unknown }).detail === "string";
  } catch {
    return false;
  }
}
