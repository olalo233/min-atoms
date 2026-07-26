"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function CreateProjectForm() {
  const router = useRouter();
  const [buildRequest, setBuildRequest] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!buildRequest.trim()) {
      setError("Describe what you want to build first.");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ buildRequest }),
      });

      const body = (await response.json()) as {
        error?: string;
        project?: { id: string };
      };
      if (!response.ok || !body.project) {
        setError(body.error ?? "Unable to create the project.");
        return;
      }

      router.push(`/projects/${body.project.id}`);
      router.refresh();
    } catch {
      setError("Unable to create the project. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="project-form" onSubmit={handleSubmit}>
      <div className="field">
        <label htmlFor="build-request">What do you want to build?</label>
        <textarea
          aria-describedby="build-request-hint"
          id="build-request"
          name="buildRequest"
          onChange={(event) => setBuildRequest(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="For example: A daily water tracker with add, undo, and a clear weekly total."
          required
          rows={6}
          value={buildRequest}
        />
        <span className="field-hint" id="build-request-hint">
          Be specific about the interaction. Press ⌘ or Ctrl + Enter to create.
        </span>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <button
        aria-busy={isSubmitting}
        className="primary-button"
        disabled={isSubmitting}
        type="submit"
      >
        {isSubmitting ? <><span className="loading-mark" aria-hidden="true" />Creating project…</> : "Create project"}
      </button>
    </form>
  );
}
