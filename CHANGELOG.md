# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-03-22

### Added
- Initial release
- Gmail OAuth2 sign-in with read-only scope
- Fetch emails with unsubscribe links from the past day or past 7 days
- Displays sender domain, email address, subject, date, and unsubscribe link
- Unsubscribe link detection via `List-Unsubscribe` header and email body scanning
- Deduplication by sender + unsubscribe URL
- Clean, responsive web UI with table view
