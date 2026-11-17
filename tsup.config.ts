import { defineConfig, type Options } from "tsup";

const common: Options = {
  target: "node22",
  platform: "node",
  sourcemap: false,
  treeshake: true,
  // `vitest` est une peerDependency : jamais embarqué.
  external: ["vitest"],
};

export default defineConfig([
  {
    ...common,
    entry: {
      index: "src/index.ts",
      vitest: "src/vitest.ts",
      "vitest-setup": "src/vitest-setup.ts",
      jest: "src/jest.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    // Code partagé en chunks communs : une seule copie des classes d'erreur entre les entrées.
    splitting: true,
    // `import.meta.url` disponible dans le build CJS (chemin du fichier de setup Vitest).
    shims: true,
  },
  {
    ...common,
    entry: { cli: "src/cli/bin.ts" },
    format: ["esm"],
    dts: false,
    clean: false,
    splitting: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
