'use strict';

// AWS SDK v3 is included in the Lambda Node.js 20.x runtime — no bundling needed.
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');

const s3 = new S3Client({});
const ses = new SESClient({ region: 'us-east-1' });

exports.handler = async (event) => {
  const record = event.Records[0];
  const { messageId, commonHeaders } = record.ses.mail;
  const originalFrom = commonHeaders.from?.[0] || commonHeaders.returnPath || '';
  const from = process.env.FROM_EMAIL;
  const to = process.env.FORWARD_TO;

  // Fetch raw email stored by the S3 receipt action
  const { Body } = await s3.send(new GetObjectCommand({
    Bucket: process.env.EMAIL_BUCKET,
    Key: `emails/${messageId}`,
  }));
  const raw = await Body.transformToString('latin1');

  // Split into header section and body (headers end at first blank line)
  const sep = raw.indexOf('\r\n\r\n');
  const [headerSection, bodySection] = sep >= 0
    ? [raw.slice(0, sep), raw.slice(sep)]
    : [raw, ''];

  // Process headers: collect folded (multi-line) headers, rewrite From, add Reply-To,
  // and drop DKIM signatures (they become invalid after header modification).
  const lines = headerSection.split('\r\n');
  const outHeaders = [];
  let i = 0;
  while (i < lines.length) {
    let full = lines[i];
    // Collect continuation lines (folded headers start with whitespace)
    while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) {
      i++;
      full += '\r\n' + lines[i];
    }
    const key = full.split(':')[0].toLowerCase().trim();
    // Drop DKIM signatures (invalid after rewrite) and envelope headers that
    // contain the original sender address — SES validates these in production.
    const drop = new Set(['dkim-signature', 'x-google-dkim-signature', 'return-path', 'sender']);
    if (!drop.has(key)) {
      if (key === 'from') {
        outHeaders.push(`From: ${from}`);
        outHeaders.push(`Reply-To: ${originalFrom}`);
      } else {
        outHeaders.push(full);
      }
    }
    i++;
  }

  const rewritten = outHeaders.join('\r\n') + bodySection;

  await ses.send(new SendRawEmailCommand({
    Source: from,
    Destinations: [to],
    RawMessage: { Data: Buffer.from(rewritten, 'latin1') },
  }));

  console.log(`Forwarded ${messageId} from "${originalFrom}" to ${to}`);
};
