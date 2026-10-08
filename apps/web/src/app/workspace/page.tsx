import { redirect } from "next/navigation";
import { LogoutButton } from "@/components/auth/logout-button";
import { getCurrentUser } from "@/lib/auth/session";

export default async function WorkspacePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <main className="shell" id="main-content">
      <header className="product-header">
        <p className="brand-lockup">min-atoms</p>
        <nav className="user-controls" aria-label="Account">
          <span>Signed in as <strong>{user.username}</strong></span>
          <LogoutButton />
        </nav>
      </header>
    </main>
  );
}
