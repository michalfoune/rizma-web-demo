export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": origin || "*", // consider pinning to your site in prod
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Vary": "Origin",
    };

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    // Route: /openai/* -> https://api.openai.com/v1/*
    if (url.pathname.startsWith("/openai/")) {
      const upstreamPath = url.pathname.replace("/openai/", "");
      const upstream = new URL(`https://api.openai.com/v1/${upstreamPath}`);

      // Forward headers, but enforce our Authorization
      const fwdHeaders = new Headers(req.headers);
      fwdHeaders.set("authorization", `Bearer ${env.OPENAI_API_KEY}`);

      // Forward the body as-is (works for JSON and multipart/form-data)
      const resp = await fetch(upstream, {
        method: req.method,
        headers: fwdHeaders,
        body: req.body,
      });

      // Stream back with CORS
      const outHeaders = new Headers(resp.headers);
      for (const [k, v] of Object.entries(cors)) outHeaders.set(k, v);

      // Ensure content-type passes through (JSON/audio/etc.)
      if (!outHeaders.get("content-type")) {
        outHeaders.set("content-type", "application/json");
      }

      return new Response(resp.body, { status: resp.status, headers: outHeaders });
    }

    return new Response("Not found", { status: 404, headers: cors });
  },
};