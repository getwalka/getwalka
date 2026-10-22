/* ==========================================================================
   Vercel Edge Middleware: tags each /moms, /start, or /myplan request with
   the visitor's country, read from Vercel's own edge geolocation (the
   x-vercel-ip-country request header, present automatically on every
   request Vercel's network handles; empty for local dev / vercel dev
   without a real edge request).

   This does NOT decide who gets blocked. It only stamps a
   walka_geo_country cookie that moms-app.js / start-app.js / couch6k-app.js
   read client-side to apply each funnel's own US/CA gate
   (GEO_ALLOWED_COUNTRIES in moms-copy.js / start-copy.js / couch6k-copy.js)
   and to log the country on every lead row, allowed or blocked. Keeping the
   decision in the *-app.js/*-copy.js pair means there is exactly one place
   per funnel that owns gating logic, same as the existing feature-flag
   gate. One shared cookie, Path=/, is fine across all three funnels since a
   visitor's country doesn't change between them.

   No npm dependency on purpose (this repo has no build step): the
   "x-middleware-next: 1" response header is the same low-level signal
   @vercel/edge's next() helper sends, telling Vercel to keep serving the
   static file/route this request already resolved to rather than replacing
   the response.
   ========================================================================== */

export const config = {
  matcher: ["/moms", "/start", "/myplan"]
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
