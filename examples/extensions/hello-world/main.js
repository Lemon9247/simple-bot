// Hello World — minimal nest extension example
// Demonstrates: dashboard panel, toolbar button, CSS injection, state persistence

export function activate(nest) {
    // ── Dashboard Panel ─────────────────────────────────────
    const panel = nest.dashboard.addPanel({
        id: "hello",
        title: "Hello Extension",
        order: 25, // between cron (20) and usage (30)
        render(container) {
            const count = nest.state.get("clickCount") ?? 0;

            container.innerHTML = `
                <div class="hello-panel">
                    <p>Hello from an extension! 🎉</p>
                    <p class="hello-subtitle">This panel was added by <code>hello-world</code>.</p>
                    <div class="hello-counter">
                        <span>Button clicks: <strong id="hello-count">${count}</strong></span>
                    </div>
                </div>
            `;

            // Keep the counter updated when state changes
            return () => {
                // Cleanup — nothing to do here
            };
        },
    });

    // ── Toolbar Button ──────────────────────────────────────
    const button = nest.toolbar.addButton({
        id: "greet",
        label: "👋 Hello",
        title: "Click to increment the hello counter",
        onClick() {
            const count = (nest.state.get("clickCount") ?? 0) + 1;
            nest.state.set("clickCount", count);

            // Update the counter in the dashboard panel if visible
            const el = document.getElementById("hello-count");
            if (el) el.textContent = String(count);
        },
    });

    // ── CSS Injection ───────────────────────────────────────
    const style = nest.styles.inject(`
        .hello-panel {
            text-align: center;
            padding: 0.5rem;
        }
        .hello-subtitle {
            color: var(--text-muted);
            font-size: 0.85rem;
        }
        .hello-counter {
            margin-top: 0.75rem;
            padding: 0.5rem;
            background: var(--bg-tertiary);
            border-radius: 6px;
            font-size: 0.9rem;
        }
    `);

    console.log("[hello-world] Extension activated!");
}

export function deactivate() {
    console.log("[hello-world] Extension deactivated");
}
