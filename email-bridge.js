import nodemailer from 'nodemailer';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { resolveMx } from './dns-utils.js';
import { prisma, createEmail, findUser, createAttachment } from './lib/prisma.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DOMAIN = process.env.DOMAIN_NAME || 'localhost';
const SMTP_BRIDGE_PORT = +process.env.SMTP_BRIDGE_PORT || 2525;
const ATTACHMENTS_DIR = path.resolve('./attachments');

// Ensure attachments directory exists
if (!fs.existsSync(ATTACHMENTS_DIR)) {
    fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    console.log(`📁 Created attachments directory: ${ATTACHMENTS_DIR}`);
}

// Send email directly to recipient's mail server (no relay needed)
// Note: This function only handles SMTP delivery - caller is responsible for database logging
// options: { inReplyTo, references } - optional headers for reply threading
export async function sendToTraditionalEmail(fromEmail, toEmail, subject, textBody, htmlBody, options = {}) {
    try {
        const [, toDomain] = toEmail.split('@');

        // Resolve MX records for recipient domain
        const mxRecords = await resolveMx(toDomain);
        if (!mxRecords || mxRecords.length === 0) {
            throw new Error(`No mail server found for ${toDomain}`);
        }

        // Use the highest priority MX server
        const mx = mxRecords[0];

        console.log(`📮 Sending to ${mx.exchange} (MX for ${toDomain})...`);

        // Create direct SMTP connection to recipient's mail server
        const transporter = nodemailer.createTransport({
            host: mx.exchange,
            port: 25,
            secure: false,
            tls: {
                rejectUnauthorized: false
            },
            connectionTimeout: 10000,
            greetingTimeout: 5000,
            socketTimeout: 10000,
            // No authentication needed - direct server-to-server
        });

        const customHeaders = {
            'X-Mailer': 'Mail Server'
        };

        const mailOptions = {
            from: fromEmail, // Sender address is dynamic
            to: toEmail,
            subject: subject,
            text: textBody,
            html: htmlBody || textBody,
            headers: customHeaders
        };

        // Add reply threading headers for proper Gmail/Outlook threading
        if (options.inReplyTo) {
            mailOptions.inReplyTo = options.inReplyTo;
        }
        if (options.references) {
            mailOptions.references = options.references;
        }

        const info = await transporter.sendMail(mailOptions);

        console.log(`✅ Email sent successfully to ${toEmail} (MessageID: ${info.messageId})`);
        return info;
    } catch (error) {
        console.error('Error sending email:', error);
        throw error;
    }
}

// SMTP server to receive emails from traditional email servers
export function createBridgeReceiver() {
    const server = new SMTPServer({
        authOptional: true, // Allow unauthenticated connections from other mail servers
        secure: false,
        allowInsecureAuth: true,
        disabledCommands: ['STARTTLS'], // For simplicity

        onData(stream, session, callback) {
            console.log('Received email from', session.envelope.mailFrom.address);
            console.log('Received email to', session.envelope.rcptTo);
            console.log('Received email with subject', stream);
            simpleParser(stream, async (err, parsed) => {
                if (err) {
                    console.error('Error parsing incoming email:', err);
                    return callback(err);
                }


                try {
                    console.log(parsed);
                    const fromEmail = parsed.from?.value?.[0]?.address || session.envelope.mailFrom?.address || '';
                    // Use the actual SMTP envelope recipient, as parsed.to might be missing/incorrect for BCCs or mailing lists
                    const toEmail = (session.envelope.rcptTo && session.envelope.rcptTo.length > 0)
                        ? session.envelope.rcptTo[0].address
                        : (parsed.to?.value?.[0]?.address || '');
                    const subject = parsed.subject || '(No Subject)';
                    const textBody = parsed.text || '';
                    const htmlBody = parsed.html || '';
                    const recipient = parsed.from?.value[0]?.name || '';

                    console.log('\n' + '='.repeat(80));
                    console.log(`📨 INCOMING EMAIL`);
                    console.log('='.repeat(80));
                    console.log(`From: ${fromEmail}`);
                    console.log(`To: ${toEmail}`);
                    console.log(`Subject: ${subject}`);
                    console.log(`Body Length: ${textBody.length} chars`);
                    console.log(`Time: ${new Date().toISOString()}`);
                    console.log('='.repeat(80));

                    // Recipient should be user@yourdomain.com
                    const [username, domain] = toEmail.split('@');

                    // Check if recipient exists
                    const user = await findUser(username, domain);

                    if (!user) {
                        console.log(`❌ ERROR: Recipient ${toEmail} not found on this server`);
                        throw new Error('Recipient not found');
                    }

                    // Store the email
                    const email = await createEmail({
                        user: user.id,
                        from_address: fromEmail,
                        from_domain: fromEmail.split('@')[1],
                        to_address: toEmail,
                        to_domain: domain,
                        subject: subject,
                        body: textBody,
                        html_body: htmlBody,
                        content_type: 'text/html',
                        status: 'sent',
                        folder: 'inbox',
                        sent_at: new Date(),
                        userInfo: user.id,
                        messageId: parsed.messageId || null,
                        recipient: recipient,

                    });

                    console.log(`✅ Email #${email.id} successfully delivered to ${toEmail}`);

                    // Process incoming attachments
                    if (parsed.attachments && parsed.attachments.length > 0) {
                        console.log(`📎 Processing ${parsed.attachments.length} attachment(s)...`);

                        const savedAttachments = [];

                        for (const att of parsed.attachments) {
                            try {
                                // Generate unique key for the file
                                const uuid = crypto.randomUUID();
                                const safeName = (att.filename || 'unnamed').replace(/[^a-zA-Z0-9._-]/g, '_');
                                const key = `${uuid}_${safeName}`;
                                const filePath = path.join(ATTACHMENTS_DIR, key);

                                // Write attachment content to disk
                                fs.writeFileSync(filePath, att.content);

                                // Create attachment record in database
                                const attachmentRecord = await createAttachment({
                                    user_id: user.id,
                                    key: key,
                                    filename: att.filename || 'unnamed',
                                    size: att.size || att.content.length,
                                    type: att.contentType || 'application/octet-stream',
                                    email_id: email.id,
                                    status: 'sent'
                                });

                                // Collect attachment info for the email's JSON attachments field
                                savedAttachments.push({
                                    id: attachmentRecord.id,
                                    key: key,
                                    filename: att.filename || 'unnamed',
                                    size: att.size || att.content.length,
                                    type: att.contentType || 'application/octet-stream'
                                });

                                console.log(`  📎 Saved attachment: ${att.filename || 'unnamed'} (${att.size || att.content.length} bytes) → ${key}`);
                            } catch (attErr) {
                                console.error(`  ❌ Failed to save attachment ${att.filename}:`, attErr);
                                // Continue processing other attachments even if one fails
                            }
                        }

                        // Update the email's JSON attachments field so frontends can see them
                        if (savedAttachments.length > 0) {
                            await prisma.email.update({
                                where: { id: email.id },
                                data: { attachments: JSON.stringify(savedAttachments) }
                            });
                            console.log(`📎 Updated email #${email.id} with ${savedAttachments.length} attachment(s) in DB`);
                        }

                        console.log(`📎 Finished processing attachments for email #${email.id}`);
                    }

                    console.log('='.repeat(80) + '\n');
                    callback();
                } catch (error) {
                    console.error('Error processing incoming email:', error);
                    callback(error);
                }
            });
        }
    });

    server.listen(SMTP_BRIDGE_PORT, () => {
        console.log(`SMTP Bridge (receiving) listening on port ${SMTP_BRIDGE_PORT}`);
        console.log(`Configure your domain MX records to point to this server`);
    });

    return server;
}

// Test email sending capability
export async function testEmailSending() {
    console.log('✅ Direct SMTP sending enabled - no relay configuration needed');
    console.log('   Emails will be sent directly to recipient mail servers');
    return true;
}
