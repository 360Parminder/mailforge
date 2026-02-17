import express from 'express'
import net from 'net'
import cors from 'cors'
import { createHash } from 'crypto'
import { resolveSrv, verifySharpDomain } from './dns-utils.js'
import { validateApiKey } from './middleware/apiAuth.js'
import { createSMTPServer } from './smtp-server.js'
import { createIMAPServer } from './imap-server.js'
import { createBridgeReceiver, testEmailSending, sendToTraditionalEmail } from './email-bridge.js'
import { 
    prisma, 
    createEmail, 
    updateEmailStatus, 
    getEmailById,
    verifyUser,
    findUser,
    getScheduledEmails,
    isHashcashUsed,
    markHashcashUsed,
    cleanupExpiredHashcash,
    cleanupPendingEmails,
    updateAttachmentsByEmailId
} from './lib/prisma.js'

const MAILFORGE_PORT = +process.env.MAILFORGE_PORT || 5000
const HTTP_PORT = +process.env.HTTP_PORT || MAILFORGE_PORT + 1
const DOMAIN = process.env.DOMAIN_NAME || 'localhost'

const USERNAME_REGEX = /^[a-zA-Z0-9_\-!$%&'*/?=^@.]+$/;
const MAX_USERNAME_LENGTH = 20;

// Cleanup for pending emails
setInterval(async () => {
    try {
        await cleanupPendingEmails();
    } catch (error) {
        console.error('Error updating stale pending emails:', error);
    }
}, 10000);

// Cleanup for expired emails
setInterval(async () => {
    try {
        const toDelete = await prisma.email.findMany({
            where: {
                expires_at: {
                    lt: new Date()
                },
                NOT: {
                    expires_at: null
                }
            },
            select: { id: true }
        });

        if (toDelete.length > 0) {
            const ids = toDelete.map(r => r.id);
            await prisma.attachment.deleteMany({
                where: {
                    email_id: { in: ids }
                }
            });
            await prisma.email.deleteMany({
                where: {
                    id: { in: ids }
                }
            });
        }
    } catch (error) {
        console.error('Error cleaning up expired emails:', error);
    }
}, 10000);

// Cleanup for used hashcash tokens
setInterval(async () => {
    try {
        const result = await cleanupExpiredHashcash();
        if (result.count > 0) {
            console.log(`Cleaned up ${result.count} expired hashcash tokens.`);
        }
    } catch (error) {
        console.error('Error cleaning up used hashcash tokens:', error);
    }
}, 3600000); // Run every hour

const PROTOCOL_VERSION = 'SHARP/1.3'

const KEYWORDS = {
    promotions: new Set([
        'sale', 'discount', 'buy now', 'limited time', 'offer',
        'free shipping', 'coupon', 'deal', 'save', 'special'
    ]),
    social: new Set([
        'friend request', 'mentioned you', 'liked your post',
        'new follower', 'connection', 'following'
    ]),
    forums: new Set([
        'digest', 'thread', 'post reply', 'new topic',
        'unsubscribe from this group', 'mailing list'
    ]),
    updates: new Set([
        'receipt', 'order confirmation', 'invoice',
        'payment received', 'shipping update', 'account update'
    ])
};

const HASHCASH_THRESHOLDS = {
    GOOD: 18,
    WEAK: 10,
    TRIVIAL: 5,
    REJECT: 3
};

// logEmail helper function using Prisma
const logEmail = async (fa, fd, ta, td, s, b, ct = 'text/plain', hb = null, st = 'pending', sa = null, rid = null, tid = null, ea = null, sd = false) => {
    const classification = classifyEmail(s, b, hb);
    
    // Determine which user to associate the email with
    // For incoming/received emails (status: sent), use the recipient (to)
    // For outgoing/pending emails, try sender first, then recipient
    let user = null;
    if (st === 'sent' || st === 'delivered') {
        user = await findUser(ta.split('@')[0], td);
    }
    if (!user) {
        user = await findUser(fa.split('@')[0], fd);
    }
    
    const email = await createEmail({
        user: user?.id || 'system',
        from_address: fa,
        from_domain: fd,
        to_address: ta,
        to_domain: td,
        subject: s,
        body: b,
        content_type: ct,
        html_body: hb,
        status: st,
        scheduled_at: sa,
        classification: classification,
        reply_to_id: rid,
        thread_id: tid,
        expires_at: ea,
        self_destruct: sd
    });
    return [{ id: email.id }];
}

const parseSharpAddress = a => {
    const m = a.match(/^(.+)@([^:]+)(?::(\d+))?$/);
    if (!m) throw new Error('Invalid email address format');
    return { username: m[1].toLowerCase(), domain: m[2].toLowerCase(), port: m[3] && +m[3] };
};

// Legacy alias for compatibility
const parseEmailAddress = parseSharpAddress;

const sendJSON = (s, m) => s.writable && s.write(JSON.stringify(m) + '\n')
const sendError = (s, e, code = 400) => {
    sendJSON(s, { type: 'ERROR', message: e, code })
    s.end()
}

function isValidSharpUsername(username) {
    if (!username || username.length === 0 || username.length > MAX_USERNAME_LENGTH) {
        return false;
    }
    if (!USERNAME_REGEX.test(username)) {
        return false;
    }
    return true;
}

async function handleSharpMessage(socket, raw, state) {
    const MAX_MESSAGE_SIZE = 1 * 1024 * 1024;
    if (raw.length > MAX_MESSAGE_SIZE) {
        sendError(socket, 'Message too large', 413);
        return;
    }

    try {
        const cmd = JSON.parse(raw.replace(/\r$/, ''));
        switch (state.step) {
            case 'HELLO':
                if (cmd.type !== 'HELLO') {
                    sendError(socket, 'Expected HELLO')
                    return
                }
                if (cmd.protocol !== PROTOCOL_VERSION) {
                    sendError(socket, `Unsupported protocol version: ${cmd.protocol}`)
                    return
                }

                try {
                    const parsedFrom = parseSharpAddress(cmd.server_id);
                    if (!isValidSharpUsername(parsedFrom.username)) {
                        sendError(socket, `Invalid username format in server_id.`);
                        return;
                    }
                    await verifySharpDomain(parsedFrom.domain, socket.remoteAddress);
                    state.from = cmd.server_id;
                    state.step = 'MAIL_TO';
                    sendJSON(socket, { type: 'OK', protocol: PROTOCOL_VERSION });
                } catch (e) {
                    sendError(socket, `Sender verification failed: ${e.message}`);
                }
                return

            case 'MAIL_TO':
                if (cmd.type !== 'MAIL_TO') {
                    sendError(socket, 'Expected MAIL_TO')
                    return
                }
                state.to = cmd.address
                let to;
                try {
                    to = parseSharpAddress(state.to);
                } catch (e) {
                    sendError(socket, `Invalid recipient address format: ${e.message}`);
                    return;
                }

                if (!isValidSharpUsername(to.username)) {
                    sendError(socket, `Invalid username format in recipient address.`);
                    return;
                }

                const addr = to.port
                    ? `${to.domain}:${to.port}`
                    : to.domain
                if (addr !== DOMAIN) {
                    sendError(socket, `This server does not handle mail for ${to.domain}`, 451)
                    return
                }
                const user = await verifyUser(to.username, DOMAIN)
                if (!user) {
                    sendError(socket, 'Recipient user not found', 550)
                    return
                }

                // Inter-server hashcash check
                if (!cmd.hashcash) {
                    sendError(socket, 'Missing X-Hashcash header or hashcash field', 429);
                    return;
                }
                const spamScore = await calculateSpamScore(cmd.hashcash, state.to);
                if (spamScore >= HASHCASH_THRESHOLDS.REJECT) {
                    sendError(socket, `Insufficient proof of work. Score: ${spamScore}`, 429);
                    return;
                }
                state.hashcash = cmd.hashcash;

                state.step = 'DATA'
                sendJSON(socket, { type: 'OK' })
                return

            case 'DATA':
                if (cmd.type !== 'DATA') {
                    sendError(socket, 'Expected DATA')
                    return
                }
                state.step = 'RECEIVING_DATA'
                sendJSON(socket, { type: 'OK' })
                return

            case 'RECEIVING_DATA':
                if (cmd.type === 'EMAIL_CONTENT') {
                    state.subject = cmd.subject;
                    state.body = cmd.body;
                    state.content_type = cmd.content_type || 'text/plain';
                    state.html_body = cmd.html_body || null;
                    state.attachments = cmd.attachments || [];

                    sendJSON(socket, { type: 'OK', message: 'Email content received' });
                } else if (cmd.type === 'END_DATA') {
                    await processEmail(state);
                    sendJSON(socket, { type: 'OK', message: 'Email processed' });
                    socket.end();
                } else {
                    sendError(socket, 'Expected EMAIL_CONTENT or END_DATA');
                }
                return;

            default:
                sendError(socket, `Unhandled state: ${state.step}`)
        }
    } catch {
        sendError(socket, 'Invalid message format or processing error')
    }
}

async function processEmail({ from, to, subject, body, content_type, html_body, attachments = [], hashcash }) {
    const f = parseSharpAddress(from)
    const t = parseSharpAddress(to)
    const emailResult = await logEmail(from, f.domain, to, t.domain, subject, body, content_type, html_body, 'sent')
    const emailId = emailResult[0]?.id;

    if (emailId && hashcash) {
        try {
            const hashcashDate = parseHashcashDate(hashcash.split(':')[2]);
            const tokenExpiry = new Date(hashcashDate.getTime() + 24 * 60 * 60 * 1000);
            await markHashcashUsed(hashcash, tokenExpiry);
        } catch (e) {
            console.error(`Failed to log used hashcash token ${hashcash} for SHARP email ${emailId}:`, e);
        }
    }

    if (emailId && attachments.length > 0) {
        await prisma.attachment.updateMany({
            where: {
                key: { in: attachments }
            },
            data: {
                email_id: emailId,
                status: 'sent'
            }
        });
    }
}

function classifyEmail(subject, body, htmlBody) {
    const fullText = `${subject || ''} ${body || ''}`.toLowerCase();

    const scores = {
        promotions: 0,
        social: 0,
        forums: 0,
        updates: 0
    };

    for (const [category, keywords] of Object.entries(KEYWORDS)) {
        for (const keyword of keywords) {
            if (fullText.includes(keyword.toLowerCase())) {
                scores[category]++;
            }
        }
    }

    // HTML structure score for promotions
    if (htmlBody) {
        const htmlScore = (htmlBody.match(/<img/g) || []).length +
            (htmlBody.match(/<table/g) || []).length +
            (htmlBody.match(/<style/g) || []).length;
        scores.promotions += Math.min(htmlScore, 5);
    }

    // find category with highest score
    const maxScore = Math.max(...Object.values(scores));
    if (maxScore > 0) {
        return Object.entries(scores)
            .find(([_, score]) => score === maxScore)?.[0] || 'primary';
    }

    return 'primary';
}

async function sendEmailToRemoteServer(emailData) {
    const recAddr = parseSharpAddress(emailData.to);
    let target;

    if (recAddr.port) {
        target = { host: recAddr.domain, port: recAddr.port };
    } else {
        const srv = await resolveSrv(recAddr.domain);
        target = { host: srv.ip, port: srv.port };
    }

    console.log(`[sendEmailToRemoteServer] dialing TCP ${target.host}:${target.port}`);

    const client = net.createConnection({
        host: target.host,
        port: target.port
    });

    const steps = [
        { type: 'HELLO', server_id: emailData.from, protocol: PROTOCOL_VERSION },
        { type: 'MAIL_TO', address: emailData.to, hashcash: emailData.hashcash },
        { type: 'DATA' },
        {
            type: 'EMAIL_CONTENT',
            subject: emailData.subject,
            body: emailData.body,
            content_type: emailData.content_type,
            html_body: emailData.html_body,
            attachments: emailData.attachments || []
        },
        { type: 'END_DATA' }
    ];

    return new Promise((resolve, reject) => {
        const responses = [];
        let stepIndex = 0;
        let timeout;

        const cleanup = () => {
            clearTimeout(timeout);
            client.removeAllListeners();
            client.destroy();
        };

        const handleResponse = (line) => {
            console.log('[sendEmailToRemoteServer] recv', line.trim());
            let response;
            try {
                response = JSON.parse(line);
            } catch {
                cleanup();
                return reject(new Error('Invalid JSON from remote'));
            }

            if (response.type === 'ERROR') {
                cleanup();
                return reject(new Error(response.message));
            }

            if (response.type === 'OK') {
                if (response.message === 'Email processed') {
                    cleanup();
                    return resolve({ success: true, responses });
                }

                if (response.message === 'Email content received') {
                    return;
                }

                sendNextMessage();
            }
        };

        const sendMessage = (message) => {
            console.log('[sendEmailToRemoteServer] send', JSON.stringify(message));
            client.write(JSON.stringify(message) + '\n');
        };

        const sendNextMessage = () => {
            if (stepIndex < steps.length) {
                const message = steps[stepIndex++];
                sendMessage(message);

                if (message.type === 'EMAIL_CONTENT' && steps[stepIndex]?.type === 'END_DATA') {
                    sendMessage(steps[stepIndex]);
                    stepIndex++;
                }
            } else {
                cleanup();
                reject(new Error('Unexpected state: No more messages to send.'));
            }
        };

        client.on('connect', () => {
            clearTimeout(timeout);
            sendNextMessage();
        });

        client.on('data', (chunk) => {
            const lines = chunk.toString().split('\n').filter(Boolean);
            lines.forEach(handleResponse);
        });

        client.on('error', (err) => {
            cleanup();
            reject(new Error(`Socket error: ${err.message}`));
        });

        client.on('close', (hadError) => {
            if (hadError) {
                return;
            }
            cleanup();
            reject(new Error('Connection closed unexpectedly'));
        });

        timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Connection timed out'));
        }, 10000);
    });
}

async function processScheduledEmails() {
    try {
        const emails = await getScheduledEmails();
        
        for (const email of emails) {
            console.log(`Processing scheduled email ID ${email.id} scheduled for ${email.scheduled_at}`);
            await prisma.email.update({
                where: { id: email.id },
                data: {
                    status: 'sending',
                    sent_at: new Date()
                }
            });
            const to = parseSharpAddress(email.to_address);
            if (to.domain === DOMAIN) {
                await prisma.email.update({
                    where: { id: email.id },
                    data: { status: 'sent' }
                });
                console.log(
                    `Locally delivered scheduled email ID ${email.id}`
                );
                continue;
            }
            try {
                await sendEmailToRemoteServer({
                    from: email.from_address,
                    to: email.to_address,
                    subject: email.subject,
                    body: email.body,
                    content_type: email.content_type,
                    html_body: email.html_body,
                    attachments: email.attachments || [],
                    // placeholder.
                    // scheduled emails are not sent with hashcash
                    // they are already sent as "spam" instantly, without scheduling, if weak hashcash
                    // hashcash: hashcash(email.to_address)
                });
                await prisma.email.update({
                    where: { id: email.id },
                    data: { status: 'sent' }
                });
                console.log(
                    `Successfully sent scheduled email ID ${email.id}`
                );
            } catch (error) {
                console.error(
                    `Failed to send scheduled email ID ${email.id}:`,
                    error
                );
                await prisma.email.update({
                    where: { id: email.id },
                    data: {
                        status: 'failed',
                        error_message: error.message
                    }
                });
            }
        }
    } catch (error) {
        console.error('Error processing scheduled emails:', error);
    }
}

processScheduledEmails();
setInterval(processScheduledEmails, 60000);

const app = express()

// Configure CORS for external frontend integration
const corsOptions = {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
}
app.use(cors(corsOptions), express.json())

function parseHashcashDate(dateString) {
    const year = parseInt(dateString.substring(0, 2), 10) + 2000;
    const month = parseInt(dateString.substring(2, 4), 10) - 1; // Month is 0-indexed
    const day = parseInt(dateString.substring(4, 6), 10);
    const hour = parseInt(dateString.substring(6, 8), 10);
    const minute = parseInt(dateString.substring(8, 10), 10);
    const second = parseInt(dateString.substring(10, 12), 10);

    return new Date(Date.UTC(year, month, day, hour, minute, second));
}

function hasLeadingZeroBits(hexHash, bits) {
    if (bits === 0) return true;
    if (bits > hexHash.length * 4) {
        return false;
    }

    const hashInt = BigInt('0x' + hexHash);
    const shiftAmount = BigInt(160 - bits);
    return (hashInt >> shiftAmount) === 0n;
}

async function calculateSpamScore(header, resource) {
    if (!header) return HASHCASH_THRESHOLDS.REJECT;

    try {
        const [version, bits, date, headerResource, ext, rand, counter] = header.split(':');

        if (version !== '1' || !bits || !date || !headerResource || !rand || !counter) {
            return HASHCASH_THRESHOLDS.REJECT;
        }

        // Verify resource matches
        if (headerResource !== resource) {
            return HASHCASH_THRESHOLDS.REJECT;
        }

        const headerDate = parseHashcashDate(date);
        const now = new Date();
        const offset = 2 * 60 * 1000;

        if (headerDate > new Date(now.getTime() + offset)) {
            return HASHCASH_THRESHOLDS.REJECT;
        }

        if (now - headerDate > 24 * 60 * 60 * 1000) {
            return HASHCASH_THRESHOLDS.WEAK + 1;
        }

        const existingToken = await isHashcashUsed(header);
        if (existingToken) {
            return HASHCASH_THRESHOLDS.REJECT;
        }

        // Verify proof of work
        const hash = createHash('sha1')
            .update(header)
            .digest('hex');

        const actualBits = parseInt(bits, 10);

        if (!hasLeadingZeroBits(hash, actualBits)) {
            return HASHCASH_THRESHOLDS.REJECT;
        }

        if (actualBits >= HASHCASH_THRESHOLDS.GOOD) return 0;
        if (actualBits >= HASHCASH_THRESHOLDS.WEAK) return 1;
        if (actualBits >= HASHCASH_THRESHOLDS.TRIVIAL) return 2;
        return HASHCASH_THRESHOLDS.REJECT;
    } catch {
        return HASHCASH_THRESHOLDS.REJECT;
    }
}

// Primary endpoint: API key authentication (for external frontends)
app.post('/send', validateApiKey, async (req, res) => {
    let logEntry;
    let emailId;
    try {
        const { hashcash, ...emailData } = req.body;

        let fp, tp;
        try {
            fp = parseSharpAddress(emailData.from);
            tp = parseSharpAddress(emailData.to);
        } catch {
            return res.status(400).json({
                success: false,
                message: 'Invalid SHARP address format'
            });
        }

        if (!req.turnstileVerified) {
            return res.status(403).json({
                success: false,
                message: 'Turnstile verification failed. Please try again.'
            });
        }

        // API key authentication bypasses hashcash requirement
        let status = 'pending';
        let spamScore = 0;

        if (hashcash) {
            spamScore = await calculateSpamScore(hashcash, emailData.to);
            if (spamScore > 0) {
                status = 'spam';
            }
        }

        if (emailData.scheduled_at && status !== 'spam') {
            status = 'scheduled';
        }

        const { from, to, subject, body, content_type = 'text/plain',
            html_body, scheduled_at, reply_to_id, thread_id,
            attachments = [], expires_at = null, self_destruct = false } = emailData;

        if (fp.username !== req.user.username || fp.domain !== req.user.domain) {
            return res.status(403).json({
                success: false,
                message: 'You can only send emails from your own address.'
            });
        }

        if (fp.domain !== DOMAIN) {
            return res.status(403).json({
                success: false,
                message: `This server does not relay mail for the domain ${fp.domain}`
            });
        }

        if (hashcash && spamScore < HASHCASH_THRESHOLDS.REJECT) {
            try {
                const hashcashDate = parseHashcashDate(hashcash.split(':')[2]);
                const tokenExpiry = new Date(hashcashDate.getTime() + 24 * 60 * 60 * 1000);
                await markHashcashUsed(hashcash, tokenExpiry);
            } catch (e) {
                console.error(`Failed to log used hashcash token ${hashcash} for /send:`, e);
                // proceed with email sending
            }
        }

        const attachmentKeys = attachments.map(att => att.key).filter(Boolean);

        if (scheduled_at && status === 'scheduled') {
            logEntry = await logEmail(from, fp.domain, to, tp.domain, subject, body, content_type, html_body, status, scheduled_at, reply_to_id, thread_id, expires_at, self_destruct);
            emailId = logEntry[0]?.id;
            if (emailId && attachmentKeys.length > 0) {
                await prisma.attachment.updateMany({
                    where: { key: { in: attachmentKeys } },
                    data: { email_id: emailId, status: status }
                });
            }
            return res.json({ success: true, scheduled: true, id: emailId });
        }

        if (tp.domain === DOMAIN) {
            if (!await verifyUser(tp.username, tp.domain)) {
                return res.status(404).json({ success: false, message: 'Recipient user not found on this server' });
            }
            const finalStatus = status === 'pending' ? 'sent' : status;
            logEntry = await logEmail(from, fp.domain, to, tp.domain, subject, body, content_type, html_body, finalStatus, null, reply_to_id, thread_id, expires_at, self_destruct);
            emailId = logEntry[0]?.id;
            if (emailId && attachmentKeys.length > 0) {
                await prisma.attachment.updateMany({
                    where: { key: { in: attachmentKeys } },
                    data: { email_id: emailId, status: finalStatus }
                });
            }
            return res.json({ success: true, id: emailId });
        }

        logEntry = await logEmail(
            from, fp.domain, to, tp.domain, subject, body,
            content_type, html_body, status, scheduled_at,
            reply_to_id, thread_id, expires_at, self_destruct
        );
        emailId = logEntry[0]?.id;

        if (emailId && attachmentKeys.length > 0) {
            console.log(`[Remote] Linking ${attachmentKeys.length} attachments to email ID ${emailId}:`, attachmentKeys);
            await prisma.attachment.updateMany({
                where: { key: { in: attachmentKeys } },
                data: {
                    email_id: emailId,
                    status: 'sending'
                }
            });
        }

        // don't attempt remote delivery, just store as spam
        if (status === 'spam') {
            if (emailId) {
                await updateEmailStatus(emailId, 'spam');
                if (attachmentKeys.length > 0) {
                    await prisma.attachment.updateMany({
                        where: { email_id: emailId },
                        data: { status: 'spam' }
                    });
                }
            }
            return res.json({ success: true, id: emailId, message: "Email marked as spam due to low PoW or Turnstile policy." });
        }

        // Send to external email servers using SMTP
        try {
            await sendToTraditionalEmail(
                from,
                to,
                subject,
                body,
                html_body || body
            );

            if (emailId) {
                await prisma.email.update({
                    where: { id: emailId },
                    data: { status: 'sent', folder: 'sent', sent_at: new Date() }
                });
                if (attachmentKeys.length > 0) {
                    await prisma.attachment.updateMany({
                        where: { key: { in: attachmentKeys } },
                        data: { status: 'sent' }
                    });
                }
            }
            return res.json({ success: true, id: emailId });
        } catch (e) {
            if (emailId) {
                await prisma.email.update({
                    where: { id: emailId },
                    data: { status: 'failed', error_message: e.message }
                });
                if (attachmentKeys.length > 0) {
                    await prisma.attachment.updateMany({
                        where: { key: { in: attachmentKeys } },
                        data: { status: 'failed' }
                    });
                }
            }
            throw e;
        }
    } catch (e) {
        console.error('Request failed:', e);
        if (emailId) {
            const checkStatus = await prisma.email.findUnique({
                where: { id: emailId },
                select: { status: true }
            });
            if (checkStatus && !['failed', 'rejected', 'spam'].includes(checkStatus.status)) {
                await prisma.email.update({
                    where: { id: emailId },
                    data: { status: 'failed', error_message: e.message }
                });
                const attachmentKeys = req.body.attachments?.map(att => att.key).filter(Boolean) || [];
                if (attachmentKeys.length > 0) {
                    await prisma.attachment.updateMany({
                        where: { email_id: emailId },
                        data: { status: 'failed' }
                    });
                }
            }
        }
        return res.status(400).json({ success: false, message: e.message })
    }
})

app.get('/server/health', (_, res) =>
    res.json({
        status: 'ok',
        protocol: PROTOCOL_VERSION,
        domain: DOMAIN,
        hashcash: {
            minBits: HASHCASH_THRESHOLDS.TRIVIAL,
            recommendedBits: HASHCASH_THRESHOLDS.GOOD
        }
    })
)

app.get('/server/info', (_, res) =>
    res.json({
        status: 'ok',
        name: 'MailForge Server',
        protocol: PROTOCOL_VERSION,
        domain: DOMAIN,
        version: '1.3.0',
        ports: {
            sharp_tcp: MAILFORGE_PORT,
            http_api: HTTP_PORT
        },
        hashcash: {
            algorithm: 'SHA-1',
            minBits: HASHCASH_THRESHOLDS.TRIVIAL,
            recommendedBits: HASHCASH_THRESHOLDS.GOOD,
            weakBits: HASHCASH_THRESHOLDS.WEAK,
            rejectBits: HASHCASH_THRESHOLDS.REJECT
        },
        features: {
            authentication: ['api-key'],
            turnstile: !!process.env.PRIVATE_TURNSTILE_SECRET_KEY && 
                       process.env.PRIVATE_TURNSTILE_SECRET_KEY !== '1x0000000000000000000000000000000AA',
            scheduled_emails: true,
            self_destruct_emails: true,
            attachments: true,
            classification: true
        },
        endpoints: {
            send: {
                method: 'POST',
                path: '/send',
                auth: 'X-API-Key header (APP_SERVER_API_KEY from .env)',
                description: 'Send email with API key authentication'
            },
            health: {
                method: 'GET',
                path: '/server/health',
                auth: 'none',
                description: 'Server health check'
            },
            info: {
                method: 'GET',
                path: '/server/info',
                auth: 'none',
                description: 'Detailed server information and API documentation'
            }
        },
        cors: {
            enabled: true,
            origins: process.env.ALLOWED_ORIGINS || '*'
        },
        usage: {
            example_curl: `curl -X POST http://localhost:${HTTP_PORT}/send \\\n  -H 'X-API-Key: <APP_SERVER_API_KEY from .env>' \\\n  -H 'Content-Type: application/json' \\\n  -d '{\n    "from": "user@${DOMAIN}",\n    "to": "recipient@other.com",\n    "subject": "Test Email",\n    "body": "Hello World",\n    "content_type": "text/plain",\n    "hashcash": "1:18:250208120000:recipient@other.com::xxxx:yyyy"\n  }'`,
            api_key_setup: 'Set APP_SERVER_API_KEY in your .env file'
        }
    })
)

net
    .createServer(socket => {
        const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB total buffer limit
        const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`;
        const state = { step: 'HELLO', buffer: '', hashcash: null };

        socket.on('data', d => {
            if (state.buffer.length + d.length > MAX_BUFFER_SIZE) {
                console.error(`Buffer overflow attempt from ${remoteAddress}`);
                sendError(socket, 'Maximum message size exceeded');
                socket.destroy();
                return;
            }

            state.buffer += d;
            let idx;
            while ((idx = state.buffer.indexOf('\n')) > -1) {
                const line = state.buffer.slice(0, idx).replace(/\r$/, '');
                state.buffer = state.buffer.slice(idx + 1);
                if (line.trim().length > 0) {
                    handleSharpMessage(socket, line, state);
                }
            }
        });

        socket.on('error', (err) => {
            console.error(`Socket error from ${remoteAddress}:`, err);
        });
        socket.on('end', () => {
            console.log(`Connection ended from ${remoteAddress}`);
        });
        socket.on('close', (hadError) => {
            console.log(`Connection closed from ${remoteAddress}. Had error: ${hadError}`);
        });
    })
    .listen(MAILFORGE_PORT, () => {
        console.log(
            `Mail server listening on port ${MAILFORGE_PORT} ` +
            `(HTTP API on ${HTTP_PORT})`
        )
        console.log(`Server address format: user@${DOMAIN}`)
    })

app.listen(HTTP_PORT, () => {
    console.log(`HTTP server listening on port ${HTTP_PORT}`)
})

// Start SMTP server for traditional email clients
if (process.env.ENABLE_SMTP_SERVER !== 'false') {
    createSMTPServer();
}

// Start IMAP server for traditional email clients
if (process.env.ENABLE_IMAP_SERVER !== 'false') {
    createIMAPServer();
}

// Start SMTP bridge for receiving emails from traditional email servers
if (process.env.ENABLE_EMAIL_BRIDGE !== 'false') {
    createBridgeReceiver();
    testEmailSending();
}
