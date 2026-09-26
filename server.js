require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const fs = require('fs');
const path = require('path');
const config = require('./config');

const app = express();
const PORT = process.env.PORT || 3000;

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const files = {
  loa: path.join(dataDir, 'loa.json'),
  tickets: path.join(dataDir, 'tickets.json'),
  announcements: path.join(dataDir, 'announcements.json'),
  chat: path.join(dataDir, 'staffchat.json'),
  audit: path.join(dataDir, 'audit.json'),
  profiles: path.join(dataDir, 'profiles.json'),
  macros: path.join(dataDir, 'macros.json')
};

for (const key of Object.keys(files)) {
  if (!fs.existsSync(files[key])) {
    fs.writeFileSync(files[key], key === 'profiles' ? '{}' : '[]');
  }
}

function read(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function save(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function addAudit(entry) {
  const logs = read(files.audit);
  logs.push({ id: Date.now().toString(), ...entry, at: new Date().toISOString() });
  save(files.audit, logs.slice(-2000));
}
function getProfile(userId) {
  const all = read(files.profiles);
  return all[userId] || {
    displayName: '',
    bio: '',
    tagline: '',
    bannerUrl: '',
    timezone: 'America/Chicago',
    accent: config.colors.primary,
    compactMode: false,
    collapseSidebar: false
  };
}
function saveProfile(userId, data) {
  const all = read(files.profiles);
  all[userId] = Object.assign({}, getProfile(userId), data);
  save(files.profiles, all);
}

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));
passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL,
  scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
  profile.accessToken = accessToken;
  return done(null, profile);
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'lsc-secret',
  resave: false,
  saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

async function getMemberRoles(userId) {
  try {
    const res = await fetch('https://discord.com/api/v10/guilds/' + process.env.GUILD_ID + '/members/' + userId, {
      headers: { Authorization: 'Bot ' + process.env.BOT_TOKEN }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.roles || [];
  } catch (e) { return []; }
}
async function getGuildRoles() {
  try {
    const res = await fetch('https://discord.com/api/v10/guilds/' + process.env.GUILD_ID + '/roles', {
      headers: { Authorization: 'Bot ' + process.env.BOT_TOKEN }
    });
    if (!res.ok) return [];
    return await res.json();
  } catch (e) { return []; }
}
async function getHighestRoleName(userId) {
  try {
    const memberRoles = await getMemberRoles(userId);
    const guildRoles = await getGuildRoles();
    const userRoles = guildRoles.filter(r => memberRoles.includes(r.id)).sort((a, b) => b.position - a.position);
    return userRoles[0] ? userRoles[0].name : 'Staff';
  } catch (e) { return 'Staff'; }
}
function containsBadWord(text) {
  const lower = String(text || '').toLowerCase();
  return config.badWords.some(w => lower.includes(w));
}
async function dmUser(userId, embed) {
  try {
    const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: { Authorization: 'Bot ' + process.env.BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: userId })
    });
    const dm = await dmRes.json();
    if (!dm.id) return false;
    await fetch('https://discord.com/api/v10/channels/' + dm.id + '/messages', {
      method: 'POST',
      headers: { Authorization: 'Bot ' + process.env.BOT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] })
    });
    return true;
  } catch (e) {
    console.error('DM failed', e);
    return false;
  }
}
async function checkAccess(req, res, next) {
  if (!req.isAuthenticated()) return res.redirect('/login');
  const memberRoles = await getMemberRoles(req.user.id);
  const guildRoles = await getGuildRoles();
  const webRole = guildRoles.find(r => r.name === config.roles.webAccess);
  const botRole = guildRoles.find(r => r.name === config.roles.botManagement);
  const hasWeb = webRole && memberRoles.includes(webRole.id);
  const hasBot = botRole && memberRoles.includes(botRole.id);
  if (!hasWeb && !hasBot) {
    return res.send('<!DOCTYPE html><html><body style="background:#070b14;color:#fff;font-family:system-ui;display:flex;height:100vh;align-items:center;justify-content:center;text-align:center"><div><h1>Access Denied</h1><p>You need <b>' + config.roles.webAccess + '</b></p><a href="/logout" style="color:#0ea5e9">Logout</a></div></body></html>');
  }
  req.user.hasBotManagement = !!hasBot;
  next();
}

function layout(user, title, content, highestRank) {
  highestRank = highestRank || 'Staff';
  const isManager = user.hasBotManagement;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${title} • ${config.siteName}</title>
<link rel="icon" href="${config.favicon || config.logo}"/>
<style>
:root{--bg:${config.colors.background};--card:${config.colors.card};--primary:${config.colors.primary};--text:${config.colors.text};--muted:${config.colors.muted};--border:rgba(255,255,255,.08);--shadow:0 10px 30px rgba(0,0,0,.25)}
body.light{--bg:#f4f7fb;--card:#ffffff;--text:#0f172a;--muted:#64748b;--border:#e2e8f0;--shadow:0 8px 24px rgba(15,23,42,.08)}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,system-ui,sans-serif;background:radial-gradient(1200px 600px at 10% -10%,rgba(14,165,233,.12),transparent),var(--bg);color:var(--text);min-height:100vh}
.sidebar{width:270px;background:rgba(18,26,43,.92);border-right:1px solid var(--border);height:100vh;position:fixed;padding:22px 14px;display:flex;flex-direction:column;backdrop-filter:blur(10px)}
body.light .sidebar{background:rgba(255,255,255,.95)}
.logo{display:flex;align-items:center;gap:12px;margin-bottom:28px;padding:8px}
.logo img{width:42px;height:42px;border-radius:12px;object-fit:cover;box-shadow:var(--shadow)}
.logo-text{font-weight:750;font-size:15px;line-height:1.2}
.logo-text span{display:block;font-size:11px;color:var(--muted);font-weight:500}
.nav a{display:block;padding:12px 14px;border-radius:12px;color:var(--muted);text-decoration:none;margin-bottom:6px;font-size:14px;font-weight:600}
.nav a:hover,.nav a.active{background:rgba(14,165,233,.14);color:var(--primary)}
.main{margin-left:270px;padding:28px 34px}
.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
.profile{display:flex;align-items:center;gap:12px;background:var(--card);padding:8px 14px 8px 8px;border-radius:999px;border:1px solid var(--border);box-shadow:var(--shadow)}
.profile img{width:36px;height:36px;border-radius:50%}
.card{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:20px;margin-bottom:16px;box-shadow:var(--shadow)}
h1{font-size:28px;letter-spacing:-.02em}h2{font-size:18px;margin-bottom:10px}
.muted{color:var(--muted);font-size:14px}
.btn{background:var(--primary);color:#fff;border:none;padding:10px 16px;border-radius:12px;cursor:pointer;font-weight:700;text-decoration:none;display:inline-block;font-size:14px}
.btn:hover{filter:brightness(1.08)}
.btn-outline{background:transparent;border:1px solid var(--border);color:var(--text)}
input,textarea,select{width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--border);background:rgba(0,0,0,.18);color:var(--text);margin:8px 0 12px;font-size:14px}
body.light input,body.light textarea,body.light select{background:#fff}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.badge{display:inline-block;background:rgba(14,165,233,.16);color:var(--primary);font-size:11px;padding:4px 9px;border-radius:999px;font-weight:700}
.msg{padding:12px;border-radius:12px;margin-bottom:10px;background:rgba(255,255,255,.03);border:1px solid var(--border)}
.msg.staff{border-left:3px solid var(--primary)}.msg.user{border-left:3px solid #22c55e}
@media(max-width:980px){.sidebar{display:none}.main{margin-left:0}.grid,.grid-4{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="sidebar">
  <div class="logo"><img src="${config.logo}" alt="Logo"/><div class="logo-text">${config.siteName}<span>${config.siteSubtitle}</span></div></div>
  <div class="nav">
    <a href="/dashboard" class="${title==='Dashboard'?'active':''}">Dashboard</a>
    <a href="/loa" class="${title==='LOA'?'active':''}">Leave of Absence</a>
    <a href="/support" class="${title==='Support'?'active':''}">Support</a>
    <a href="/settings" class="${title==='Settings'?'active':''}">Settings</a>
    ${isManager ? `
      <a href="/announcements" class="${title==='Announcements'?'active':''}">Announcements</a>
      <a href="/notifications" class="${title==='Notifications'?'active':''}">Notifications</a>
      <a href="/logs" class="${title==='Logs'?'active':''}">Logs</a>
    ` : ''}
    <a href="/logout" style="margin-top:auto;color:#f87171">Logout</a>
  </div>
</div>
<div class="main">
  <div class="topbar">
    <div><h1>${title}</h1></div>
    <div style="display:flex;align-items:center;gap:12px">
      <button class="btn btn-outline" onclick="toggleTheme()" style="padding:8px 12px">Theme</button>
      <div class="profile">
        <img src="${user.avatar ? 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png' : 'https://via.placeholder.com/36'}" alt=""/>
        <div style="font-size:13px;line-height:1.2"><div style="font-weight:700">${user.username}</div><div class="muted" style="font-size:11px">${highestRank}</div></div>
      </div>
    </div>
  </div>
  ${content}
</div>
<script>
function toggleTheme(){document.body.classList.toggle('light');localStorage.setItem('theme',document.body.classList.contains('light')?'light':'dark')}
if(localStorage.getItem('theme')==='light')document.body.classList.add('light');
var idle=0;function resetIdle(){idle=0}
setInterval(function(){idle++;if(idle>=30)location.href='/logout'},60000);
['load','mousemove','keypress','click','scroll'].forEach(function(e){window.addEventListener(e,resetIdle)});
</script>
</body></html>`;
}

app.get('/', function(req, res) {
  if (req.isAuthenticated()) return res.redirect('/dashboard');
  res.redirect('/login');
});

app.get('/login', function(req, res) {
  res.send(`<!DOCTYPE html><html><head><title>Login • ${config.siteName}</title>
<link rel="icon" href="${config.favicon || config.logo}"/>
<style>
body{margin:0;font-family:system-ui;background:#070b14;color:#fff;display:flex;height:100vh;align-items:center;justify-content:center}
.box{background:#121a2b;padding:48px;border-radius:20px;text-align:center;width:400px;border:1px solid rgba(255,255,255,.08);box-shadow:0 20px 50px rgba(0,0,0,.35)}
img{width:84px;height:84px;border-radius:18px;margin-bottom:18px}
a{display:inline-block;background:#5865F2;color:#fff;padding:12px 28px;border-radius:12px;text-decoration:none;font-weight:700;margin-top:18px}
</style></head>
<body><div class="box"><img src="${config.loginLogo}" alt=""/><h1>${config.siteName}</h1><p style="color:#8b9bb8">Staff Panel • Authorized only</p><a href="/auth/discord">Login with Discord</a></div></body></html>`);
});

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/login' }), function(req, res) {
  res.redirect('/dashboard');
});
app.get('/logout', function(req, res) {
  req.logout(function() { res.redirect('/login'); });
});

// ONE ticket per user
app.post('/api/modmail/ticket', function(req, res) {
  if (req.headers['x-modmail-secret'] !== process.env.MODMAIL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const userId = String(req.body.userId || '');
  const username = req.body.username || 'Unknown';
  const content = req.body.content;
  const tickets = read(files.tickets);

  let ticket = tickets.find(function(t) {
    return String(t.userId) === userId && t.status !== 'closed';
  });

  if (!ticket) {
    ticket = {
      id: Date.now().toString(),
      userId: userId,
      username: username,
      status: 'pending_staff',
      priority: 'normal',
      type: 'general',
      claimedBy: null,
      claimedByName: null,
      subject: 'ModMail',
      messages: [],
      createdAt: new Date().toISOString()
    };
    tickets.push(ticket);
  } else {
    ticket.username = username || ticket.username;
    if (ticket.status === 'pending_user' || ticket.status === 'resolved') {
      ticket.status = ticket.claimedBy ? 'claimed' : 'pending_staff';
    }
  }

  if (content) {
    ticket.messages.push({
      from: 'user',
      author: username,
      content: content,
      timestamp: new Date().toISOString()
    });
  }

  save(files.tickets, tickets);
  res.json({ success: true, ticket: ticket });
});

app.get('/dashboard', checkAccess, async function(req, res) {
  const announcements = read(files.announcements);
  const latest = announcements[announcements.length - 1];
  const chat = read(files.chat).slice(-40).reverse();
  const qotd = config.questionsOfTheDay[new Date().getDate() % config.questionsOfTheDay.length];
  const highestRank = await getHighestRoleName(req.user.id);
  const chatHTML = chat.map(function(m) {
    return '<div style="padding:12px 0;border-bottom:1px solid var(--border)"><strong>' + m.username + '</strong> <span class="muted" style="font-size:12px">' + new Date(m.createdAt).toLocaleString() + '</span><p style="margin-top:5px">' + m.content + '</p></div>';
  }).join('') || '<p class="muted">No messages yet.</p>';
  const latestHTML = latest ? ('<p><strong>' + latest.title + '</strong></p><p class="muted">' + latest.content + '</p><small class="muted">By ' + latest.author + '</small>') : '<p class="muted">None yet</p>';

  res.send(layout(req.user, 'Dashboard', `
    <div class="card"><h2>Welcome back, ${req.user.username}</h2><p class="muted">Highest Rank: <strong>${highestRank}</strong></p></div>
    <div class="grid">
      <div class="card"><h2>Latest Announcement</h2>${latestHTML}</div>
      <div class="card"><h2>Question of the Day</h2><p style="margin-bottom:14px">${qotd}</p>
        <form method="POST" action="/chat/post"><input type="hidden" name="type" value="qotd"/><textarea name="content" required rows="3"></textarea><button class="btn" type="submit">Post Answer</button></form></div>
    </div>
    <div class="card"><h2>Staff Chat</h2><div style="max-height:400px;overflow-y:auto;margin-bottom:16px">${chatHTML}</div>
      <form method="POST" action="/chat/post"><input type="hidden" name="type" value="chat"/><textarea name="content" required rows="2"></textarea><button class="btn" type="submit">Send</button></form></div>
  `, highestRank));
});

app.post('/chat/post', checkAccess, function(req, res) {
  const content = String(req.body.content || '').trim();
  if (!content) return res.redirect('/dashboard');
  if (containsBadWord(content)) return res.send('<p style="color:#fff;background:#070b14;padding:40px;text-align:center">Blocked. <a href="/dashboard" style="color:#0ea5e9">Back</a></p>');
  const chat = read(files.chat);
  chat.push({ id: Date.now(), userId: req.user.id, username: req.user.username, content: content, type: req.body.type || 'chat', createdAt: new Date().toISOString() });
  save(files.chat, chat);
  addAudit({ type: 'staff_chat', actorId: req.user.id, actor: req.user.username, detail: content.slice(0, 200) });
  res.redirect('/dashboard');
});

app.get('/support', checkAccess, async function(req, res) {
  const highestRank = await getHighestRoleName(req.user.id);
  const tickets = read(files.tickets);
  const open = tickets.filter(t => ['open', 'claimed', 'pending_staff'].includes(t.status));
  const waitingUser = tickets.filter(t => t.status === 'pending_user');
  const resolved = tickets.filter(t => t.status === 'resolved' || t.status === 'closed');
  const status = req.query.status || 'all';
  const priority = req.query.priority || 'all';
  const assigned = req.query.assigned || 'all';
  const q = String(req.query.q || '').toLowerCase();
  let filtered = tickets.slice().reverse();
  if (status !== 'all') filtered = filtered.filter(t => t.status === status);
  if (priority !== 'all') filtered = filtered.filter(t => (t.priority || 'normal') === priority);
  if (assigned === 'me') filtered = filtered.filter(t => t.claimedBy === req.user.id);
  if (assigned === 'unassigned') filtered = filtered.filter(t => !t.claimedBy);
  if (q) filtered = filtered.filter(t => String(t.username || '').toLowerCase().includes(q) || String(t.userId || '').includes(q) || String(t.id || '').includes(q));

  const cards = filtered.map(function(t) {
    const last = t.messages && t.messages.length ? t.messages[t.messages.length - 1] : null;
    return '<div class="card"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><div><strong>' + t.username + '</strong> <span class="muted">#' + t.id + '</span> <span class="badge">' + (t.type || 'general') + '</span> <span class="badge">' + t.status + '</span> <span class="badge">' + (t.priority || 'normal') + '</span><p class="muted" style="margin-top:6px">' + (last ? last.content.slice(0, 120) : 'No messages') + '</p><small class="muted">' + (last ? ('Last: ' + new Date(last.timestamp).toLocaleString() + ' by ' + last.author) : '') + (t.claimedByName ? (' • Assigned: ' + t.claimedByName) : ' • Unassigned') + ' • ' + ((t.messages || []).length) + ' messages</small></div><a class="btn" href="/support/ticket/' + t.id + '">Open</a></div></div>';
  }).join('') || '<p class="muted">No tickets found.</p>';

  res.send(layout(req.user, 'Support', `
    <div class="grid-4">
      <div class="card"><h2>${open.length}</h2><p class="muted">Open / Pending Staff</p></div>
      <div class="card"><h2>${waitingUser.length}</h2><p class="muted">Waiting on User</p></div>
      <div class="card"><h2>${resolved.length}</h2><p class="muted">Resolved / Closed</p></div>
      <div class="card"><h2>${tickets.length}</h2><p class="muted">Total</p></div>
    </div>
    <div class="card"><h2>Queue</h2>
      <form method="GET" action="/support" style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr auto;gap:10px;align-items:end">
        <div><label class="muted">Search</label><input name="q" value="${req.query.q || ''}" placeholder="Username, ID..."/></div>
        <div><label class="muted">Status</label><select name="status"><option value="all">All</option><option value="pending_staff" ${status==='pending_staff'?'selected':''}>Pending Staff</option><option value="pending_user" ${status==='pending_user'?'selected':''}>Pending User</option><option value="claimed" ${status==='claimed'?'selected':''}>Claimed</option><option value="resolved" ${status==='resolved'?'selected':''}>Resolved</option><option value="closed" ${status==='closed'?'selected':''}>Closed</option></select></div>
        <div><label class="muted">Priority</label><select name="priority"><option value="all">All</option><option value="low" ${priority==='low'?'selected':''}>Low</option><option value="normal" ${priority==='normal'?'selected':''}>Normal</option><option value="high" ${priority==='high'?'selected':''}>High</option><option value="urgent" ${priority==='urgent'?'selected':''}>Urgent</option></select></div>
        <div><label class="muted">Assigned</label><select name="assigned"><option value="all">Everyone</option><option value="me" ${assigned==='me'?'selected':''}>Me</option><option value="unassigned" ${assigned==='unassigned'?'selected':''}>Unassigned</option></select></div>
        <button class="btn" type="submit">Filter</button>
      </form>
    </div>
    <div style="margin-bottom:12px"><a class="btn btn-outline" href="/support/macros">Macros</a></div>
    ${cards}
  `, highestRank));
});

app.get('/support/macros', checkAccess, async function(req, res) {
  const highestRank = await getHighestRoleName(req.user.id);
  const macros = read(files.macros);
  const list = macros.map(function(m) {
    return '<div class="card"><strong>' + m.title + '</strong> <span class="badge">' + (m.active ? 'Active' : 'Inactive') + '</span><p class="muted" style="margin-top:8px">' + m.content + '</p><form method="POST" action="/support/macros/' + m.id + '/toggle" style="display:inline"><button class="btn btn-outline" type="submit">' + (m.active ? 'Set Inactive' : 'Set Active') + '</button></form> <form method="POST" action="/support/macros/' + m.id + '/delete" style="display:inline;margin-left:8px"><button class="btn btn-outline" type="submit">Delete</button></form></div>';
  }).join('') || '<p class="muted">No macros yet.</p>';
  res.send(layout(req.user, 'Support', `
    <div class="card"><h2>Create Macro</h2><p class="muted">Variables: {{username}} {{id}}</p>
      <form method="POST" action="/support/macros/create"><input name="title" required placeholder="Title"/><textarea name="content" required rows="4" placeholder="Hello {{username}}..."></textarea><button class="btn" type="submit">Save Macro</button></form></div>
    <h2 style="margin:18px 0 12px">Saved Macros</h2>${list}<a class="btn btn-outline" href="/support">Back</a>
  `, highestRank));
});
app.post('/support/macros/create', checkAccess, function(req, res) {
  const macros = read(files.macros);
  macros.push({ id: Date.now().toString(), title: req.body.title, content: req.body.content, active: true, createdBy: req.user.username, createdAt: new Date().toISOString() });
  save(files.macros, macros);
  addAudit({ type: 'macro_create', actorId: req.user.id, actor: req.user.username, detail: req.body.title });
  res.redirect('/support/macros');
});
app.post('/support/macros/:id/toggle', checkAccess, function(req, res) {
  const macros = read(files.macros);
  const m = macros.find(x => x.id === req.params.id);
  if (m) m.active = !m.active;
  save(files.macros, macros);
  res.redirect('/support/macros');
});
app.post('/support/macros/:id/delete', checkAccess, function(req, res) {
  save(files.macros, read(files.macros).filter(x => x.id !== req.params.id));
  res.redirect('/support/macros');
});

app.get('/support/ticket/:id', checkAccess, async function(req, res) {
  const tickets = read(files.tickets);
  const ticket = tickets.find(t => t.id === req.params.id);
  if (!ticket) return res.redirect('/support');
  const highestRank = await getHighestRoleName(req.user.id);
  const macros = read(files.macros).filter(m => m.active);
  let memberInfo = { username: ticket.username, id: ticket.userId, avatar: null };
  try {
    const ures = await fetch('https://discord.com/api/v10/users/' + ticket.userId, { headers: { Authorization: 'Bot ' + process.env.BOT_TOKEN } });
    if (ures.ok) {
      const u = await ures.json();
      memberInfo.username = u.username;
      if (u.avatar) memberInfo.avatar = 'https://cdn.discordapp.com/avatars/' + u.id + '/' + u.avatar + '.png';
    }
  } catch (e) {}

  const messages = (ticket.messages || []).map(function(m) {
    return '<div class="msg ' + m.from + '"><strong>' + m.author + '</strong>' + (m.internal ? ' <span class="badge">Internal</span>' : '') + ' <span class="muted" style="font-size:12px">' + new Date(m.timestamp).toLocaleString() + '</span><p style="margin-top:6px">' + m.content + '</p></div>';
  }).join('') || '<p class="muted">No messages</p>';
  const macroOptions = macros.map(m => '<option value="' + m.id + '">' + m.title + '</option>').join('');

  res.send(layout(req.user, 'Support', `
    <div class="grid" style="grid-template-columns:2fr 1fr">
      <div>
        <div class="card"><h2>${ticket.username}</h2>
          <p class="muted">${ticket.type || 'general'} • #${ticket.id} • Status: <strong>${ticket.status}</strong> • Priority: <strong>${ticket.priority || 'normal'}</strong>${ticket.claimedByName ? ' • Assigned: ' + ticket.claimedByName : ''}</p>
        </div>
        <div class="card"><h2>Conversation</h2>
          <div style="max-height:420px;overflow-y:auto;margin-bottom:14px">${messages}</div>
          <form method="POST" action="/support/ticket/${ticket.id}/reply">
            <label class="muted">Reply type</label>
            <select name="replyType"><option value="public">Public Reply</option><option value="internal">Internal Note</option></select>
            <label class="muted">Macro</label>
            <select name="macroId"><option value="">None</option>${macroOptions}</select>
            <textarea name="content" rows="4" placeholder="Message..."></textarea>
            <button class="btn" type="submit">Send</button>
          </form>
          <button class="btn btn-outline" type="button" style="margin-top:10px" onclick="openCloseModal()">Close Ticket</button>
          <div id="closeModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:50;align-items:center;justify-content:center">
            <div class="card" style="max-width:420px;margin:auto"><h2>Close this ticket?</h2><p class="muted" style="margin:12px 0">Are you sure?</p>
              <div style="display:flex;gap:10px;justify-content:flex-end">
                <button class="btn btn-outline" type="button" onclick="closeCloseModal()">Cancel</button>
                <form method="POST" action="/support/ticket/${ticket.id}/close" style="margin:0"><button id="confirmCloseBtn" class="btn" type="submit" disabled style="background:#6b7280">Wait...</button></form>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div>
        <div class="card"><h2>Member Lookup</h2>
          <img src="${memberInfo.avatar || 'https://via.placeholder.com/64'}" style="width:64px;height:64px;border-radius:50%;margin-bottom:10px"/>
          <p><strong>${memberInfo.username}</strong></p><p class="muted">${memberInfo.id}</p>
        </div>
        <div class="card"><h2>Claim / Assign</h2>
          <form method="POST" action="/support/ticket/${ticket.id}/claim">
            <button class="btn" type="submit">${ticket.claimedBy ? 'Re-assign to Me' : 'Claim Ticket'}</button>
          </form>
        </div>
        <div class="card"><h2>Status</h2>
          <form method="POST" action="/support/ticket/${ticket.id}/status">
            <select name="status">
              <option value="pending_staff" ${ticket.status==='pending_staff'?'selected':''}>Pending Staff</option>
              <option value="pending_user" ${ticket.status==='pending_user'?'selected':''}>Pending User</option>
              <option value="claimed" ${ticket.status==='claimed'?'selected':''}>Claimed</option>
              <option value="resolved" ${ticket.status==='resolved'?'selected':''}>Resolved</option>
              <option value="closed" ${ticket.status==='closed'?'selected':''}>Closed</option>
            </select>
            <button class="btn" type="submit">Update Status</button>
          </form>
        </div>
        <div class="card"><h2>Priority</h2>
          <form method="POST" action="/support/ticket/${ticket.id}/priority">
            <select name="priority">
              <option value="low" ${(ticket.priority||'normal')==='low'?'selected':''}>Low</option>
              <option value="normal" ${(ticket.priority||'normal')==='normal'?'selected':''}>Normal</option>
              <option value="high" ${(ticket.priority||'normal')==='high'?'selected':''}>High</option>
              <option value="urgent" ${(ticket.priority||'normal')==='urgent'?'selected':''}>Urgent</option>
            </select>
            <button class="btn" type="submit">Update Priority</button>
          </form>
        </div>
      </div>
    </div>
    <a class="btn btn-outline" href="/support">Back to Queue</a>
    <script>
      function openCloseModal(){var m=document.getElementById('closeModal');var b=document.getElementById('confirmCloseBtn');m.style.display='flex';b.disabled=true;b.style.background='#6b7280';b.textContent='Wait...';setTimeout(function(){b.disabled=false;b.style.background='#dc2626';b.textContent='Yes, close ticket'},2000)}
      function closeCloseModal(){document.getElementById('closeModal').style.display='none'}
    </script>
  `, highestRank));
});

app.post('/support/ticket/:id/claim', checkAccess, async function(req, res) {
  const tickets = read(files.tickets);
  const ticket = tickets.find(t => t.id === req.params.id);
  if (ticket) {
    ticket.status = 'claimed';
    ticket.claimedBy = req.user.id;
    ticket.claimedByName = req.user.username;
    save(files.tickets, tickets);
    addAudit({ type: 'ticket_claim', actorId: req.user.id, actor: req.user.username, detail: 'Claimed ' + ticket.username });
    await dmUser(ticket.userId, { color: 0x003768, title: 'Ticket Claimed', description: 'Your ticket has been claimed by **' + req.user.username + '**.', footer: { text: 'Lone Star College • ModMail' }, timestamp: new Date().toISOString() });
  }
  res.redirect('/support/ticket/' + req.params.id);
});

app.post('/support/ticket/:id/reply', checkAccess, async function(req, res) {
  const tickets = read(files.tickets);
  const ticket = tickets.find(t => t.id === req.params.id);
  if (!ticket) return res.redirect('/support');
  let content = String(req.body.content || '').trim();
  const replyType = req.body.replyType || 'public';
  const macroId = req.body.macroId;
  if (macroId) {
    const macro = read(files.macros).find(m => m.id === macroId);
    if (macro) content = macro.content.replace(/\{\{username\}\}/g, ticket.username).replace(/\{\{id\}\}/g, ticket.userId);
  }
  if (!content) return res.redirect('/support/ticket/' + req.params.id);
  if (containsBadWord(content)) return res.send('Blocked. <a href="/support">Back</a>');
  const isInternal = replyType === 'internal';
  ticket.messages.push({ from: 'staff', author: req.user.username, content: content, internal: isInternal, timestamp: new Date().toISOString() });
  if (!isInternal) {
    ticket.status = 'pending_user';
    await dmUser(ticket.userId, { color: 0x003768, title: 'Lone Star College Staff', description: content, footer: { text: 'Replied by ' + req.user.username }, timestamp: new Date().toISOString() });
  }
  save(files.tickets, tickets);
  addAudit({ type: isInternal ? 'ticket_note' : 'ticket_reply', actorId: req.user.id, actor: req.user.username, detail: ticket.username });
  res.redirect('/support/ticket/' + req.params.id);
});

app.post('/support/ticket/:id/status', checkAccess, function(req, res) {
  const tickets = read(files.tickets);
  const ticket = tickets.find(t => t.id === req.params.id);
  if (ticket) { ticket.status = req.body.status; save(files.tickets, tickets); }
  res.redirect('/support/ticket/' + req.params.id);
});
app.post('/support/ticket/:id/priority', checkAccess, function(req, res) {
  const tickets = read(files.tickets);
  const ticket = tickets.find(t => t.id === req.params.id);
  if (ticket) { ticket.priority = req.body.priority; save(files.tickets, tickets); }
  res.redirect('/support/ticket/' + req.params.id);
});
app.post('/support/ticket/:id/close', checkAccess, function(req, res) {
  const tickets = read(files.tickets);
  const ticket = tickets.find(t => t.id === req.params.id);
  if (ticket) { ticket.status = 'closed'; save(files.tickets, tickets); addAudit({ type: 'ticket_close', actorId: req.user.id, actor: req.user.username, detail: 'Closed ' + ticket.username }); }
  res.redirect('/support');
});

app.get('/loa', checkAccess, async function(req, res) {
  const loas = read(files.loa).filter(l => l.active);
  const highestRank = await getHighestRoleName(req.user.id);
  const list = loas.map(l => '<div class="card"><strong>' + l.username + '</strong> <span class="badge">Active</span><p class="muted">' + l.reason + '</p><small class="muted">' + l.start + ' → ' + l.end + '</small></div>').join('') || '<p class="muted">No active LOAs</p>';
  res.send(layout(req.user, 'LOA', '<div class="card"><h2>Request LOA</h2><form method="POST" action="/loa/request"><input name="reason" required placeholder="Reason"/><div class="grid"><input name="start" type="date" required/><input name="end" type="date" required/></div><button class="btn" type="submit">Submit</button></form></div><h2 style="margin:20px 0 12px">Active LOAs</h2>' + list, highestRank));
});
app.post('/loa/request', checkAccess, function(req, res) {
  const loas = read(files.loa);
  loas.push({ id: Date.now(), userId: req.user.id, username: req.user.username, reason: req.body.reason, start: req.body.start, end: req.body.end, active: true, createdAt: new Date().toISOString() });
  save(files.loa, loas);
  addAudit({ type: 'loa_request', actorId: req.user.id, actor: req.user.username, detail: req.body.reason });
  res.redirect('/loa');
});

app.get('/announcements', checkAccess, async function(req, res) {
  if (!req.user.hasBotManagement) return res.redirect('/dashboard');
  const highestRank = await getHighestRoleName(req.user.id);
  const list = read(files.announcements).reverse().map(a => '<div class="card"><strong>' + a.title + '</strong><p class="muted">' + a.content + '</p><small class="muted">By ' + a.author + '</small></div>').join('') || '<p class="muted">None</p>';
  res.send(layout(req.user, 'Announcements', '<div class="card"><h2>Post Announcement</h2><form method="POST" action="/announcements/create"><input name="title" required/><textarea name="content" required rows="4"></textarea><button class="btn" type="submit">Post</button></form></div><h2 style="margin:20px 0 12px">Previous</h2>' + list, highestRank));
});
app.post('/announcements/create', checkAccess, function(req, res) {
  if (!req.user.hasBotManagement) return res.redirect('/dashboard');
  const a = read(files.announcements);
  a.push({ id: Date.now(), title: req.body.title, content: req.body.content, author: req.user.username, createdAt: new Date().toISOString() });
  save(files.announcements, a);
  addAudit({ type: 'announcement', actorId: req.user.id, actor: req.user.username, detail: req.body.title });
  res.redirect('/announcements');
});

app.get('/notifications', checkAccess, async function(req, res) {
  if (!req.user.hasBotManagement) return res.redirect('/dashboard');
  const highestRank = await getHighestRoleName(req.user.id);
  res.send(layout(req.user, 'Notifications', '<div class="card"><h2>Send Staff Notification</h2><form method="POST" action="/notifications/send"><input name="title" required/><textarea name="message" required rows="4"></textarea><button class="btn" type="submit">Send</button></form></div>', highestRank));
});
app.post('/notifications/send', checkAccess, function(req, res) {
  if (!req.user.hasBotManagement) return res.redirect('/dashboard');
  addAudit({ type: 'notification', actorId: req.user.id, actor: req.user.username, detail: req.body.title + ': ' + req.body.message });
  res.redirect('/notifications');
});

app.get('/logs', checkAccess, async function(req, res) {
  if (!req.user.hasBotManagement) return res.redirect('/dashboard');
  const highestRank = await getHighestRoleName(req.user.id);
  const rows = read(files.audit).slice().reverse().slice(0, 300).map(l => '<div class="card" style="padding:14px"><strong>' + l.type + '</strong> <span class="muted">' + new Date(l.at).toLocaleString() + '</span><p style="margin-top:6px"><strong>' + (l.actor || 'System') + '</strong>: ' + (l.detail || '') + '</p></div>').join('') || '<p class="muted">No logs yet.</p>';
  res.send(layout(req.user, 'Logs', '<div class="card"><h2>Website Audit Logs</h2><p class="muted">These cannot be deleted from the panel.</p></div>' + rows, highestRank));
});

app.get('/settings', checkAccess, async function(req, res) {
  const highestRank = await getHighestRoleName(req.user.id);
  const p = getProfile(req.user.id);
  const tab = req.query.tab || 'profile';
  const tabs = '<div style="display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap"><a class="btn ' + (tab==='profile'?'':'btn-outline') + '" href="/settings?tab=profile">Profile</a><a class="btn ' + (tab==='account'?'':'btn-outline') + '" href="/settings?tab=account">Account Info</a><a class="btn ' + (tab==='appearance'?'':'btn-outline') + '" href="/settings?tab=appearance">Appearance</a></div>';
  let body = '';
  if (tab === 'profile') {
    body = '<div class="card"><h2>Profile</h2><form method="POST" action="/settings/profile"><input name="displayName" value="' + (p.displayName || '') + '" placeholder="Display name"/><input name="tagline" value="' + (p.tagline || '') + '" placeholder="Tagline"/><textarea name="bio" rows="4" placeholder="Bio">' + (p.bio || '') + '</textarea><input name="bannerUrl" value="' + (p.bannerUrl || '') + '" placeholder="Banner URL"/><input name="timezone" value="' + (p.timezone || 'America/Chicago') + '" placeholder="Timezone"/><button class="btn" type="submit">Save Profile</button></form></div>';
  } else if (tab === 'account') {
    body = '<div class="card"><h2>Account Info</h2><p><strong>Discord ID:</strong> ' + req.user.id + '</p><p><strong>Username:</strong> ' + req.user.username + '</p><p><strong>Highest Rank:</strong> ' + highestRank + '</p><form method="POST" action="/settings/sync-roles" style="margin-top:14px"><button class="btn" type="submit">Sync Roles from Discord</button></form></div>';
  } else {
    body = '<div class="card"><h2>Appearance</h2><form method="POST" action="/settings/appearance"><input name="accent" value="' + (p.accent || config.colors.primary) + '" placeholder="#0ea5e9"/><label><input type="checkbox" name="compactMode" ' + (p.compactMode ? 'checked' : '') + '/> Compact mode</label><br/><br/><label><input type="checkbox" name="collapseSidebar" ' + (p.collapseSidebar ? 'checked' : '') + '/> Collapse sidebar by default</label><br/><br/><button class="btn" type="submit">Save Changes</button></form></div>';
  }
  res.send(layout(req.user, 'Settings', '<div class="card"><h2>Settings</h2><p class="muted">Manage profile and preferences.</p></div>' + tabs + body, highestRank));
});
app.post('/settings/profile', checkAccess, function(req, res) {
  saveProfile(req.user.id, { displayName: req.body.displayName || '', tagline: req.body.tagline || '', bio: req.body.bio || '', bannerUrl: req.body.bannerUrl || '', timezone: req.body.timezone || 'America/Chicago' });
  res.redirect('/settings?tab=profile');
});
app.post('/settings/appearance', checkAccess, function(req, res) {
  saveProfile(req.user.id, { accent: req.body.accent || config.colors.primary, compactMode: !!req.body.compactMode, collapseSidebar: !!req.body.collapseSidebar });
  res.redirect('/settings?tab=appearance');
});
app.post('/settings/sync-roles', checkAccess, function(req, res) {
  res.redirect('/settings?tab=account');
});

app.listen(PORT, function() {
  console.log('Staff Panel running on port ' + PORT);
});
