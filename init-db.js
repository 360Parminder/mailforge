#!/usr/bin/env bun
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function initializeDatabase() {
    try {
        console.log('🔍 Verifying database connection...');
        
        // Check tables using Prisma's raw query
        const tables = await prisma.$queryRaw`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
            ORDER BY table_name
        `;
        
        console.log('\n📋 Database tables:');
        tables.forEach(t => console.log(`  - ${t.table_name}`));
        
        console.log('\n✅ Database connection verified!');
        console.log('\n📝 Note: Database schema is managed by Prisma migrations from your app server');
        console.log('\n📝 Next steps:');
        console.log('1. Ensure Prisma migrations are applied on app server');
        console.log('2. Create a user account: bun run create-user.js');
        console.log('3. Start the server: bun main.js');
        
    } catch (error) {
        console.error('❌ Error initializing database:', error.message);
        console.error(error);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

initializeDatabase();
