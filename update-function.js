#!/usr/bin/env bun
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

console.log('🔑 Updating API key generation function...');

try {
    // Just update the function
    await prisma.$executeRaw`
        CREATE OR REPLACE FUNCTION generate_api_key(user_id INTEGER) 
        RETURNS VARCHAR(64) AS $$
        DECLARE
            new_key VARCHAR(64);
        BEGIN
            new_key := md5(random()::text || clock_timestamp()::text || user_id::text) || 
                       md5(random()::text || clock_timestamp()::text || user_id::text);
            UPDATE users SET api_key = new_key WHERE id = user_id;
            RETURN new_key;
        END;
        $$ LANGUAGE plpgsql;
    `;
    
    console.log('✅ Function updated successfully');
    await prisma.$disconnect();
} catch (e) {
    console.error('Error:', e.message);
    await prisma.$disconnect();
    process.exit(1);
}
