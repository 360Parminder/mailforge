# SHARP (Self-Hosted Address Routing Protocol) Server

This server implements the SHARP protocol, a decentralized email system that uses `#` symbols for addressing (e.g., `user#domain.com`).

You can find instructions for running this server in the [main README.md file](../README.md).

## Protocol Details

* **Version:** SHARP/1.3
* **Transport:** TCP with JSON messages
* **Default Ports:** 5000 (SHARP TCP), 5001 (HTTP API)

### Message Exchange Flow

1. **Connection Establishment (HELLO)**
   ```jsonc
   // Client -> Server
   { 
     "type": "HELLO", 
     "server_id": "sender#domain.com", 
     "protocol": "SHARP/1.3" 
   }
   // Server -> Client (Success)
   { "type": "OK", "protocol": "SHARP/1.3" }
   // Server -> Client (Error - Protocol Mismatch)
   { "type": "ERROR", "message": "Unsupported protocol version", "code": 400 }
   ```

2. **Mail Delivery (MAIL_TO)**
   ```jsonc
   // Client -> Server
   { 
     "type": "MAIL_TO", 
     "address": "recipient#domain.com",
     "hashcash": "1:18:230701100000:recipient#domain.com::xxxx:yyyy"
   }
   // Server -> Client (Success)
   { "type": "OK" }
   // Server -> Client (Error - Missing/Invalid Hashcash)
   { "type": "ERROR", "message": "Insufficient proof of work", "code": 429 }
   // Server -> Client (Error - Unknown Recipient)
   { "type": "ERROR", "message": "Recipient user not found", "code": 550 }
   ```

3. **Content Transfer (DATA & EMAIL_CONTENT)**
   ```jsonc
   // Client -> Server
   { "type": "DATA" }
   // Server -> Client
   { "type": "OK" }
   // Client -> Server
   {
     "type": "EMAIL_CONTENT",
     "subject": "Subject line",
     "body": "Message body",
     "content_type": "text/plain",
     "html_body": null,
     "attachments": ["key1", "key2"]
   }
   // Server -> Client
   { "type": "OK", "message": "Email content received" }
   // Client -> Server
   { "type": "END_DATA" }
   // Server -> Client (Success)
   { "type": "OK", "message": "Email processed" }
   // Server -> Client (Error - Processing Failed)
   { "type": "ERROR", "message": "Email processing failed", "code": 500 }
   ```

### Error Codes

SHARP uses HTTP-like status codes for errors:

* **400 Bad Request**
  - Invalid JSON format
  - Expected different command type
  - Invalid address format
  - Invalid username format
  - Message too large (>1MB per message)

* **413 Payload Too Large**
  - Total buffer overflow (>10MB)
  - Attachment too large

* **429 Too Many Requests**
  - Missing Hashcash token
  - Invalid/reused Hashcash token
  - Insufficient proof-of-work bits
  - Token date too far in future
  - Token expired

* **451 Unavailable For Legal Reasons**
  - Server doesn't handle mail for recipient domain

* **500 Internal Server Error**
  - Email processing failed
  - Database errors

* **550 Mailbox Unavailable**
  - Recipient user not found
  - Invalid recipient

### Anti-Spam Features

* **Hashcash Proof-of-Work**
  * Minimum bits: 5
  * Recommended bits: 18
  * Weak threshold: 10

* **IQ-based Word Length Limits**
  * IQ < 90: 3 characters
  * IQ < 100: 4 characters
  * IQ < 120: 5 characters
  * IQ < 130: 6 characters
  * IQ < 140: 7 characters
  * IQ ≥ 140: No limit

### Message Classification

Messages are automatically classified into categories:
* Primary
* Promotions
* Social
* Forums
* Updates

## Key Features

*   **Decentralized Addressing:** Uses `#` symbol for addressing, allowing users to have addresses tied to their own domains.
*   **Self-Hosting:** Allows users to host their own email servers and control their data.

## SHARP Addresses

SHARP uses addresses in the format `user#domain.com`.

*   `user` is the username of the recipient.
*   `domain.com` is the domain name of the SHARP server.

## Configuration

Besides configuration available through the `.env` file, some core protocol and behavior settings are defined as constants in `SHARP/main.js`:

```javascript
const PROTOCOL_VERSION = 'SHARP/1.x'

const KEYWORDS = {
    promotions: new Set([/* ...keywords... */]),
    social: new Set([/* ...keywords... */]),
    forums: new Set([/* ...keywords... */]),
    updates: new Set([/* ...keywords... */])
};

const HASHCASH_THRESHOLDS = {
    GOOD: 18,
    WEAK: 10,
    TRIVIAL: 5
};
```

*   You are free to tweak these variables to your needs.
*   `PROTOCOL_VERSION`: This string defines the SHARP protocol version the server adheres to. Clients and servers with mismatching `PROTOCOL_VERSION` values will typically reject connections to ensure compatibility.
*   `KEYWORDS`: This object contains sets of keywords used to automatically classify incoming emails into categories like 'promotions', 'social', etc. Modifying these sets will change how emails are categorized. The classification also considers HTML structure for promotions. If no keywords match and HTML structure doesn't strongly indicate a promotion, emails default to 'primary'.
*   `HASHCASH_THRESHOLDS`: These values define the number of leading zero bits required in a SHA-1 hash of a Hashcash stamp for an email to be processed:
    *   `GOOD` (e.g., 18 bits): The email has sufficient proof-of-work and is processed normally (status: 'pending' or 'scheduled').
    *   `WEAK` (e.g., 10 bits): The email has some proof-of-work but less than `GOOD`. It's accepted but marked as 'spam'.
    *   `TRIVIAL` (e.g., 5 bits): The email has minimal proof-of-work. It's accepted but marked as 'spam'. If the proof-of-work is below `TRIVIAL`, the `/api/send` endpoint will reject the request with a 429 status, asking for at least `TRIVIAL` bits.

Additionally, `main.js` includes IQ-based vocabulary checks:
```javascript
// filepath: SHARP\main.js
function checkVocabulary(text, iq) {
    let maxWordLength;

    if (iq < 90) maxWordLength = 3;
    else if (iq < 100) maxWordLength = 4;
    // ... and so on
    else return { isValid: true, limit: null }; // No limit for IQ >= 140

    // ... logic to check word lengths ...
}
```
*   `checkVocabulary`: This function, used by both the SHARP TCP server (for `EMAIL_CONTENT`) and the `/api/send` endpoint, limits the maximum word length in plain text email bodies based on the sender's IQ (fetched from the `users` table). **This behavior is optional and can be totally removed if needed.**
