# MailLaunch

A Node.js command-line tool for sending personalized campaigns through Gmail or Microsoft Graph. Campaign data stays on the computer, queued recipients can be resumed, a daily limit is enforced, and activity is recorded as JSON Lines.

## Requirements

- Node.js 18 or newer
- One Gmail or Microsoft 365 account for live sending
- OAuth application IDs for the provider you plan to use

## Setup

1. Run `npm install` to install the dependencies.
2. Add the client ID for each provider you plan to use to `maillaunch.config.yaml`.
3. Run `npm link` to use `maillaunch` as a local command, or start it with `node src/main.js`.
4. Sign in to a provider:

   ```sh
   maillaunch auth gmail
   maillaunch auth microsoft
   ```

### Gmail OAuth app

Create a Google Cloud project, enable the Gmail API, configure the OAuth consent screen, and create an OAuth client using the **Desktop app** type. If the app is in testing, add the account you will use as a test user. Put the client ID in `gmail.client_id`. If Google requires the desktop client's secret and it is not already saved, MailLaunch prompts for it in the terminal during authorization or the first send. The prompt hides the secret while you type. MailLaunch stores the secret or your choice that no secret is needed directly in the operating system's credential store, so later sends and scheduled runs can refresh tokens without asking again. Do not put the secret in the YAML file. For non-interactive runs without a saved credential, provide `MAILLAUNCH_GOOGLE_CLIENT_SECRET` to that process through its environment.

The CLI requests the `gmail.send` permission and uses a local browser authorization-code flow with PKCE. Google may show an unverified-app warning while the OAuth app is in testing. In that case, the account must be listed as a test user.

### Microsoft OAuth app

Register a public-client app in Microsoft Entra and select the account types the app should support. Add delegated `Mail.Send` permission and configure a **Mobile and desktop applications** redirect URI for `http://localhost`. Put the application client ID in `microsoft.client_id`. The default authority accepts personal Microsoft accounts and work or school accounts. If the app is limited to one organization, use that tenant's authority. Organization policy may require admin consent.

The CLI uses MSAL Node with the authorization-code flow and PKCE. No client secret is needed.

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
maillaunch run-scheduled
```

The CSV needs a header containing `email` or `mail` (matching is case-insensitive). Use any column in a `{{variable}}` template; missing values become empty strings. The body file is sent as plain text.

Defaults are read from `maillaunch.config.yaml`. Pass `--config <path>` before or after a command to use another YAML file. The example config sets a daily limit of 100 messages, delays of 60–180 seconds, and two retry attempts. The limit counts successful sends from both providers and all campaigns on this computer, based on its local calendar day. Duplicate addresses in a campaign are skipped and logged as `SKIPPED`.

### Schedule a campaign

Pass `--schedule` to enter a future ISO 8601 date-time with a timezone in the terminal, or pass that value directly with `--schedule-at`. MailLaunch saves the campaign locally. It starts sending after that time when `run-scheduled` is invoked:

```sh
maillaunch send --provider gmail --csv recipients.csv --subject "Hi {{name}}" --body-file template.txt --schedule
maillaunch run-scheduled
```

At the prompt, enter a real future date and time such as `2026-10-18T20:50:00+08:00`. For a non-interactive command, pass the same format with `--schedule-at "<future-date-time>"`.

Scheduled campaigns do not run by themselves. To have them start automatically, configure your operating system to invoke `run-scheduled` repeatedly (for example, once a minute): run `node /path/to/maillaunch/src/main.js --config /path/to/maillaunch/maillaunch.config.yaml run-scheduled`. In Windows Task Scheduler, choose `node.exe`, provide the script, `--config` path, and `run-scheduled` as arguments, then set **Start in** to the project directory. On macOS or Linux, add the command to cron with a one-minute interval. Replace the example paths with the paths on your computer. A saved Gmail client secret is read from the operating system's credential store. If none is saved for a non-interactive scheduled process, provide `MAILLAUNCH_GOOGLE_CLIENT_SECRET` through that process's environment; do not put it in the config file. Due campaigns run without an open browser. If a scheduler tick occurs while MailLaunch is already running, it skips that tick. If the computer is off at the scheduled time, the campaign starts on the first tick after the computer is back on.

## Data and test cleanup

By default, campaign state and JSONL logs are stored under `~/.maillaunch`. Local OAuth token files use AES-256-GCM encryption. The encryption key is stored in the operating system's credential store. Linux needs a running Secret Service provider, such as GNOME Keyring or KWallet. The database contains recipient addresses and rendered messages, so keep the state directory private.

For a test send, authorize a test account and use an address you control. When finished, revoke MailLaunch's access in the Google or Microsoft account's security settings. Remove any temporary `MAILLAUNCH_GOOGLE_CLIENT_SECRET` environment variable, delete the configured state directory, and remove the `maillaunch` / `gmail-client-secret` and `maillaunch` / `token-encryption-key` entries from the operating system's credential store. OAuth client IDs in the YAML file identify the app; they are not passwords. Replace or remove them if you no longer need the test setup. The example config contains placeholders only.

## Tests

Run the mocked unit tests with:

```sh
npm test
```

The tests cover BOM-prefixed and quoted CSV input, empty rows, email-column detection, template rendering, the daily limit, retry backoff, token refresh after a 401, abort-signal forwarding to Microsoft Graph, resuming queued recipients without resending completed ones, scheduled-campaign due-time selection, and JSONL log fields. They do not contact Google or Microsoft or send email.

## Design decisions

- **Node.js:** It meets the runtime requirement and lets the CLI, OAuth flows, and tests use one language.
- **SQLite:** `sql.js` avoids native compiler tools. MailLaunch exports the local database atomically after each state change, which keeps installation straightforward for a small CLI.
- **Credentials:** Microsoft uses a public OAuth client, so it needs no client secret. Google uses the Desktop app flow. Refresh tokens and the MSAL token cache are encrypted with AES-GCM. The operating system credential store holds the encryption key and Google client secret.
- **Logs:** Each line is a JSON object with an ISO 8601 timestamp, status, recipient, campaign ID, and error details when applicable.
- **Resume safety:** MailLaunch does not resend recipients already marked `SENT`. If the process stops during a provider request, the delivery result may be unknown. That recipient is marked failed so it can be checked manually before anyone retries it.
- **Delays and retries:** Delays use uniformly selected whole seconds, including both ends of the configured range. Non-authentication failures use exponential backoff, and MailLaunch honors an HTTP `Retry-After` value when provided. A 401 triggers one token refresh; if refresh fails, the campaign pauses and asks the user to authenticate again.

## Future improvements

- Add an account chooser so users can select among multiple sender accounts for each provider.
- Add integration tests using disposable provider accounts and a test campaign that only sends to a safe mailbox.
- Use native SQLite for very large local histories instead of exporting the database after every state change.
