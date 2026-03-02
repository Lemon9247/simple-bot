import { useState, useMemo } from "react";
import Auth from "./components/Auth";
import Layout from "./components/Layout";
import ErrorBoundary from "./components/ErrorBoundary";
import { ExtensionRegistry, ExtensionRegistryContext } from "./extensions";

export default function App() {
    const [authenticated, setAuthenticated] = useState(false);
    const registry = useMemo(() => new ExtensionRegistry(), []);

    return (
        <ErrorBoundary>
            <ExtensionRegistryContext.Provider value={registry}>
                {authenticated
                    ? <Layout />
                    : <Auth onAuthenticated={() => setAuthenticated(true)} />
                }
            </ExtensionRegistryContext.Provider>
        </ErrorBoundary>
    );
}
