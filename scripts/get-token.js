'use strict';

/**
 * Helper script to obtain a Google OAuth2 refresh token.
 * Starts a local HTTP server, opens the browser for authorization,
 * then prints the refresh token to the console.
 *
 * Usage: node scripts/get-token.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const http = require('http');
const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
];

const PORT = 3333;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

const client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  REDIRECT_URI
);

const authUrl = client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES,
});

console.log('\n[get-token] Opening browser for Google OAuth2 authorization...');
console.log('[get-token] If the browser does not open automatically, visit:\n');
console.log(' ', authUrl, '\n');

// Try to open the URL in the default browser
const { exec } = require('child_process');
const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
exec(`${open} "${authUrl}"`);

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/callback')) return;

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get('code');

  if (!code) {
    res.end('Missing authorization code.');
    return;
  }

  try {
    const { tokens } = await client.getToken(code);
    res.end('<h2>Authorization successful! You can close this tab.</h2>');

    console.log('\n✅ Authorization successful!\n');
    console.log('Add the following to your .env file:\n');
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('');
  } catch (err) {
    res.end(`<h2>Error: ${err.message}</h2>`);
    console.error('[get-token] Failed to exchange code:', err.message);
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log(`[get-token] Waiting for callback on http://localhost:${PORT}/callback`);
});
