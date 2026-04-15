import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// Firebase Hosting은 루트(/)에서 서빙하므로 base 경로 없음
export default defineConfig({
  plugins: [react()],
  base: '/',
})
