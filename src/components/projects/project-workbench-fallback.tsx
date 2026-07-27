export function ProjectWorkbenchFallback() {
  return (
    <section
      aria-busy="true"
      aria-labelledby="generation-title"
      className="generation-section"
    >
      <h2 className="visually-hidden" id="generation-title">
        Builder workbench
      </h2>
      <div className="builder-grid">
        <aside
          aria-label="Loading project conversation"
          className="evidence-column"
        >
          <section
            aria-labelledby="conversation-title"
            className="conversation-panel"
          >
            <div className="conversation-heading">
              <div>
                <p className="request-label">Project conversation</p>
                <h3 id="conversation-title">You and the Agent</h3>
              </div>
            </div>
            <div className="conversation-list">
              <p className="request-content">Loading conversation…</p>
            </div>
          </section>
        </aside>
        <div className="preview-panel">
          <div className="preview-waiting">
            <div className="waiting-register">
              <span>Preview</span>
              <span>Loading project state</span>
            </div>
            <div className="waiting-aperture">
              <span className="waiting-mark" />
              <p>The project shell is ready. Loading the latest version…</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
