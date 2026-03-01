import { useState } from "react";
import Auth from "./components/Auth";
import Layout from "./components/Layout";

export default function App() {
    const [authenticated, setAuthenticated] = useState(false);

    if (!authenticated) {
        return <Auth onAuthenticated={() => setAuthenticated(true)} />;
    }

    return <Layout />;
}
