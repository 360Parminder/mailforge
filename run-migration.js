#!/usr/bin/env node
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const prisma = new PrismaClient();

async function runMigration() {
    try {
        console.log('Running add-api-keys migration...');
        
        const migrationPath = join(__dirname, 'database/migrations/add-api-keys.sql');
        const migrationSQL = readFileSync(migrationPath, 'utf-8');
        
        // Execute the migration using Prisma
        await prisma.$executeRawUnsafe(migrationSQL);
        
        console.log('✅ Migration completed successfully!');
        console.log('API key column added to users table');
        
        await prisma.$disconnect();
        process.exit(0);
    } catch (error) {
        console.error('❌ Migration failed:', error);
        await prisma.$disconnect();
        process.exit(1);
    }
}

runMigration();
