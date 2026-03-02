import { useState, useMemo } from "react";
import Auth from "./components/Auth";
import Layout from "./components/Layout";
import ErrorBoundary from "./components/ErrorBoundary";
import { ExtensionRegistry, ExtensionRegistryContext, loadExtensions } from "./extensions";

export default function App() {
    const [authenticated, setAuthenticated] = useState(false);
    const registry = useMemo(() => new ExtensionRegistry(), []);

    const handleAuthenticated = () => {
        setAuthenticated(true);
        // Load extensions after auth — fire and forget, errors are per-extension
        loadExtensions(registry).catch((err) =>
            console.error("[extensions] Loader error:", err)
        );
    };

    return (
        <ErrorBoundary>
            <ExtensionRegistryContext.Provider value={registry}>
                {authenticated
                    ? <Layout />
                    : <Auth onAuthenticated={handleAuthenticated} />
                }
            </ExtensionRegistryContext.Provider>
        </ErrorBoundary>
    );
}
