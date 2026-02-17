#!/bin/bash

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║         SHARP Standalone Server Setup                         ║"
echo "║  Self-Hosted Address Routing Protocol - Independent Mode      ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

echo "📋 Step 1: Database Initialization"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ ! -f ".env" ]; then
    echo "Running database initialization script..."
    bash database/init.sh
    echo
else
    echo "⚠️  .env file already exists. Skipping database init."
    echo "   To reconfigure, delete .env and run this script again."
    echo
fi

echo "📋 Step 2: Installing Dependencies"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if command -v bun &> /dev/null; then
    echo "Using Bun package manager..."
    bun install
elif command -v npm &> /dev/null; then
    echo "Using npm package manager..."
    npm install
else
    echo "❌ Error: Neither bun nor npm found. Please install Node.js or Bun."
    exit 1
fi
echo

echo "📋 Step 3: Setting Up API Key Support"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Load DATABASE_URL from .env
if [ -f ".env" ]; then
    export $(cat .env | grep -v '^#' | xargs)
fi

if [ -z "$DATABASE_URL" ]; then
    echo "❌ Error: DATABASE_URL not found in .env file"
    exit 1
fi

echo "Applying API key migration..."
psql "$DATABASE_URL" -f database/migrations/add-api-keys.sql 2>/dev/null
if [ $? -eq 0 ]; then
    echo "✅ API key support added successfully"
else
    echo "⚠️  Migration may have already been applied or database is not accessible"
    echo "   You can manually run: psql \$DATABASE_URL -f database/migrations/add-api-keys.sql"
fi
echo

echo "📋 Step 4: Configuration"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Update .env with standalone-specific settings
if ! grep -q "ALLOWED_ORIGINS" .env; then
    echo "" >> .env
    echo "# CORS Configuration - comma-separated origins (* for all)" >> .env
    echo "ALLOWED_ORIGINS=*" >> .env
fi

if ! grep -q "API_MODE" .env; then
    echo "" >> .env
    echo "# API Mode - set to 'true' for standalone operation" >> .env
    echo "API_MODE=true" >> .env
fi

echo "✅ Configuration updated in .env"
echo

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                    🎉 Setup Complete!                          ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo
echo "📝 Next Steps:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo
echo "1️⃣  Review and update SHARP/.env:"
echo "   • DOMAIN_NAME: Your domain (e.g., yourdomain.com)"
echo "   • DATABASE_URL: PostgreSQL connection string"
echo "   • ALLOWED_ORIGINS: Comma-separated frontend URLs or * for all"
echo "   • JWT_SECRET: Optional, only needed if using Twoblade website"
echo
echo "2️⃣  Start the SHARP server:"
if command -v bun &> /dev/null; then
    echo "   cd $SCRIPT_DIR"
    echo "   bun run main.js"
else
    echo "   cd $SCRIPT_DIR"
    echo "   node main.js"
fi
echo
echo "3️⃣  Create user accounts and generate API keys:"
echo "   Connect to your database and run:"
echo "   psql \$DATABASE_URL"
echo
echo "   -- Create a user account"
echo "   INSERT INTO users (username, domain, password_hash, iq)"
echo "   VALUES ('myuser', 'yourdomain.com', 'hash', 100);"
echo
echo "   -- Generate API key for the user"
echo "   SELECT generate_api_key(1);  -- Replace 1 with actual user ID"
echo
echo "4️⃣  Configure DNS (for production):"
echo "   Add SRV record to your DNS:"
echo "   _sharp._tcp.yourdomain.com. 86400 IN SRV 10 0 5000 yourdomain.com."
echo
echo "5️⃣  Test the API:"
echo "   curl http://localhost:5001/server/info"
echo
echo "📚 API Documentation:"
echo "   Once running, visit: http://localhost:5001/server/info"
echo "   For detailed API usage and examples"
echo
echo "🔑 API Key Usage Example:"
echo "   curl -X POST http://localhost:5001/send \\"
echo "     -H 'X-API-Key: your-api-key-here' \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{"
echo "       \"from\": \"user#yourdomain.com\","
echo "       \"to\": \"recipient#other.com\","
echo "       \"subject\": \"Test Email\","
echo "       \"body\": \"Hello World\","
echo "       \"hashcash\": \"1:18:250208120000:recipient#other.com::xxxx:yyyy\""
echo "     }'"
echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "For support, visit: https://github.com/twoblade/twoblade"
echo
