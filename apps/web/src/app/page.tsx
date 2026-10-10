import { redirect } from "next/navigation";

import { HomeScreen } from "@/components/home/home-screen";
import { getCurrentUser } from "@/lib/auth/session";

// Mock mode (development only + NEXT_PUBLIC_MOCK_STREAM=1) renders the home
// screen with local fake projects and never touches the database, so the
// auth check is skipped there. Production builds always enforce it.
const MOCK_ENABLED = process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_MOCK_STREAM === "1";

export default async function HomePage() {
  if (MOCK_ENABLED) return <HomeScreen username="demo" />;

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return <HomeScreen username={user.username} />;
}
