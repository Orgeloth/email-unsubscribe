# Changelog

All notable changes to this project will be documented in this file.

## [1.2.0] - 2026-03-22

### Changed
- Switched from App Runner to Lambda + Function URL (effectively free for <20 users)
- Replaced `express-session` + `memorystore` with `cookie-session` (stateless, no DB needed)
- Lambda handler exported via `serverless-http`; local `npm start` still works unchanged

---

## [1.1.0] - 2026-03-22

### Added
- AWS CDK stack for App Runner deployment with ECR and SSM Parameter Store
- Dockerfile and `.dockerignore` for container builds
- `/health` endpoint for health checks
- `memorystore` session store

### Changed
- Session cookies now use `secure: true` in production
- Express now trusts proxy headers in production

---

## [1.0.0] - 2026-03-22

### Added
- Initial release
- Gmail OAuth2 sign-in with read-only scope
- Fetch emails with unsubscribe links from the past day or past 7 days
- Displays sender domain, email address, subject, date, and unsubscribe link
- Unsubscribe link detection via `List-Unsubscribe` header and email body scanning
- Deduplication by sender + unsubscribe URL
- Clean, responsive web UI with table view
