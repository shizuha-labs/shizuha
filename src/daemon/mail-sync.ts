/**
 * IMAP Mail Sync — uses Python imaplib subprocess for reliable IMAP access.
 * Simpler than a custom TLS IMAP client, works with all providers.
 */

import * as child_process from 'node:child_process';
import { logger } from '../utils/logger.js';

export interface MailAccountConfig {
  id: string;
  email: string;
  host: string;
  port: number;
  username: string;
  password: string;
  assignee: string;
  lastUid?: number;
  enabled: boolean;
}

interface NewEmail {
  uid: number;
  message_id: string;
  from_email: string;
  from_name: string;
  to: string;
  subject: string;
  date: string;
  has_attachments: boolean;
  size: number;
}

const IMAP_SYNC_SCRIPT = `
import imaplib, json, sys, email.utils

config = json.loads(sys.argv[1])
host = config['host']
port = config['port']
username = config['username']
password = config['password']
last_uid = config.get('last_uid', 0)

try:
    imap = imaplib.IMAP4_SSL(host, port)
    status, data = imap.login(username, password)
    if status != 'OK':
        print(json.dumps({"error": "Login failed"}))
        sys.exit(0)

    imap.select('INBOX')

    # Search for UIDs after last_uid
    if last_uid > 0:
        status, data = imap.uid('search', None, f'UID {last_uid + 1}:*')
    else:
        # First sync — get last 20 messages
        status, data = imap.uid('search', None, 'ALL')

    if status != 'OK' or not data[0]:
        print(json.dumps({"emails": [], "max_uid": last_uid}))
        imap.logout()
        sys.exit(0)

    uids = data[0].split()
    if last_uid > 0:
        uids = [u for u in uids if int(u) > last_uid]
    else:
        uids = uids[-20:]  # Last 20 on first sync

    results = []
    for uid in uids:
        try:
            status, msg_data = imap.uid('fetch', uid, '(RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID CONTENT-TYPE)])')
            if status != 'OK' or not msg_data[0]:
                continue

            header_raw = msg_data[0][1].decode('utf-8', errors='replace') if isinstance(msg_data[0][1], bytes) else str(msg_data[0][1])
            size_raw = msg_data[0][0].decode('utf-8', errors='replace') if isinstance(msg_data[0][0], bytes) else str(msg_data[0][0])

            # Parse headers
            headers = {}
            for line in header_raw.strip().split('\\n'):
                if ':' in line:
                    key, val = line.split(':', 1)
                    headers[key.strip().lower()] = val.strip()

            # Parse From
            from_raw = headers.get('from', '')
            from_name, from_email = email.utils.parseaddr(from_raw)

            # Parse size
            size = 0
            import re
            size_match = re.search(r'RFC822\\.SIZE (\\d+)', size_raw)
            if size_match:
                size = int(size_match.group(1))

            has_attachments = 'multipart/mixed' in headers.get('content-type', '').lower()

            msg_id = headers.get('message-id', '').strip('<> ')

            results.append({
                "uid": int(uid),
                "message_id": msg_id or f"uid:{int(uid)}",
                "from_email": from_email or from_raw,
                "from_name": from_name or from_email or from_raw,
                "to": headers.get('to', ''),
                "subject": headers.get('subject', '(no subject)'),
                "date": headers.get('date', ''),
                "has_attachments": has_attachments,
                "size": size,
            })
        except Exception as e:
            pass

    max_uid = max([int(u) for u in uids], default=last_uid)
    imap.logout()
    print(json.dumps({"emails": results, "max_uid": max_uid}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

export async function syncMailAccount(
  account: MailAccountConfig,
  fireAlert: (alert: Record<string, unknown>) => Promise<void>,
): Promise<{ newMessages: number; lastUid: number }> {
  const config = JSON.stringify({
    host: account.host,
    port: account.port,
    username: account.username,
    password: account.password,
    last_uid: account.lastUid ?? 0,
  });

  return new Promise((resolve, reject) => {
    const proc = child_process.spawn('python3', ['-c', IMAP_SYNC_SCRIPT, config], {
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', async (code) => {
      try {
        const result = JSON.parse(stdout);
        if (result.error) {
          logger.error({ email: account.email, error: result.error }, 'Mail sync: IMAP error');
          resolve({ newMessages: 0, lastUid: account.lastUid ?? 0 });
          return;
        }

        const emails = result.emails as NewEmail[];
        logger.info({ email: account.email, count: emails.length, maxUid: result.max_uid }, 'Mail sync: fetched emails');

        for (const em of emails) {
          await fireAlert({
            title: `${em.from_name}: ${em.subject}`,
            description: `From: ${em.from_email}\nTo: ${em.to}\nDate: ${em.date}`,
            item_type: 'alert.email.new',
            severity: 'info',
            assignee: account.assignee,
            source: 'gmail',
            source_id: em.message_id,
            source_url: account.email.includes('gmail')
              ? `https://mail.google.com/mail/u/0/#inbox`
              : undefined,
            payload: {
              from: em.from_email,
              from_name: em.from_name,
              to: em.to,
              subject: em.subject,
              date: em.date,
              has_attachments: em.has_attachments,
              size: em.size,
              uid: em.uid,
              account_email: account.email,
            },
            labels: em.has_attachments ? ['has-attachments'] : [],
            created_by: 'mail-sync',
          });
        }

        resolve({ newMessages: emails.length, lastUid: result.max_uid });
      } catch (err) {
        logger.error({ email: account.email, stdout, stderr, code }, 'Mail sync: parse error');
        resolve({ newMessages: 0, lastUid: account.lastUid ?? 0 });
      }
    });

    proc.on('error', (err) => {
      logger.error({ email: account.email, err }, 'Mail sync: spawn error');
      resolve({ newMessages: 0, lastUid: account.lastUid ?? 0 });
    });
  });
}
