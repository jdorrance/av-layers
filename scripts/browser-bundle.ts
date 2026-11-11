import { isBuiltin } from 'node:module';
import { gzipSync } from 'node:zlib';
import type { Plugin } from 'vite';

const serverModules = [
  /\/apps\/(?:api|batch)\//,
  /\/packages\/contracts\/config\/models\.json/,
  /\/packages\/contracts\/src\/(?:products|regional-publication|refinement)\.ts/,
  /\/packages\/forecast\/src\/(?:frame|refinement|terrain-column|science)\.ts/
];

export function browserBundleBudget(startupLimit: number, lazyLimit = 0): Plugin {
  return {
    name: 'browser-bundle-budget',
    apply: 'build',
    generateBundle(_options, bundle) {
      const startup = new Set<string>();
      function visit(name: string): void {
        const output = bundle[name];
        if (output?.type !== 'chunk' || startup.has(name)) return;
        startup.add(name);
        output.imports.forEach(visit);
      }
      for (const output of Object.values(bundle)) if (output.type === 'chunk' && output.isEntry) visit(output.fileName);
      let startupBytes = 0, lazyBytes = 0;
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const [id, module] of Object.entries(output.modules)) {
          if (!module.renderedLength) continue;
          const path = id.replaceAll('\\', '/');
          if (id.includes('browser-external') || serverModules.some(pattern => pattern.test(path))) {
            this.error(`Browser chunk ${output.fileName} emits server module ${id}`);
          }
        }
        for (const id of [...output.imports, ...output.dynamicImports]) {
          if (isBuiltin(id)) this.error(`Browser chunk ${output.fileName} imports Node module ${id}`);
        }
        const bytes = gzipSync(output.code).byteLength;
        if (startup.has(output.fileName)) startupBytes += bytes;
        else lazyBytes += bytes;
      }
      if (startupBytes > startupLimit || lazyBytes > lazyLimit || (lazyLimit > 0 && lazyBytes === 0)) {
        this.error(`Browser JS budget exceeded or lazy chunk missing: startup ${startupBytes}/${startupLimit} B gzip, lazy ${lazyBytes}/${lazyLimit} B gzip`);
      }
    }
  };
}
