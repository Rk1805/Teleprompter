import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig } from 'vite'

// HTTPS is required: phones only allow the microphone on secure origins.
export default defineConfig({
  plugins: [react(), tailwindcss(), basicSsl()],
})
