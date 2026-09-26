import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const web = resolve(import.meta.dirname, 'web');

export default defineConfig({
  root: web,
  // Rutas relativas en el build: el sitio funciona igual en la raíz del dominio o en un subdirectorio.
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      // Sitio de varias páginas: cada HTML es un punto de entrada.
      input: {
        index: resolve(web, 'index.html'),
        import: resolve(web, 'import.html')
      }
    }
  }
});
