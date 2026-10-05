import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

const bundles = [
  {
    name: '@jacklika/dsh-qoder-connect',
    entry: join(root, '..', 'packages', 'qoder-connect', 'src', 'client.tsx'),
    out: join(root, '..', 'packages', 'qoder-connect', 'lib', 'client.js'),
    tsconfig: join(root, '..', 'packages', 'qoder-connect', 'tsconfig.json'),
  },
  {
    name: '@jacklika/dsh-devin-connect',
    entry: join(root, '..', 'packages', 'devin-connect', 'src', 'client.tsx'),
    out: join(root, '..', 'packages', 'devin-connect', 'lib', 'client.js'),
    tsconfig: join(root, '..', 'packages', 'devin-connect', 'tsconfig.json'),
  },
]

const externals = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-renderer/client',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-settings-plugins/client',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-sidebar/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-slots/client',
]

for (const bundle of bundles) {
  const result = await build({
    entryPoints: [bundle.entry],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: externals,
    write: false,
    tsconfig: bundle.tsconfig,
  })
  const code = result.outputFiles[0].text
  const wrapped = `window.__ModuleLoader__.load({ id: ${JSON.stringify(bundle.name)}, factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${code}
return module.exports;
}});
`
  await writeFile(bundle.out, wrapped)
  console.log(`bundled ${bundle.name} -> ${bundle.out}`)
}
