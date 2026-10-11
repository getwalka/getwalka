/* ==========================================================================
   Vercel Edge Middleware: tags each /moms request with the visitor's
   country, read from Vercel's own edge geolocation (the x-vercel-ip-country
   request header, present automatically on every request Vercel's network
   handles; empty for local dev / vercel dev without a real edge request).

   This does NOT decide who gets blocked. It only stamps a
   walka_geo_country cookie that moms-app.js reads client-side to apply the
   US/CA gate defined in moms-copy.js (GEO_ALLOWED_COUNTRIES) and to log the
   country on every lead row, allowed or blocked. Keeping the decision in
   moms-app.js/moms-copy.js means there is exactly one place that owns gating
   logic, same as the existing feature-flag gate.

   No npm dependency on purpose (this repo has no build step): the
   "x-middleware-next: 1" response header is the same low-level signal
   @vercel/edge's next() helper sends, telling Vercel to keep serving the
   static file/route this request already resolved to rather than replacing
   the response.
   ========================================================================== */

export const config = {
  matcher: ["/moms"]
};

export default function middleware(request) {
  var country = request.headers.get("x-vercel-ip-country") || "";

  return new Response(null, {
    headers: {
      "x-middleware-next": "1",
      "set-cookie": "walka_geo_country=" + country + "; Path=/; Max-Age=3600; SameSite=Lax"
    }
  });
}
