# Workspace Extensions

Extensions add custom UI to the nest workspace — dashboard panels, toolbar buttons, sidebar sections, custom file viewers, and more. They're plain JavaScript modules served from a configured directory. No build step, no Docker rebuild, no React knowledge required.

## Quick Start

1. Create an extension directory:
   ```
   ~/extensions/my-ext/
   ├── manifest.yaml
   └── main.js
   ```

2. Add a manifest:
   ```yaml
   id: my-ext
   name: My Extension
   version: 1
   entry: main.js
   ```

3. Write your entry point:
   ```js
   export function activate(nest) {
       nest.dashboard.addPanel({
           id: "hello",
           title: "Hello",
           render(container) {
               container.innerHTML = "<p>Hello from my extension!</p>";
           },
       });
   }
   ```

4. Refresh the workspace page.

## Configuration

Add to `config.yaml`:

```yaml
extensions:
    dir: /home/wren/extensions
```

Each subdirectory of `extensions.dir` with a valid `manifest.yaml` is loaded as an extension.

## Manifest Format

```yaml
id: my-ext          # Unique identifier (used in API paths)
name: My Extension  # Display name
version: 1          # Integer version
entry: main.js      # JS entry point (relative to extension dir)
styles: styles.css  # Optional CSS file to inject via <link>
```

## API Reference

Extensions receive a `nest` API object in their `activate()` function:

### `nest.dashboard`

```js
// Add a panel to the dashboard
const panel = nest.dashboard.addPanel({
    id: "my-panel",
    title: "My Panel",
    order: 25,           // Lower = earlier. Built-in: status=0, sessions=10, cron=20, usage=30, activity=40, logs=50
    render(container) {
        container.innerHTML = "<p>Panel content</p>";
        return () => { /* cleanup */ };
    },
});
panel.dispose(); // Remove the panel

// Hide/show built-in panels
nest.dashboard.removePanel("logs");
nest.dashboard.restorePanel("logs");
```

### `nest.toolbar`

```js
const btn = nest.toolbar.addButton({
    id: "my-btn",
    label: "🔧 Tool",
    title: "Tooltip text",
    order: 10,
    onClick() { /* ... */ },
});
btn.dispose();
```

### `nest.sidebar`

```js
const section = nest.sidebar.addSection({
    id: "my-section",
    title: "My Section",
    order: 10,
    render(container) {
        container.innerHTML = "<p>Sidebar content</p>";
        return () => { /* cleanup */ };
    },
});
section.dispose();
```

### `nest.views`

```js
// Register a full-page view
const view = nest.views.register({
    id: "my-view",
    title: "My View",
    render(container) {
        container.innerHTML = "<h1>Custom view</h1>";
        return () => { /* cleanup */ };
    },
});

// Navigate to it
nest.views.navigate("my-ext:my-view");
```

### `nest.files`

```js
// Custom file viewer for specific extensions
const viewer = nest.files.registerViewer({
    id: "cave-viewer",
    extensions: [".cave", ".map"],
    // OR: match: (path) => path.endsWith(".cave"),
    render(container, { content, path, root }) {
        container.innerHTML = `<pre>${content}</pre>`;
        return () => { /* cleanup */ };
    },
});

// Add context menu actions to files
const action = nest.files.registerAction({
    id: "analyze",
    label: "🔍 Analyze",
    filter: (path) => path.endsWith(".md"),
    onClick(path, root) {
        alert(`Analyzing ${path}`);
    },
});
```

### `nest.styles`

```js
// Inject CSS dynamically
const style = nest.styles.inject(`
    .my-class { color: var(--green); }
`);
style.dispose(); // Remove the CSS

// Read current theme variables
const theme = nest.styles.getTheme();
// { "--bg": "#0d1117", "--text": "#e6edf3", ... }
```

### `nest.api`

```js
// Authenticated fetch (auto-adds Bearer token)
const res = await nest.api.fetch("/api/status");
const data = await res.json();

// File operations
const file = await nest.api.fetchFile("home", "notes.md");
await nest.api.saveFile("home", "notes.md", "Updated content");
```

### `nest.state`

```js
// Persistent state (localStorage, scoped by extension ID)
nest.state.set("lastRun", Date.now());
const lastRun = nest.state.get("lastRun");
```

### `nest.on()`

```js
// Listen for events
const sub = nest.on("fileSelected", ({ path, root }) => {
    console.log("File selected:", path);
});
sub.dispose();

// Available events: fileSelected, viewChanged, extensionsLoaded
```

## The `render()` Pattern

Extensions get raw DOM containers — use vanilla JS, lit-html, Preact, or any framework:

```js
render(container) {
    // container is an HTMLElement — fill it however you want
    container.innerHTML = "<p>Simple HTML</p>";

    // Optionally return a cleanup function
    return () => {
        // Called when the component unmounts
    };
}
```

## Built-in Panel IDs

For `dashboard.removePanel()`:
- `status` — uptime, model, context gauge
- `sessions` — multi-session status (hidden if single session)
- `cron` — cron jobs table
- `usage` — cost and token usage
- `activity` — recent message activity
- `logs` — log stream

## Tips

- **CSS scoping**: Scope your CSS with a class prefix (e.g., `.ext-myext .panel`) to avoid conflicts with the host UI.
- **Error isolation**: Each extension loads independently. A broken extension won't crash others.
- **No build step**: Extensions are served as plain ES modules. Use `import()` for dependencies if needed.
- **Refresh to reload**: Extensions load at page startup. Edit files, refresh the page.
