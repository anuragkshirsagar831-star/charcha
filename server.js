const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static('public/uploads'));

if (!fs.existsSync('./public/uploads')) {
  fs.mkdirSync('./public/uploads', { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, './public/uploads'),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

const db = new DatabaseSync('database.sqlite');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password TEXT,
    secure_id TEXT UNIQUE,
    provider TEXT DEFAULT 'manual',
    bio TEXT DEFAULT 'No bio yet.',
    avatar_url TEXT DEFAULT '',
    banner_url TEXT DEFAULT '',
    joined_date TEXT,
    is_private_account INTEGER DEFAULT 0,
    push_notifications INTEGER DEFAULT 1,
    email_notifications INTEGER DEFAULT 1,
    read_receipts INTEGER DEFAULT 1,
    is_active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS follows (
    follower TEXT,
    following TEXT,
    PRIMARY KEY (follower, following)
  );

  CREATE TABLE IF NOT EXISTS blocks (
    user_id TEXT,
    blocked_id TEXT,
    PRIMARY KEY (user_id, blocked_id)
  );

  CREATE TABLE IF NOT EXISTS mutes (
    user_id TEXT,
    muted_id TEXT,
    PRIMARY KEY (user_id, muted_id)
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author TEXT,
    content TEXT,
    media_url TEXT,
    media_type TEXT,
    repost_of INTEGER DEFAULT NULL,
    quote_content TEXT,
    time TEXT,
    likes INTEGER DEFAULT 0,
    deleted_at INTEGER DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER,
    parent_reply_id INTEGER DEFAULT NULL,
    author TEXT,
    content TEXT,
    time TEXT
  );

  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT,
    receiver TEXT,
    content TEXT,
    time TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT,
    device_type TEXT,
    created_at INTEGER
  );
`);

try { db.exec(`ALTER TABLE users ADD COLUMN secure_id TEXT UNIQUE`); } catch (e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN provider TEXT DEFAULT 'manual'`); } catch (e) {}

function getDeviceType(userAgent = '') {
  return /mobi|android|iphone|ipad|ipod/i.test(userAgent) ? 'mobile' : 'desktop';
}

function verifySession(req) {
  const token = req.headers['authorization'];
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  const user = db.prepare('SELECT is_active FROM users WHERE username = ?').get(session.username);
  if (!user || user.is_active === 0) return null;
  return session.username;
}

function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(message);
  });
}

app.post('/api/login', (req, res) => {
  const { username, password, secureId, provider } = req.body;
  if (!username || !password || !secureId) {
    return res.status(400).json({ error: 'Username, password, and secure ID are required!' });
  }

  const cleanName = username.trim().replace(/^@/, '');
  const cleanSecureId = secureId.trim();

  const existingSecureIdOwner = db.prepare('SELECT username FROM users WHERE secure_id = ?').get(cleanSecureId);
  if (existingSecureIdOwner && existingSecureIdOwner.username.toLowerCase() !== cleanName.toLowerCase()) {
    return res.status(400).json({ error: `This secure ID is already linked to @${existingSecureIdOwner.username}!` });
  }

  const existingUser = db.prepare('SELECT * FROM users WHERE username = ?').get(cleanName);
  const today = new Date().toLocaleDateString();

  if (!existingUser) {
    try {
      db.prepare(`
        INSERT INTO users (username, password, secure_id, provider, joined_date) 
        VALUES (?, ?, ?, ?, ?)
      `).run(cleanName, password, cleanSecureId, provider || 'Google/OAuth', today);
    } catch (err) {
      return res.status(400).json({ error: 'Secure ID is already in use by another account.' });
    }
  } else {
    if (existingUser.is_active === 0) {
      db.prepare('UPDATE users SET is_active = 1 WHERE username = ?').run(cleanName);
    }
    if (existingUser.password !== password) {
      return res.status(401).json({ error: 'Incorrect password!' });
    }
    if (!existingUser.secure_id) {
      db.prepare('UPDATE users SET secure_id = ?, provider = ? WHERE username = ?').run(cleanSecureId, provider || 'Google/OAuth', cleanName);
    }
  }

  const deviceType = getDeviceType(req.headers['user-agent']);
  db.prepare('DELETE FROM sessions WHERE username = ? AND device_type = ?').run(cleanName, deviceType);

  const token = 'token_' + Math.random().toString(36).substring(2) + Date.now();
  db.prepare('INSERT INTO sessions (token, username, device_type, created_at) VALUES (?, ?, ?, ?)')
    .run(token, cleanName, deviceType, Date.now());

  res.json({ token, username: cleanName });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['authorization'];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ success: true });
});

app.get('/api/settings', (req, res) => {
  const username = verifySession(req);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  const settings = db.prepare(`
    SELECT is_private_account, push_notifications, email_notifications, read_receipts, bio, avatar_url, banner_url, secure_id, provider 
    FROM users WHERE username = ?
  `).get(username);
  
  const blocked = db.prepare('SELECT blocked_id FROM blocks WHERE user_id = ?').all(username).map(b => b.blocked_id);
  const muted = db.prepare('SELECT muted_id FROM mutes WHERE user_id = ?').all(username).map(m => m.muted_id);

  res.json({ ...settings, blocked_users: blocked, muted_users: muted });
});

app.patch('/api/settings', (req, res) => {
  const username = verifySession(req);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  const updates = req.body;
  const allowedFields = ['is_private_account', 'push_notifications', 'email_notifications', 'read_receipts'];
  let queryParts = [];
  let values = [];

  for (let key of allowedFields) {
    if (updates[key] !== undefined) {
      queryParts.push(`${key} = ?`);
      values.push(updates[key] ? 1 : 0);
    }
  }

  if (queryParts.length > 0) {
    values.push(username);
    db.prepare(`UPDATE users SET ${queryParts.join(', ')} WHERE username = ?`).run(...values);
  }
  res.json({ success: true });
});

app.get('/api/sessions', (req, res) => {
  const username = verifySession(req);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });
  const currentToken = req.headers['authorization'];
  const sessions = db.prepare('SELECT token, device_type, created_at FROM sessions WHERE username = ?').all(username);
  res.json(sessions.map(s => ({ ...s, isCurrent: s.token === currentToken })));
});

app.delete('/api/sessions/:token', (req, res) => {
  const username = verifySession(req);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });
  db.prepare('DELETE FROM sessions WHERE token = ? AND username = ?').run(req.params.token, username);
  res.json({ success: true });
});

app.post('/api/block/:username', (req, res) => {
  const currentUser = verifySession(req);
  if (!currentUser) return res.status(401).json({ error: 'Unauthorized' });
  const target = req.params.username;
  try {
    db.prepare('INSERT OR IGNORE INTO blocks (user_id, blocked_id) VALUES (?, ?)').run(currentUser, target);
    db.prepare('DELETE FROM follows WHERE (follower = ? AND following = ?) OR (follower = ? AND following = ?)').run(currentUser, target, target, currentUser);
  } catch(e) {}
  res.json({ success: true });
});

app.post('/api/mute/:username', (req, res) => {
  const currentUser = verifySession(req);
  if (!currentUser) return res.status(401).json({ error: 'Unauthorized' });
  const target = req.params.username;
  try {
    db.prepare('INSERT OR IGNORE INTO mutes (user_id, muted_id) VALUES (?, ?)').run(currentUser, target);
  } catch(e) {}
  res.json({ success: true });
});

app.post('/api/account/deactivate', (req, res) => {
  const username = verifySession(req);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });
  db.prepare('UPDATE users SET is_active = 0 WHERE username = ?').run(username);
  db.prepare('DELETE FROM sessions WHERE username = ?').run(username);
  res.json({ success: true });
});

app.delete('/api/account/delete', (req, res) => {
  const username = verifySession(req);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });
  db.prepare('DELETE FROM users WHERE username = ?').run(username);
  db.prepare('DELETE FROM posts WHERE author = ?').run(username);
  db.prepare('DELETE FROM replies WHERE author = ?').run(username);
  db.prepare('DELETE FROM sessions WHERE username = ?').run(username);
  res.json({ success: true });
});

app.get('/api/account/export', (req, res) => {
  const username = verifySession(req);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });
  const user = db.prepare('SELECT username, bio, joined_date, secure_id, provider FROM users WHERE username = ?').get(username);
  const posts = db.prepare('SELECT * FROM posts WHERE author = ?').all(username);
  const replies = db.prepare('SELECT * FROM replies WHERE author = ?').all(username);
  const archive = { user, posts, replies, exported_at: new Date().toISOString() };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=charcha_archive_${username}.json`);
  res.send(JSON.stringify(archive, null, 2));
});

app.get('/api/users/:username', (req, res) => {
  const currentUser = verifySession(req);
  if (!currentUser) return res.status(401).json({ error: 'Unauthorized' });
  const username = req.params.username;

  const user = db.prepare('SELECT username, bio, avatar_url, banner_url, joined_date, is_private_account, secure_id, provider FROM users WHERE username = ?').get(username);
  if (!user || user.is_active === 0) return res.status(404).json({ error: 'User not found' });

  const isBlocked = db.prepare('SELECT * FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)').get(currentUser, username, username, currentUser);
  if (isBlocked) return res.status(403).json({ error: 'User unavailable' });

  const followers = db.prepare('SELECT follower as username FROM follows WHERE following = ?').all(username);
  const following = db.prepare('SELECT following as username FROM follows WHERE follower = ?').all(username);
  const isFollowing = db.prepare('SELECT * FROM follows WHERE follower = ? AND following = ?').get(currentUser, username) ? true : false;

  let userPosts = [];
  if (!user.is_private_account || isFollowing || currentUser.toLowerCase() === username.toLowerCase()) {
    userPosts = db.prepare('SELECT * FROM posts WHERE author = ? ORDER BY id DESC').all(username);
  }

  const recommended = db.prepare(`
    SELECT username, bio, avatar_url FROM users 
    WHERE username != ? AND is_active = 1 AND username NOT IN (SELECT following FROM follows WHERE follower = ?)
    LIMIT 5
  `).all(currentUser, currentUser);

  res.json({ ...user, followers, following, followersCount: followers.length, followingCount: following.length, isFollowing, posts: userPosts, recommended });
});

app.post('/api/profile', upload.fields([{ name: 'avatar', maxCount: 1 }, { name: 'banner', maxCount: 1 }]), (req, res) => {
  const username = verifySession(req);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  const bio = req.body.bio !== undefined ? req.body.bio : null;
  let avatarUrl = req.files && req.files['avatar'] ? '/uploads/' + req.files['avatar'][0].filename : null;
  let bannerUrl = req.files && req.files['banner'] ? '/uploads/' + req.files['banner'][0].filename : null;

  if (bio !== null) db.prepare('UPDATE users SET bio = ? WHERE username = ?').run(bio, username);
  if (avatarUrl) db.prepare('UPDATE users SET avatar_url = ? WHERE username = ?').run(avatarUrl, username);
  if (bannerUrl) db.prepare('UPDATE users SET banner_url = ? WHERE username = ?').run(bannerUrl, username);

  res.json({ success: true });
});

app.post('/api/follow/:username', (req, res) => {
  const currentUser = verifySession(req);
  if (!currentUser) return res.status(401).json({ error: 'Unauthorized' });
  const targetUser = req.params.username;

  if (currentUser.toLowerCase() === targetUser.toLowerCase()) {
    return res.status(400).json({ error: 'Cannot follow yourself' });
  }

  const existing = db.prepare('SELECT * FROM follows WHERE follower = ? AND following = ?').get(currentUser, targetUser);
  if (existing) {
    db.prepare('DELETE FROM follows WHERE follower = ? AND following = ?').run(currentUser, targetUser);
    res.json({ following: false });
  } else {
    db.prepare('INSERT INTO follows (follower, following) VALUES (?, ?)').run(currentUser, targetUser);
    res.json({ following: true });
  }
});

app.get('/api/posts', (req, res) => {
  const currentUser = verifySession(req);
  if (!currentUser) return res.status(401).json({ error: 'Unauthorized' });

  const feedType = req.query.feed || 'global';
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  const cutoffTime = Date.now() - TWENTY_FOUR_HOURS;
  db.prepare('DELETE FROM replies WHERE post_id IN (SELECT id FROM posts WHERE deleted_at IS NOT NULL AND deleted_at < ?)').run(cutoffTime);
  db.prepare('DELETE FROM posts WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(cutoffTime);

  let postsQuery = `
    SELECT p.* FROM posts p
    JOIN users u ON p.author = u.username
    WHERE u.is_active = 1
      AND p.author NOT IN (SELECT blocked_id FROM blocks WHERE user_id = ?)
      AND p.author NOT IN (SELECT user_id FROM blocks WHERE blocked_id = ?)
      AND p.author NOT IN (SELECT muted_id FROM mutes WHERE user_id = ?)
  `;
  let queryParams = [currentUser, currentUser, currentUser];

  if (feedType === 'following') {
    postsQuery += ` AND (p.author = ? OR p.author IN (SELECT following FROM follows WHERE follower = ?))`;
    queryParams.push(currentUser, currentUser);
  }

  postsQuery += ' ORDER BY p.id DESC';

  const posts = db.prepare(postsQuery).all(...queryParams);
  const replies = db.prepare('SELECT * FROM replies ORDER BY id ASC').all();
  const followingList = db.prepare('SELECT following FROM follows WHERE follower = ?').all(currentUser).map(f => f.following);

  const postsWithDetails = posts.map(post => {
    let originalPost = null;
    if (post.repost_of) {
      originalPost = db.prepare('SELECT * FROM posts WHERE id = ?').get(post.repost_of);
      if (originalPost) {
        const origAuthor = db.prepare('SELECT avatar_url FROM users WHERE username = ?').get(originalPost.author);
        originalPost.authorAvatar = origAuthor ? origAuthor.avatar_url : '';
      }
    }
    const authorInfo = db.prepare('SELECT avatar_url FROM users WHERE username = ?').get(post.author);
    return {
      ...post,
      authorAvatar: authorInfo ? authorInfo.avatar_url : '',
      content: post.deleted_at ? 'This post was deleted by the author.' : post.content,
      isDeleted: Boolean(post.deleted_at),
      originalPost,
      replies: replies.filter(r => r.post_id === post.id)
    };
  });

  const hashtagCounts = {};
  posts.forEach(p => {
    if (!p.content || p.deleted_at) return;
    const matches = p.content.match(/#([a-zA-Z0-9_]+)/g);
    if (matches) matches.forEach(tag => { hashtagCounts[tag] = (hashtagCounts[tag] || 0) + 1; });
  });

  const trending = Object.entries(hashtagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(entry => ({ tag: entry[0], count: entry[1] }));

  res.json({ posts: postsWithDetails, trending, followingList });
});

app.post('/api/posts', upload.single('media'), (req, res) => {
  const username = verifySession(req);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  const content = req.body.content || '';
  const repostOf = req.body.repostOf ? Number(req.body.repostOf) : null;
  let mediaUrl = null;
  let mediaType = null;

  if (req.file) {
    mediaUrl = '/uploads/' + req.file.filename;
    const mime = req.file.mimetype;
    if (mime.startsWith('image/')) mediaType = 'image';
    else if (mime.startsWith('video/')) mediaType = 'video';
    else mediaType = 'file';
  }

  const time = new Date().toLocaleTimeString();
  const result = db.prepare(`
    INSERT INTO posts (author, content, media_url, media_type, repost_of, time, likes, deleted_at) 
    VALUES (?, ?, ?, ?, ?, ?, 0, NULL)
  `).run(username, content, mediaUrl, mediaType, repostOf, time);

  broadcast({ type: 'new_post' });
  res.json({ success: true, id: result.lastInsertRowid });
});

app.post('/api/posts/:id/like', (req, res) => {
  if (!verifySession(req)) return res.status(401).json({ error: 'Unauthorized' });
  db.prepare('UPDATE posts SET likes = COALESCE(likes, 0) + 1 WHERE id = ? AND deleted_at IS NULL').run(req.params.id);
  broadcast({ type: 'update_post' });
  res.json({ success: true });
});

app.post('/api/posts/:id/reply', (req, res) => {
  const username = verifySession(req);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  const postId = Number(req.params.id);
  const parentReplyId = req.body.parentReplyId ? Number(req.body.parentReplyId) : null;
  const content = req.body.content;
  if (!content) return res.status(400).json({ error: 'Empty reply' });

  const time = new Date().toLocaleTimeString();
  db.prepare('INSERT INTO replies (post_id, parent_reply_id, author, content, time) VALUES (?, ?, ?, ?, ?)')
    .run(postId, parentReplyId, username, content, time);

  broadcast({ type: 'update_post' });
  res.json({ success: true });
});

app.delete('/api/posts/:id', (req, res) => {
  const username = verifySession(req);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.author.toLowerCase() !== username.toLowerCase()) {
    return res.status(403).json({ error: 'You can only delete your own posts!' });
  }

  db.prepare('UPDATE posts SET content = ?, media_url = NULL, deleted_at = ? WHERE id = ?')
    .run('[Deleted]', Date.now(), req.params.id);
  
  broadcast({ type: 'update_post' });
  res.json({ success: true });
});

app.get('/api/chats/:peer', (req, res) => {
  const username = verifySession(req);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });
  const peer = req.params.peer;

  const messages = db.prepare(`
    SELECT * FROM chats 
    WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
    ORDER BY id ASC
  `).all(username, peer, peer, username);

  res.json(messages);
});

app.post('/api/chats/:peer', (req, res) => {
  const username = verifySession(req);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });
  const peer = req.params.peer;
  const content = req.body.content;
  if (!content) return res.status(400).json({ error: 'Empty message' });

  const time = new Date().toLocaleTimeString();
  db.prepare('INSERT INTO chats (sender, receiver, content, time) VALUES (?, ?, ?, ?)')
    .run(username, peer, content, time);

  broadcast({ type: 'new_chat', sender: username, receiver: peer });
  res.json({ success: true });
});

server.listen(3000, '0.0.0.0', () => {
  console.log('Charcha Server is ON! Visit http://localhost:3000');
});