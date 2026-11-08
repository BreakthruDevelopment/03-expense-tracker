import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // `server-only` throws outside a React Server Component build; it's a no-op under test.
      "server-only": path.resolve(__dirname, "test/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // The integration files share one database; run files one at a time so they can't
    // see each other's rows mid-test.
    fileParallelism: false,
    coverage: { provider: "v8", include: ["src/lib/**"] },
  },
});
