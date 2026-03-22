# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - 2026-03-22

### Added
- AWS CDK stack for App Runner deployment with ECR and SSM Parameter Store
- Dockerfile and `.dockerignore` for container builds
- `/health` endpoint for App Runner health checks
- `memorystore` session store (proper TTL and pruning vs default MemoryStore)

### Changed
- Session cookies now use `secure: true` in production
- Express now trusts proxy headers in production (required for App Runner HTTPS)

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
