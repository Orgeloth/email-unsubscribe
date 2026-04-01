# TODO — Email Unsubscribe Manager

## Core Functionality
- [x] **One-click unsubscribe** — For emails with `List-Unsubscribe-Post` headers, POST directly without opening a link
- [x] **Mark as unsubscribed** — Track clicked links; gray them out on future visits
- [x] **Longer date ranges** — Add "Last 30 days" and a custom date picker
- [x] **Search / filter** — Filter results by domain, subject keyword, or date range
- [x] **Sort columns** — Click column headers to sort by domain, date, etc.

## Organization & Tracking
- [x] **Unsubscribe history** — DynamoDB log of every unsubscribe action (domain, date, user)
- [x] **Domain grouping** — Collapse multiple emails from the same domain into one row with a count
- [x] **"Already unsubscribed" detection** — Flag senders you've unsubscribed from before who are still sending
- [ ] **Snooze** — Hide a sender for X days before it reappears

## Bulk Actions
- [x] **Select multiple + bulk open** — Checkbox per row, open all selected unsubscribe links at once
- [x] **Export to CSV** — Download current results as a spreadsheet

## Notifications / Automation
- [ ] **Email digest** — Scheduled Lambda (EventBridge) that emails a daily summary of unsubscribe candidates

## Multi-user / Admin Enhancements
- [x] **Audit log tab** — Admin view of all user actions (who unsubscribed from what, when)
- [ ] **Usage stats** — Per-user counts, most common sender domains across all users
- [ ] **Invite link** — Admin generates a time-limited invite URL instead of manually adding emails

## Quality of Life
- [ ] **PWA manifest** — Add `manifest.json` and service worker to make the app installable on mobile (favicon already done)
- [ ] **Keyboard shortcuts** — `u` to open unsubscribe link, `j/k` to navigate rows, `/` to focus search, `x` to toggle checkbox (update help page when implemented)
- [ ] **Pagination or infinite scroll** — For users with many results

## Email Providers
- [ ] **Microsoft Outlook / Hotmail support** — Add Microsoft Identity Platform OAuth + Microsoft Graph API as a second email provider alongside Gmail. Requires provider abstraction layer in server.js, new Azure app registration, and `Mail.Read` scope. New SSM params: `microsoft-client-id`, `microsoft-client-secret`.

## Dev Environment
- [x] **Separate AWS dev stack** — Deployed at https://unsub-dev.dorangroup.io. SSM params under `/email-unsubscribe-dev/*`, separate Google OAuth app, isolated DynamoDB tables, CloudFront + ACM + Route 53 all live. Seed admin with `--context adminEmail=...` or direct DynamoDB put-item.

## CI/CD Pipeline
- [x] **GitHub Actions deployment pipeline** — `.github/workflows/deploy.yml` created. Triggers on `v*` tags. Jobs: security-gates (npm audit, Gitleaks, Semgrep) → test → deploy (OIDC auth, `cdk deploy --context env=prod`, CloudFront invalidation, health check).
  - IAM role deployed: `arn:aws:iam::965843121700:role/email-unsubscribe-github-deploy`
  - GitHub secrets still to add: `AWS_DEPLOY_ROLE_ARN` (see above ARN)
- [x] **Test suite** — Jest + supertest. 19 tests across 2 suites. Run: `npm test`.
  - Unit tests: `parseListUnsubscribe()`, `findUnsubscribeInBody()` (12 cases)
  - Integration tests: `/health`, `/auth/status`, CSRF enforcement, auth middleware on all protected routes (7 cases)

## Security Scanning
Tools to run manually and/or integrate into the CI/CD pipeline.

**Pre-deploy gates** (run against source before deploying — block on failure):
- [x] **npm audit** — `npm audit --audit-level=high` in security-gates job.
- [x] **Gitleaks** — `gitleaks/gitleaks-action@v2` in security-gates job, full git history scan.
- [x] **Semgrep** — `semgrep/semgrep-action@v1` with `p/express` ruleset in security-gates job.
- [x] **Snyk** — `snyk/actions/node@master` in security-gates job. Add `SNYK_TOKEN` GitHub secret to enable (currently `continue-on-error: true` until secret is set).

**Post-deploy checks** (run against the live app after deploying — `post-deploy-scan` job):
- [x] **OWASP ZAP baseline scan** — `zaproxy/action-baseline@v0.14.0`, passive scan, findings create GitHub issues. Does not block pipeline.
- [x] **Mozilla Observatory** — API call after deploy; fails pipeline if grade is D or F.
- [x] **testssl.sh** — Docker-based TLS check (`drwetter/testssl.sh --severity HIGH`). Does not block pipeline.

**Manual / periodic** (not suited to automated pipeline):
- [ ] **Nikto** — HTTP server misconfiguration and exposed path scanner. Run periodically: `nikto -h https://unsub.dorangroup.io`.

## Privacy & Security
- [x] **Do not persist Google OAuth tokens in DynamoDB** — Tokens stripped from session blob before DynamoDB write. Encrypted with AES-256-GCM (key derived from SESSION_SECRET via scrypt) and stored in a separate `encryptedTokens` field. Decrypted transparently on session read. Raw tokens never written to database.
- [x] **Correct privacy policy — token storage** — Section 8 updated to accurately describe AES-256-GCM token encryption. False "held in memory only" claim removed.
- [x] **Scope down admin history view** — `getAllHistory()` now uses DynamoDB `ProjectionExpression` to return only `userEmail`, `unsubscribedAt`, `count`. Domain, sender email, and unsubscribe URL no longer exposed to admin.
- [x] **Privacy policy acceptance modal** — Modal shown on first login and after any policy update. Acceptance recorded in DynamoDB (`privacyAcceptedVersion`, `privacyAcceptedAt` on the allowlist entry). Declining logs the user out. Version controlled by `PRIVACY_POLICY_VERSION` constant in `server.js` — bump the date string on each material policy change.
- [x] **Add cookie and localStorage disclosure to privacy policy** — Section 4 added: documents `connect.sid` session cookie (strictly necessary, no consent required) and `theme` localStorage key. Confirms no tracking or third-party cookies.
- [x] **Clarify "encrypted sessions" claim in privacy policy** — Section 8 reworded: describes DynamoDB at-rest encryption (AWS-managed AES-256) accurately, distinguishing it from the application-level token encryption.
- [x] **Set CloudWatch log retention policy** — `logRetention: logs.RetentionDays.ONE_MONTH` added to Lambda in CDK stack. Note: `logRetention` is deprecated in newer CDK — migrate to an explicit `logs.LogGroup` construct when setting up the dev stack.

## Email Infrastructure
- [x] **Obfuscate contact email in privacy policy and terms** — JS assembles `admin@dorangroup.io` at runtime; no address in raw HTML source.
- [ ] **SES email receiving + forwarding** — Set up `admin@dorangroup.io` to forward to personal Gmail. Requires:
  - Route 53 MX record → `inbound-smtp.us-east-1.amazonaws.com`
  - S3 bucket for raw email storage (with 30-day lifecycle policy)
  - SES receipt rule set + rule for `admin@dorangroup.io` (spam/virus scanning enabled, reject unknown recipients)
  - Lambda forwarder using `aws-lambda-ses-forwarder` — From: `admin@dorangroup.io`, Reply-To: original sender
  - Lambda reserved concurrency limit (e.g. 10) to cap blast radius
  - AWS Budget alert at $2–3/month on SES
  - Request SES production access (one-time, required to send to Gmail)
  - All resources added to CDK stack

## Backlog
- [ ] **Webhook / Slack + Discord notification** — Post to Slack and/or Discord when new marketing emails arrive. Admin configures webhook URLs per channel. Slack uses incoming webhooks; Discord uses the same format (`application/json` POST to webhook URL).
