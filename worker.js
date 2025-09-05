export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": origin || "*", // consider pinning to your site in prod
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, authorization",
      "Vary": "Origin",
    };

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    // Route: POST /session -> create ephemeral Realtime session with OpenAI
    if (req.method === "POST" && url.pathname === "/session") {
      try {
        // Optional payload from client to override defaults
        let body = {};
        try { body = await req.json(); } catch {}
        const model = body.model || "gpt-realtime"; // ensure this matches your project allowlist
        const voice = body.voice || "alloy";
        const modalities = body.modalities || ["audio", "text"];
        const turn_detection = body.turn_detection || { type: "server_vad" };

        const upstream = "https://api.openai.com/v1/realtime/sessions";
        const r = await fetch(upstream, {
          method: "POST",
          headers: {
            "authorization": `Bearer ${env.OPENAI_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model, voice, modalities, turn_detection }),
        });

        const text = await r.text(); // pass through JSON (or error text)
        return new Response(text, {
          status: r.status,
          headers: {
            ...cors,
            "content-type": "application/json",
          },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
          headers: { ...cors, "content-type": "application/json" },
        });
      }
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