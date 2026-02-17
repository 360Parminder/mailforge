import net from 'net';
import { prisma, findUser } from './lib/prisma.js';
import { createHash } from 'crypto';
const DOMAIN = process.env.DOMAIN_NAME || 'localhost';
const IMAP_PORT = +process.env.IMAP_PORT || 143;

// Simple IMAP server implementation
export function createIMAPServer() {
    const server = net.createServer((socket) => {
        console.log('IMAP: Client connected');
        
        let authenticated = false;
        let user = null;
        let selectedFolder = null;
        let tagCounter = 0;

        // Send greeting
        socket.write('* OK MailForge IMAP Server Ready\r\n');

        socket.on('data', async (data) => {
            const commands = data.toString().split('\r\n').filter(cmd => cmd.trim());
            
            for (const command of commands) {
                await handleIMAPCommand(socket, command, { authenticated, user, selectedFolder });
            }
        });

        socket.on('error', (err) => {
            console.error('IMAP socket error:', err);
        });

        socket.on('end', () => {
            console.log('IMAP: Client disconnected');
        });
    });

    server.listen(IMAP_PORT, () => {
        console.log(`IMAP server listening on port ${IMAP_PORT}`);
    });

    return server;
}

async function handleIMAPCommand(socket, command, state) {
    const parts = command.match(/^(\w+)\s+(\w+)\s*(.*)$/);
    if (!parts) {
        socket.write(`* BAD Invalid command\r\n`);
        return;
    }

    const [, tag, cmd, args] = parts;
    const cmdUpper = cmd.toUpperCase();

    console.log(`IMAP<: ${command}`);

    try {
        switch (cmdUpper) {
            case 'CAPABILITY':
                socket.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n');
                socket.write(`${tag} OK CAPABILITY completed\r\n`);
                break;

            case 'LOGIN':
                const loginMatch = args.match(/"?([^"\s]+)"?\s+"?([^"\s]+)"?/);
                if (!loginMatch) {
                    socket.write(`${tag} NO Invalid login credentials\r\n`);
                    return;
                }
                
                const [, username, password] = loginMatch;
                const authenticatedUser = await authenticateUser(username, password);
                
                if (authenticatedUser) {
                    state.authenticated = true;
                    state.user = authenticatedUser;
                    socket.write(`${tag} OK LOGIN completed\r\n`);
                } else {
                    socket.write(`${tag} NO LOGIN failed\r\n`);
                }
                break;

            case 'LIST':
                if (!state.authenticated) {
                    socket.write(`${tag} NO Not authenticated\r\n`);
                    return;
                }
                socket.write('* LIST () "/" "INBOX"\r\n');
                socket.write('* LIST () "/" "Sent"\r\n');
                socket.write('* LIST () "/" "Drafts"\r\n');
                socket.write('* LIST () "/" "Spam"\r\n');
                socket.write('* LIST () "/" "Starred"\r\n');
                socket.write(`${tag} OK LIST completed\r\n`);
                break;

            case 'SELECT':
            case 'EXAMINE':
                if (!state.authenticated) {
                    socket.write(`${tag} NO Not authenticated\r\n`);
                    return;
                }
                
                const folder = args.replace(/"/g, '').trim();
                state.selectedFolder = folder;
                
                const count = await getEmailCount(state.user, folder);
                socket.write(`* ${count} EXISTS\r\n`);
                socket.write(`* ${count} RECENT\r\n`);
                socket.write('* OK [UIDVALIDITY 1] UIDs valid\r\n');
                socket.write(`* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n`);
                socket.write(`${tag} OK [READ-WRITE] SELECT completed\r\n`);
                break;

            case 'FETCH':
                if (!state.authenticated || !state.selectedFolder) {
                    socket.write(`${tag} NO Not authenticated or no folder selected\r\n`);
                    return;
                }
                
                await fetchEmails(socket, tag, args, state.user, state.selectedFolder);
                break;

            case 'LOGOUT':
                socket.write('* BYE IMAP4rev1 Server logging out\r\n');
                socket.write(`${tag} OK LOGOUT completed\r\n`);
                socket.end();
                break;

            case 'NOOP':
                socket.write(`${tag} OK NOOP completed\r\n`);
                break;

            default:
                socket.write(`${tag} BAD Command not recognized\r\n`);
        }
    } catch (error) {
        console.error('IMAP command error:', error);
        socket.write(`${tag} NO Command failed: ${error.message}\r\n`);
    }
}

async function authenticateUser(username, password) {
    try {
        // Try API key
        const apiKeyUser = await prisma.user.findFirst({
            where: {
                api_key: password,
                is_banned: false
            },
            select: {
                id: true,
                username: true,
                domain: true,
                is_banned: true
            }
        });
        
        if (apiKeyUser) {
            return apiKeyUser;
        }

        // Try username@domain
        let user, domain;
        if (username.includes('@')) {
            [user, domain] = username.split('@');
        } else {
            user = username;
            domain = DOMAIN;
        }

        const passwordHash = createHash('sha256').update(password).digest('hex');

        const authenticatedUser = await prisma.user.findFirst({
            where: {
                username: user,
                domain: domain,
                password: passwordHash,
                is_banned: false
            },
            select: {
                id: true,
                username: true,
                domain: true,
                is_banned: true
            }
        });

        return authenticatedUser || null;
    } catch (error) {
        console.error('IMAP authentication error:', error);
        return null;
    }
}

async function getEmailCount(user, folder) {
    const address = `${user.username}@${user.domain}`;
    
    let count = 0;
    switch (folder.toUpperCase()) {
        case 'INBOX':
            count = await prisma.email.count({
                where: {
                    to_address: address,
                    status: { notIn: ['spam', 'scheduled'] }
                }
            });
            break;
        case 'SENT':
            count = await prisma.email.count({
                where: {
                    from_address: address,
                    status: 'sent'
                }
            });
            break;
        case 'DRAFTS':
            count = await prisma.emailDraft.count({
                where: { user_id: user.id }
            });
            break;
        case 'SPAM':
            count = await prisma.email.count({
                where: {
                    to_address: address,
                    status: 'spam'
                }
            });
            break;
        case 'STARRED':
            count = await prisma.emailStar.count({
                where: { user_id: user.id }
            });
            break;
        default:
            count = 0;
    }
    
    return count;
}

async function fetchEmails(socket, tag, args, user, folder) {
    const address = `${user.username}@${user.domain}`;
    
    // Parse FETCH command (simplified)
    const rangeMatch = args.match(/^(\d+):(\*|\d+)/);
    if (!rangeMatch) {
        socket.write(`${tag} BAD Invalid FETCH range\r\n`);
        return;
    }

    let emails;
    switch (folder.toUpperCase()) {
        case 'INBOX':
            emails = await prisma.email.findMany({
                where: {
                    to_address: address,
                    status: { notIn: ['spam', 'scheduled'] }
                },
                orderBy: { sent_at: 'desc' },
                take: 50
            });
            break;
        case 'SENT':
            emails = await prisma.email.findMany({
                where: {
                    from_address: address,
                    status: 'sent'
                },
                orderBy: { sent_at: 'desc' },
                take: 50
            });
            break;
        default:
            emails = [];
    }

    for (let i = 0; i < emails.length; i++) {
        const email = emails[i];
        const seqNum = i + 1;
        
        // Simple FETCH response with envelope and body structure
        const date = new Date(email.sent_at).toUTCString();
        const size = (email.body || '').length + (email.html_body || '').length;
        
        socket.write(`* ${seqNum} FETCH (UID ${email.id} RFC822.SIZE ${size} ENVELOPE ("${date}" "${email.subject}" ((NIL NIL "${email.from_address.split('@')[0]}" "${email.from_address.split('@')[1]}")) ((NIL NIL "${email.from_address.split('@')[0]}" "${email.from_address.split('@')[1]}")) ((NIL NIL "${email.to_address.split('@')[0]}" "${email.to_address.split('@')[1]}")) ((NIL NIL "${email.to_address.split('@')[0]}" "${email.to_address.split('@')[1]}")) NIL NIL NIL NIL))\r\n`);
    }

    socket.write(`${tag} OK FETCH completed\r\n`);
}
