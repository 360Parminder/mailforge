# SHARP Standalone - Quick Reference

## 🚀 One-Command Setup

```bash
cd SHARP && bash setup-standalone.sh
```

## 🔑 Generate API Key

```sql
psql $DATABASE_URL
SELECT generate_api_key(1);  -- Returns: a1b2c3d4e5f6...
```

## 📡 API Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /send` | API Key | Send email ⭐ |
| `POST /send/jwt` | JWT | Send (website) |
| `GET /server/info` | None | API docs |
| `GET /server/health` | None | Health check |

## 💻 Send Email

```bash
curl -X POST http://localhost:5001/send \
  -H 'X-API-Key: YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "from": "user#yourdomain.com",
    "to": "recipient#other.com",
    "subject": "Hello",
    "body": "Test message",
    "hashcash": "1:18:250208120000:recipient#other.com::xxxx:yyyy"
  }'
```

## ⚙️ Environment Variables

```env
DOMAIN_NAME=yourdomain.com
DATABASE_URL=postgres://user:pass@host:5432/db
SHARP_PORT=5000
HTTP_PORT=5001
ALLOWED_ORIGINS=*
```

## 🌐 Frontend Example

```javascript
const response = await fetch('http://localhost:5001/send', {
  method: 'POST',
  headers: {
    'X-API-Key': 'your-api-key',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    from: 'user#domain.com',
    to: 'recipient#other.com',
    subject: 'Test',
    body: 'Hello World',
    hashcash: generateHashcash('recipient#other.com')
  })
});
```

## 📋 Create User

```sql
INSERT INTO users (username, domain, password_hash, iq)
VALUES ('myuser', 'yourdomain.com', 'hash', 100);

SELECT generate_api_key(currval('users_id_seq'));
```

## 🔒 Security Checklist

- [ ] Set specific ALLOWED_ORIGINS (not *)
- [ ] Use HTTPS in production
- [ ] Secure API keys (don't commit)
- [ ] Configure firewall
- [ ] Enable Turnstile (optional)
- [ ] Add rate limiting (optional)

## 📚 Docs

- **Full Guide:** [STANDALONE.md](STANDALONE.md)
- **Changes:** [CHANGES.md](CHANGES.md)
- **Protocol:** [README.md](README.md)

## 🐛 Troubleshooting

**CORS Error?** → Add frontend URL to ALLOWED_ORIGINS
**Auth Failed?** → Check API key with `SELECT * FROM users WHERE api_key='...'`
**DB Error?** → Verify DATABASE_URL in .env
**Port Taken?** → Change SHARP_PORT/HTTP_PORT

## 🎯 What You Get

✅ Independent SHARP server  
✅ API key authentication  
✅ Any frontend framework  
✅ Full email protocol  
✅ Spam prevention  
✅ Scheduled emails  
✅ Attachments support  
✅ Auto-classification  

---

**Ready to use SHARP with your own frontend!** 🎉
