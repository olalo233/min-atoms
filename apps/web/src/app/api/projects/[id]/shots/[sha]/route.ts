import { getCurrentUser } from "@/lib/auth/session";
import { isUuid, jsonError, managerFailure, notFound, unauthorized } from "@/lib/server/http";
import { getManagerClient, MANAGER_TIMEOUTS } from "@/lib/server/manager";
import { findOwnedProject } from "@/lib/server/projects";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; sha: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return unauthorized();
  }

  const params = await context.params;
  const sha = params.sha.replace(/\.png$/i, "");
  if (!isUuid(params.id) || !/^[0-9a-f]{7,64}$/i.test(sha)) {
    return notFound("Screenshot");
  }

  const project = await findOwnedProject(params.id, user.id);
  if (!project) {
    return notFound("Screenshot");
  }

  let response: Response;
  try {
    response = await getManagerClient().screenshot(params.id, sha, MANAGER_TIMEOUTS.screenshot);
  } catch (error) {
    return managerFailure(error);
  }

  if (response.status === 404) {
    return notFound("Screenshot");
  }
  if (!response.ok) {
    return jsonError(502, "The demo environment is unavailable.");
  }

  const bytes = await response.arrayBuffer();
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": response.headers.get("content-type") ?? "image/png",
      // Screenshots are owner-scoped. `max-age` would let a shared or browser
      // cache reuse one account's bytes after a different account signs in,
      // bypassing the owner check above; only /api/vm status may be cached.
      "cache-control": "private, no-store",
    },
  });
}
