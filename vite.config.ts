import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

const manifest = JSON.parse(readFileSync("plugin.json", "utf-8"));

// Decky Loader exposes these as window globals; the bundle must not import them.
const globals: Record<string, string> = {
  react: "SP_REACT",
  "react/jsx-runtime": "SP_JSX",
  "react-dom": "SP_REACTDOM",
  "@decky/ui": "DFL",
};

function deckyGlobals(): Plugin {
  return {
    name: "decky-globals",
    enforce: "pre",
    resolveId(id) {
      if (id in globals || id === "@decky/manifest") return `\0${id}`;
    },
    load(id) {
      if (!id.startsWith("\0")) return;
      const name = id.slice(1);
      if (name === "@decky/manifest") return `export default ${JSON.stringify(manifest)};`;
      // Rolldown has no syntheticNamedExports and output.globals is iife/umd only; a CommonJS shim
      // lets named imports become property reads on the global.
      if (name in globals) return `module.exports = ${globals[name]};`;
    },
  };
}

export default defineConfig({
  plugins: [deckyGlobals()],
  define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "production") },
  build: {
    lib: { entry: "src/index.tsx", formats: ["es"], fileName: "index" },
    minify: false,
    sourcemap: true,
    rolldownOptions: {
      treeshake: { propertyReadSideEffects: false },
      output: {
        exports: "default",
        sourcemapPathTransform: (p) =>
          p.replace(/^\.\.\//, `decky://decky/plugin/${encodeURIComponent(manifest.name)}/`),
      },
    },
  },
});
