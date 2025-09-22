import { SESSION_URL } from "../config/constants";

export async function getEphemeralKey() {
    // Your Cloudflare Worker should create an ephemeral session token by POSTing to
    // https://api.openai.com/v1/realtime/sessions with your server-side API key.
    // It must return JSON that includes { client_secret: { value } }.
    const r = await fetch(SESSION_URL, { method: 'POST' });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) {
        const txt = await r.text();
        throw new Error(`Session POST failed ${r.status}. URL=${SESSION_URL}. Content-Type=${ct}. Body=${txt.slice(0, 500)}`);
    }
    if (!ct.includes('application/json')) {
        const txt = await r.text();
        throw new Error(`Session endpoint returned non-JSON. URL=${SESSION_URL}. Content-Type=${ct}. Body=${txt.slice(0, 500)}`);
    }
    const j = await r.json();
    if (j?.model) console.log('Realtime session model:', j.model);
    const key = j?.client_secret?.value || j?.client_secret?.secret || j?.client_secret;
    if (!key) throw new Error(`No ephemeral key in /session response: ${JSON.stringify(j).slice(0, 500)}`);
    return key;
}