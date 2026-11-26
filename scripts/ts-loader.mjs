import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.(mjs|cjs|js|jsx|ts|tsx|json)$/.test(specifier) &&
      context.parentURL?.startsWith("file:")
    ) {
      const tsCandidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(tsCandidate)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      const indexCandidate = new URL(`${specifier}/index.ts`, context.parentURL);
      if (existsSync(indexCandidate)) {
        return nextResolve(`${specifier}/index.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
