import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// VITE_BASE: Unterpfad der App (z. B. "/podcast/"), Standard "/".
// PORT: Dev-Server-Port, API: Ziel des /api-Proxys (Server oder server/stub.mjs).
const base = process.env.VITE_BASE ?? "/";
const api = process.env.API ?? "http://127.0.0.1:8850";

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PORT ?? 5190),
    strictPort: true,
    proxy: { [`${base}api`]: api },
  },
  preview: { host: "127.0.0.1", strictPort: true },
  test: { environment: "node", include: ["src/**/*.test.ts", "test/server/**/*.test.{ts,mjs}"] },
});
