import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/admin-spa/',
  server: {
    proxy: {
      '/api': 'http://192.168.110.106:8000'
    }
  }
})
