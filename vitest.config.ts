import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        coverage: {
            include: ["src/**/*.ts"],
            provider: "v8",
            reporter: ["text", "json", "html"],
        },
        include: ["test/{unit,transport}/**/*.test.ts"],
        passWithNoTests: true,
    },
});
