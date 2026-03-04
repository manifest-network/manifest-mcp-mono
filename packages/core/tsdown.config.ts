import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/**/*.ts", "!src/**/*.test.ts", "!src/__test-utils__/**"],
  format: "esm",
  unbundle: true,
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2020",
  platform: "node",
});
