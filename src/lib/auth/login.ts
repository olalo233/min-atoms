import { eq } from "drizzle-orm";

import { users } from "@/db/schema";
import { getDb } from "@/lib/db/client";
import { verifyPassword } from "@/lib/auth/password";

const DUMMY_PASSWORD_HASH =
  "$2b$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

export const INVALID_LOGIN_MESSAGE = "Invalid username or password.";

export async function authenticateUser(
  username: string,
  password: string,
) {
  const result = await getDb()
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  const user = result[0];
  const passwordHash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
  const passwordMatches = await verifyPassword(password, passwordHash);

  if (!user || !passwordMatches) {
    return null;
  }

  return user;
}
