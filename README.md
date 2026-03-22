# Email Unsubscribe Manager

A local web app that connects to your Gmail account and shows you emails with unsubscribe links from the past day or week — so you can quickly clean up your inbox.

## Features

- Sign in with Google (OAuth2, read-only Gmail access)
- View emails with unsubscribe links from **yesterday** or the **last 7 days**
- Displays sender domain, email address, subject, date, and a direct unsubscribe link
- Detects unsubscribe links from the `List-Unsubscribe` header and email body
- Deduplicates by sender + unsubscribe URL

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- A Google Cloud project with the Gmail API enabled and OAuth 2.0 credentials

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/your-username/email-unsubscribe.git
cd email-unsubscribe
npm install
```

### 2. Create Google OAuth credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project, enable the **Gmail API**
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Type: **Web application**
   - Authorized redirect URI: `http://localhost:3000/auth/callback`
4. Copy your **Client ID** and **Client Secret**
5. Under **OAuth consent screen → Test users**, add your Gmail address

### 3. Configure environment

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

```
GOOGLE_CLIENT_ID=your_client_id_here
GOOGLE_CLIENT_SECRET=your_client_secret_here
REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=any-random-string
PORT=3000
```

### 4. Run

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000), sign in with Google, and click **Fetch Emails**.

## Security Notes

- The app requests **read-only** Gmail access (`gmail.readonly` scope)
- Credentials are stored in `.env` which is excluded from git via `.gitignore`
- Sessions are stored in memory and expire after 24 hours
