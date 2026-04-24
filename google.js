'use strict';

const { google } = require('googleapis');

function createOAuth2Client() {
  const client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return client;
}

function getDriveClient() {
  return google.drive({ version: 'v3', auth: createOAuth2Client() });
}

function getDocsClient() {
  return google.docs({ version: 'v1', auth: createOAuth2Client() });
}

module.exports = { createOAuth2Client, getDriveClient, getDocsClient };
