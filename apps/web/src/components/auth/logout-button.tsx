"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LogoutButton() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogout() {
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) {
        setError("Sign out failed. Try again.");
        return;
      }
      router.push("/login");
      router.refresh();
    } catch {
      setError("Sign out failed. Try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="logout-control">
      <button
        aria-busy={isSubmitting}
        className="quiet-button"
        disabled={isSubmitting}
        onClick={handleLogout}
        type="button"
      >
        {isSubmitting ? "Signing out…" : "Sign out"}
      </button>
      {error ? <span className="visually-hidden" role="alert">{error}</span> : null}
    </div>
  );
}
