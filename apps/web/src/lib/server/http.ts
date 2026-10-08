import { NextResponse } from "next/server";
import { z } from "zod";

import { ManagerError } from "./manager";

const uuidSchema = z.uuid();

export function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}

export function jsonError(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export function unauthorized() {
  return jsonError(401, "Sign in to continue.");
}

export function notFound(what: string) {
  return jsonError(404, `${what} not found.`);
}

/**
 * Maps manager failures onto the web API's status codes. 404 and 409 keep their
 * meaning; anything else (network, timeout, unexpected response) is a 502.
 */
export function managerFailure(error: unknown) {
  if (error instanceof ManagerError) {
    if (error.status === 404) {
      return notFound("Resource");
    }
    if (error.status === 409) {
      return jsonError(409, "The request conflicts with the current run state.");
    }
    return jsonError(502, "The demo environment is unavailable.");
  }
  throw error;
}
