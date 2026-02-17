#!/usr/bin/env bun
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { SignJWT } from 'jose';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load environment variables
const envPath = join(__dirname, '.env');
const envContent = readFileSync(envPath, 'utf-8');
const envVars = {};
envContent.split('\n').forEach(line => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        envVars[key] = value;
        process.env[key] = value;
    }
});

const DATABASE_URL = envVars.DATABASE_URL || process.env.DATABASE_URL;
const DOMAIN_NAME = envVars.DOMAIN_NAME || 'localhost';
const JWT_SECRET = new TextEncoder().encode(envVars.JWT_SECRET || process.env.JWT_SECRET);

if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL not found in .env file');
    process.exit(1);
}

if (!JWT_SECRET) {
    console.error('❌ JWT_SECRET not found in .env file');
    process.exit(1);
}

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║           MailForge User Creation Tool                  ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log();

// Get username from command line or prompt
const args = process.argv.slice(2);
const username = args[0] || 'admin';

const prisma = new PrismaClient();

console.log(`👤 Creating user: ${username}@${DOMAIN_NAME}`);
console.log();

async function generateJWT(userId, username, domain) {
    return await new SignJWT({ 
        id: userId,
        userId: userId,
        username: username,
        domain: domain,
        email: `${username}@${domain}`
    })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('365d') // 1 year expiration
    .sign(JWT_SECRET);
}

async function createUser() {
    try {
        // Generate password
        const password = Math.random().toString(36).slice(-12);
        const passwordHash = createHash('sha256').update(password).digest('hex');
        
        // Check if user exists
        const existing = await prisma.user.findFirst({
            where: {
                username: username,
                domain: DOMAIN_NAME
            }
        });
        
        if (existing) {
            console.log('⚠️  User already exists. Generating new JWT token...');
            
            const jwtToken = await generateJWT(existing.id, existing.username, existing.domain);
            
            console.log();
            console.log('✅ JWT Token generated successfully!');
            console.log();
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📧 Email Address:', `${username}@${DOMAIN_NAME}`);
            console.log('👤 User ID:', existing.id);
            console.log('🔑 JWT Token:');
            console.log(jwtToken);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log();
            return;
        }
        
        // Create new user with Prisma
        const user = await prisma.user.create({
            data: {
                username: username,
                domain: DOMAIN_NAME,
                email: `${username}@${DOMAIN_NAME}`,
                password: passwordHash,
                name: username,
                role: 'user',
                active: true,
                is_banned: false,
                is_admin: false,
                settings: {
                    create: {
                        notifications_enabled: true
                    }
                },
                storageLimit: {
                    create: {
                        storage_limit: 1073741824 // 1GB
                    }
                }
            }
        });
        
        // Generate JWT token
        const jwtToken = await generateJWT(user.id, user.username, user.domain);
        
        console.log(`✅ User created with ID: ${user.id}`);
        
        console.log();
        console.log('╔══════════════════════════════════════════════════════════╗');
        console.log('║              User Created Successfully!                  ║');
        console.log('╚══════════════════════════════════════════════════════════╝');
        console.log();
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📧 Email Address:', `${username}@${DOMAIN_NAME}`);
        console.log('👤 User ID:', user.id);
        console.log('🔒 Password (temporary):', password);
        console.log('💾 Storage Limit: 1GB');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log();
        console.log('🔑 JWT Token (valid for 1 year):');
        console.log(jwtToken);
        console.log();
        console.log('⚠️  IMPORTANT: Use this JWT token in your app server and mail server.');
        console.log();
        console.log('📝 Test the API:');
        console.log(`   curl -X POST http://localhost:${envVars.HTTP_PORT || 5501}/send \\`);
        console.log(`     -H 'Authorization: Bearer YOUR_JWT_TOKEN' \\`);
        console.log(`     -H 'Content-Type: application/json' \\`);
        console.log(`     -d '{"from":"${username}@${DOMAIN_NAME}","to":"test@example.com","subject":"Test","body":"Hello"}'`);
        console.log();
        
    } catch (error) {
        console.error('❌ Error creating user:', error.message);
        console.error(error);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

createUser();
