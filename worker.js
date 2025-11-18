export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": origin || "*", // consider pinning to your site in prod
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, authorization",
      "Access-Control-Max-Age": "86400",
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
        const voice = body.voice || "marin";
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

    // Route: POST /annie-token -> mint CallAnnie/Animato client token server-side
    if (req.method === "POST" && url.pathname === "/annie-token") {
      try {
        if (!env.ANIMATO_CLIENT_ID || !env.ANIMATO_API_KEY) {
          return new Response(JSON.stringify({ error: "server_misconfigured", detail: "Missing ANIMATO_CLIENT_ID or ANIMATO_API_KEY" }), {
            status: 500,
            headers: { ...cors, "content-type": "application/json" },
          });
        }
        // Optional payload from client { userId?: string, sessionId?: string }
        let payload = {};
        try { payload = await req.json(); } catch {}
        const userId = payload.userId || "web_user";
        const sessionId = payload.sessionId || `s_${Date.now()}`;

        // Call vendor to mint a session token
        const upstream = await fetch("https://api.callannie.ai/getClientToken", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_id: env.ANIMATO_CLIENT_ID,      // set via: wrangler secret put ANIMATO_CLIENT_ID
            api_key_secret: env.ANIMATO_API_KEY,   // set via: wrangler secret put ANIMATO_API_KEY
            user_id: userId,
            session_id: sessionId,
          }),
        });

        const text = await upstream.text();

        // Pass through JSON (or error text) with CORS
        return new Response(text, {
          status: upstream.status,
          headers: {
            ...cors,
            "content-type": "application/json",
          },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "annie_token_failed", detail: String(e) }), {
          status: 500,
          headers: { ...cors, "content-type": "application/json" },
        });
      }
    }

    // Route: POST /eval -> evaluate transcript with OpenAI (server-side; keep API key private)
    if (req.method === "POST" && url.pathname === "/eval") {
      try {
        if (!env.OPENAI_API_KEY) {
          return new Response(JSON.stringify({ error: "server_misconfigured", detail: "Missing OPENAI_API_KEY" }), {
            status: 500,
            headers: { ...cors, "content-type": "application/json" },
          });
        }

        // Parse body
        let body = {};
        try { body = await req.json(); } catch {}
        const raw = Array.isArray(body.messages) ? body.messages : [];

        // Keep only user/assistant, last N turns, coerce to strings
        const trimmed = raw
          .filter(m => m && (m.role === "user" || m.role === "assistant"))
          .slice(-60)
          .map(m => ({ role: m.role, content: String(m.content || "") }));

        // If nothing to evaluate, return a benign default
        if (trimmed.length === 0) {
          const fallback = {
            score: 75,
            pass: true,
            strengths: ["Kept the conversation going"],
            improvements: ["Be more specific"],
            fillerPer100: 0,
            toneHint: "Balanced",
            paceHint: "Comfortable",
          };
          return new Response(JSON.stringify(fallback), {
            status: 200,
            headers: { ...cors, "content-type": "application/json" },
          });
        }

        // Prompt (concise, JSON-only)
        const system = "You are an interview coach. Score the candidate 0–100, return concise arrays of strengths and improvements, estimate filler words per 100 words, and short tone/pace hints. Respond in strict JSON only.";
        const transcript = trimmed.map(m => `${m.role}: ${m.content}`).join("\n");
        const user = `Transcript (role: content lines):\n${transcript}\n\nReturn JSON with keys: score, pass, strengths[], improvements[], fillerPer100, toneHint, paceHint.`;

        // Call OpenAI
        const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "authorization": `Bearer ${env.OPENAI_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: body.model || "gpt-4o-mini",
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            temperature: 0.2,
            max_tokens: 400,
          }),
        });

        const text = await upstream.text();
        if (!upstream.ok) {
          return new Response(JSON.stringify({ error: "upstream_error", detail: text.slice(0, 1200) }), {
            status: upstream.status,
            headers: { ...cors, "content-type": "application/json" },
          });
        }

        // Extract JSON from assistant
        let parsed = {};
        try {
          const data = JSON.parse(text);
          parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
        } catch { parsed = {}; }

        // Sanitize output fields
        const num = (v, d) => (Number.isFinite(+v) ? +v : d);
        const arr = v => (Array.isArray(v) ? v : []);
        const clamp100 = v => Math.max(0, Math.min(100, v));

        const out = {
          score: clamp100(num(parsed.score, 75)),
          pass: typeof parsed.pass === "boolean" ? parsed.pass : true,
          strengths: arr(parsed.strengths),
          improvements: arr(parsed.improvements),
          fillerPer100: num(parsed.fillerPer100, 0),
          toneHint: typeof parsed.toneHint === "string" ? parsed.toneHint : "Balanced",
          paceHint: typeof parsed.paceHint === "string" ? parsed.paceHint : "Comfortable",
        };

        return new Response(JSON.stringify(out), {
          status: 200,
          headers: { ...cors, "content-type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "eval_failed", detail: String(e) }), {
          status: 500,
          headers: { ...cors, "content-type": "application/json" },
        });
      }
    }

    return new Response("Not found", { status: 404, headers: cors });
  },
};