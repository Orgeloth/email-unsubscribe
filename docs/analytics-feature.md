# User Analytics Feature — Design Document

**Date:** 2026-04-05
**Status:** Draft
**App:** email-unsubscribe (Node.js/Express on AWS Lambda + CloudFront + DynamoDB)

---

## Overview

This document describes a new **Analytics** tab for the email-unsubscribe app. The feature shows the authenticated user a bar chart of how many unsubscribable emails (those carrying a `List-Unsubscribe` header) they received per day over the **past 7 days** or **past 30 days**, along with a trend indicator comparing the selected period against the equivalent preceding period.

Daily counts are stored in a new DynamoDB table (`email-unsubscribe-analytics`) and served from there on subsequent loads. Gmail is only queried to fill gaps (days not yet stored) and to refresh today's count (since the day is still in progress). This keeps analytics fast, preserves historical accuracy, and minimises Gmail API quota usage.

---

## Gmail API Approach

### Query strategy

The Gmail `messages.list` endpoint supports server-side filtering via the `q` parameter. The query used is:

```
has:list-unsubscribe after:YYYY/MM/DD before:YYYY/MM/DD
```

This lets Gmail do the heavy lifting — only messages that already contain a `List-Unsubscribe` header are returned. Only days that are missing from DynamoDB (or today's date) trigger a Gmail API call.

### Bulk metadata fetch

`messages.list` returns a list of message IDs (up to 500 per page). Rather than fetching each message individually, the server uses the **Gmail batch API** (`https://www.googleapis.com/batch/gmail/v1`) to retrieve just the `Date` metadata header for all matched messages in a single HTTP round trip. This keeps latency low and avoids burning through per-user Gmail API quota.

### Cap behaviour

Gmail's `messages.list` returns a maximum of 500 message IDs per page. The server does not paginate beyond the first page. If exactly 500 IDs are returned, a `capped: true` flag is set in the API response so the frontend can display a warning to the user.

---

## Data Storage

### New DynamoDB table: `email-unsubscribe-analytics`

| Attribute    | Type   | Description                                               |
|--------------|--------|-----------------------------------------------------------|
| `userEmail`  | String | Partition key — the authenticated user's email address    |
| `date`       | String | Sort key — calendar date in `YYYY-MM-DD` format           |
| `count`      | Number | Number of unsubscribable emails received on that date     |
| `fetchedAt`  | String | ISO timestamp of when this count was written              |
| `expiresAt`  | Number | TTL — Unix epoch; records auto-expire after 90 days       |

- **Billing mode:** PAY_PER_REQUEST
- **TTL attribute:** `expiresAt` (90-day auto-expiry)
- **Removal policy:** RETAIN (consistent with other tables)

### Read/write strategy

```
On analytics page load (period = week or month):
  1. Read stored daily counts from DynamoDB for the requested date range
  2. Identify missing dates (not in DB) and today's date (always re-fetch)
  3. For each missing/today date: query Gmail API, write result to DynamoDB
  4. Assemble full date range from DB + fresh fetches, return to frontend
```

**First-ever load:** All days in the requested period are missing — Gmail is queried for each. Subsequent loads for the same period are served entirely from DynamoDB (except today).

**Today's count:** Always re-fetched from Gmail and overwritten in DynamoDB, since the day is still accumulating emails.

### Storage estimate

| Parameter              | Value                         |
|------------------------|-------------------------------|
| Users                  | 50                            |
| Days stored per user   | 90 (TTL window)               |
| Item size              | ~150 bytes                    |
| Total storage          | 50 × 90 × 150B = ~675 KB      |
| DynamoDB storage cost  | First 25 GB free → **$0.00** |

---

## API Design

### Endpoint

```
GET /api/analytics?period=week|month
```

- `period=week` — past 7 days vs. the 7 days before that
- `period=month` — past 30 days vs. the 30 days before that
- Requires an authenticated session (existing cookie-based auth middleware applies)

### Response schema

```json
{
  "labels": ["2026-03-25", "2026-03-26", "..."],
  "counts": [4, 7, 2, 0, 11, 5, 3],
  "total": 32,
  "previousTotal": 28,
  "capped": false
}
```

| Field           | Type       | Description                                                                 |
|-----------------|------------|-----------------------------------------------------------------------------|
| `labels`        | `string[]` | ISO date strings (YYYY-MM-DD) for each day in the current period            |
| `counts`        | `number[]` | Unsubscribable email count for each day; parallel array with `labels`       |
| `total`         | `number`   | Sum of `counts` for the current period                                      |
| `previousTotal` | `number`   | Total count for the equivalent preceding period (for trend comparison)      |
| `capped`        | `boolean`  | `true` if the 500-message Gmail API limit was reached; results may be lower |

### Error responses

| HTTP Status | Condition                                   |
|-------------|---------------------------------------------|
| `401`       | User not authenticated                      |
| `400`       | `period` parameter missing or invalid       |
| `502`       | Gmail API call failed (token expired, etc.) |

---

## Frontend

### New Analytics tab

A new **Analytics** tab is added to the existing navigation alongside the current Unsubscribe tab. No routing library is in use; the tab follows the same show/hide pattern used by existing tabs.

### Week / Month toggle

A two-button toggle (Week / Month) at the top of the Analytics tab controls the `period` query parameter sent to `/api/analytics`. Switching the toggle triggers a fresh API call and re-renders the chart.

### Bar chart (Chart.js via CDN)

Chart.js is loaded from CDN — no bundler step is needed. A `<canvas>` element hosts the bar chart. Each bar represents one day. The chart is destroyed and recreated on each toggle to avoid dataset accumulation.

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
```

### Trend indicator

Below the chart, a single line shows the trend:

- **Up arrow + red** if `total > previousTotal` (more marketing email — bad)
- **Down arrow + green** if `total < previousTotal` (less marketing email — good)
- **Dash + grey** if equal

Example: `↓ 14% fewer than the previous 7 days (32 vs 28)`

### Capped warning

If `capped: true` is returned, a dismissible banner is shown beneath the chart:

> Results may be incomplete — your inbox exceeded 500 matching emails in this period.

---

## AWS Infrastructure Changes

One new DynamoDB table is required. All other infrastructure is unchanged.

### CDK changes

Add to `email-unsubscribe-stack.ts`:

```typescript
const analyticsTable = new dynamodb.Table(this, 'AnalyticsTable', {
  tableName: `${prefix}-analytics`,
  partitionKey: { name: 'userEmail', type: dynamodb.AttributeType.STRING },
  sortKey:      { name: 'date',      type: dynamodb.AttributeType.STRING },
  billingMode:  dynamodb.BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: 'expiresAt',
  removalPolicy: cdk.RemovalPolicy.RETAIN,
});
analyticsTable.grantReadWriteData(fn);
```

No changes required to:
- Lambda function configuration or memory allocation
- CloudFront distribution
- IAM roles (CDK handles the table grant automatically)
- SSM parameters

---

## AWS Cost Estimate

### Assumptions

| Parameter                        | Value                                      |
|----------------------------------|--------------------------------------------|
| Active users                     | 50                                         |
| Analytics views per user per day | 5                                          |
| Gmail API calls per view         | ~1 (today only, after first load)          |
| DynamoDB reads per view          | 7 or 30 (one per day in the period)        |
| DynamoDB writes per view         | ~1 (today's count overwritten)             |
| Lambda memory                    | 256 MB (existing allocation)               |
| Analytics call duration          | ~1s (DB read) or ~3s (Gmail fetch needed)  |
| Lambda compute price             | $0.0000166667 per GB-second                |
| Lambda request price             | $0.20 per 1,000,000 requests               |
| DynamoDB read price              | $0.25 per million read request units       |
| DynamoDB write price             | $1.25 per million write request units      |

### Monthly incremental calculation

**Request volume:**
```
50 users × 5 views/day × 30 days = 7,500 requests/month
```

**Lambda compute (warm path — DB read, ~1s):**
```
7,500 requests × 1s × 0.25 GB = 1,875 GB-seconds
Cost: 1,875 × $0.0000166667 = $0.031/month
```

**Lambda compute (cold path — Gmail fetch, ~3s, first load only):**
```
50 users × 30 days (first load fills 30 days) = 1,500 Gmail fetch calls
Cost: 1,500 × 3s × 0.25 GB × $0.0000166667 = $0.019/month
```

**Lambda requests:**
```
7,500 ÷ 1,000,000 × $0.20 = $0.002/month
```

**DynamoDB reads:**
```
7,500 views × 30 reads (worst case, month view) = 225,000 reads
Cost: 225,000 ÷ 1,000,000 × $0.25 = $0.056/month
```

**DynamoDB writes:**
```
7,500 views × 1 write (today) = 7,500 writes
Cost: 7,500 ÷ 1,000,000 × $1.25 = $0.009/month
```

### Cost summary

| Cost component              | Monthly cost |
|-----------------------------|--------------|
| Lambda compute (warm)       | $0.031       |
| Lambda compute (cold/first) | $0.019       |
| Lambda requests             | $0.002       |
| DynamoDB reads              | $0.056       |
| DynamoDB writes             | $0.009       |
| DynamoDB storage            | $0.000       |
| CloudFront (incremental)    | ~$0.000      |
| **Total**                   | **~$0.12**   |

### Comparison to original live-fetch design

| Design                  | Monthly cost | Gmail API calls/month | Cold load time |
|-------------------------|--------------|-----------------------|----------------|
| Live-fetch (original)   | ~$0.10       | ~225,000              | 2–5s every time|
| DB-backed (revised)     | ~$0.12       | ~1,500 (first loads)  | 2–5s once, then ~1s |

The DB-backed design costs ~$0.02/month more but is dramatically faster after first load and uses 99% fewer Gmail API calls.

---

## Data Privacy

- Only the **count per day** is stored in DynamoDB — no email subjects, sender addresses, or message IDs are persisted.
- The `fetchedAt` timestamp records when the count was written, not when individual emails arrived.
- The 90-day TTL ensures old analytics data is automatically purged.
- The existing **AES-256-GCM encryption** applied to stored Gmail OAuth tokens is unchanged.
- Users can revoke Gmail access at any time via Google account settings, which immediately prevents further analytics queries (existing counts in DynamoDB are retained until TTL expiry).

---

## Limitations

| Limitation               | Detail                                                                                           |
|--------------------------|--------------------------------------------------------------------------------------------------|
| 500-message cap per day  | Gmail `messages.list` returns at most 500 IDs per page; the server does not paginate further     |
| First-load latency       | First analytics load fetches all days from Gmail — may take 5–10s for 30 days                   |
| Historical availability  | Data is only stored from first use of the analytics tab; no backfill of pre-feature history      |
| Timezone handling        | Day grouping defaults to UTC if the user's timezone cannot be determined                         |
| Today always live        | Today's count is always re-fetched from Gmail — adds ~1–3s to every load                        |

---

## Rollout

### CDK deployment required (one-time)

A new DynamoDB table must be deployed before the code is released. Deploy with:

```bash
npx cdk deploy --context env=prod --profile temp-admin
```

### Steps

1. Add `analyticsTable` to CDK stack, deploy to prod.
2. Implement `GET /api/analytics` route in `server.js` with DB-backed fetch-and-cache logic.
3. Add the Analytics tab HTML/JS to the existing view template.
4. Add Chart.js CDN script tag to the view.
5. Test locally against dev Gmail account.
6. Tag and push to trigger the production pipeline.

---

## Conclusion

The DB-backed analytics design costs ~$0.12/month for 50 active users — only $0.02 more than the original live-fetch approach — while delivering dramatically better performance (sub-second loads after first visit) and 99% fewer Gmail API calls. The tradeoff is a single new DynamoDB table and a one-time CDK deploy before release. Historical accuracy is preserved: stored counts are immutable once written, so deleting emails from Gmail does not alter past analytics data.
