# MailLaunch

A local Node.js CLI for sending personalized email campaigns through Gmail or Microsoft Graph. It keeps campaign data on the computer, resumes queued recipients, applies a daily limit, and writes JSON Lines activity logs.

## Requirements

- Node.js 18 or newer
- One Gmail or Microsoft 365 account for live sending
- OAuth application IDs for the provider you plan to use

## Setup

1. Install dependencies: `npm install`
2. Open `maillaunch.config.yaml` and enter the client ID for each provider you plan to use.
3. Link the command locally with `npm link` (or run it with `node src/main.js`).
4. Authorize a provider:

   ```sh
   maillaunch auth gmail
   maillaunch auth microsoft
   ```

### Gmail OAuth app

Create a Google Cloud project, enable the Gmail API, configure the OAuth consent screen, and create an OAuth client with the **Desktop app** application type. For testing, add the Google account you will use as a test user. Copy its client ID into `gmail.client_id` in the config file. If Google requires the desktop client's client secret during token exchange, provide it only in the environment variable `MAILLAUNCH_GOOGLE_CLIENT_SECRET`; never put it in the YAML file.

The CLI requests only the `gmail.send` permission and uses the local browser authorization-code flow with PKCE. Google may show an unverified-app warning while the OAuth app is in testing. The test account must be listed as a test user.

### Microsoft OAuth app

Register a public-client app in Microsoft Entra, choose the supported account types you need, and add delegated `Mail.Send` permission. Configure a **Mobile and desktop applications** redirect URI for `http://localhost`. Copy the application client ID into `microsoft.client_id`. The default authority accepts personal Microsoft accounts and work/school accounts; use your tenant-specific authority if the app is restricted to one organization. Organization policy may require admin consent.

The CLI uses MSAL Node with the authorization-code flow and PKCE. It does not need a client secret.

## Usage

```sh
maillaunch auth gmail

maillaunch send \
  --provider gmail \
  --csv recipients.csv \
  --subject "Hi {{name}}, quick note about {{company}}" \
  --body-file template.txt \
  --min-delay 60 \
  --max-delay 180

maillaunch status
maillaunch resume
maillaunch log
```

The CSV must have a header whose name contains `email` or `mail` (case-insensitive). Any CSV column can be used in `{{variable}}` templates. Missing values render as empty strings. The body file is sent as plain text.

Defaults live in `maillaunch.config.yaml`; use `--config <path>` before or after a command to select another YAML file. The example sets a 100-message daily limit, 60–180 second delays, and two retry attempts. The limit counts successful sends per provider across campaigns on this computer, using the computer's local calendar day.

## Data and test cleanup

Campaign state and JSONL logs are written under `~/.maillaunch` by default. OAuth tokens are encrypted with AES-256-GCM in local files; the encryption key is held in the operating system credential store. On Linux, a Secret Service provider such as GNOME Keyring or KWallet must be running. The database contains recipient addresses and rendered messages, so keep the state directory private.

For test-only use, authorize a test account and send only to an address you control. After testing, revoke MailLaunch's access in the Google or Microsoft account's security settings, remove any temporary `MAILLAUNCH_GOOGLE_CLIENT_SECRET` environment variable, delete the configured state directory, and remove the `maillaunch` / `token-encryption-key` entry from the operating system credential store. OAuth client IDs in the YAML file are identifiers, not passwords; replace or remove them if you no longer need the test setup. The config file contains placeholders only.

## Tests

Run the mocked unit tests with:

```sh
npm test
```

They cover BOM/quoted/empty CSV input, email-column detection, template rendering, the daily limit, and retry backoff. They do not contact Google or Microsoft or send email.

## Design decisions

- **Node.js:** Chosen to meet the runtime preference and use one language for the CLI, OAuth, and tests.
- **SQLite:** `sql.js` provides SQLite without requiring native compiler tools. The local database is exported atomically after each state change. This keeps setup simple for a small local CLI.
- **Credentials:** Public OAuth clients avoid a client secret for Microsoft; Google uses the Desktop app flow. Refresh tokens and the MSAL token cache are AES-GCM encrypted, with the encryption key kept in the OS credential store.
- **Logs:** One JSON object per line with ISO 8601 timestamp, status, recipient, campaign ID, and optional error details.
- **Resume safety:** Known `SENT` recipients are not resent. If the process stops while a provider request is in flight, the result may be unknown; that recipient is marked failed for manual verification rather than automatically resent.
- **Delays and retries:** Integer-second delays are uniformly selected from the inclusive configured range. Non-auth failures use exponential backoff; an HTTP `Retry-After` value is honored when present. A 401 triggers token refresh once and pauses for re-authentication if refresh fails.

## Future improvements

- Add a supported account chooser for multiple sender accounts per provider.
- Add integration tests with disposable provider accounts and a mailbox-safe test campaign.
- Use native SQLite for very large local histories instead of exporting the SQLite file after each state change.
