import { LoginForm } from "@/components/auth/login-form";

export default function LoginPage() {
  return (
    <main className="auth-shell" id="main-content">
      <section className="auth-card" aria-labelledby="login-title">
        <p className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">m/a</span>
          <span>min-atoms</span>
        </p>
        <p className="eyebrow">Private workspace</p>
        <h1 id="login-title">Sign in to build</h1>
        <p className="lede">
          Describe a small interactive app. The agent plans, builds, and
          validates it while you watch every step.
        </p>
        <LoginForm />
        <ul className="auth-assurances" aria-label="Workspace safeguards">
          <li>Sandboxed preview</li>
          <li>Validated output</li>
          <li>Stop the agent anytime</li>
        </ul>
      </section>
    </main>
  );
}
