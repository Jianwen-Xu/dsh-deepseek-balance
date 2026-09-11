/**
 * Two faces, two bundles: `lib/index.js` is the host plugin (plain CJS ESM
 * output) and `lib/client.js` is the browser half, wrapped in the
 * `window.__ModuleLoader__.load({ id, factory })` registration the client
 * module system expects. The id must equal the package name.
 */
const PLUGIN_ID = 'dsh-deepseek-balance'

export default [
    {
        entry: 'src/index.ts',
        format: 'esm',
        platform: 'node',
        outDir: 'lib',
        clean: false,
        outputOptions: {
            entryFileNames: 'index.js',
        },
    },
    {
        entry: 'src/client/index.ts',
        format: 'cjs',
        platform: 'browser',
        outDir: 'lib',
        clean: false,
        deps: {
            neverBundle: ['react', 'react-dom'],
        },
        outputOptions: {
            entryFileNames: 'client.js',
            banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
            footer: 'return module.exports; } });',
            intro: 'var module = { exports: {} }; var exports = module.exports;',
        },
    },
]
