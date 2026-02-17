import dns from 'dns/promises';

const dnsCache = new Map();
const DNS_CACHE_TTL = 60000; // 60 seconds

function getCachedEntries(key) {
    const entry = dnsCache.get(key);
    if (entry && Date.now() - entry.timestamp < DNS_CACHE_TTL) {
        return entry.value;
    }
    dnsCache.delete(key);
    return null;
}

function setCachedEntries(key, value) {
    dnsCache.set(key, { value, timestamp: Date.now() });
}

// Resolve MX records for email delivery
export async function resolveMx(domain) {
    const d = domain.trim().toLowerCase();
    const cacheKey = `mx:${d}`;
    const cached = getCachedEntries(cacheKey);
    if (cached) return cached;

    try {
        const mxRecords = await dns.resolveMx(d);
        if (!mxRecords || mxRecords.length === 0) {
            throw new Error(`No MX records found for ${d}`);
        }

        // Sort by priority (lower is higher priority)
        const sorted = mxRecords.sort((a, b) => a.priority - b.priority);
        
        // Resolve IPs for each MX server
        const resolved = await Promise.all(
            sorted.map(async (mx) => {
                try {
                    const [v4, v6] = await Promise.all([
                        dns.resolve4(mx.exchange).catch(() => []),
                        dns.resolve6(mx.exchange).catch(() => [])
                    ]);
                    return {
                        exchange: mx.exchange,
                        priority: mx.priority,
                        ips: [...v4, ...v6]
                    };
                } catch {
                    return null;
                }
            })
        );

        const filtered = resolved.filter(r => r && r.ips.length > 0);
        if (filtered.length === 0) {
            throw new Error(`Could not resolve any MX server IPs for ${d}`);
        }

        setCachedEntries(cacheKey, filtered);
        return filtered;
    } catch (error) {
        console.error(`MX resolution failed for ${d}:`, error.message);
        throw error;
    }
}

// Legacy function for backward compatibility - now uses MX records
async function fetchSrvRecords(domain) {
    // For compatibility, try MX records
    try {
        const mxRecords = await resolveMx(domain);
        return mxRecords.map(mx => ({
            name: mx.exchange,
            port: 25, // Standard SMTP port
            ips: mx.ips
        }));
    } catch (error) {
        throw new Error(`No mail server found for ${domain}`);
    }
}

export async function resolveSrv(domain) {
    const records = await fetchSrvRecords(domain);

    // Find first record with valid IPs
    for (const record of records) {
        if (record.ips.length > 0) {
            return [{
                name: record.name,
                port: record.port,
                ips: record.ips
            }];
        }
    }

    throw new Error(`Could not resolve any mail server address for ${domain}`);
}

export async function verifyEmailDomain(claimedDomain, clientIP) {
    if (!clientIP) throw new Error('No client IP provided');

    // Normalize IPv4-mapped IPv6 addresses
    const normalizedIP = clientIP.startsWith('::ffff:') ?
        clientIP.substring(7) : clientIP;

    const records = await fetchSrvRecords(claimedDomain);

    // Check if client IP matches any resolved IPs
    for (const record of records) {
        const normalizedIPs = record.ips.map(ip =>
            ip.startsWith('::ffff:') ? ip.substring(7) : ip
        );
        if (normalizedIPs.includes(normalizedIP)) {
            return true;
        }
    }

    throw new Error(
        `IP ${normalizedIP} is not an authorized mail server for ${claimedDomain}`
    );
}

// Legacy alias
export const verifySharpDomain = verifyEmailDomain;

// Parse email address into username and domain
export function parseEmailAddress(address) {
    if (!address || typeof address !== 'string') return null;
    const match = address.match(/^([^@]+)@([^@]+)$/);
    if (!match) return null;
    return {
        username: match[1],
        domain: match[2]
    };
}

// Legacy alias
export const parseSharpAddress = parseEmailAddress;
