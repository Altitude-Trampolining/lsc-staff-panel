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
  chat: path.join(dataDir, 'staffchat.json')
};
Object.values(files).forEach(f => { if (!fs.existsSync(f)) fs.writeFileSync(f, '[]'); });

const read = f => JSON.parse(fs.readFileSync(f));
const save = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

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
app.use(session({ secret: process.env.SESSION_SECRET || 'lsc', resave: false, saveUninitialized: false }));
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

async function checkAccess(req, res, next) {
  if (!req.isAuthenticated()) return res.redirect('/login');
  const memberRoles = await getMemberRoles(req.user.id);
  const guildRoles = await getGuildRoles();
  const webRole = guildRoles.find(r => r.name === config.roles.webAccess);
  const botRole = guildRoles.find(r => r.name === config.roles.botManagement);
  const hasWeb = webRole && memberRoles.includes(webRole.id);
  const hasBot = botRole && memberRoles.includes(botRole.id);
  if (!hasWeb && !hasBot) {
    return res.send(`<html><body style="background:#0b1120;color:#fff;font-family:sans-serif;display:flex;height:100vh;align-items:center;justify-content:center;text-align:center"><div><h1>Access Denied</h1><p>You need <b>${config.roles.webAccess}</b></p><a href="/logout" style="color:#0ea5e9">Logout</a></div></body></html>`);
  }
  req.user.hasBotManagement = hasBot;
  next();
}

function layout(user, title, content, highestRank = 'Staff') {
  const isManager = user.hasBotManagement;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} • ${config.siteName}</title>
<style>
:root{--bg:${config.colors.background};--card:${config.colors.card};--primary:${config.colors.primary};--text:${config.colors.text};--muted:${config.colors.muted};--border:#334155}
body.light{--bg:#f1f5f9;--card:#fff;--text:#0f172a;--muted:#64748b;--border:#e2e8f0}
*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.sidebar{width:260px;background:var(--card);border-right:1px solid var(--border);height:100vh;position:fixed;padding:24px 16px;display:flex;flex-direction:column}
.logo{display:flex;align-items:center;gap:12px;margin-bottom:40px;padding:0 8px}
.logo img{width:42px;height:42px;border-radius:8px;object-fit:cover}
.logo-text{font-weight:700;font-size:15px;line-height:1.2}.logo-text span{display:block;font-size:11px;color:var(--muted);font-weight:500}
.nav a{display:block;padding:12px 14px;border-radius:8px;color:var(--muted);text-decoration:none;margin-bottom:4px;font-size:14px}
.nav a:hover,.nav a.active{background:rgba(14,165,233,.12);color:var(--primary)}
.main{margin-left:260px;padding:28px 36px}
.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:32px}
.profile{display:flex;align-items:center;gap:12px;background:var(--card);padding:8px 14px 8px 8px;border-radius:50px;border:1px solid var(--border)}
.profile img{width:36px;height:36px;border-radius:50%}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:22px;margin-bottom:20px}
h1{font-size:26px}h2{font-size:18px;margin-bottom:14px}.muted{color:var(--muted);font-size:14px}
.btn{background:var(--primary);color:#fff;border:none;padding:10px 18px;border-radius:8px;cursor:pointer;font-weight:600;text-decoration:none;display:inline-block;font-size:14px}
.btn-outline{background:transparent;border:1px solid var(--border);color:var(--text)}
input,textarea{width:100%;padding:11px 14px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);margin-bottom:12px;font-size:14px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.badge{display:inline-block;background:rgba(14,165,233,.15);color:var(--primary);font-size:11px;padding:3px 8px;border-radius:20px;font-weight:600}
.msg{padding:12px;border-radius:10px;margin-bottom:10px;background:var(--bg);border:1px solid var(--border)}
.msg.staff{border-left:3px solid var(--primary)}.msg.user{border-left:3px solid #22c55e}
@media(max-width:900px){.sidebar{display:none}.main{margin-left:0}.grid{grid-template-columns:1fr}}
</style></head><body>
<div class="sidebar">
  <div class="logo"><img src="${config.logo}" alt="Logo"><div class="logo-text">${config.siteName}<span>${config.siteSubtitle}</span></div></div>
  <div class="nav">
    <a href="/dashboard" class="${title==='Dashboard'?'active':''}">Dashboard</a>
    <a href="/loa" class="${title==='LOA'?'active':''}">Leave of Absence</a>
    <a href="/tickets" class="${title==='Tickets'?'active':''}">Tickets / ModMail</a>
    ${isManager?`<a href="/announcements" class="${title==='Announcements'?'active':''}">Announcements</a>
    <a href="/notifications" class="${title==='Notifications'?'active':''}">Staff Notifications</a>`:''}
    <a href="/logout" style="margin-top:auto;color:#f87171">Logout</a>
  </div>
</div>
<div class="main">
  <div class="topbar">
    <h1>${title}</h1>
    <div style="display:flex;align-items:center;gap:12px">
      <button class="btn btn-outline" onclick="toggleTheme()" style="padding:8px 12px">Theme</button>
      <div class="profile">
        <img src="${user.avatar?`https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`:'https://via.placeholder.com/36'}" alt="">
        <div style="font-size:13px;line-height:1.2"><div style="font-weight:600">${user.username}</div><div class="muted" style="font-size:11px">${highestRank}</div></div>
      </div>
    </div>
  </div>
  ${content}
</div>
<script>
function toggleTheme(){document.body.classList.toggle('light');localStorage.setItem('theme',document.body.classList.contains('light')?'light':'dark')}
if(localStorage.getItem('theme')==='light')document.body.classList.add('light');
let idle=0;const max=30;function reset(){idle=0}
setInterval(()=>{idle++;if(idle>=max)location.href='/logout'},60000);
['load','mousemove','keypress','click','scroll'].forEach(e=>window.addEventListener(e,reset));
</script></body></html>`;
}

app.get('/', (req, res) => req.isAuthenticated() ? res.redirect('/dashboard') : res.redirect('/login'));
app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Login</title><style>body{margin:0;font-family:system-ui;background:#0b1120;color:#fff;display:flex;height:100vh;align-items:center;justify-content:center}.box{background:#1e293b;padding:48px;border-radius:16px;text-align:center;width:380px;border:1px solid #334155}img{width:64px;height:64px;border-radius:12px;margin-bottom:20px}a{display:inline-block;background:#5865F2;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:20px}</style></head><body><div class="box"><img src="${config.loginLogo}" alt=""><h1>${config.siteName}</h1><p style="color:#94a3b8">Staff Panel</p><a href="/auth/discord">Login with Discord</a></div></body></html>`);
});
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/login' }), (req, res) => res.redirect('/dashboard'));
app.get('/logout', (req, res) => req.logout(() => res.redirect('/login')));

// ===== MODMAIL API (bot calls this) =====
app.post('/api/modmail/ticket', (req, res) => {
  if (req.headers['x-modmail-secret'] !== process.env.MODMAIL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { userId, username, content } = req.body;
  let tickets = read(files.tickets);
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
      <div class="card"><h2>Latest Announcement</h2>${latest?`<p><strong>${latest.title}</strong></p><p class="muted">${latest.content}</p><small class="muted">By ${latest.author}</small>`:'<p class="muted">None yet</p>'}</div>
      <div class="card"><h2>Question of the Day</h2><p style="margin-bottom:14px">${qotd}</p>
        <form method="POST" action="/chat/post"><input type="hidden" name="type" value="qotd"><textarea name="content" required rows="3" placeholder="Your answer..."></textarea><button class="btn" type="submit">Post Answer</button></form></div>
    </div>
    <div class="card"><h2>Staff Chat</h2><div style="max-height:400px;overflow-y:auto;margin-bottom:16px">${chatHTML}</div>
      <form method="POST" action="/chat/post"><input type="hidden" name="type" value="chat"><textarea name="content" required rows="2" placeholder="Message..."></textarea><button class="btn" type="submit">Send</button></form></div>
  `, highestRank));
});

app.post('/chat/post', checkAccess, (req, res) => {
  const content = (req.body.content || '').trim();
  if (!content) return res.redirect('/dashboard');
  if (containsBadWord(content)) return res.send('<p style="color:white;background:#0b1120;padding:40px;text-align:center">Message blocked (bad language). <a href="/dashboard" style="color:#0ea5e9">Back</a></p>');
  const chat = read(files.chat);
  chat.push({ id: Date.now(), userId: req.user.id, username: req.user.username, content, type: req.body.type || 'chat', createdAt: new Date().toISOString() });
  save(files.chat, chat);
  res.redirect('/dashboard');
});

// ===== TICKETS / MODMAIL UI =====
app.get('/tickets', checkAccess, async (req, res) => {
  const tickets = read(files.tickets).filter(t => t.status !== 'closed').reverse();
  const highestRank = await getHighestRoleName(req.user.id);
  const list = tickets.map(t => `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <strong>#${t.id}</strong> — ${t.username}
          <span class="badge" style="margin-left:8px">${t.status}</span>
          ${t.claimedByName ? `<span class="muted" style="margin-left:8px">Claimed by ${t.claimedByName}</span>` : ''}
        </div>
        <a class="btn" href="/tickets/${t.id}">Open</a>
      </div>
      <p class="muted" style="margin-top:8px">${(t.messages[t.messages.length-1]?.content || '').slice(0,120)}</p>
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
      <strong>${m.author}</strong> <span class="muted" style="font-size:12px">${new Date(m.timestamp).toLocaleString()}</span>
      <p style="margin-top:6px">${m.content}</p>
    </div>
  `).join('');

  let actions = '';
  if (ticket.status === 'open') {
    actions = `<form method="POST" action="/tickets/${ticket.id}/claim" style="margin-bottom:16px"><button class="btn" type="submit">Claim Ticket</button></form>`;
  } else if (ticket.status === 'claimed') {
    actions = `
      <form method="POST" action="/tickets/${ticket.id}/reply">
        <textarea name="content" required rows="3" placeholder="Reply to user (sent as DM embed)..."></textarea>
        <button class="btn" type="submit">Send Reply</button>
      </form>
      <form method="POST" action="/tickets/${ticket.id}/close" style="margin-top:10px">
        <button class="btn btn-outline" type="submit">Close Ticket</button>
      </form>`;
  }

  res.send(layout(req.user, 'Tickets', `
    <div class="card">
      <h2>Ticket #${ticket.id}</h2>
      <p class="muted">User: ${ticket.username} (${ticket.userId}) • Status: <strong>${ticket.status}</strong>
      ${ticket.claimedByName ? ` • Claimed by ${ticket.claimedByName}` : ''}</p>
    </div>
    <div class="card">
      <h2>Conversation</h2>
      <div style="max-height:450px;overflow-y:auto;margin-bottom:16px">${messages || '<p class="muted">No messages</p>'}</div>
      ${actions}
    </div>
    <a href="/tickets" class="btn btn-outline">← Back to list</a>
  `, highestRank));
});

app.post('/tickets/:id/claim', checkAccess, (req, res) => {
  const tickets = read(files.tickets);
  const ticket = tickets.find(t => t.id === req.params.id);
  if (ticket && ticket.status === 'open') {
    ticket.status = 'claimed';
    ticket.claimedBy = req.user.id;
    ticket.claimedByName = req.user.username;
    save(files.tickets, tickets);
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

  ticket.messages.push({
    from: 'staff',
    author: req.user.username,
    content,
    timestamp: new Date().toISOString()
  });
  save(files.tickets, tickets);

  // DM user via Discord API
  try {
    const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: { Authorization: `Bot ${process.env.BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: ticket.userId })
    });
    const dm = await dmRes.json();
    if (dm.id) {
      await fetch(`https://discord.com/api/v10/channels/${dm.id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${process.env.BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{
            color: 0x003768,
            title: 'Lone Star College Staff',
            description: content,
            footer: { text: `Replied by ${req.user.username}` },
            timestamp: new Date().toISOString()
          }]
        })
      });
    }
  } catch (e) {
    console.error('DM failed', e);
  }
  res.redirect(`/tickets/${req.params.id}`);
});

app.post('/tickets/:id/close', checkAccess, (req, res) => {
  const tickets = read(files.tickets);
  const ticket = tickets.find(t => t.id === req.params.id);
  if (ticket) {
    ticket.status = 'closed';
    save(files.tickets, tickets);
  }
  res.redirect('/tickets');
});

// ===== LOA / ANNOUNCEMENTS / NOTIFICATIONS (same as before) =====
app.get('/loa', checkAccess, async (req, res) => {
  const loas = read(files.loa).filter(l => l.active);
  const highestRank = await getHighestRoleName(req.user.id);
  const list = loas.map(l => `<div class="card"><strong>${l.username}</strong> <span class="badge">Active</span><p class="muted">${l.reason}</p><small class="muted">${l.start} → ${l.end}</small></div>`).join('') || '<p class="muted">No active LOAs</p>';
  res.send(layout(req.user, 'LOA', `
    <div class="card"><h2>Request LOA</h2>
      <form method="POST" action="/loa/request">
        <input name="reason" placeholder="Reason" required>
        <div class="grid"><input name="start" type="date" required><input name="end" type="date" required></div>
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
  res.redirect('/loa');
});

app.get('/announcements', checkAccess, async (req, res) => {
  if (!req.user.hasBotManagement) return res.redirect('/dashboard');
  const highestRank = await getHighestRoleName(req.user.id);
  const list = read(files.announcements).reverse().map(a => `<div class="card"><strong>${a.title}</strong><p class="muted">${a.content}</p><small class="muted">By ${a.author}</small></div>`).join('') || '<p class="muted">None</p>';
  res.send(layout(req.user, 'Announcements', `
    <div class="card"><h2>Post Announcement</h2>
      <form method="POST" action="/announcements/create">
        <input name="title" required placeholder="Title">
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
  res.redirect('/announcements');
});

app.get('/notifications', checkAccess, async (req, res) => {
  if (!req.user.hasBotManagement) return res.redirect('/dashboard');
  const highestRank = await getHighestRoleName(req.user.id);
  res.send(layout(req.user, 'Notifications', `
    <div class="card"><h2>Send Staff Notification</h2>
      <form method="POST" action="/notifications/send">
        <input name="title" required placeholder="Title">
        <textarea name="message" required rows="4" placeholder="Message"></textarea>
        <button class="btn" type="submit">Send</button>
      </form>
    </div>
  `, highestRank));
});
app.post('/notifications/send', checkAccess, (req, res) => {
  if (!req.user.hasBotManagement) return res.redirect('/dashboard');
  console.log(`[NOTIFY] ${req.user.username}: ${req.body.title} - ${req.body.message}`);
  res.redirect('/notifications');
});

app.listen(PORT, () => console.log(`Staff Panel on http://localhost:${PORT}`));