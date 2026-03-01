import { useState } from "react";
import Auth from "./components/Auth";
import Layout from "./components/Layout";
import ErrorBoundary from "./components/ErrorBoundary";

export default function App() {
    const [authenticated, setAuthenticated] = useState(false);

    return (
        <ErrorBoundary>
            {authenticated
                ? <Layout />
                : <Auth onAuthenticated={() => setAuthenticated(true)} />
            }
        </ErrorBoundary>
    );
}
