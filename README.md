# Email Unsubscribe Manager

A web app that connects to your Gmail account so you can unsubscribe from marketing emails and keep your inbox clean.

## Features

**Emails tab**
- Sign in with Google OAuth2
- Scan your inbox for emails with unsubscribe links (yesterday / last 7 / last 30 days)
- One-click unsubscribe (RFC 8058) or open the sender's unsubscribe page
- Group by domain, sort by any column, filter by keyword, export to CSV
- Bulk-select and open multiple unsubscribe links at once

**Clean tab**
- After unsubscribing, move remaining emails from those senders to Gmail Trash in bulk
- Skips starred and important emails by default (configurable)
- Confirmation dialog with "don't ask again" option
- Processes up to 500 emails per run

**Analytics tab**
- Bar chart of unsubscribable emails received per day over the past 7 or 30 days
- Trend indicator comparing current period to the previous equivalent period
- DynamoDB-backed caching — fast on repeat loads, minimal Gmail API usage

**Settings & account**
- Dark / light mode toggle (persisted)
- Suppress clean inbox confirmation
- Permanently delete account and all associated data

**PWA — installable**
- Add to Home Screen on iOS (Safari → Share → Add to Home Screen)
- Install prompt on Android Chrome
- Runs full-screen, no browser chrome

**Security**
- Allowlist-based access control — only approved Gmail addresses can sign in
- Session tokens encrypted at rest (AES-256-GCM)
- Security headers: HSTS, CSP, X-Frame-Options, X-Content-Type-Options
- Admin panel: manage users, view active sessions, audit unsubscribe history

---

## Local Development

### Prerequisites
- [Node.js](https://nodejs.org/) v18+
- A Google Cloud project with Gmail API and OAuth2 credentials (see below)

### 1. Clone and install

```bash
git clone https://github.com/Orgeloth/email-unsubscribe.git
cd email-unsubscribe
npm install
```

### 2. Create Google OAuth credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com) and create a project
2. Enable the **Gmail API** (APIs & Services → Library)
3. Create credentials: APIs & Services → Credentials → OAuth client ID
   - Type: **Web application**
   - Authorized redirect URI: `http://localhost:3000/auth/callback`
4. Under **OAuth consent screen → Test users**, add your Gmail address

### 3. Configure `.env`

```bash
cp .env.example .env
```

Fill in:
```
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=any-random-string
PORT=3000
```

### 4. Run

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

---

## AWS Deployment (Lambda + CDK)

### Architecture

| Service | Purpose | Cost |
|---|---|---|
| **Lambda** | Runs the app, serverless | ~$0/month (free tier) |
| **Lambda Function URL** | HTTPS endpoint, no API Gateway needed | Free |
| **SSM Parameter Store** | Secrets storage | Free (standard tier) |

Lambda free tier: 1M requests/month + 400,000 GB-seconds compute. For <20 users this is effectively **free**.

### Prerequisites

- [AWS CLI](https://aws.amazon.com/cli/) configured (`aws configure`)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) running
- [Node.js](https://nodejs.org/) v18+

### Step 1: Bootstrap CDK (once per AWS account/region)

```bash
cd cdk
npm install
npx cdk bootstrap
```

### Step 2: Store secrets in SSM Parameter Store

Run these once — replace values with your actual credentials:

```bash
aws ssm put-parameter --name "/email-unsubscribe/google-client-id" \
  --value "YOUR_CLIENT_ID" --type String

aws ssm put-parameter --name "/email-unsubscribe/google-client-secret" \
  --value "YOUR_CLIENT_SECRET" --type String

aws ssm put-parameter --name "/email-unsubscribe/session-secret" \
  --value "any-long-random-string" --type String

# Placeholder — you'll update this after the first deploy
aws ssm put-parameter --name "/email-unsubscribe/redirect-uri" \
  --value "https://placeholder/auth/callback" --type String
```

### Step 3: Deploy

```bash
cd cdk
npx cdk deploy
```

CDK will build the Docker image, push it to ECR, and create the App Runner service. At the end you'll see:

```
Outputs:
EmailUnsubscribeStack.FunctionUrl = https://xxxxxxxxxx.lambda-url.us-east-1.on.aws/
```

### Step 4: Update the redirect URI

Once you have the Lambda Function URL:

1. Update the SSM parameter:
```bash
aws ssm put-parameter --name "/email-unsubscribe/redirect-uri" \
  --value "https://YOUR-FUNCTION-URL/auth/callback" \
  --type String --overwrite
```

2. Add the same URL to Google Cloud Console:
   - APIs & Services → Credentials → your OAuth client → Authorized redirect URIs
   - Add: `https://YOUR-FUNCTION-URL/auth/callback`

3. Redeploy to pick up the updated parameter:
```bash
npx cdk deploy
```

### Adding test users (while app is in Testing mode)

Google limits OAuth to explicitly added test users until the app is verified.

- Go to **APIs & Services → OAuth consent screen → Test users**
- Add each user's Gmail address

> For a private app with <100 users, you can stay in Testing mode indefinitely and just manage the test user list.

### Teardown

```bash
cd cdk
npx cdk destroy
```

---

## Security Notes

- Requests **read-only** Gmail access (`gmail.readonly` scope)
- `.env` is excluded from git via `.gitignore`
- Secrets in AWS are stored in SSM Parameter Store (SecureString = encrypted at rest)
- Sessions are stored in memory and expire after 24 hours
