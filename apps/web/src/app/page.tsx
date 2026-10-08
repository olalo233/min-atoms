import { redirect } from "next/navigation";

import { HomeScreen } from "@/components/home/home-screen";
import { getCurrentUser } from "@/lib/auth/session";

export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return <HomeScreen username={user.username} />;
}
