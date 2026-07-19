// @ts-check
import * as esbuild from 'esbuild'
import {
    NodeGlobalsPolyfillPlugin
} from '@esbuild-plugins/node-globals-polyfill'

esbuild.build({
    entryPoints: ['test/index.ts'],
    bundle: true,
    write: false,  // Don't write to disk
    platform: 'browser',
    loader: { '.json': 'json' },
    keepNames: true,

    define: {
        global: 'globalThis',
    },

    plugins: [
        // Polyfill Buffer and Process
        // This plugin automatically sets up the inject and define options for
        // Buffer and process.
        NodeGlobalsPolyfillPlugin({
            // Set buffer as the name of the package to use for the
            // Buffer polyfill
            buffer: true,
            // Set process as the name of the package to use for the
            // process polyfill
            process: true,
        })
    ],
}).then(result => {
    // Write the bundled output to stdout
    process.stdout.write(result.outputFiles[0].text)
}).catch(() => process.exit(1))
