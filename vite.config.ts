import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  build: {
    // three 占了大半体积，单独拆出来让浏览器长期缓存，业务代码改动不必重新下载
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          vue: ['vue'],
        },
      },
    },
  },
})
