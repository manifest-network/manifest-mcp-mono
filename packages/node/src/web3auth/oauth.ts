import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { OAuthConfig, OAuthResult } from './types.js';

// Local OAuth callback port. Override with WEB3AUTH_OAUTH_CALLBACK_PORT if 9876 is in use.
const CALLBACK_PORT = Number.parseInt(process.env.WEB3AUTH_OAUTH_CALLBACK_PORT ?? '9876', 10) || 9876;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
const TIMEOUT_MS = 120_000;

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');
  // base64url → base64
  const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const json = Buffer.from(base64, 'base64').toString('utf-8');
  return JSON.parse(json) as Record<string, unknown>;
}

function buildAuthorizeUrl(oauthConfig: OAuthConfig, state: string): string {
  if (oauthConfig.provider === 'google') {
    const params = new URLSearchParams({
      client_id: oauthConfig.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'offline',
      prompt: 'consent',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  throw new Error(`Unsupported OAuth provider: ${oauthConfig.provider}`);
}

async function exchangeCodeForToken(
  oauthConfig: OAuthConfig,
  code: string,
): Promise<{ id_token: string }> {
  if (oauthConfig.provider === 'google') {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: oauthConfig.clientId,
        client_secret: oauthConfig.clientSecret,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token exchange failed (${res.status}): ${text}`);
    }
    const data = await res.json() as { id_token?: string };
    if (!data.id_token) {
      throw new Error('Token response missing id_token');
    }
    return { id_token: data.id_token };
  }

  throw new Error(`Unsupported OAuth provider: ${oauthConfig.provider}`);
}

export async function runOAuthFlow(oauthConfig: OAuthConfig): Promise<OAuthResult> {
  const state = randomBytes(32).toString('hex');
  const open = (await import('open')).default;

  return new Promise<OAuthResult>((resolve, reject) => {
    let server: Server;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    function settle(): void {
      settled = true;
      clearTimeout(timer);
      server?.close();
    }

    timer = setTimeout(() => {
      if (!settled) {
        settle();
        reject(new Error('OAuth callback timed out after 120 seconds'));
      }
    }, TIMEOUT_MS);

    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (settled) { res.end(); return; }

      const url = new URL(req.url ?? '/', `http://localhost:${CALLBACK_PORT}`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const callbackState = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        settle();
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Authentication failed</h1><p>You can close this tab.</p></body></html>');
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (callbackState !== state) {
        settle();
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Invalid state</h1><p>CSRF check failed. Please try again.</p></body></html>');
        reject(new Error('OAuth state mismatch (possible CSRF)'));
        return;
      }

      if (!code) {
        settle();
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Missing code</h1><p>No authorization code received.</p></body></html>');
        reject(new Error('OAuth callback missing authorization code'));
        return;
      }

      try {
        const tokens = await exchangeCodeForToken(oauthConfig, code);
        const payload = decodeJwtPayload(tokens.id_token);
        const verifierId = (payload.email as string | undefined) ?? '';

        if (!verifierId) {
          throw new Error('JWT id_token missing email claim');
        }

        settle();
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Login successful!</h1><p>You can close this tab and return to the terminal.</p></body></html>');
        resolve({ idToken: tokens.id_token, verifierId });
      } catch (err) {
        settle();
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Token exchange failed</h1><p>Check the terminal for details.</p></body></html>');
        reject(err);
      }
    });

    server.listen(CALLBACK_PORT, () => {
      const authorizeUrl = buildAuthorizeUrl(oauthConfig, state);
      console.error(`Opening browser for authentication...`);
      console.error(`If the browser does not open, visit:\n${authorizeUrl}\n`);
      open(authorizeUrl).catch((err: unknown) => {
        console.error(
          `Could not open browser automatically: ${err instanceof Error ? err.message : String(err)}\n` +
          'Please open the URL above manually in your browser.'
        );
      });
    });

    server.on('error', (err) => {
      if (!settled) {
        settle();
        reject(new Error(`Failed to start OAuth callback server on port ${CALLBACK_PORT}: ${err.message}`));
      }
    });
  });
}
