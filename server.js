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

if (!fs.existsSync('./public/uploads')) fs.mkdirSync('./public/uploads', { recursive: true });

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
    username TEXT PRIMARY KEY, password TEXT, secure_id TEXT UNIQUE, provider TEXT DEFAULT 'manual',
    bio TEXT DEFAULT 'No bio yet.', avatar_url TEXT DEFAULT '', banner_url TEXT DEFAULT '',
    joined_date TEXT, is_private_account INTEGER DEFAULT 0, push_notifications INTEGER DEFAULT 1,
    email_notifications INTEGER DEFAULT 1, read_receipts INTEGER DEFAULT 1, is_active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS follows (follower TEXT, following TEXT, PRIMARY KEY (follower, following));
  CREATE TABLE IF NOT EXISTS blocks (user_id TEXT, blocked_id TEXT, PRIMARY KEY (user_id, blocked_id));
  CREATE TABLE IF NOT EXISTS mutes (user_id TEXT, muted_id TEXT, PRIMARY KEY (user_id, muted_id));
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT, content TEXT, media_url TEXT,
    media_type TEXT, repost_of INTEGER DEFAULT NULL, quote_content TEXT, time TEXT,
    likes INTEGER DEFAULT 0, deleted_at INTEGER DEFAULT NULL
  );
  CREATE TABLE IF NOT EXISTS replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, parent_reply_id INTEGER DEFAULT NULL,
    author TEXT, content TEXT, time TEXT
  );
  CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, receiver TEXT, content TEXT, time TEXT);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT, device_type TEXT, created_at INTEGER);
  CREATE TABLE IF NOT EXISTS post_likes (post_id INTEGER, username TEXT, PRIMARY KEY (post_id, username));
`);

try { db.exec(`ALTER TABLE users ADD COLUMN secure_id TEXT UNIQUE`); } catch (e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN provider TEXT DEFAULT 'manual'`); } catch (e) {}

const DEFAULT_AVATARS = [
  'https://api.dicebear.com/9.x/micah/svg?seed=Felix&backgroundColor=ffdfbf',
  'https://api.dicebear.com/9.x/micah/svg?seed=Aneka&backgroundColor=c0aede',
  'https://api.dicebear.com/9.x/micah/svg?seed=Mimi&backgroundColor=b6e3f4',
  'https://api.dicebear.com/9.x/micah/svg?seed=Jack&backgroundColor=ffd5dc',
  'https://api.dicebear.com/9.x/micah/svg?seed=Leo&backgroundColor=d1d4f9',
  'https://api.dicebear.com/9.x/micah/svg?seed=Zoe&backgroundColor=c2e8ce',
  'https://api.dicebear.com/9.x/micah/svg?seed=Sam&backgroundColor=fbe6a2'
];

function getDeviceType(userAgent = '') { return /mobi|android|iphone|ipad|ipod/i.test(userAgent) ? 'mobile' : 'desktop'; }

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
  wss.clients.forEach(client => { if (client.readyState === 1) client.send(message); });
}

app.post('/api/login', (req, res) => {
  const { username, password, secureId, provider } = req.body;
  if (!username || !password || !secureId) return res.status(400).json({ error: 'Missing credentials' });

  const cleanName = username.trim().replace(/^@/, '');
  const cleanSecureId = secureId.trim();

  const existingSecureIdOwner = db.prepare('SELECT username FROM users WHERE secure_id = ?').get(cleanSecureId);
  if (existingSecureIdOwner && existingSecureIdOwner.username.toLowerCase() !== cleanName.toLowerCase()) {
    return res.status(400).json({ error: `Secure ID linked to @${existingSecureIdOwner.username}!` });
  }

  const existingUser = db.prepare('SELECT * FROM users WHERE username = ?').get(cleanName);
  
  if (!existingUser) {
    try {
      const randomAvatar = DEFAULT_AVATARS[Math.floor(Math.random() * 7)];
      db.prepare(`INSERT INTO users (username, password, secure_id, provider, joined_date, avatar_url) VALUES (?, ?, ?, ?, ?, ?)`).run(cleanName, password, cleanSecureId, provider || 'Google/OAuth', new Date().toLocaleDateString(), randomAvatar);
    } catch (err) { return res.status(400).json({ error: 'Secure ID in use.' }); }
  } else {
    if (existingUser.is_active === 0) db.prepare('UPDATE users SET is_active = 1 WHERE username = ?').run(cleanName);
    if (existingUser.password !== password) return res.status(401).json({ error: 'Incorrect password!' });
    if (!existingUser.secure_id) db.prepare('UPDATE users SET secure_id = ?, provider = ? WHERE username = ?').run(cleanSecureId, provider || 'Google/OAuth', cleanName);
  }

  const deviceType = getDeviceType(req.headers['user-agent']);
  db.prepare('DELETE FROM sessions WHERE username = ? AND device_type = ?').run(cleanName, deviceType);
  const token = 'token_' + Math.random().toString(36).substring(2) + Date.now();
  db.prepare('INSERT INTO sessions (token, username, device_type, created_at) VALUES (?, ?, ?, ?)').run(token, cleanName, deviceType, Date.now());

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
  const settings = db.prepare('SELECT is_private_account, push_notifications, email_notifications, read_receipts, bio, avatar_url, banner_url, secure_id, provider FROM users WHERE username = ?').get(username);
  res.json({ ...settings, blocked_users: [], muted_users: [] });
});

app.patch('/api/settings', (req, res) => {
  const username = verifySession(req);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });
  for (let key of ['is_private_account', 'push_notifications', 'email_notifications', 'read_receipts']) {
    if (req.body[key] !== undefined) db.prepare(`UPDATE users SET ${key} = ? WHERE username = ?`).run(req.body[key] ? 1 : 0, username);
  }
  res.json({ success: true });
});

app.get('/api/users/:username', (req, res) => {
  const currentUser = verifySession(req);
  if (!currentUser) return res.status(401).json({ error: 'Unauthorized' });
  const username = req.params.username;

  const user = db.prepare('SELECT username, bio, avatar_url, banner_url, joined_date, is_private_account, secure_id, provider FROM users WHERE username = ?').get(username);
  if (!user || user.is_active === 0) return res.status(404).json({ error: 'User not found' });

  const followers = db.prepare('SELECT follower as username FROM follows WHERE following = ?').all(username);
  const following = db.prepare('SELECT following as username FROM follows WHERE follower = ?').all(username);
  const isFollowing = db.prepare('SELECT * FROM follows WHERE follower = ? AND following = ?').get(currentUser, username) ? true : false;
  const myLikes = db.prepare('SELECT post_id FROM post_likes WHERE username = ?').all(currentUser).map(r => r.post_id);

  let userPosts = [];
  if (!user.is_private_account || isFollowing || currentUser.toLowerCase() === username.toLowerCase()) {
    const rawPosts = db.prepare('SELECT * FROM posts WHERE author = ? ORDER BY id DESC').all(username);
    userPosts = rawPosts.map(p => ({ ...p, isLiked: myLikes.includes(p.id) }));
  }

  const recommended = db.prepare(`SELECT username, bio, avatar_url FROM users WHERE username != ? AND is_active = 1 AND username NOT IN (SELECT following FROM follows WHERE follower = ?) LIMIT 5`).all(currentUser, currentUser);
  res.json({ ...user, followers, following, followersCount: followers.length, followingCount: following.length, isFollowing, posts: userPosts, recommended });
});

// UPGRADED /api/profile TO HANDLE DEFAULT AVATARS
app.post('/api/profile', upload.fields([{ name: 'avatar', maxCount: 1 }, { name: 'banner', maxCount: 1 }]), (req, res) => {
  const username = verifySession(req);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });
  if (req.body.bio !== undefined) db.prepare('UPDATE users SET bio = ? WHERE username = ?').run(req.body.bio, username);
  
  if (req.files['avatar']) {
    db.prepare('UPDATE users SET avatar_url = ? WHERE username = ?').run('/uploads/' + req.files['avatar'][0].filename, username);
  } else if (req.body.default_avatar) {
    db.prepare('UPDATE users SET avatar_url = ? WHERE username = ?').run(req.body.default_avatar, username);
  }
  
  if (req.files['banner']) db.prepare('UPDATE users SET banner_url = ? WHERE username = ?').run('/uploads/' + req.files['banner'][0].filename, username);
  res.json({ success: true });
});

app.post('/api/follow/:username', (req, res) => {
  const currentUser = verifySession(req);
  if (!currentUser) return res.status(401).json({ error: 'Unauthorized' });
  const existing = db.prepare('SELECT * FROM follows WHERE follower = ? AND following = ?').get(currentUser, req.params.username);
  if (existing) db.prepare('DELETE FROM follows WHERE follower = ? AND following = ?').run(currentUser, req.params.username);
  else db.prepare('INSERT INTO follows (follower, following) VALUES (?, ?)').run(currentUser, req.params.username);
  res.json({ success: true });
});

app.get('/api/posts', (req, res) => {
  const currentUser = verifySession(req);
  if (!currentUser) return res.status(401).json({ error: 'Unauthorized' });

  const feedType = req.query.feed || 'global';
  let postsQuery = `SELECT p.* FROM posts p JOIN users u ON p.author = u.username WHERE u.is_active = 1`;
  let queryParams = [];

  if (feedType === 'following') {
    postsQuery += ` AND (p.author = ? OR p.author IN (SELECT following FROM follows WHERE follower = ?))`;
    queryParams.push(currentUser, currentUser);
  }
  postsQuery += ' ORDER BY p.id DESC';

  const posts = db.prepare(postsQuery).all(...queryParams);
  const replies = db.prepare('SELECT * FROM replies ORDER BY id ASC').all();
  const followingList = db.prepare('SELECT following FROM follows WHERE follower = ?').all(currentUser).map(f => f.following);
  const myLikes = db.prepare('SELECT post_id FROM post_likes WHERE username = ?').all(currentUser).map(r => r.post_id);

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
      isDeleted: Boolean(post.deleted_at),
      originalPost,
      isLiked: myLikes.includes(post.id),
      replies: replies.filter(r => r.post_id === post.id)
    };
  });

  const hashtagCounts = {};
  posts.forEach(p => {
    const matches = (p.content || '').match(/#([a-zA-Z0-9_]+)/g);
    if (matches) matches.forEach(tag => { hashtagCounts[tag] = (hashtagCounts[tag] || 0) + 1; });
  });
  const trending = Object.entries(hashtagCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(entry => ({ tag: entry[0], count: entry[1] }));

  res.json({ posts: postsWithDetails, trending, followingList });
});

app.post('/api/posts', upload.single('media'), (req, res) => {
  const username = verifySession(req);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  let mediaUrl = null; let mediaType = null;
  if (req.file) {
    mediaUrl = '/uploads/' + req.file.filename;
    mediaType = req.file.mimetype.startsWith('image/') ? 'image' : (req.file.mimetype.startsWith('video/') ? 'video' : 'file');
  }

  db.prepare(`INSERT INTO posts (author, content, media_url, media_type, repost_of, time) VALUES (?, ?, ?, ?, ?, ?)`).run(username, req.body.content || '', mediaUrl, mediaType, req.body.repostOf || null, new Date().toLocaleTimeString());
  broadcast({ type: 'new_post' });
  res.json({ success: true });
});

app.post('/api/posts/:id/like', (req, res) => {
  const username = verifySession(req);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });
  
  const postId = req.params.id;
  const existingLike = db.prepare('SELECT * FROM post_likes WHERE post_id = ? AND username = ?').get(postId, username);
  
  if (existingLike) {
    db.prepare('DELETE FROM post_likes WHERE post_id = ? AND username = ?').run(postId, username);
    db.prepare('UPDATE posts SET likes = MAX(0, likes - 1) WHERE id = ?').run(postId);
  } else {
    db.prepare('INSERT INTO post_likes (post_id, username) VALUES (?, ?)').run(postId, username);
    db.prepare('UPDATE posts SET likes = COALESCE(likes, 0) + 1 WHERE id = ?').run(postId);
  }
  
  broadcast({ type: 'update_post' });
  res.json({ success: true });
});

app.post('/api/posts/:id/reply', (req, res) => {
  const username = verifySession(req);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });
  if (!req.body.content) return res.status(400).json({ error: 'Empty reply' });
  db.prepare('INSERT INTO replies (post_id, parent_reply_id, author, content, time) VALUES (?, ?, ?, ?, ?)').run(req.params.id, req.body.parentReplyId || null, username, req.body.content, new Date().toLocaleTimeString());
  broadcast({ type: 'update_post' });
  res.json({ success: true });
});

app.delete('/api/posts/:id', (req, res) => {
  const username = verifySession(req);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });
  db.prepare('UPDATE posts SET content = ?, media_url = NULL, deleted_at = ? WHERE id = ?').run('[Deleted]', Date.now(), req.params.id);
  broadcast({ type: 'update_post' });
  res.json({ success: true });
});

server.listen(3000, '0.0.0.0', () => console.log('Charcha Server is ON! Visit http://localhost:3000'));