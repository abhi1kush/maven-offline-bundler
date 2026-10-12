import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Project Pages site is served at https://<user>.github.io/maven-offline-bundler/
export default defineConfig({
  root: "web",
  base: "/maven-offline-bundler/",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  plugins: [react()],
});
