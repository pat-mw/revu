import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@revu/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  worker: {
    format: 'es',
  },
})
