import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "react-dom/server": path.resolve(import.meta.dirname, "apps/dashboard/node_modules/react-dom/server"),
      "react-dom": path.resolve(import.meta.dirname, "apps/dashboard/node_modules/react-dom"),
      react: path.resolve(import.meta.dirname, "apps/dashboard/node_modules/react"),
      "lucide-react": path.resolve(import.meta.dirname, "apps/dashboard/node_modules/lucide-react"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
  },
});
