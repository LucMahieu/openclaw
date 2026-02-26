import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type {
  AuthProfileCredential,
  OAuthCredential,
  ProviderAuthContext,
  ProviderPlugin,
} from "openclaw/plugin-sdk";

const PROVIDER_ID = "google-calendar" as const;
const REDIRECT_URI = "http://127.0.0.1:51123/oauth-callback";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/userinfo.email",
];

function envClientId(): string {
  return (
    process.env.OPENCLAW_GTD_GOOGLE_CLIENT_ID?.trim() ||
    process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID?.trim() ||
    ""
  );
}

function envClientSecret(): string {
  return (
    process.env.OPENCLAW_GTD_GOOGLE_CLIENT_SECRET?.trim() ||
    process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET?.trim() ||
    ""
  );
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function buildAuthUrl(params: { clientId: string; challenge: string; state: string }): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

async function waitForCallback(timeoutMs: number): Promise<URL> {
  const redirect = new URL(REDIRECT_URI);
  const port = Number(redirect.port || "51123");

  let resolveCb: (url: URL) => void;
  let rejectCb: (error: Error) => void;
  const callbackPromise = new Promise<URL>((resolve, reject) => {
    resolveCb = resolve;
    rejectCb = reject;
  });

  const timer = setTimeout(() => {
    rejectCb(new Error("Timed out waiting for Google OAuth callback"));
  }, timeoutMs);
  timer.unref?.();

  const server = createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end("Missing callback URL");
      return;
    }

    const url = new URL(req.url, `${redirect.protocol}//${redirect.host}`);
    if (url.pathname !== redirect.pathname) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<h1>Google Calendar auth complete</h1><p>Return to terminal.</p>");
    resolveCb(url);
    setImmediate(() => {
      server.close();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  try {
    return await callbackPromise;
  } finally {
    clearTimeout(timer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function exchangeCode(params: {
  clientId: string;
  clientSecret: string;
  verifier: string;
  code: string;
}): Promise<{ access: string; refresh: string; expires: number }> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      code_verifier: params.verifier,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!payload.access_token || !payload.refresh_token) {
    throw new Error("OAuth response missing access_token or refresh_token");
  }

  return {
    access: payload.access_token,
    refresh: payload.refresh_token,
    expires: Date.now() + Math.max(60, payload.expires_in ?? 3600) * 1000 - 60_000,
  };
}

async function fetchEmail(accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      return undefined;
    }
    const payload = (await response.json()) as { email?: string };
    return payload.email;
  } catch {
    return undefined;
  }
}

export function createGoogleCalendarProvider(): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "Google Calendar",
    docsPath: "/providers/google-calendar",
    aliases: ["gcal", "google-calendar"],
    auth: [
      {
        id: "oauth",
        label: "Google OAuth",
        hint: "PKCE + localhost callback",
        kind: "oauth" as const,
        run: async (ctx: ProviderAuthContext) => {
          const clientId = envClientId();
          const clientSecret = envClientSecret();
          if (!clientId || !clientSecret) {
            throw new Error(
              "Missing Google OAuth client credentials. Set OPENCLAW_GTD_GOOGLE_CLIENT_ID and OPENCLAW_GTD_GOOGLE_CLIENT_SECRET.",
            );
          }

          const pkce = generatePkce();
          const state = randomBytes(16).toString("hex");
          const authUrl = buildAuthUrl({ clientId, challenge: pkce.challenge, state });

          const progress = ctx.prompter.progress("Starting Google Calendar OAuth…");
          try {
            await ctx.openUrl(authUrl);
            progress.update("Waiting for OAuth callback…");
            const callbackUrl = await waitForCallback(180_000);
            const returnedState = callbackUrl.searchParams.get("state") ?? "";
            const code = callbackUrl.searchParams.get("code") ?? "";
            if (!code || returnedState !== state) {
              throw new Error("Invalid OAuth callback (missing code or state mismatch)");
            }

            const exchanged = await exchangeCode({
              clientId,
              clientSecret,
              verifier: pkce.verifier,
              code,
            });
            const email = await fetchEmail(exchanged.access);
            const profileId = `google-calendar:${email ?? "default"}`;

            const credential: AuthProfileCredential = {
              type: "oauth",
              provider: PROVIDER_ID,
              access: exchanged.access,
              refresh: exchanged.refresh,
              expires: exchanged.expires,
              ...(email ? { email } : {}),
              clientId,
              clientSecret,
            } as AuthProfileCredential;

            progress.stop("Google Calendar OAuth complete");

            return {
              profiles: [{ profileId, credential }],
              notes: [
                "Google Calendar connected.",
                "Calendar sync uses GTD as source of truth when conflicts happen.",
              ],
            };
          } catch (error) {
            progress.stop("Google Calendar OAuth failed");
            throw error;
          }
        },
      },
    ],
    refreshOAuth: async (cred: OAuthCredential): Promise<OAuthCredential> => {
      const refreshToken = cred.refresh?.trim();
      if (!refreshToken) {
        throw new Error("Missing refresh token for google-calendar profile");
      }
      const clientId = (typeof cred.clientId === "string" && cred.clientId.trim()) || envClientId();
      const clientSecret =
        (typeof cred.clientSecret === "string" && cred.clientSecret.trim()) || envClientSecret();
      if (!clientId || !clientSecret) {
        throw new Error("Missing Google OAuth client credentials for refresh");
      }

      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });

      if (!response.ok) {
        throw new Error(`Google OAuth refresh failed: ${await response.text()}`);
      }

      const payload = (await response.json()) as {
        access_token?: string;
        expires_in?: number;
      };

      if (!payload.access_token) {
        throw new Error("Google OAuth refresh response missing access_token");
      }

      return {
        ...cred,
        type: "oauth",
        provider: PROVIDER_ID,
        access: payload.access_token,
        expires: Date.now() + Math.max(60, payload.expires_in ?? 3600) * 1000 - 60_000,
        clientId,
        clientSecret,
      };
    },
  };
}
