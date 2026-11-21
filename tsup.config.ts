import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    express: "src/adapters/express.ts",
    testing: "src/adapters/testing.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  platform: "node",
  splitting: true,
  treeshake: true,
});
