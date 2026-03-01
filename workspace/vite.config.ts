import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    base: "/",
    build: {
        outDir: "../public",
        emptyOutDir: true,
    },
    server: {
        proxy: {
            "/api": "http://localhost:3000",
            "/attach": {
                target: "ws://localhost:3000",
                ws: true,
            },
        },
    },
});
