import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        coverage: {
            include: ["src/**/*.ts"],
            provider: "v8",
            reporter: ["text", "json", "html"],
            thresholds: {
                branches: 100,
                functions: 100,
                lines: 100,
                statements: 100,
            },
        },
        include: ["test/{unit,transport}/**/*.test.ts"],
        passWithNoTests: true,
    },
});
