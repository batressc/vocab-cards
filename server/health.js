export function createHealthHandler(store) {
  return (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      store.checkHealth();
      res.json({ status: 'ok', database: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable', database: 'unavailable' });
    }
  };
}
