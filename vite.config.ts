import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

const DEFAULT_APP_BASE_PATH = '/json/';

const normalizeBasePath = (value?: string) => {
  if (!value) return DEFAULT_APP_BASE_PATH;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '/';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withTrailingSlash = withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
  return withTrailingSlash.replace(/\/{2,}/g, '/');
};

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  const appBasePath = normalizeBasePath(env.APP_BASE_PATH);

  return {
    base: appBasePath,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify-file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Allow ngrok tunnel hosts in dev (covers rotating subdomains).
      allowedHosts: ['.ngrok-free.app'],
    },
  };
});
