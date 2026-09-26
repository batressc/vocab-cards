import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const digest = s => createHash('sha256').update(String(s)).digest();

/**
 * Protege las rutas de escritura con una clave (cabecera Authorization: Bearer <clave>).
 * Si ADMIN_TOKEN no está definido, se genera una clave temporal al arrancar y
 * se muestra en la consola; cambia en cada reinicio, así que conviene fijarla
 * en .env.
 */
export function createAuth(getConfig) {
  let temporary = null;

  const currentToken = async () => {
    const configured = (await getConfig()).adminToken;
    if (configured) return configured;
    temporary ??= randomBytes(18).toString('base64url');
    return temporary;
  };

  return {
    async announce() {
      const configured = (await getConfig()).adminToken;
      if (!configured) {
        console.warn(`\n  No hay ADMIN_TOKEN configurado. Clave temporal de administración:\n\n      ${await currentToken()}\n\n  Cambia en cada reinicio. Define ADMIN_TOKEN en .env.\n`);
      } else if (configured.length < 12) {
        console.warn('  Aviso: ADMIN_TOKEN tiene menos de 12 caracteres; usa una clave más larga.');
      }
    },
    require: async (req, res, next) => {
      const header = req.get('authorization') || '';
      const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (given && timingSafeEqual(digest(given), digest(await currentToken()))) return next();
      res.status(401).json({ error: 'Clave de administración incorrecta o faltante.', code: 'UNAUTHORIZED' });
    }
  };
}
