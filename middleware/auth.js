import { PrismaClient } from '@prisma/client';
import { jwtVerify } from 'jose';

export const prisma = new PrismaClient();
const secret = new TextEncoder().encode(process.env.JWT_SECRET);
const alg = 'HS256';

async function verifyTurnstile(token) {
    // Skip Turnstile in standalone/development mode
    if (!process.env.PRIVATE_TURNSTILE_SECRET_KEY || 
        process.env.PRIVATE_TURNSTILE_SECRET_KEY === '1x0000000000000000000000000000000AA') {
        console.log('Turnstile verification skipped (dev/standalone mode)');
        return true;
    }
    
    if (!token) return false;
    
    try {
        const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                secret: process.env.PRIVATE_TURNSTILE_SECRET_KEY,
                response: token
            })
        });
        const data = await response.json();
        return data.success;
    } catch (error) {
        console.error('Turnstile verification error:', error);
        return false;
    }
}

export async function validateAuthToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    const turnstileToken = req.body?.turnstileToken;

    req.turnstileVerified = await verifyTurnstile(turnstileToken);

    if (!token) {
        return res.status(401).json({
            success: false,
            message: 'Authentication required'
        });
    }

    try {
        const { payload } = await jwtVerify(token, secret, {
            algorithms: [alg]
        });

        // Get user by ID from JWT
        const userId = payload.userId || payload.id;
        const user = await prisma.user.findUnique({
            where: { id: String(userId) }
        });

        if (!user || user.is_banned || !user.active) {
            return res.status(403).json({
                success: false,
                message: 'Account not found or banned'
            });
        }

        req.user = user;
        next();
    } catch (error) {
        console.error('Auth error:', error);
        return res.status(401).json({
            success: false,
            message: error.code === 'ERR_JWT_EXPIRED' ? 'Token expired' : 'Invalid token'
        });
    }
}
