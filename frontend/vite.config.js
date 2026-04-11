import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const httpProxy = require('http-proxy');

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Reads port from backend/.dev-port (also used once when this config file is evaluated for preview.proxy). */
function readBackendPort() {
  const devPortFile = join(__dirname, '..', 'backend', '.dev-port');
  if (existsSync(devPortFile)) {
    const p = readFileSync(devPortFile, 'utf8').trim();
    if (/^\d+$/.test(p)) return Number(p);
  }
  return 5001;
}

const apiProxy = httpProxy.createProxyServer({
  changeOrigin: true,
  xfwd: true,
});

apiProxy.on('error', (err, _req, res) => {
  if (!res || typeof res.writeHead !== 'function') return;
  if (res.headersSent || res.writableEnded) return;
  const port = readBackendPort();
  console.error(`[vite] API proxy → 127.0.0.1:${port}:`, err.message);
  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      error: 'Backend not reachable',
      hint: 'Start the backend from /backend with npm run dev',
      details: err.message,
      port,
    }),
  );
});

/** Dev server: forwards /api with per-request port from .dev-port. */
function devDynamicApiProxy() {
  return {
    name: 'dev-dynamic-api-proxy',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] || '';
        if (!url.startsWith('/api')) return next();

        const target = `http://127.0.0.1:${readBackendPort()}`;
        apiProxy.web(req, res, { target });
      });
    },
  };
}

const previewApiTarget = `http://127.0.0.1:${readBackendPort()}`;

export default defineConfig({
  plugins: [devDynamicApiProxy(), react()],
  server: {
    port: 5173,
  },
  preview: {
    proxy: {
      '/api': {
        target: previewApiTarget,
        changeOrigin: true,
      },
    },
  },
});
