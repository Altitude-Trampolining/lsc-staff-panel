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
  profiles: path.join(dataDir, 'profiles.json')
};

Object.entries(files).forEach(([key, file]) => {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, key === 'profiles' ? '{}' : '[]');
  }
});

const read = (f) => JSON.parse(fs.readFileSync(f));
const save = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

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
    accent: '#0ea5e9',
    compactMode: false,
    collapseSidebar: false
  };
}

function saveProfile(userId, data) {
  const all = read(files.profiles);
  all[userId] = { ...getProfile(userId), ...data };
  save(files.profiles, all);
}

passport.serializeUser((u, d) => d(null, u));
passport.deserializeUser((o, d) => d(null, o));
passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL,
  scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
  profile.accessToken = accessToken;
  done(null, profile);
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
    const r = await fetch(`https://discord.com/api/v10/guilds/${process.env.GUILD_ID}/members/${userId}`, {
      headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` }
    });
    if (!r.ok) return [];
    return (await r.json()).roles || [];
  } catch { return []; }
}

async function getGuildRoles() {
  try {
    const r = await fetch(`https://discord.com/api/v10/guilds/${process.env.GUILD_ID}/roles`, {
      headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` }
    });
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

async function getHighestRoleName(userId) {
  try {
    const memberRoles = await getMemberRoles(userId);
    const guildRoles = await getGuildRoles();
    const userRoles = guildRoles.filter(r => memberRoles.includes(r.id)).sort((a, b) => b.position - a.position);
    return userRoles[0]?.name || 'Staff';
  } catch { return 'Staff'; }
}

function containsBadWord(text) {
  const lower = (text || '').toLowerCase();
  return config.badWords.some(w => lower.includes(w));
}

async function dmUser(userId, embed) {
  try {
    const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: {
        Authorization: `Bot ${process.env.BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ recipient_id: userId })
    });
    const dm = await dmRes.json();
    if (!dm.id) return false;
    await fetch(`https://discord.com/api/v10/channels/${dm.id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${process.env.BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
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
    return res.send(`<!DOCTYPE html><html><body style="background:#0b1120;color:#fff;font-family:sans-serif;display:flex;height:100vh;align-items:center;justify-content:center;text-align:center"><div><h1>Access Denied</h1><p>You need <b>${config.roles.webAccess}</b></p><a href="/logout" style="color:#0ea5e9">Logout</a></div></body></html>`);
  }
  req.user.hasBotManagement = !!hasBot;
  next();
}

function layout(user, title, content, highestRank = 'Staff') {
  const isManager = user.hasBotManagement;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${title} • ${config.siteName}</title>
<style>
:root{--bg:${config.colors.background};--card:${config.colors.card};--primary:${config.colors.primary};--text:${config.colors.text};--muted:${config.colors.muted};--border:#334155}
body.light{--bg:#f1f5f9;--card:#fff;--text:#0f172a;--muted:#64748b;--border:#e2e8f0}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.sidebar{width:260px;background:var(--card);border-right:1px solid var(--border);height:100vh;position:fixed;padding:24px 16px;display:flex;flex-direction:column}
.logo{display:flex;align-items:center;gap:12px;margin-bottom:32px;padding:0 8px}
.logo img{width:42px;height:42px;border-radius:8px;object-fit:cover}
.logo-text{font-weight:700;font-size:15px;line-height:1.2}
.logo-text span{display:block;font-size:11px;color:var(--muted);font-weight:500}
.nav a{display:block;padding:12px 14px;border-radius:8px;color:var(--muted);text-decoration:none;margin-bottom:4px;font-size:14px}
.nav a:hover,.nav a.active{background:rgba(14,165,233,.12);color:var(--primary)}
.main{margin-left:260px;padding:28px 36px}
.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}
.profile{display:flex;align-items:center;gap:12px;background:var(--card);padding:8px 14px 8px 8px;border-radius:50px;border:1px solid var(--border)}
.profile img{width:36px;height:36px;border-radius:50%}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:22px;margin-bottom:18px}
h1{font-size:26px}h2{font-size:18px;margin-bottom:12px}
.muted{color:var(--muted);font-size:14px}
.btn{background:var(--primary);color:#fff;border:none;padding:10px 18px;border-radius:8px;cursor:pointer;font-weight:600;text-decoration:none;display:inline-block;font-size:14px}
.btn-outline{background:transparent;border:1px solid var(--border);color:var(--text)}
input,textarea,select{width:100%;padding:11px 14px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);margin:8px 0 12px;font-size:14px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.badge{display:inline-block;background:rgba(14,165,233,.15);color:var(--primary);font-size:11px;padding:3px 8px;border-radius:20px;font-weight:600}
.msg{padding:12px;border-radius:10px;margin-bottom:10px;background:var(--bg);border:1px solid var(--border)}
.msg.staff{border-left:3px solid var(--primary)}
.msg.user{border-left:3px solid #22c55e}
@media(max-width:900px){.sidebar{display:none}.main{margin-left:0}.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="sidebar">
  <div class="logo">
    <img src="${config.logo}" alt="Logo"/>
    <div class="logo-text">${config.siteName}<span>${config.siteSubtitle}</span></div>
  </div>
  <div class="nav">
    <a href="/dashboard" class="${title==='Dashboard'?'active':''}">Dashboard</a>
    <a href="/loa" class="${title==='LOA'?'active':''}">Leave of Absence</a>
    <a href="/tickets" class="${title==='Tickets'?'active':''}">Tickets / ModMail</a>
    <a href="/settings" class="${title==='Settings'?'active':''}">Settings</a>
    ${isManager ? `
      <a href="/announcements" class="${title==='Announcements'?'active':''}">Announcements</a>
      <a href="/notifications" class="${title==='Notifications'?'active':''}">Staff Notifications</a>
      <a href="/logs" class="${title==='Logs'?'active':''}">Logs</a>
    ` : ''}
    <a href="/logout" style="margin-top:auto;color:#f87171">Logout</a>
  </div>
</div>
<div class="main">
  <div class="topbar">
    <h1>${title}</h1>
    <div style="display:flex;align-items:center;gap:12px">
      <button class="btn btn-outline" onclick="toggleTheme()" style="padding:8px 12px">Theme</button>
      <div class="profile">
        <img src="${user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : 'https://via.placeholder.com/36'}" alt=""/>
        <div style="font-size:13px;line-height:1.2">
          <div style="font-weight:600">${user.username}</div>
          <div class="muted" style="font-size:11px">${highestRank}</div>
        </div>
      </div>
    </div>
  </div>
  ${content}
</div>
<script>
function toggleTheme(){document.body.classList.toggle('light');localStorage.setItem('theme',document.body.classList.contains('light')?'light':'dark')}
if(localStorage.getItem('theme')==='light')document.body.classList.add('light');
let idle=0; const max=30; function reset(){idle=0}
setInterval(()=>{idle++; if(idle>=max) location.href='/logout'},60000);
['load','mousemove','keypress','click','scroll'].forEach(e=>window.addEventListener(e,reset));
</script>
</body></html>`;
}

app.get('/', (req, res) => req.isAuthenticated() ? res.redirect('/dashboard') : res.redirect('/login'));

app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Login</title>
<style>body{margin:0;font-family:system-ui;background:#0b1120;color:#fff;display:flex;height:100vh;align-items:center;justify-content:center}
.box{background:#1e293b;padding:48px;border-radius:16px;text-align:center;width:380px;border:1px solid #334155}
img{width:64px;height:64px;border-radius:12px;margin-bottom:20px}
a{display:inline-block;background:#5865F2;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:20px}</style></head>
<body><div class="box"><img src="${config.loginLogo}" alt=""/><h1>${config.siteName}</h1><p style="color:#94a3b8">Staff Panel</p><a href="/auth/discord">Login with Discord</a></div></body></html>`);
});

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/login' }), (req, res) => res.redirect('/dashboard'));
app.get('/logout', (req, res) => req.logout(() => res.redirect('/login')));

// ===== MODMAIL API =====
app.post('/api/modmail/ticket', (req, res) => {
  if (req.headers['x-modmail-secret'] !== process.env.MODMAIL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { userId, username, content } = req.body;
  const tickets = read(files.tickets);
  let ticket = tickets.find(t => t.userId === userId && t.status !== 'closed');
  if (!ticket) {
    ticket = {
      id: Date.now().toString(),
      userId,
      username: username || 'Unknown',
      status: 'open',
      claimedBy: null,
      claimedByName: null,
      subject: 'ModMail',
      messages: [],
      createdAt: new Date().toISOString()
    };
    tickets.push(ticket);
  }
  if (content) {
    ticket.messages.push({
      from: 'user',
      author: username || 'User',
      content,
      timestamp: new Date().toISOString()
    });
  }
  save(files.tickets, tickets);
  res.json({ success: true, ticket });
});

// ===== DASHBOARD =====
app.get('/dashboard', checkAccess, async (req, res) => {
  const announcements = read(files.announcements);
  const latest = announcements[announcements.length - 1];
  const chat = read(files.chat).slice(-40).reverse();
  const qotd = config.questionsOfTheDay[new Date().getDate() % config.questionsOfTheDay.length];
  const highestRank = await getHighestRoleName(req.user.id);
  const chatHTML = chat.map(m => `<div style="padding:12px 0;border-bottom:1px solid var(--border)"><strong>${m.username}</strong> <span class="muted" style="font-size:12px">${new Date(m.createdAt).toLocaleString()}</span><p style="margin-top:5px">${m.content}</p></div>`).join('') || '<p class="muted">No messages yet.</p>';

  res.send(layout(req.user, 'Dashboard', `
    <div class="card"><h2>Welcome back, ${req.user.username}</h2><p class="muted">Highest Rank: <strong>${highestRank}</strong></p></div>
    <div class="grid">
      <div class="card"><h2>Latest Announcement</h2>${latest ? `<p><strong>${latest.title}</strong></p><p class="muted">${latest.content}</p><small class="muted">By ${latest.author}</small>` : '<p class="muted">None yet</p>'}</div>
      <div class="card"><h2>Question of the Day</h2><p style="margin-bottom:14px">${qotd}</p>
        <form method="POST" action="/chat/post"><input type="hidden" name="type" value="qotd"/><textarea name="content" required rows="3" placeholder="Your answer..."></textarea><button class="btn" type="submit">Post Answer</button></form></div>
    </div>
    <div class="card"><h2>Staff Chat</h2><div style="max-height:400px;overflow-y:auto;margin-bottom:16px">${chatHTML}</div>
      <form method="POST" action="/chat/post"><input type="hidden" name="type" value="chat"/><textarea name="content" required rows="2" placeholder="Message..."></textarea><button class="btn" type="submit">Send</button></form></div>
  `, highestRank));
});

app.post('/chat/post', checkAccess, (req, res) => {
  const content = (req.body.content || '').trim();
  if (!content) return res.redirect('/dashboard');
  if (containsBadWord(content)) return res.send('<p style="color:#fff;background:#0b1120;padding:40px;text-align:center">Message blocked. <a href="/dashboard" style="color:#0ea5e9">Back</a></p>');
  const chat = read(files.chat);
  chat.push({ id: Date.now(), userId: req.user.id, username: req.user.username, content, type: req.body.type || 'chat', createdAt: new Date().toISOString() });
  save(files.chat, chat);
  addAudit({ type: 'staff_chat', actorId: req.user.id, actor: req.user.username, detail: content.slice(0, 200) });
  res.redirect('/dashboard');
});

// ===== TICKETS =====
app.get('/tickets', checkAccess, async (req, res) => {
  const tickets = read(files.tickets).filter(t => t.status !== 'closed').reverse();
  const highestRank = await getHighestRoleName(req.user.id);
  const list = tickets.map(t => `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
        <div>
          <strong>${t.username}</strong>
          <span class="muted">#${t.id}</span>
          <span class="badge" style="margin-left:8px">${t.status}</span>
          ${t.claimedByName ? `<span class="muted" style="margin-left:8px">Claimed by ${t.claimedByName}</span>` : ''}
        </div>
        <a class="btn" href="/tickets/${t.id}">Open</a>
      </div>
      <p class="muted" style="margin-top:8px">${(t.messages[t.messages.length - 1]?.content || '').slice(0, 140)}</p>
    </div>
  `).join('') || '<p class="muted">No open tickets</p>';
  res.send(layout(req.user, 'Tickets', `<h2 style="margin-bottom:16px">Open ModMail Tickets</h2>${list}`, highestRank));
});

app.get('/tickets/:id', checkAccess, async (req, res) => {
  const tickets = read(files.tickets);
  const ticket = tickets.find(t => t.id === req.params.id);
  if (!ticket) return res.redirect('/tickets');
  const highestRank = await getHighestRoleName(req.user.id);
  const messages = (ticket.messages || []).map(m => `
    <div class="msg ${m.from}">
      <strong>${m.author}</strong>
      <span class="muted" style="font-size:12px">${new Date(m.timestamp).toLocaleString()}</span>
      <p style="margin-top:6px">${m.content}</p>
    </div>
  `).join('') || '<p class="muted">No messages</p>';

  let actions = '';
  if (ticket.status === 'open') {
    actions = `<form method="POST" action="/tickets/${ticket.id}/claim"><button class="btn" type="submit">Claim Ticket</button></form>`;
  } else if (ticket.status === 'claimed') {
    actions = `
      <form method="POST" action="/tickets/${ticket.id}/reply">
        <textarea name="content" required rows="3" placeholder="Reply to user..."></textarea>
        <button class="btn" type="submit">Send Reply</button>
      </form>
      <button class="btn btn-outline" type="button" style="margin-top:10px" onclick="openCloseModal()">Close Ticket</button>
      <div id="closeModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:50;align-items:center;justify-content:center">
        <div class="card" style="max-width:420px;margin:auto">
          <h2>Close this ticket?</h2>
          <p class="muted" style="margin:12px 0">This cannot be easily undone. Make sure you are finished helping this user.</p>
          <div style="display:flex;gap:10px;justify-content:flex-end">
            <button class="btn btn-outline" type="button" onclick="closeCloseModal()">Cancel</button>
            <form method="POST" action="/tickets/${ticket.id}/close" style="margin:0">
              <button id="confirmCloseBtn" class="btn" type="submit" disabled style="background:#6b7280">Wait...</button>
            </form>
          </div>
        </div>
      </div>
      <script>
        function openCloseModal(){
          const modal=document.getElementById('closeModal');
          const btn=document.getElementById('confirmCloseBtn');
          modal.style.display='flex';
          btn.disabled=true; btn.style.background='#6b7280'; btn.textContent='Wait...';
          setTimeout(()=>{btn.disabled=false; btn.style.background='#dc2626'; btn.textContent='Yes, close ticket';},2000);
        }
        function closeCloseModal(){document.getElementById('closeModal').style.display='none'}
      </script>`;
  }

  res.send(layout(req.user, 'Tickets', `
    <div class="card">
      <h2>${ticket.username}</h2>
      <p class="muted">Ticket #${ticket.id} • ${ticket.userId} • Status: <strong>${ticket.status}</strong>${ticket.claimedByName ? ` • Claimed by ${ticket.claimedByName}` : ''}</p>
    </div>
    <div class="card">
      <h2>Conversation</h2>
      <div style="max-height:450px;overflow-y:auto;margin-bottom:16px">${messages}</div>
      ${actions}
    </div>
    <a href="/tickets" class="btn btn-outline">← Back</a>
  `, highestRank));
});

app.post('/tickets/:id/claim', checkAccess, async (req, res) => {
  const tickets = read(files.tickets);
  const ticket = tickets.find(t => t.id === req.params.id);
  if (ticket && ticket.status === 'open') {
    ticket.status = 'claimed';
    ticket.claimedBy = req.user.id;
    ticket.claimedByName = req.user.username;
    save(files.tickets, tickets);
    addAudit({ type: 'ticket_claim', actorId: req.user.id, actor: req.user.username, detail: `Claimed ${ticket.username}` });
    await dmUser(ticket.userId, {
      color: 0x003768,
      title: 'Ticket Claimed',
      description: `Your ticket has been claimed by **${req.user.username}**.\nStaff will reply here shortly.`,
      footer: { text: 'Lone Star College • ModMail' },
      timestamp: new Date().toISOString()
    });
  }
  res.redirect(`/tickets/${req.params.id}`);
});

app.post('/tickets/:id/reply', checkAccess, async (req, res) => {
  const content = (req.body.content || '').trim();
  if (!content) return res.redirect(`/tickets/${req.params.id}`);
  if (containsBadWord(content)) return res.send('Blocked. <a href="/tickets">Back</a>');
  const tickets = read(files.tickets);
  const ticket = tickets.find(t => t.id === req.params.id);
  if (!ticket) return res.redirect('/tickets');
  ticket.messages.push({ from: 'staff', author: req.user.username, content, timestamp: new Date().toISOString() });
  save(files.tickets, tickets);
  addAudit({ type: 'ticket_reply', actorId: req.user.id, actor: req.user.username, detail: `Replied to ${ticket.username}` });
  await dmUser(ticket.userId, {
    color: 0x003768,
    title: 'Lone Star College Staff',
    description: content,
    footer: { text: `Replied by ${req.user.username}` },
    timestamp: new Date().toISOString()
  });
  res.redirect(`/tickets/${req.params.id}`);
});

app.post('/tickets/:id/close', checkAccess, (req, res) => {
  const tickets = read(files.tickets);
  const ticket = tickets.find(t => t.id === req.params.id);
  if (ticket) {
    ticket.status = 'closed';
    save(files.tickets, tickets);
    addAudit({ type: 'ticket_close', actorId: req.user.id, actor: req.user.username, detail: `Closed ${ticket.username}` });
  }
  res.redirect('/tickets');
});

// ===== LOA =====
app.get('/loa', checkAccess, async (req, res) => {
  const loas = read(files.loa).filter(l => l.active);
  const highestRank = await getHighestRoleName(req.user.id);
  const list = loas.map(l => `<div class="card"><strong>${l.username}</strong> <span class="badge">Active</span><p class="muted">${l.reason}</p><small class="muted">${l.start} → ${l.end}</small></div>`).join('') || '<p class="muted">No active LOAs</p>';
  res.send(layout(req.user, 'LOA', `
    <div class="card"><h2>Request LOA</h2>
      <form method="POST" action="/loa/request">
        <input name="reason" placeholder="Reason" required/>
        <div class="grid"><input name="start" type="date" required/><input name="end" type="date" required/></div>
        <button class="btn" type="submit">Submit</button>
      </form>
    </div>
    <h2 style="margin:20px 0 12px">Active LOAs</h2>${list}
  `, highestRank));
});

app.post('/loa/request', checkAccess, (req, res) => {
  const loas = read(files.loa);
  loas.push({ id: Date.now(), userId: req.user.id, username: req.user.username, reason: req.body.reason, start: req.body.start, end: req.body.end, active: true, createdAt: new Date().toISOString() });
  save(files.loa, loas);
  addAudit({ type: 'loa_request', actorId: req.user.id, actor: req.user.username, detail: req.body.reason });
  res.redirect('/loa');
});

// ===== ANNOUNCEMENTS =====
app.get('/announcements', checkAccess, async (req, res) => {
  if (!req.user.hasBotManagement) return res.redirect('/dashboard');
  const highestRank = await getHighestRoleName(req.user.id);
  const list = read(files.announcements).reverse().map(a => `<div class="card"><strong>${a.title}</strong><p class="muted">${a.content}</p><small class="muted">By ${a.author}</small></div>`).join('') || '<p class="muted">None</p>';
  res.send(layout(req.user, 'Announcements', `
    <div class="card"><h2>Post Announcement</h2>
      <form method="POST" action="/announcements/create">
        <input name="title" required placeholder="Title"/>
        <textarea name="content" required rows="4" placeholder="Content"></textarea>
        <button class="btn" type="submit">Post</button>
      </form>
    </div>
    <h2 style="margin:20px 0 12px">Previous</h2>${list}
  `, highestRank));
});

app.post('/announcements/create', checkAccess, (req, res) => {
  if (!req.user.hasBotManagement) return res.redirect('/dashboard');
  const a = read(files.announcements);
  a.push({ id: Date.now(), title: req.body.title, content: req.body.content, author: req.user.username, createdAt: new Date().toISOString() });
  save(files.announcements, a);
  addAudit({ type: 'announcement', actorId: req.user.id, actor: req.user.username, detail: req.body.title });
  res.redirect('/announcements');
});

// ===== NOTIFICATIONS =====
app.get('/notifications', checkAccess, async (req, res) => {
  if (!req.user.hasBotManagement) return res.redirect('/dashboard');
  const highestRank = await getHighestRoleName(req.user.id);
  res.send(layout(req.user, 'Notifications', `
    <div class="card"><h2>Send Staff Notification</h2>
      <form method="POST" action="/notifications/send">
        <input name="title" required placeholder="Title"/>
        <textarea name="message" required rows="4" placeholder="Message"></textarea>
        <button class="btn" type="submit">Send</button>
      </form>
    </div>
  `, highestRank));
});

app.post('/notifications/send', checkAccess, (req, res) => {
  if (!req.user.hasBotManagement) return res.redirect('/dashboard');
  addAudit({ type: 'notification', actorId: req.user.id, actor: req.user.username, detail: `${req.body.title}: ${req.body.message}` });
  res.redirect('/notifications');
});

// ===== LOGS (Bot Management only, cannot delete) =====
app.get('/logs', checkAccess, async (req, res) => {
  if (!req.user.hasBotManagement) return res.redirect('/dashboard');
  const highestRank = await getHighestRoleName(req.user.id);
  const logs = read(files.audit).slice().reverse().slice(0, 300);
  const rows = logs.map(l => `
    <div class="card" style="padding:14px">
      <strong>${l.type}</strong>
      <span class="muted" style="margin-left:8px">${new Date(l.at).toLocaleString()}</span>
      <p style="margin-top:6px"><strong>${l.actor || 'System'}</strong>: ${l.detail || ''}</p>
    </div>
  `).join('') || '<p class="muted">No logs yet.</p>';
  res.send(layout(req.user, 'Logs', `
    <div class="card">
      <h2>Website Audit Logs</h2>
      <p class="muted">Chat, LOA, tickets, announcements, notifications, settings. These cannot be deleted.</p>
    </div>
    ${rows}
  `, highestRank));
});

// ===== SETTINGS =====
app.get('/settings', checkAccess, async (req, res) => {
  const highestRank = await getHighestRoleName(req.user.id);
  const p = getProfile(req.user.id);
  const tab = req.query.tab || 'profile';
  const tabs = `
    <div style="display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap">
      <a class="btn ${tab==='profile'?'':'btn-outline'}" href="/settings?tab=profile">Profile</a>
      <a class="btn ${tab==='account'?'':'btn-outline'}" href="/settings?tab=account">Account Info</a>
      <a class="btn ${tab==='appearance'?'':'btn-outline'}" href="/settings?tab=appearance">Appearance</a>
    </div>`;

  let body = '';
  if (tab === 'profile') {
    body = `<div class="card"><h2>Profile</h2>
      <form method="POST" action="/settings/profile">
        <label class="muted">Display name (blank = Discord name)</label>
        <input name="displayName" value="${p.displayName || ''}" placeholder="${req.user.username}"/>
        <label class="muted">Tagline</label>
        <input name="tagline" value="${p.tagline || ''}"/>
        <label class="muted">Bio</label>
        <textarea name="bio" rows="4">${p.bio || ''}</textarea>
        <label class="muted">Banner image URL</label>
        <input name="bannerUrl" value="${p.bannerUrl || ''}" placeholder="https://..."/>
        <label class="muted">Timezone</label>
        <input name="timezone" value="${p.timezone || 'America/Chicago'}"/>
        <button class="btn" type="submit">Save Profile</button>
      </form></div>`;
  } else if (tab === 'account') {
    body = `<div class="card"><h2>Account Info</h2>
      <p><strong>Discord ID:</strong> ${req.user.id}</p>
      <p><strong>Discord Username:</strong> ${req.user.username}</p>
      <p><strong>Highest Rank:</strong> ${highestRank}</p>
      <p class="muted">Email / IP / location can be added later with extra tracking.</p>
      <form method="POST" action="/settings/sync-roles" style="margin-top:14px">
        <button class="btn" type="submit">Sync Roles from Discord</button>
      </form></div>`;
  } else {
    body = `<div class="card"><h2>Appearance</h2>
      <form method="POST" action="/settings/appearance">
        <label class="muted">Accent color (hex)</label>
        <input name="accent" value="${p.accent || '#0ea5e9'}"/>
        <label><input type="checkbox" name="compactMode" ${p.compactMode ? 'checked' : ''}/> Compact mode</label><br/><br/>
        <label><input type="checkbox" name="collapseSidebar" ${p.collapseSidebar ? 'checked' : ''}/> Collapse sidebar by default</label><br/><br/>
        <button class="btn" type="submit">Save Changes</button>
      </form></div>`;
  }

  res.send(layout(req.user, 'Settings', `
    <div class="card"><h2>Settings</h2><p class="muted">Manage your profile, preferences, and security.</p></div>
    ${tabs}${body}
  `, highestRank));
});

app.post('/settings/profile', checkAccess, (req, res) => {
  saveProfile(req.user.id, {
    displayName: req.body.displayName || '',
    tagline: req.body.tagline || '',
    bio: req.body.bio || '',
    bannerUrl: req.body.bannerUrl || '',
    timezone: req.body.timezone || 'America/Chicago'
  });
  addAudit({ type: 'settings_profile', actorId: req.user.id, actor: req.user.username, detail: 'Updated profile' });
  res.redirect('/settings?tab=profile');
});

app.post('/settings/appearance', checkAccess, (req, res) => {
  saveProfile(req.user.id, {
    accent: req.body.accent || '#0ea5e9',
    compactMode: !!req.body.compactMode,
    collapseSidebar: !!req.body.collapseSidebar
  });
