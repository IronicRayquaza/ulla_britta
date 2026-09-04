import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const client = (SUPABASE_URL && SUPABASE_KEY)
    ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;

/**
 * Extracts a bearer token from the Authorization header.
 */
function extractToken(req) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return null;
    const token = header.slice(7).trim();
    return token.length > 0 ? token : null;
}

/**
 * Verifies a Supabase access token and resolves the user it belongs to.
 * Returns null when the token is missing, malformed, or rejected.
 */
export async function verifyToken(token) {
    if (!client || !token) return null;
    try {
        const { data, error } = await client.auth.getUser(token);
        if (error || !data?.user) return null;
        return data.user;
    } catch {
        return null;
    }
}

/**
 * Express middleware. Requires a valid Supabase session and attaches the
 * verified identity to req.auth.
 *
 * The user id ALWAYS comes from the verified token — never from the request
 * body — so a caller cannot act on behalf of somebody else.
 */
export async function requireAuth(req, res, next) {
    if (!client) {
        return res.status(503).json({ error: 'Authentication is not configured on this server.' });
    }

    const user = await verifyToken(extractToken(req));
    if (!user) {
        return res.status(401).json({ error: 'Unauthorized. A valid Supabase session is required.' });
    }

    req.auth = { userId: user.id, email: user.email };
    next();
}

export default requireAuth;
