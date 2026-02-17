import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// API key from environment variable for app server authentication
const APP_SERVER_API_KEY = process.env.APP_SERVER_API_KEY;

/**
 * Middleware to validate API key authentication
 * This allows the app server to authenticate with MailForge server
 * using a shared API key from environment variables
 */
export async function validateApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    
    console.log('🔑 API Auth - Received headers:', {
        'x-api-key': req.headers['x-api-key'] ? 'present' : 'missing',
        'authorization': req.headers['authorization'] ? 'present' : 'missing'
    });
    
    if (!apiKey) {
        return res.status(401).json({
            success: false,
            message: 'API key required. Include X-API-Key or Authorization header.'
        });
    }

    // Check if APP_SERVER_API_KEY is configured
    if (!APP_SERVER_API_KEY) {
        console.error('❌ APP_SERVER_API_KEY is not configured in environment variables');
        return res.status(500).json({
            success: false,
            message: 'Server configuration error: API key not configured'
        });
    }

    // Verify API key matches
    if (apiKey !== APP_SERVER_API_KEY) {
        console.log('❌ Invalid API key provided');
        return res.status(401).json({
            success: false,
            message: 'Invalid API key'
        });
    }

    console.log('✅ API key verified successfully');

    // Get user from request body (from address)
    try {
        const fromAddress = req.body?.from;
        if (!fromAddress) {
            return res.status(400).json({
                success: false,
                message: 'Missing "from" address in request body'
            });
        }

        // Parse the from address to get username and domain
        const match = fromAddress.match(/^(.+)@([^:]+)(?::(\d+))?$/);
        if (!match) {
            return res.status(400).json({
                success: false,
                message: 'Invalid "from" address format'
            });
        }

        const username = match[1].toLowerCase();
        const domain = match[2].toLowerCase();

        // Find user in database
        const user = await prisma.user.findFirst({
            where: {
                username: username,
                domain: domain
            }
        });

        if (!user) {
            console.log('❌ User not found:', username, '@', domain);
            return res.status(401).json({
                success: false,
                message: 'User not found'
            });
        }

        console.log('✅ User found:', user.username, 'active:', user.active, 'banned:', user.is_banned);

        if (user.is_banned || !user.active) {
            return res.status(403).json({
                success: false,
                message: 'User account is inactive or banned'
            });
        }

        req.user = user;
        req.turnstileVerified = true; // Skip Turnstile for API key auth
        console.log('✅ Authentication successful for user:', user.username);
        next();
    } catch (error) {
        console.error('❌ API Auth error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Authentication error',
            error: error.message
        });
    }
}
