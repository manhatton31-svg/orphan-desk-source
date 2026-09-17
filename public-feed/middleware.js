/**
 * Edge Middleware: x402 paywall rewrite for Echo GET only.
 * Free catalog/stats/agent-card are NOT matched (static).
 * Uses native Response rewrite — does NOT import @vercel/edge (avoids missing-module 500).
 * Header x-od-internal:1 bypasses rewrite so serverless can read static echoes.
 */
export const config = {
  matcher: [
    '/preview/:path*',
    '/redeem/:path*',
    '/:file*.echo.json',
  ],
};

function copyPayParams(src, dest) {
  for (const k of [
    'tx_hash',
    'tx',
    'chain',
    'network',
    'asset',
    'amount',
    'amount_usdc',
    'payer',
    'preview',
    'quote_id',
    'credit_token',
    'creditToken',
    'odc',
  ]) {
    if (src.searchParams.has(k)) dest.searchParams.set(k, src.searchParams.get(k));
  }
}

export default function middleware(request) {
  try {
    // Never rewrite discovery / agent-card / well-known (matcher already excludes; belt+suspenders)
    const pathname = new URL(request.url).pathname;
    if (
      pathname === '/agent-card.json' ||
      pathname === '/.well-known/agent-card.json' ||
      pathname.startsWith('/.well-known/') ||
      pathname === '/index.json' ||
      pathname === '/stats.json' ||
      pathname === '/FEEDBACK.json'
    ) {
      return;
    }

    if (request.headers.get('x-od-internal') === '1') {
      return;
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method || 'GET';

    try {
      console.log(
        JSON.stringify({
          type: 'echo_paywall_hit',
          method,
          path,
          at: new Date().toISOString(),
        })
      );
    } catch (_) {}

    if (method !== 'GET' && method !== 'HEAD') {
      return;
    }

    const dest = new URL('/api/echo', request.url);

    if (path.startsWith('/preview/')) {
      const id = decodeURIComponent(path.slice('/preview/'.length).replace(/\/$/, ''));
      dest.searchParams.set('preview', '1');
      if (id.endsWith('.echo.json')) dest.searchParams.set('file', id);
      else {
        dest.searchParams.set('echo_id', id);
        dest.searchParams.set('id', id);
      }
      return new Response(null, {
        status: 200,
        headers: { 'x-middleware-rewrite': dest.href },
      });
    }

    if (path.startsWith('/redeem/')) {
      const id = decodeURIComponent(path.slice('/redeem/'.length).replace(/\/$/, ''));
      if (id.endsWith('.echo.json')) dest.searchParams.set('file', id);
      else dest.searchParams.set('echo_id', id);
      copyPayParams(url, dest);
      return new Response(null, {
        status: 200,
        headers: { 'x-middleware-rewrite': dest.href },
      });
    }

    if (path.endsWith('.echo.json')) {
      dest.searchParams.set('file', path.replace(/^\//, ''));
      copyPayParams(url, dest);
      return new Response(null, {
        status: 200,
        headers: { 'x-middleware-rewrite': dest.href },
      });
    }

    return;
  } catch (err) {
    console.log(
      JSON.stringify({
        type: 'middleware_error',
        error: String(err && err.message ? err.message : err),
        at: new Date().toISOString(),
      })
    );
    // Fail open — never 500 agent-card or static routes
    return;
  }
}
