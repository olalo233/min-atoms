export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const encoder = new TextEncoder();
const tokenUrl = "https://oauth2.googleapis.com/token";
const scope = "https://www.googleapis.com/auth/compute";

function base64url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export async function signAssertion(keyJson: string, now: number): Promise<string> {
  const key = JSON.parse(keyJson) as { client_email: string; private_key: string };
  const der = Uint8Array.from(atob(key.private_key.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  const signingKey = await crypto.subtle.importKey("pkcs8", der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const iat = Math.floor(now / 1000);
  const unsigned = [
    { alg: "RS256", typ: "JWT" },
    { iss: key.client_email, scope, aud: tokenUrl, iat, exp: iat + 3600 },
  ].map((part) => base64url(encoder.encode(JSON.stringify(part)))).join(".");
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, encoder.encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

// Hash both inputs to fixed-length buffers before comparing every byte.
export async function authorized(header: string | null, token: string): Promise<boolean> {
  const [provided, expected] = await Promise.all([header ?? "", `Bearer ${token}`].map(
    (value) => crypto.subtle.digest("SHA-256", encoder.encode(value)),
  ));
  const a = new Uint8Array(provided);
  const b = new Uint8Array(expected);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0 && token.length > 0;
}

export function tokenProvider(fetch: Fetch, now: () => number) {
  let cached: { key: string; token: string; expires: number } | undefined;
  return async (key: string): Promise<string> => {
    if (cached?.key === key && cached.expires > now() + 60_000) return cached.token;
    const assertion = await signAssertion(key, now());
    const response = await fetch(tokenUrl, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("oauth_failed");
    const result = await response.json() as { access_token: string; expires_in: number };
    if (!result.access_token || !(result.expires_in > 0)) throw new Error("oauth_invalid");
    cached = { key, token: result.access_token, expires: now() + result.expires_in * 1000 };
    return cached.token;
  };
}
