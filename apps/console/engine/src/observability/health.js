export function healthHandler(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
}

export function readyHandler(req, res, { checkDb = null } = {}) {
  try {
    if (checkDb && typeof checkDb === 'function') {
      checkDb();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ready', timestamp: new Date().toISOString() }));
  } catch (error) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'not_ready', error: String(error?.message ?? error) }));
  }
}
