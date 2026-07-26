import { LoginForm } from "@/components/auth/login-form";

export default function LoginPage() {
  return (
    <main className="auth-shell" id="main-content">
      <div className="auth-layout">
        <section className="auth-intro" aria-labelledby="auth-intro-title">
          <p className="brand-lockup">
            <span className="brand-mark" aria-hidden="true">m/a</span>
            <span>min-atoms</span>
          </p>
          <p className="eyebrow">Private fabrication workspace</p>
          <h1 id="auth-intro-title">One request.<br />A result you can inspect.</h1>
          <p className="lede">
            Build small interactive applications while every generation stage
            stays visible and the Preview stays isolated.
          </p>
          <dl className="trust-register" aria-label="Workspace safeguards">
            <div>
              <dt>Input</dt>
              <dd>One Build Request</dd>
            </div>
            <div>
              <dt>Output</dt>
              <dd>Validated Artifact Version</dd>
            </div>
            <div>
              <dt>Preview</dt>
              <dd>Sandboxed, no network</dd>
            </div>
          </dl>
        </section>
        <section className="auth-card" aria-labelledby="login-title">
          <p className="eyebrow">Authorized access</p>
          <h2 id="login-title">Open your workspace</h2>
          <p className="lede">Use the pre-provisioned Demo User credentials.</p>
          <LoginForm />
        </section>
      </div>
    </main>
  );
}
