# Email Unsubscribe Manager

A web app that connects to your Gmail account and shows emails with unsubscribe links from the past day or week — so you can quickly clean up your inbox.

## Features

- Sign in with Google (OAuth2, read-only Gmail access)
- View emails with unsubscribe links from **yesterday** or the **last 7 days**
- Displays sender domain, email address, subject, date, and a direct unsubscribe link
- Detects unsubscribe links via `List-Unsubscribe` header and email body scanning
- Deduplicates by sender + unsubscribe URL

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

## AWS Deployment (App Runner + CDK)

### Architecture

| Service | Purpose | Cost |
|---|---|---|
| **App Runner** | Hosts the container, HTTPS included | ~$10–15/month |
| **ECR** | Docker image storage | 500 MB free |
| **SSM Parameter Store** | Secrets storage | Free (standard tier) |

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
  --value "YOUR_CLIENT_SECRET" --type SecureString

aws ssm put-parameter --name "/email-unsubscribe/session-secret" \
  --value "$(openssl rand -hex 32)" --type SecureString

# Placeholder — you'll update this after the first deploy
aws ssm put-parameter --name "/email-unsubscribe/redirect-uri" \
  --value "https://placeholder.awsapprunner.com/auth/callback" --type String
```

### Step 3: Deploy

```bash
cd cdk
npx cdk deploy
```

CDK will build the Docker image, push it to ECR, and create the App Runner service. At the end you'll see:

```
Outputs:
EmailUnsubscribeStack.ServiceUrl = https://xxxxxxxxxx.us-east-1.awsapprunner.com
```

### Step 4: Update the redirect URI

Once you have the App Runner URL:

1. Update the SSM parameter:
```bash
aws ssm put-parameter --name "/email-unsubscribe/redirect-uri" \
  --value "https://YOUR-APP-RUNNER-URL/auth/callback" \
  --type String --overwrite
```

2. Add the same URL to Google Cloud Console:
   - APIs & Services → Credentials → your OAuth client → Authorized redirect URIs
   - Add: `https://YOUR-APP-RUNNER-URL/auth/callback`

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
