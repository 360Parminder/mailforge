import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

// User operations
export async function findUser(username, domain) {
    return await prisma.user.findFirst({
        where: { username, domain }
    });
}

export async function verifyUser(username, domain) {
    const user = await findUser(username, domain);
    return user !== null;
}

export async function createUser(data) {
    return await prisma.user.create({
        data: {
            username: data.username,
            domain: data.domain,
            email: data.email || `${data.username}@${data.domain}`,
            password: data.password_hash,
            name: data.name || data.username,
            is_banned: data.is_banned || false,
            is_admin: data.is_admin || false,
            ip: data.ip,
            user_agent: data.user_agent
        }
    });
}

// Email operations
export async function createEmail(emailData) {
    console.log('Creating email with data:', emailData);
    const data = {
        from_address: emailData.from_address,
        from_domain: emailData.from_domain,
        to_address: emailData.to_address,
        to_domain: emailData.to_domain,
        subject: emailData.subject,
        body: emailData.body,
        text: emailData.body,
        html: emailData.html_body,
        html_body: emailData.html_body,
        content_type: emailData.content_type || 'text/plain',
        status: emailData.status || 'pending',
        classification: emailData.classification || 'primary',
        scheduled_at: emailData.scheduled_at,
        expires_at: emailData.expires_at,
        self_destruct: emailData.self_destruct || false,
        sent_at: emailData.sent_at || new Date(),
        user: emailData.user || emailData.user_id,
        folder: emailData.folder || 'inbox',
        error_message: emailData.error_message
    };

    // Add optional relation fields only if provided
    if (emailData.reply_to_id) {
        data.reply_to_id = emailData.reply_to_id;
    }
    
    if (emailData.thread_id || emailData.thread_id_ref) {
        data.thread_id_ref = emailData.thread_id || emailData.thread_id_ref;
    }
    
    if (emailData.from_user_id) {
        data.from_user_id = emailData.from_user_id;
    }

    return await prisma.email.create({ data });
}

export async function updateEmailStatus(emailId, status, errorMessage = null) {
    return await prisma.email.update({
        where: { id: emailId },
        data: {
            status,
            error_message: errorMessage,
            sent_at: status === 'sent' ? new Date() : undefined
        }
    });
}

export async function getEmailById(id) {
    return await prisma.email.findUnique({
        where: { id }
    });
}

export async function getEmailsByUser(username, domain, folder = null) {
    const user = await findUser(username, domain);
    if (!user) return [];

    const whereClause = {
        OR: [
            { from_address: `${username}@${domain}` },
            { to_address: `${username}@${domain}` }
        ]
    };

    if (folder) {
        whereClause.folder = folder;
    }

    return await prisma.email.findMany({
        where: whereClause,
        orderBy: { sent_at: 'desc' }
    });
}

export async function getScheduledEmails() {
    return await prisma.email.findMany({
        where: {
            status: 'scheduled',
            scheduled_at: {
                lte: new Date()
            }
        },
        orderBy: { scheduled_at: 'asc' },
        take: 10
    });
}

// Star operations
export async function toggleStar(emailId, userId) {
    const existing = await prisma.emailStar.findUnique({
        where: {
            email_id_user_id: {
                email_id: emailId,
                user_id: userId
            }
        }
    });

    if (existing) {
        await prisma.emailStar.delete({
            where: {
                email_id_user_id: {
                    email_id: emailId,
                    user_id: userId
                }
            }
        });
        return false;
    } else {
        await prisma.emailStar.create({
            data: {
                email_id: emailId,
                user_id: userId
            }
        });
        return true;
    }
}

export async function getStarredEmails(userId) {
    return await prisma.emailStar.findMany({
        where: { user_id: userId },
        include: { email: true }
    });
}

// Draft operations
export async function createDraft(userId, draftData) {
    return await prisma.emailDraft.create({
        data: {
            user_id: userId,
            to_address: draftData.to_address,
            subject: draftData.subject,
            body: draftData.body,
            content_type: draftData.content_type || 'text/plain',
            html_body: draftData.html_body
        }
    });
}

export async function updateDraft(draftId, draftData) {
    return await prisma.emailDraft.update({
        where: { id: draftId },
        data: {
            to_address: draftData.to_address,
            subject: draftData.subject,
            body: draftData.body,
            content_type: draftData.content_type,
            html_body: draftData.html_body,
            updated_at: new Date()
        }
    });
}

export async function getDrafts(userId) {
    return await prisma.emailDraft.findMany({
        where: { user_id: userId },
        orderBy: { updated_at: 'desc' }
    });
}

export async function deleteDraft(draftId) {
    return await prisma.emailDraft.delete({
        where: { id: draftId }
    });
}

// Contact operations
export async function createContact(userId, contactData) {
    return await prisma.contact.create({
        data: {
            user_id: userId,
            full_name: contactData.full_name,
            email_address: contactData.email_address,
            tag: contactData.tag
        }
    });
}

export async function getContacts(userId) {
    return await prisma.contact.findMany({
        where: { user_id: userId },
        orderBy: { full_name: 'asc' }
    });
}

export async function deleteContact(contactId) {
    return await prisma.contact.delete({
        where: { id: contactId }
    });
}

// Hashcash token operations
export async function isHashcashUsed(token) {
    const used = await prisma.usedHashcashToken.findUnique({
        where: { token }
    });
    return used !== null;
}

export async function markHashcashUsed(token, expiresAt) {
    return await prisma.usedHashcashToken.create({
        data: {
            token,
            expires_at: expiresAt
        }
    });
}

export async function cleanupExpiredHashcash() {
    return await prisma.usedHashcashToken.deleteMany({
        where: {
            expires_at: {
                lt: new Date()
            }
        }
    });
}

// Attachment operations
export async function createAttachment(attachmentData) {
    return await prisma.attachment.create({
        data: {
            user_id: attachmentData.user_id,
            key: attachmentData.key,
            filename: attachmentData.filename,
            size: attachmentData.size,
            type: attachmentData.type,
            expires_at: attachmentData.expires_at,
            email_id: attachmentData.email_id,
            status: attachmentData.status || 'pending'
        }
    });
}

export async function updateAttachmentStatus(key, status, emailId = null) {
    return await prisma.attachment.update({
        where: { key },
        data: {
            status,
            email_id: emailId
        }
    });
}

export async function updateAttachmentsByEmailId(emailId, status) {
    return await prisma.attachment.updateMany({
        where: { email_id: emailId },
        data: { status }
    });
}

export async function getUserStorage(userId) {
    const result = await prisma.attachment.aggregate({
        where: {
            user_id: userId,
            status: { not: 'failed' }
        },
        _sum: {
            size: true
        }
    });
    return result._sum.size || 0;
}

export async function getUserStorageLimit(userId) {
    const limit = await prisma.userStorageLimit.findUnique({
        where: { user_id: userId }
    });
    return limit?.storage_limit || 1073741824; // 1GB default
}

// Cleanup operations
export async function cleanupPendingEmails() {
    const thirtySecondsAgo = new Date(Date.now() - 30000);
    
    return await prisma.email.updateMany({
        where: {
            status: 'pending',
            sent_at: {
                lt: thirtySecondsAgo
            }
        },
        data: {
            status: 'failed',
            error_message: 'Timed out while pending'
        }
    });
}
