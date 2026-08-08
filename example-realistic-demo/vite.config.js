import { defineConfig } from 'vite'
import browserslist from 'browserslist'
import { browserslistToTargets } from 'lightningcss'
import preact from '@preact/preset-vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'url'

const dir = dirname(fileURLToPath(import.meta.url))

// The client is its own application at the root of the Worker's
// hostname, so `base` is '/' rather than the '/webcrypto-mls' the
// GitHub Pages build uses.
export default defineConfig({
    define: {
        global: 'globalThis'
    },
    root: resolve(dir, './client'),
    base: '/',
    plugins: [
        preact({
            devtoolsInProd: false,
            prefreshEnabled: true
        })
    ],
    esbuild: {
        logOverride: { 'this-is-undefined-in-esm': 'silent' }
    },
    css: {
        transformer: 'lightningcss',
        lightningcss: {
            targets: browserslistToTargets(browserslist('>= 0.25%')),
        },
    },
    server: {
        port: 1234,
        host: true,
        proxy: {
            // ws:true is what lets the WebSocket upgrade through to
            // wrangler dev. Without it the socket fails in development
            // only, which is a confusing way to find out.
            '/api': {
                target: 'http://localhost:8787',
                changeOrigin: true,
                ws: true
            }
        }
    },
    build: {
        cssMinify: 'lightningcss',
        outDir: resolve(dir, './public'),
        emptyOutDir: true,
        sourcemap: 'inline'
    }
})
