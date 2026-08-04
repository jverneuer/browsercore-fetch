import { definePackageConfig } from "@browsercore/dev/vitest";

export default definePackageConfig({
    name: "fetch",
    coverage: { reporter: ["text", "html", "json-summary"] },
});
