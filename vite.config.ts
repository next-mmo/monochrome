import path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import authGatePlugin from './vite-plugin-auth-gate.js';
import blobAssetPlugin from './vite-plugin-blob.js';
import svgUse from './vite-plugin-svg-use.js';
import uploadPlugin from './vite-plugin-upload.js';
// import purgecss from 'vite-plugin-purgecss';
import { playwright } from '@vitest/browser-playwright';
import { execSync } from 'child_process';
import purgecss from 'vite-plugin-purgecss';

function proxyAudioPlugin() {
    return {
        name: 'proxy-audio-dev',
        configureServer(server) {
            server.middlewares.use('/proxy-audio', async (req, res) => {
                const url = new URL(req.url, `http://${req.headers.host}`);
                const targetUrl = url.searchParams.get('url');

                if (!targetUrl) {
                    res.writeHead(400, { 'Content-Type': 'text/plain' });
                    res.end('Missing url parameter');
                    return;
                }

                try {
                    // Forward the request method (GET, HEAD, etc.)
                    const fetchOptions = {
                        method: req.method || 'GET',
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        },
                    };

                    // Forward range headers for seeking support
                    if (req.headers.range) {
                        fetchOptions.headers['Range'] = req.headers.range;
                    }

                    const response = await fetch(targetUrl, fetchOptions);

                    // Set CORS headers
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
                    res.setHeader('Access-Control-Allow-Headers', 'Range');
                    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');

                    // Forward response headers
                    const contentType = response.headers.get('content-type');
                    if (contentType) res.setHeader('Content-Type', contentType);

                    const contentLength = response.headers.get('content-length');
                    if (contentLength) res.setHeader('Content-Length', contentLength);

                    const contentRange = response.headers.get('content-range');
                    if (contentRange) res.setHeader('Content-Range', contentRange);

                    const acceptRanges = response.headers.get('accept-ranges');
                    if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);

                    res.writeHead(response.status);

                    if (req.method === 'HEAD') {
                        res.end();
                        return;
                    }

                    // Stream the response body
                    if (response.body) {
                        const reader = response.body.getReader();
                        const pump = async () => {
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                res.write(Buffer.from(value));
                            }
                            res.end();
                        };
                        pump().catch((err) => {
                            console.error('Proxy stream error:', err.message);
                            if (!res.headersSent) res.writeHead(502);
                            res.end();
                        });
                    } else {
                        const buffer = await response.arrayBuffer();
                        res.end(Buffer.from(buffer));
                    }
                } catch (err) {
                    console.error('Proxy fetch error:', err.message);
                    if (!res.headersSent) {
                        res.writeHead(502, { 'Content-Type': 'text/plain' });
                    }
                    res.end(`Proxy error: ${err.message}`);
                }
            });
        },
    };
}

function getGitCommitHash() {
    try {
        return execSync('git rev-parse --short HEAD').toString().trim();
    } catch {
        return 'unknown';
    }
}

export default defineConfig((_options) => {
    const commitHash = getGitCommitHash();
    return {
        test: {
            // https://vitest.dev/guide/browser/
            browser: {
                enabled: true,
                provider: playwright(),
                headless: !!process.env.HEADLESS,
                instances: [{ browser: 'chromium' }],
            },
        },
        base: typeof IS_NEUTRALINO !== 'undefined' && IS_NEUTRALINO ? './' : './',
        define: {
            __COMMIT_HASH__: JSON.stringify(commitHash),
            __VITEST__: !!process.env.VITEST,
        },
        worker: {
            format: 'es',
        },
        resolve: {
            alias: {
                '!lucide': '/node_modules/lucide-static/icons',
                '!simpleicons': '/node_modules/simple-icons/icons',
                '!': '/node_modules',

                events: '/node_modules/events/events.js',
                pocketbase: '/node_modules/pocketbase/dist/pocketbase.es.js',
                stream: path.resolve(__dirname, 'stream-stub.js'), // Stub for stream module
            },
        },
        optimizeDeps: {
            exclude: ['pocketbase', '@ffmpeg/ffmpeg', '@ffmpeg/util'],
        },
        server: {
            fs: {
                allow: ['.', 'node_modules'],
                // host: true,
                // allowedHosts: ['<your_tailscale_hostname>'], // e.g. pi5.tailf5f622.ts.net
            },
        },
        // preview: {
        //     host: true,
        //     allowedHosts: ['<your_tailscale_hostname>'], // e.g. pi5.tailf5f622.ts.net
        // },
        build: {
            outDir: 'dist',
            emptyOutDir: true,
            sourcemap: true,
            minify: 'terser',
            terserOptions: {
                compress: {
                    drop_console: true,
                    drop_debugger: true,
                },
            },
            rollupOptions: {
                treeshake: true,
            },
        },
        plugins: [
            proxyAudioPlugin(),
            purgecss({
                variables: false, // DO NOT REMOVE UNUSED VARIABLES (breaks web components like am-lyrics)
                safelist: {
                    standard: [
                        /^am-lyrics/,
                        /^lyplus-/,
                        'sidepanel',
                        'side-panel',
                        'active',
                        'show',
                        /^data-/,
                        /^modal-/,
                    ],
                    deep: [/^am-lyrics/],
                    greedy: [/^lyplus-/, /sidepanel/, /side-panel/],
                },
            }),
            authGatePlugin(),
            uploadPlugin(),
            blobAssetPlugin(),
            svgUse(),
            VitePWA({
                registerType: 'autoUpdate',
                workbox: {
                    globPatterns: ['**/*.{js,css,html,ico,png,svg,json}'],
                    cleanupOutdatedCaches: true,
                    skipWaiting: true,
                    clientsClaim: true,
                    maximumFileSizeToCacheInBytes: 3 * 1024 * 1024, // 3 MiB limit
                    // Define runtime caching strategies
                    runtimeCaching: [
                        {
                            urlPattern: ({ request }) => request.destination === 'image',
                            handler: 'CacheFirst',
                            options: {
                                cacheName: 'images',
                                expiration: {
                                    maxEntries: 100,
                                    maxAgeSeconds: 60 * 24 * 60 * 60, // 60 Days
                                },
                            },
                        },
                        {
                            urlPattern: ({ request }) =>
                                request.destination === 'audio' || request.destination === 'video',
                            handler: 'CacheFirst',
                            options: {
                                cacheName: 'media',
                                expiration: {
                                    maxEntries: 50,
                                    maxAgeSeconds: 60 * 24 * 60 * 60, // 60 Days
                                },
                                rangeRequests: true, // Support scrubbing
                            },
                        },
                    ],
                },
                includeAssets: ['discord.html'],
                manifest: false, // Use existing public/manifest.json
            }),
        ],
    };
});
