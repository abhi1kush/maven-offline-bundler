import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Project Pages site is served at https://<user>.github.io/maven-offline-bundler/
export default defineConfig({
  base: "/maven-offline-bundler/",
  plugins: [react()],
});
