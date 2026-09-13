const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const db = require('../config/db');
const { signUserToken, requireAuth } = require('../middleware/auth');
const { sendVerificationEmail } = require('../utils/mailer');

const router = express.Router();
const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/register', async (req, res) => {
  try {
    const { full_name, email, password } = req.body;
    if (!full_name || !email || !password) {
      return res.status(400).json({ error: 'Barcha maydonlarni to\'ldiring' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Email manzil noto\'g\'ri' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Parol kamida 6 ta belgidan iborat bo\'lishi kerak' });
    }

    const existing = db.prepare('SELECT id, is_verified FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing && existing.is_verified) {
      return res.status(409).json({ error: 'Bu email allaqachon ro\'yxatdan o\'tgan' });
    }

    const hash = bcrypt.hashSync(password, 10);
    const code = generateCode();
    const expires = Date.now() + 15 * 60 * 1000;

    if (existing) {
      db.prepare('UPDATE users SET full_name = ?, password = ?, verify_code = ?, verify_expires = ? WHERE id = ?')
        .run(full_name, hash, code, expires, existing.id);
    } else {
      db.prepare(
        'INSERT INTO users (full_name, email, password, is_verified, verify_code, verify_expires, balance, created_at) VALUES (?, ?, ?, 0, ?, ?, 0, ?)'
      ).run(full_name, email.toLowerCase(), hash, code, expires, Date.now());
    }

    await sendVerificationEmail(email.toLowerCase(), code);
    res.json({ success: true, email: email.toLowerCase() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server xatosi, keyinroq urinib ko\'ring' });
  }
});

router.post('/resend-code', async (req, res) => {
  try {
    const { email } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase());
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    if (user.is_verified) return res.status(400).json({ error: 'Email allaqachon tasdiqlangan' });

    const code = generateCode();
    const expires = Date.now() + 15 * 60 * 1000;
    db.prepare('UPDATE users SET verify_code = ?, verify_expires = ? WHERE id = ?').run(code, expires, user.id);
    await sendVerificationEmail(user.email, code);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server xatosi' });
  }
});

router.post('/verify', (req, res) => {
  const { email, code } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase());
  if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
  if (user.is_verified) return res.json({ success: true, alreadyVerified: true });
  if (!user.verify_code || user.verify_code !== code) {
    return res.status(400).json({ error: 'Kod noto\'g\'ri' });
  }
  if (user.verify_expires < Date.now()) {
    return res.status(400).json({ error: 'Kod muddati tugagan, qaytadan yuboring' });
  }
  db.prepare('UPDATE users SET is_verified = 1, verify_code = NULL, verify_expires = NULL WHERE id = ?').run(user.id);
  res.json({ success: true });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase());
  if (!user) return res.status(401).json({ error: 'Email yoki parol noto\'g\'ri' });
  if (!bcrypt.compareSync(password || '', user.password)) {
    return res.status(401).json({ error: 'Email yoki parol noto\'g\'ri' });
  }
  if (!user.is_verified) {
    return res.status(403).json({ error: 'Email tasdiqlanmagan', needVerification: true, email: user.email });
  }
  const token = signUserToken(user);
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
  res.json({ success: true, user: { id: user.id, full_name: user.full_name, email: user.email, balance: user.balance } });
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ---------- Google orqali kirish / ro'yxatdan o'tish ----------
router.post('/google', async (req, res) => {
  try {
    if (!googleClient) {
      return res.status(500).json({ error: 'Google kirish serverda sozlanmagan (GOOGLE_CLIENT_ID yo\'q)' });
    }
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Google ma\'lumoti kelmadi' });

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(400).json({ error: 'Google hisobidan email olinmadi' });
    }
    if (!payload.email_verified) {
      return res.status(400).json({ error: 'Google email manzili tasdiqlanmagan' });
    }

    const email = payload.email.toLowerCase();
    const fullName = payload.name || email.split('@')[0];

    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (!user) {
      const randomPassword = crypto.randomBytes(24).toString('hex');
      const hash = bcrypt.hashSync(randomPassword, 10);
      const info = db.prepare(
        'INSERT INTO users (full_name, email, password, is_verified, balance, created_at) VALUES (?, ?, ?, 1, 0, ?)'
      ).run(fullName, email, hash, Date.now());
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    } else if (!user.is_verified) {
      db.prepare('UPDATE users SET is_verified = 1 WHERE id = ?').run(user.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    }

    const token = signUserToken(user);
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ success: true, user: { id: user.id, full_name: user.full_name, email: user.email, balance: user.balance } });
  } catch (e) {
    console.error('Google login xatosi:', e);
    res.status(401).json({ error: 'Google orqali kirishda xatolik yuz berdi' });
  }
});

router.get('/config', (req, res) => {
  res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null });
});

module.exports = router;
