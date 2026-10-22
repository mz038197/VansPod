import { assertClassroomKeyAccepted } from "./classroomKeyRejection";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export async function fetchCourseCatalog(options: {
  root: string;
  apiKey: string;
  request?: FetchLike;
}): Promise<{ course_catalog_yaml?: unknown }> {
  const request = options.request ?? fetch;
  const root = options.root.replace(/\/+$/, "");
  const response = await request(`${root}/extension/course-catalog`, {
    signal: AbortSignal.timeout(5_000),
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
  });
  await assertClassroomKeyAccepted(response);
  if (!response.ok) {
    throw new Error("course catalog failed");
  }
  const json: unknown = await response.json();
  if (!json || typeof json !== "object") {
    throw new Error("course catalog failed");
  }
  return json as { course_catalog_yaml?: unknown };
}
