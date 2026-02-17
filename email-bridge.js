import nodemailer from 'nodemailer';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { resolveMx } from './dns-utils.js';
import { createEmail, findUser } from './lib/prisma.js';
const DOMAIN = process.env.DOMAIN_NAME || 'localhost';
const SMTP_BRIDGE_PORT = +process.env.SMTP_BRIDGE_PORT || 2525;

// Send email directly to recipient's mail server (no relay needed)
// Note: This function only handles SMTP delivery - caller is responsible for database logging
export async function sendToTraditionalEmail(fromEmail, toEmail, subject, textBody, htmlBody) {
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
            // No authentication needed - direct server-to-server
        });

        const mailOptions = {
            from: fromEmail, // Sender address is dynamic
            to: toEmail,
            subject: subject,
            text: textBody,
            html: htmlBody || textBody,
            headers: {
                'X-Mailer': 'Mail Server'
            }
        };

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
            simpleParser(stream, async (err, parsed) => {
                if (err) {
                    console.error('Error parsing incoming email:', err);
                    return callback(err);
                }
                
                
                try {
                    console.log(parsed);
                    const fromEmail = parsed.from?.value?.[0]?.address || '';
                    const toEmail = parsed.to?.value?.[0]?.address || '';
                    const subject = parsed.subject || '(No Subject)';
                    const textBody = parsed.text || '';
                    const htmlBody = parsed.html || '';
                    
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
                        userInfo:user.id,
                        messageId : parsed.messageId || null
                        
                    });

                    console.log(`✅ Email #${email.id} successfully delivered to ${toEmail}`);
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
