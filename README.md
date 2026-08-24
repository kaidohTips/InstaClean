# InstaClean

> See who unfollowed you on Instagram.

InstaClean is a privacy-first Instagram relationship analyzer. It runs entirely in your browser — no server, no account creation, no data collection. Find out who doesn't follow you back, discover hidden fans, and clean up your following list.

## Features

- **Unfollower detection** — Find accounts you follow that don't follow you back
- **Hidden fans** — Discover people who follow you that you don't follow back
- **Mutual friends** — See your reciprocal connections at a glance
- **Whitelist** — Protect specific accounts (celebrities, brands) from appearing in results
- **Bulk unfollow** — Generate console scripts to unfollow multiple accounts at once
- **CSV export** — Download any list as a spreadsheet
- **Scan history** — Track how your follower counts change over time
- **Search & sort** — Filter results by username or display name
- **100% client-side** — Your data never leaves your device

## How it works

InstaClean doesn't connect to Instagram directly. Instead, it analyzes a JSON export of your followers and following lists. There are two ways to get this data:

### Option 1: Console script (recommended)

1. Log into [instagram.com](https://instagram.com) in your browser
2. Open the developer console (`F12` → Console, or `Ctrl+Shift+J`)
3. Copy the scan script from InstaClean and paste it into the console
4. Wait for the scan to complete — a `instaclean_export.json` file will download
5. Import the file into InstaClean

### Option 2: Instagram data export

1. Go to Instagram Settings → Your Activity → Download Your Information
2. Request your data in JSON format
3. Import the downloaded file into InstaClean

## Privacy & security

- **No backend** — InstaClean is a static single-page app with zero server calls
- **No authentication** — Your Instagram credentials are never entered into InstaClean
- **No tracking** — No analytics, no cookies, no telemetry
- **Local storage only** — Scan history and whitelist are stored in your browser
- **Open source** — Audit the code yourself

## Disclaimer

InstaClean is not affiliated with, endorsed by, or connected to Instagram or Meta. Use the console scripts responsibly — Instagram may rate-limit accounts that make too many API requests. The built-in delays minimize this risk, but use at your own discretion.

## License

MIT
