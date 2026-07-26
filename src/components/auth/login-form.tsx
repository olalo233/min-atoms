"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        setError(body.error ?? "Unable to sign in.");
        return;
      }

      router.push("/workspace");
      router.refresh();
    } catch {
      setError("Unable to sign in. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="form" onSubmit={handleSubmit}>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="field">
        <label htmlFor="username">Username</label>
        <input
          autoComplete="username"
          autoFocus
          id="username"
          name="username"
          onChange={(event) => setUsername(event.target.value)}
          required
          value={username}
        />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          autoComplete="current-password"
          id="password"
          name="password"
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
        </div>
      <button
        aria-busy={isSubmitting}
        className="primary-button"
        disabled={isSubmitting}
        type="submit"
      >
        {isSubmitting ? <><span className="loading-mark" aria-hidden="true" />Checking access…</> : "Open workspace"}
      </button>
    </form>
  );
}
