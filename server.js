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
  if (!fs.existsSync(files[key])) fs.writeFileSync(files[key], key === 'profiles' ? '{}' : '[]');
}

function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function save(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

async function sendDiscordLog(title, description, color = 0x0ea5e9) {
  const channelId = process.env.AUDIT_LOG_CHANNEL_ID;
  if (!channelId || !process.env.BOT_TOKEN) return;
  try {
    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${process.env.BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        embeds: [{
          title,
          description,
          color,
          footer: { text: 'Lone Star College • Website Audit' },
          timestamp: new Date().toISOString()
        }]
      })
    });
  } catch (e) {
    console.error('Audit discord log failed', e);
  }
}

function addAudit(entry) {
  const logs = read(files.audit);
  const row = { id: Date.now().toString(), ...entry, at: new Date().toISOString() };
  logs.push(row);
  save(files.audit, logs.slice(-3000));
  sendDiscordLog(
    entry.type || 'Audit',
    `**Actor:** ${entry.actor || 'System'}\n**Detail:** ${entry.detail || '—'}`
  );
}

function defaultNotifications() {
  const n = {};
  (config.notificationOptions || []).forEach(o => { n[o.key] = true; });
  return n;
}

function getProfile(userId) {
  const all = read(files.profiles);
  const base = {
    displayName: '', bio: '', tagline: '', bannerUrl: '',
    timezone: 'America/Chicago', accent: config.colors.primary,
    compactMode: false, collapseSidebar: false,
    notifications: defaultNotifications()
  };
  const existing = all[userId] || {};
  return {
    ...base,
    ...existing,
    notifications: { ...defaultNotifications(), ...(existing.notifications || {}) }
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
    const res = await fetch(`https://discord.com/api/v10/guilds/${process.env.GUILD_ID}/members/${userId}`, {
      headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` }
    });
    if (!res.ok) return [];
    return (await res.json()).roles || [];
  } catch { return []; }
}
async function getGuildRoles() {
  try {
    const res = await fetch(`https://discord.com/api/v10/guilds/${process.env.GUILD_ID}/roles`, {
      headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` }
    });
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}
async function getHighestRoleName(userId) {
  try {
    const memberRoles = await getMemberRoles(userId);
    const guildRoles = await getGuildRoles();
    const userRoles = guildRoles.filter(r => memberRoles.includes(r.id)).sort((a, b) => b.position - a.position);
    return userRoles[0] ? userRoles[0].name : 'Staff';
  } catch { return 'Staff'; }
}
async function getMemberRoleNames(userId) {
  try {
    const memberRoles = await getMemberRoles(userId);
    const guildRoles = await getGuildRoles();
    return guildRoles
      .filter(r => memberRoles.includes(r.id) && r.name !== '@everyone')
      .sort((a, b) => b.position - a.position)
      .map(r => r.name);
  } catch { return []; }
}
function containsBadWord(text) {
  const lower = String(text || '').toLowerCase();
  return config.badWords.some(w => lower.includes(w));
}
async function dmUser(userId, embed) {
  try {
    const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: { Authorization: `Bot ${process.env.BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: userId })
    });
    const dm = await dmRes.json();
    if (!dm.id) return false;
    await fetch(`https://discord.com/api/v10/channels/${dm.id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${process.env.BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] })
    });
    return true;
  } catch (e) {
    console.error('DM failed', e);
    return false;
  }
}

async function postLoaReviewMessage(loa) {
  const channelId = process.env.LOA_REVIEW_CHANNEL_ID;
  if (!channelId || !process.env.BOT_TOKEN) return;
  try {
    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${process.env.BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        embeds: [{
          title: 'Leave of Absence Request',
          color: 0x0ea5e9,
          fields: [
            { name: 'Staff', value: `${loa.username}\n\`${loa.userId}\``, inline: true },
            { name: 'Available for basics?', value: loa.availableBasics ? 'Yes' : 'No', inline: true },
            { name: 'Dates', value: `${loa.start} → ${loa.end}`, inline: false },
            { name: 'Reason', value: loa.reason || '—' }
          ],
          footer: { text: `LOA ID: ${loa.id}` },
          timestamp: new Date().toISOString()
        }],
        components: [{
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Accept', custom_id: `loa_accept_${loa.id}` },
            { type: 2, style: 4, label: 'Deny', custom_id: `loa_deny_${loa.id}` }
          ]
        }]
      })
    });
  } catch (e) {
    console.error('LOA review post failed', e);
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
    return res.send(`<!DOCTYPE html><html><body style="background:#050814;color:#fff;font-family:system-ui;display:flex;height:100vh;align-items:center;justify-content:center;text-align:center"><div><h1>Access Denied</h1><p>You need <b>${config.roles.webAccess}</b></p><a href="/logout" style="color:#0ea5e9">Logout</a></div></body></html>`);
  }
  req.user.hasBotManagement = !!hasBot;
  next();
}

function layout(user, title, content, highestRank) {
  highestRank = highestRank || 'Staff';
  const isManager = user.hasBotManagement;
  const p = getProfile(user.id);
  const compactClass = p.compactMode ? 'compact' : '';
  const collapseClass = p.collapseSidebar ? 'collapse-side' : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${title} • ${config.siteName}</title>
<link rel="icon" href="${config.favicon || config.logo}"/>
<style>
:root{--bg:${config.colors.background};--card:${config.colors.card};--primary:${config.colors.primary};--accent:${config.colors.accent};--text:${config.colors.text};--muted:${config.colors.muted};--border:rgba(255,255,255,.08);--shadow:0 18px 50px rgba(0,0,0,.35)}
body.light{--bg:#f4f7fc;--card:#fff;--text:#0b1220;--muted:#64748b;--border:#e6ebf3;--shadow:0 12px 30px rgba(15,23,42,.08)}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,system-ui,sans-serif;background:radial-gradient(900px 500px at 10% -10%,rgba(14,165,233,.18),transparent 55%),radial-gradient(700px 400px at 100% 0%,rgba(179,8,56,.12),transparent 50%),var(--bg);color:var(--text);min-height:100vh}
body.compact .card{padding:14px}
.sidebar{width:300px;height:100vh;position:fixed;background:rgba(12,19,34,.96);border-right:1px solid var(--border);padding:20px 12px;display:flex;flex-direction:column;overflow-y:auto}
body.collapse-side .sidebar{width:92px}
body.collapse-side .logo-text,body.collapse-side .nav-label{display:none}
body.collapse-side .nav a{justify-content:center;padding:12px}
body.collapse-side .nav a span{position:absolute;left:-9999px}
body.collapse-side .main{margin-left:92px}
.logo{display:flex;gap:12px;align-items:center;padding:8px;margin-bottom:12px}
.logo img{width:44px;height:44px;border-radius:12px}
.logo-text{font-weight:900;font-size:14px;line-height:1.15}
.logo-text span{display:block;color:var(--muted);font-size:11px;font-weight:600}
.nav-label{font-family:Georgia,serif;font-size:12px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#c7d2e5;padding:16px 12px 8px}
.nav a{display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:12px;color:var(--muted);text-decoration:none;margin-bottom:4px;font-size:14px;font-weight:800;position:relative}
.nav a:hover,.nav a.active{background:rgba(14,165,233,.14);color:var(--primary)}
body.collapse-side .nav a:hover span{position:absolute;left:100%;top:50%;transform:translateY(-50%);background:#0c1322;border:1px solid var(--border);padding:8px 10px;border-radius:8px;white-space:nowrap;z-index:20;color:var(--text)}
.main{margin-left:300px;padding:28px 34px 50px}
.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}
.hero{background:linear-gradient(135deg,rgba(14,165,233,.18),rgba(179,8,56,.10));border:1px solid var(--border);border-radius:22px;padding:22px 24px;margin-bottom:18px}
.card{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:20px;margin-bottom:16px}
h1{font-size:30px}h2{font-size:18px;margin-bottom:10px}.muted{color:var(--muted);font-size:14px}
.btn{background:var(--primary);color:#fff;border:none;padding:11px 16px;border-radius:12px;cursor:pointer;font-weight:800;text-decoration:none;display:inline-block;font-size:14px}
.btn-outline{background:transparent;border:1px solid var(--border);color:var(--text)}
.btn-accent{background:var(--accent)}.btn-row{display:flex;flex-wrap:wrap;gap:10px}
input,textarea,select{width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--text);margin:8px 0 12px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.stat{font-size:28px;font-weight:900}
.badge{display:inline-block;background:rgba(14,165,233,.15);color:var(--primary);font-size:11px;padding:4px 9px;border-radius:999px;font-weight:800;margin:2px}
.badge-green{background:rgba(34,197,94,.15);color:#4ade80}
.badge-red{background:rgba(239,68,68,.15);color:#f87171}
.badge-yellow{background:rgba(234,179,8,.15);color:#facc15}
.msg{padding:12px 14px;border-radius:14px;margin-bottom:10px;border:1px solid var(--border)}
.msg.user{background:rgba(34,197,94,.08);border-left:3px solid #22c55e}
.msg.staff{background:rgba(14,165,233,.08);border-left:3px solid var(--primary)}
.msg.internal{background:rgba(234,179,8,.08);border-left:3px solid #eab308}
.switch-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid var(--border)}
.switch{position:relative;width:52px;height:30px;flex-shrink:0}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;cursor:pointer;inset:0;background:#334155;border-radius:999px;transition:.2s}
.slider:before{position:absolute;content:"";height:22px;width:22px;left:4px;top:4px;background:white;border-radius:50%;transition:.2s}
.switch input:checked + .slider{background:var(--primary)}
.switch input:checked + .slider:before{transform:translateX(22px)}
.profile{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--border);border-radius:999px;padding:8px 14px 8px 8px}
.profile img{width:36px;height:36px;border-radius:50%}
.ticket-shell{display:grid;grid-template-columns:1.7fr .9fr;gap:16px}
.chat-box{max-height:520px;overflow-y:auto;padding-right:6px}
.role-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
@media(max-width:980px){.sidebar{display:none}.main{margin-left:0}.grid,.grid-4,.ticket-shell{grid-template-columns:1fr}}
</style>
</head>
<body class="${compactClass} ${collapseClass}">
<div class="sidebar">
  <div class="logo"><img src="${config.logo}" alt=""/><div class="logo-text">${config.siteName}<span>${config.siteSubtitle}</span></div></div>
  <div class="nav">
    <div class="nav-label">Overview</div>
    <a href="/dashboard" class="${title==='Dashboard'?'active':''}" title="Dashboard"><span>Dashboard</span></a>
    <div class="nav-label">Community</div>
    <a href="/support" class="${title==='Support'?'active':''}" title="Support"><span>Support</span></a>
    <a href="/announcements" class="${title==='Announcements'?'active':''}" title="Announcements"><span>Announcements</span></a>
    <a href="/notifications" class="${title==='Notifications'?'active':''}" title="Notifications"><span>Notifications</span></a>
    <div class="nav-label">Management</div>
    <a href="/loa" class="${title==='LOA'?'active':''}" title="Leave of Absence"><span>Leave of Absence</span></a>
    <a href="/settings" class="${title==='Settings'?'active':''}" title="Settings"><span>Settings</span></a>
    ${isManager ? `
      <div class="nav-label">Administration</div>
      <a href="/admin/announcements" class="${title==='Admin Announcements'?'active':''}" title="Post Announcements"><span>Post Announcements</span></a>
      <a href="/logs" class="${title==='Logs'?'active':''}" title="Audit Logs"><span>Audit Logs</span></a>
    ` : ''}
    <a href="/logout" style="margin-top:auto;color:#f87171" title="Logout"><span>Logout</span></a>
  </div>
</div>
<div class="main">
  <div class="topbar">
    <div><h1>${title}</h1><p class="muted">Lone Star College Administration</p></div>
    <div style="display:flex;align-items:center;gap:12px">
      <button class="btn btn-outline" onclick="toggleTheme()" style="padding:8px 12px">Theme</button>
      <div class="profile">
        <img src="${user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : 'https://via.placeholder.com/36'}"/>
        <div style="font-size:13px"><div style="font-weight:800">${user.username}</div><div class="muted" style="font-size:11px">${highestRank}</div></div>
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
['load','mousemove','keypress','click','scroll'].forEach(e=>window.addEventListener(e,resetIdle));
</script>
</body></html>`;
}

function legalPage(title, body) {
  return `<!DOCTYPE html><html><head><title>${title}</title><link rel="icon" href="${config.favicon || config.logo}"/>
  <style>body{margin:0;font-family:system-ui;background:#050814;color:#eef3fb;padding:40px 18px}.wrap{max-width:720px;margin:0 auto;background:#0c1322;border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:28px}a{color:#0ea5e9;text-decoration:none}p{color:#b7c3d8;line-height:1.7;margin:12px 0}</style></head>
  <body><div class="wrap"><h1>${title}</h1>${body}<p style="margin-top:24px"><a href="/login">← Back to login</a></p>
  <p style="color:#66758f;font-size:12px">© 2026 Roblox, Lone Star College. All rights reserved.</p></div></body></html>`;
}

app.get('/', (req, res) => req.isAuthenticated() ? res.redirect('/dashboard') : res.redirect('/login'));

app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Staff Portal • ${config.siteName}</title><link rel="icon" href="${config.favicon || config.logo}"/>
<style>
body{margin:0;font-family:Inter,system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#eef3fb;background:radial-gradient(900px 500px at 20% -10%,rgba(14,165,233,.2),transparent 55%),#050814}
.box{width:420px;background:rgba(12,19,34,.95);border:1px solid rgba(255,255,255,.08);border-radius:24px;padding:42px 36px;text-align:center}
img{width:78px;height:78px;border-radius:18px;margin-bottom:18px}
.btn{display:inline-flex;width:100%;justify-content:center;background:#5865F2;color:#fff;text-decoration:none;padding:14px 18px;border-radius:14px;font-weight:800}
.legal{margin-top:22px;font-size:12px;color:#8b9bb8}.legal a{color:#8b9bb8;text-decoration:none;margin:0 6px}
.copy{margin-top:14px;font-size:11px;color:#66758f}
</style></head><body><div class="box">
<img src="${config.loginLogo}"/><h1>Staff Portal</h1>
<p style="color:#8b9bb8;margin:8px 0 22px">${config.siteName}<br/>Authorized personnel only</p>
<a class="btn" href="/auth/discord">Continue with Discord</a>
<div class="legal"><a href="/privacy">Privacy</a>•<a href="/terms">Terms of Service</a>•<a href="/cookies">Cookies</a></div>
<div class="copy">© 2026 Roblox, Lone Star College. All rights reserved.</div>
</div></body></html>`);
});

app.get('/privacy', (req, res) => res.send(legalPage('Privacy Policy', `<p>Staff portal authentication uses Discord identity for access control.</p><p>Operational data such as tickets, LOA, and audit events may be stored.</p>`)));
app.get('/terms', (req, res) => res.send(legalPage('Terms of Service', `<p>Authorized staff only. Misuse of tools or confidential data is prohibited.</p>`)));
app.get('/cookies', (req, res) => res.send(legalPage('Cookies', `<p>Session cookies keep you signed in. Local storage saves UI preferences.</p>`)));

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/login' }), (req, res) => {
  addAudit({ type: 'login', actorId: req.user.id, actor: req.user.username, detail: 'Staff logged into website' });
  res.redirect('/dashboard');
});
app.get('/logout', (req, res) => {
  if (req.user) addAudit({ type: 'logout', actorId: req.user.id, actor: req.user.username, detail: 'Staff logged out of website' });
  req.logout(() => res.redirect('/login'));
});

// ModMail API
app.post('/api/modmail/ticket', (req, res) => {
  if (req.headers['x-modmail-secret'] !== process.env.MODMAIL_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const userId = String(req.body.userId || '');
  const username = req.body.username || 'Unknown';
  const content = req.body.content;
  const tickets = read(files.tickets);
  let ticket = tickets.find(t => String(t.userId) === userId && t.status !== 'closed');
  const isNew = !ticket;
  if (!ticket) {
    ticket = {
      id: Date.now().toString(), userId, username,
      status: 'pending_staff', priority: 'normal', type: 'general',
      claimedBy: null, claimedByName: null, subject: 'ModMail',
      messages: [], createdAt: new Date().toISOString()
    };
    tickets.push(ticket);
  } else {
    ticket.username = username || ticket.username;
    if (ticket.status === 'pending_user' || ticket.status === 'resolved') {
      ticket.status = ticket.claimedBy ? 'claimed' : 'pending_staff';
    }
  }
  if (content) ticket.messages.push({ from: 'user', author: username, content, timestamp: new Date().toISOString() });
  save(files.tickets, tickets);
  addAudit({
    type: isNew ? 'ticket_create' : 'ticket_user_reply',
    actorId: userId,
    actor: username,
    detail: isNew ? `New ticket #${ticket.id}` : `Reply on ticket #${ticket.id}`
  });
  res.json({ success: true, ticket });
});

// LOA decision API for bot buttons
app.post('/api/loa/:id/decision', async (req, res) => {
  if (req.headers['x-modmail-secret'] !== process.env.MODMAIL_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const loas = read(files.loa);
  const loa = loas.find(l => String(l.id) === String(req.params.id));
  if (!loa) return res.status(404).json({ error: 'Not found' });
  if (loa.status !== 'pending') return res.json({ success: false, error: 'Already decided' });

  const decision = req.body.decision; // approved | denied
  const reviewer = req.body.reviewer || 'Staff';
  const reviewerId = req.body.reviewerId || '';
  const note = req.body.note || '';
  const reason = req.body.reason || '';

  if (decision === 'approved') {
    loa.status = 'approved';
    loa.active = true;
    loa.reviewedBy = reviewer;
    loa.reviewedById = reviewerId;
    loa.reviewNote = note;
    loa.reviewedAt = new Date().toISOString();
    await dmUser(loa.userId, {
      color: 0x22c55e,
      title: 'LOA Approved',
      description: `Your leave request has been **approved**.\n\n**Dates:** ${loa.start} → ${loa.end}\n**Reason:** ${loa.reason}${note ? `\n**Note:** ${note}` : ''}`,
      footer: { text: `Reviewed by ${reviewer}` },
      timestamp: new Date().toISOString()
    });
    addAudit({ type: 'loa_approved', actorId: reviewerId, actor: reviewer, detail: `Approved LOA ${loa.id} for ${loa.username}` });
  } else {
    loa.status = 'denied';
    loa.active = false;
    loa.reviewedBy = reviewer;
    loa.reviewedById = reviewerId;
    loa.denyReason = reason || 'No reason provided';
    loa.reviewedAt = new Date().toISOString();
    await dmUser(loa.userId, {
      color: 0xef4444,
      title: 'LOA Denied',
      description: `Your leave request has been **denied**.\n\n**Dates:** ${loa.start} → ${loa.end}\n**Reason submitted:** ${loa.reason}\n**Denial reason:** ${loa.denyReason}`,
      footer: { text: `Reviewed by ${reviewer}` },
      timestamp: new Date().toISOString()
    });
    addAudit({ type: 'loa_denied', actorId: reviewerId, actor: reviewer, detail: `Denied LOA ${loa.id} for ${loa.username}` });
  }
  save(files.loa, loas);
  res.json({ success: true, loa });
});

app.get('/dashboard', checkAccess, async (req, res) => {
  const announcements = read(files.announcements);
  const latest = announcements[announcements.length - 1];
  const chat = read(files.chat).slice(-40).reverse();
  const tickets = read(files.tickets);
  const openTickets = tickets.filter(t => ['pending_staff', 'claimed', 'open'].includes(t.status)).length;
  const qotd = config.questionsOfTheDay[new Date().getDate() % config.questionsOfTheDay.length];
  const highestRank = await getHighestRoleName(req.user.id);
  const chatHTML = chat.map(m => `<div style="padding:12px 0;border-bottom:1px solid var(--border)"><strong>${m.username}</strong> <span class="muted" style="font-size:12px">${new Date(m.createdAt).toLocaleString()}</span><p style="margin-top:5px">${m.content}</p></div>`).join('') || '<p class="muted">No messages yet.</p>';
  const latestHTML = latest ? `<p><strong>${latest.title}</strong></p><p class="muted">${latest.content}</p>` : '<p class="muted">No announcements yet.</p>';

  res.send(layout(req.user, 'Dashboard', `
    <div class="hero"><h2>Operations Center</h2><p class="muted">Welcome back, <strong>${req.user.username}</strong> · ${highestRank}</p></div>
    <div class="grid-4">
      <div class="card"><div class="stat">${openTickets}</div><p class="muted">Open Tickets</p></div>
      <div class="card"><div class="stat">${tickets.length}</div><p class="muted">Total Tickets</p></div>
      <div class="card"><div class="stat">${read(files.loa).filter(l => l.status === 'pending').length}</div><p class="muted">LOA Pending</p></div>
      <div class="card"><div class="stat">${announcements.length}</div><p class="muted">Announcements</p></div>
    </div>
    <div class="grid">
      <div class="card"><h2>Latest Announcement</h2>${latestHTML}</div>
      <div class="card"><h2>Question of the Day</h2><p style="margin-bottom:12px">${qotd}</p>
        <form method="POST" action="/chat/post"><input type="hidden" name="type" value="qotd"/><textarea name="content" required rows="3"></textarea><button class="btn" type="submit">Post Answer</button></form>
      </div>
    </div>
    <div class="card"><h2>Staff Chat</h2>
      <div style="max-height:320px;overflow-y:auto;margin-bottom:12px">${chatHTML}</div>
      <form method="POST" action="/chat/post"><input type="hidden" name="type" value="chat"/><textarea name="content" required rows="2"></textarea><button class="btn" type="submit">Send</button></form>
    </div>
    <div class="card"><h2>Quick Actions</h2>
      <div class="btn-row">
        <a class="btn" href="/support">Support Queue</a>
        <a class="btn btn-outline" href="/loa">Leave of Absence</a>
        <a class="btn btn-outline" href="/announcements">Announcements</a>
        <a class="btn btn-outline" href="/settings">Settings</a>
      </div>
    </div>
  `, highestRank));
});

app.post('/chat/post', checkAccess, (req, res) => {
  const content = String(req.body.content || '').trim();
  if (!content) return res.redirect('/dashboard');
  if (containsBadWord(content)) return res.send('Blocked');
  const chat = read(files.chat);
  chat.push({ id: Date.now(), userId: req.user.id, username: req.user.username, content, type: req.body.type || 'chat', createdAt: new Date().toISOString() });
  save(files.chat, chat);
  addAudit({ type: 'staff_chat', actorId: req.user.id, actor: req.user.username, detail: content.slice(0, 120) });
  res.redirect('/dashboard');
});

// SUPPORT
app.get('/support', checkAccess, async (req, res) => {
  const highestRank = await getHighestRoleName(req.user.id);
  const tickets = read(files.tickets);
  const open = tickets.filter(t => ['open', 'claimed', 'pending_staff'].includes(t.status));
  const waitingUser = tickets.filter(t => t.status === 'pending_user');
  const closed = tickets.filter(t => t.status === 'closed' || t.status === 'resolved');
  const status = req.query.status || 'all';
  const q = String(req.query.q || '').toLowerCase();
  let filtered = tickets.slice().reverse();
  if (status !== 'all') filtered = filtered.filter(t => t.status === status);
  if (q) filtered = filtered.filter(t => String(t.username || '').toLowerCase().includes(q) || String(t.userId || '').includes(q));
  const cards = filtered.map(t => {
    const last = t.messages?.[t.messages.length - 1];
    return `<a class="card" href="/support/ticket/${t.id}" style="display:block;text-decoration:none;color:inherit">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:start">
        <div>
          <div style="font-weight:900;font-size:16px">${t.username}</div>
          <div class="muted" style="margin:6px 0">#${t.id}</div>
          <span class="badge">${t.status}</span>
          <span class="badge">${t.priority || 'normal'}</span>
          <p class="muted" style="margin-top:10px">${last ? last.content.slice(0, 140) : 'No messages yet'}</p>
        </div>
        <span class="btn btn-outline">Open</span>
      </div>
    </a>`;
  }).join('') || '<p class="muted">No tickets found.</p>';

  res.send(layout(req.user, 'Support', `
    <div class="hero"><h2>Support Queue</h2><p class="muted">Live ModMail conversations with members.</p>
      <div class="btn-row" style="margin-top:12px"><a class="btn btn-outline" href="/support/macros">Macros</a></div>
    </div>
    <div class="grid-4">
      <div class="card"><div class="stat">${open.length}</div><p class="muted">Needs Staff</p></div>
      <div class="card"><div class="stat">${waitingUser.length}</div><p class="muted">Waiting on User</p></div>
      <div class="card"><div class="stat">${closed.length}</div><p class="muted">Closed</p></div>
      <div class="card"><div class="stat">${tickets.length}</div><p class="muted">Total</p></div>
    </div>
    <div class="card"><form method="GET" action="/support" style="display:grid;grid-template-columns:2fr 1fr auto;gap:10px;align-items:end">
      <div><label class="muted">Search</label><input name="q" value="${req.query.q || ''}" placeholder="Username or Discord ID"/></div>
      <div><label class="muted">Status</label><select name="status">
        <option value="all">All</option>
        <option value="pending_staff">Pending Staff</option>
        <option value="pending_user">Pending User</option>
        <option value="claimed">Claimed</option>
        <option value="closed">Closed</option>
      </select></div>
      <button class="btn" type="submit">Filter</button>
    </form></div>
    ${cards}
  `, highestRank));
});

app.get('/support/ticket/:id', checkAccess, async (req, res) => {
  const tickets = read(files.tickets);
  const ticket = tickets.find(t => t.id === req.params.id);
  if (!ticket) return res.redirect('/support');
  const highestRank = await getHighestRoleName(req.user.id);
  const macros = read(files.macros).filter(m => m.active);
  const roleNames = await getMemberRoleNames(ticket.userId);

  let memberInfo = { username: ticket.username, id: ticket.userId, avatar: null };
  try {
    const ures = await fetch('https://discord.com/api/v10/users/' + ticket.userId, { headers: { Authorization: 'Bot ' + process.env.BOT_TOKEN } });
    if (ures.ok) {
      const u = await ures.json();
      memberInfo.username = u.username;
      if (u.avatar) memberInfo.avatar = `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`;
    }
  } catch {}

  const messages = (ticket.messages || []).map(m => {
    const cls = m.internal ? 'internal' : m.from;
    return `<div class="msg ${cls}"><div style="display:flex;justify-content:space-between;gap:8px"><strong>${m.author}</strong><span class="muted" style="font-size:12px">${new Date(m.timestamp).toLocaleString()}</span></div>${m.internal ? '<span class="badge badge-yellow">Internal Note</span>' : ''}<p style="margin-top:8px">${m.content}</p></div>`;
  }).join('') || '<p class="muted">No messages</p>';
  const macroOptions = macros.map(m => `<option value="${m.id}">${m.title}</option>`).join('');
  const rolesHTML = roleNames.length ? roleNames.map(r => `<span class="badge">${r}</span>`).join('') : '<span class="muted">No roles found</span>';

  res.send(layout(req.user, 'Support', `
    <div class="ticket-shell">
      <div>
        <div class="card" style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <h2 style="margin:0">${ticket.username}</h2>
            <p class="muted">Ticket #${ticket.id} · ${ticket.status} · ${ticket.priority || 'normal'}</p>
          </div>
          <a class="btn btn-outline" href="/support">Back</a>
        </div>
        <div class="card">
          <div class="chat-box" id="chatBox">${messages}</div>
          <form method="POST" action="/support/ticket/${ticket.id}/reply" style="margin-top:14px">
            <div class="grid">
              <select name="replyType"><option value="public">Public Reply</option><option value="internal">Internal Note</option></select>
              <select name="macroId"><option value="">No macro</option>${macroOptions}</select>
            </div>
            <textarea name="content" rows="4" placeholder="Write a reply..."></textarea>
            <div class="btn-row">
              <button class="btn" type="submit">Send</button>
              <button class="btn btn-outline" type="submit" formaction="/support/ticket/${ticket.id}/close" formmethod="POST" onclick="return confirm('Close this ticket?')">Close Ticket</button>
            </div>
          </form>
        </div>
      </div>
      <div>
        <div class="card">
          <h2>Member</h2>
          <img src="${memberInfo.avatar || 'https://via.placeholder.com/72'}" style="width:72px;height:72px;border-radius:50%;margin:8px 0"/>
          <p style="font-weight:900">${memberInfo.username}</p>
          <p class="muted">${memberInfo.id}</p>
          <p style="margin-top:12px;font-weight:800">Discord Roles</p>
          <div class="role-list">${rolesHTML}</div>
        </div>
        <div class="card"><h2>Claim</h2>
          <form method="POST" action="/support/ticket/${ticket.id}/claim">
            <button class="btn" type="submit">${ticket.claimedBy ? 'Re-assign to Me' : 'Claim Ticket'}</button>
          </form>
          ${ticket.claimedByName ? `<p class="muted" style="margin-top:10px">Assigned: ${ticket.claimedByName}</p>` : ''}
        </div>
        <div class="card"><h2>Status</h2>
          <form method="POST" action="/support/ticket/${ticket.id}/status">
            <select name="status">
              <option value="pending_staff">Pending Staff</option>
              <option value="pending_user">Pending User</option>
              <option value="claimed">Claimed</option>
              <option value="resolved">Resolved</option>
              <option value="closed">Closed</option>
            </select>
            <button class="btn" type="submit">Update</button>
          </form>
        </div>
        <div class="card"><h2>Priority</h2>
          <form method="POST" action="/support/ticket/${ticket.id}/priority">
            <select name="priority">
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
            <button class="btn" type="submit">Update</button>
          </form>
        </div>
      </div>
    </div>
    <script>
      // auto refresh conversation every 5s
      setInterval(function(){
        fetch(location.href, { headers: { 'X-Requested-With': 'fetch' }})
          .then(r => r.text())
          .then(html => {
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var next = doc.getElementById('chatBox');
            var cur = document.getElementById('chatBox');
            if (next && cur && next.innerHTML !== cur.innerHTML) {
              var nearBottom = cur.scrollHeight - cur.scrollTop - cur.clientHeight < 80;
              cur.innerHTML = next.innerHTML;
              if (nearBottom) cur.scrollTop = cur.scrollHeight;
            }
          }).catch(()=>{});
      }, 5000);
    </script>
  `, highestRank));
});

app.get('/api/support/ticket/:id/messages', checkAccess, (req, res) => {
  const ticket = read(files.tickets).find(t => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'missing' });
  res.json({ messages: ticket.messages || [], status: ticket.status });
});

app.post('/support/ticket/:id/claim', checkAccess, async (req, res) => {
  const tickets = read(files.tickets);
  const ticket = tickets.find(t => t.id === req.params.id);
  if (ticket) {
    ticket.status = 'claimed';
    ticket.claimedBy = req.user.id;
    ticket.claimedByName = req.user.username;
    save(files.tickets, tickets);
    addAudit({ type: 'ticket_claim', actorId: req.user.id, actor: req.user.username, detail: `Claimed #${ticket.id}` });
    await dmUser(ticket.userId, { color: 0x003768, title: 'Ticket Claimed', description: `Claimed by **${req.user.username}**`, footer: { text: 'Lone Star College • ModMail' }, timestamp: new Date().toISOString() });
  }
  res.redirect('/support/ticket/' + req.params.id);
});
app.post('/support/ticket/:id/reply', checkAccess, async (req, res) => {
  const tickets = read(files.tickets);
  const ticket = tickets.find(t => t.id === req.params.id);
  if (!ticket) return res.redirect('/support');
  let content = String(req.body.content || '').trim();
  if (req.body.macroId) {
    const macro = read(files.macros).find(m => m.id === req.body.macroId);
    if (macro) content = macro.content.replace(/\{\{username\}\}/g, ticket.username).replace(/\{\{id\}\}/g, ticket.userId);
  }
  if (!content) return res.redirect('/support/ticket/' + req.params.id);
  const isInternal = req.body.replyType === 'internal';
  ticket.messages.push({ from: 'staff', author: req.user.username, content, internal: isInternal, timestamp: new Date().toISOString() });
  if (!isInternal) {
    ticket.status = 'pending_user';
    await dmUser(ticket.userId, { color: 0x003768, title: 'Lone Star College Staff', description: content, footer: { text: 'Replied by ' + req.user.username }, timestamp: new Date().toISOString() });
  }
  save(files.tickets, tickets);
  addAudit({ type: isInternal ? 'ticket_note' : 'ticket_reply', actorId: req.user.id, actor: req.user.username, detail: `#${ticket.id}` });
  res.redirect('/support/ticket/' + req.params.id);
});
app.post('/support/ticket/:id/status', checkAccess, (req, res) => {
  const tickets = read(files.tickets);
  const ticket = tickets.find(t => t.id === req.params.id);
  if (ticket) { ticket.status = req.body.status; save(files.tickets, tickets); addAudit({ type: 'ticket_status', actorId: req.user.id, actor: req.user.username, detail: `#${ticket.id} -> ${req.body.status}` }); }
  res.redirect('/support/ticket/' + req.params.id);
});
app.post('/support/ticket/:id/priority', checkAccess, (req, res) => {
  const tickets = read(files.tickets);
  const ticket = tickets.find(t => t.id === req.params.id);
  if (ticket) { ticket.priority = req.body.priority; save(files.tickets, tickets); }
  res.redirect('/support/ticket/' + req.params.id);
});
app.post('/support/ticket/:id/close', checkAccess, (req, res) => {
  const tickets = read(files.tickets);
  const ticket = tickets.find(t => t.id === req.params.id);
  if (ticket) { ticket.status = 'closed'; save(files.tickets, tickets); addAudit({ type: 'ticket_close', actorId: req.user.id, actor: req.user.username, detail: `#${ticket.id}` }); }
  res.redirect('/support');
});

app.get('/support/macros', checkAccess, async (req, res) => {
  const highestRank = await getHighestRoleName(req.user.id);
  const macros = read(files.macros);
  const list = macros.map(m => `<div class="card"><strong>${m.title}</strong> <span class="badge">${m.active?'Active':'Inactive'}</span><p class="muted">${m.content}</p>
    <form method="POST" action="/support/macros/${m.id}/toggle" style="display:inline"><button class="btn btn-outline" type="submit">Toggle</button></form>
    <form method="POST" action="/support/macros/${m.id}/delete" style="display:inline;margin-left:8px"><button class="btn btn-outline" type="submit">Delete</button></form></div>`).join('') || '<p class="muted">No macros</p>';
  res.send(layout(req.user, 'Support', `<div class="card"><h2>Create Macro</h2><form method="POST" action="/support/macros/create"><input name="title" required/><textarea name="content" required rows="4"></textarea><button class="btn" type="submit">Save</button></form></div>${list}`, highestRank));
});
app.post('/support/macros/create', checkAccess, (req, res) => {
  const macros = read(files.macros);
  macros.push({ id: Date.now().toString(), title: req.body.title, content: req.body.content, active: true, createdBy: req.user.username, createdAt: new Date().toISOString() });
  save(files.macros, macros);
  res.redirect('/support/macros');
});
app.post('/support/macros/:id/toggle', checkAccess, (req, res) => {
  const macros = read(files.macros);
  const m = macros.find(x => x.id === req.params.id);
  if (m) m.active = !m.active;
  save(files.macros, macros);
  res.redirect('/support/macros');
});
app.post('/support/macros/:id/delete', checkAccess, (req, res) => {
  save(files.macros, read(files.macros).filter(x => x.id !== req.params.id));
  res.redirect('/support/macros');
});

// LOA
function isAwayToday(loa) {
  if (loa.status !== 'approved') return false;
  const today = new Date(); today.setHours(0,0,0,0);
  const start = new Date(loa.start); start.setHours(0,0,0,0);
  const end = new Date(loa.end); end.setHours(0,0,0,0);
  return today >= start && today <= end;
}

app.get('/loa', checkAccess, async (req, res) => {
  const highestRank = await getHighestRoleName(req.user.id);
  const loas = read(files.loa);
  const pending = loas.filter(l => l.status === 'pending').length;
  const awayToday = loas.filter(isAwayToday).length;
  const approved = loas.filter(l => l.status === 'approved').length;
  const denied = loas.filter(l => l.status === 'denied').length;

  const status = req.query.status || 'all';
  const q = String(req.query.q || '').toLowerCase();
  let filtered = loas.slice().reverse();
  if (status !== 'all') filtered = filtered.filter(l => l.status === status);
  if (q) filtered = filtered.filter(l => String(l.username||'').toLowerCase().includes(q) || String(l.reason||'').toLowerCase().includes(q));

  const list = filtered.map(l => {
    const badge = l.status === 'approved' ? 'badge-green' : l.status === 'denied' ? 'badge-red' : 'badge-yellow';
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;gap:12px">
        <div>
          <strong>${l.username}</strong> <span class="badge ${badge}">${l.status}</span>
          <p class="muted" style="margin-top:8px">${l.reason}</p>
          <small class="muted">${l.start} → ${l.end} · Basics: ${l.availableBasics ? 'Yes' : 'No'}</small>
          ${l.denyReason ? `<p class="muted">Denied: ${l.denyReason}</p>` : ''}
          ${l.reviewNote ? `<p class="muted">Note: ${l.reviewNote}</p>` : ''}
        </div>
      </div>
    </div>`;
  }).join('') || '<p class="muted">No leave requests found.</p>';

  res.send(layout(req.user, 'LOA', `
    <div class="hero">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap">
        <div><h2>Leave of Absence</h2><p class="muted">Track pending, approved, and denied leave.</p></div>
        <button class="btn" type="button" onclick="document.getElementById('loaForm').style.display='block'">Request Leave</button>
      </div>
    </div>
    <div class="grid-4">
      <div class="card"><div class="stat">${pending}</div><p class="muted">Waiting Review</p></div>
      <div class="card"><div class="stat">${awayToday}</div><p class="muted">Away Today</p></div>
      <div class="card"><div class="stat">${approved}</div><p class="muted">All-time Approved</p></div>
      <div class="card"><div class="stat">${denied}</div><p class="muted">All-time Denials</p></div>
    </div>
    <div class="card" id="loaForm" style="display:none">
      <h2>Request Leave</h2>
      <form method="POST" action="/loa/request">
        <label class="muted">Reason</label>
        <textarea name="reason" required rows="3" placeholder="Why are you requesting leave?"></textarea>
        <div class="grid">
          <div><label class="muted">First day away</label><input type="date" name="start" required/></div>
          <div><label class="muted">Day back</label><input type="date" name="end" required/></div>
        </div>
        <div class="switch-row">
          <div><strong>Available for basic duties?</strong><p class="muted">Tickets / community help while away</p></div>
          <label class="switch"><input type="checkbox" name="availableBasics"/><span class="slider"></span></label>
        </div>
        <button class="btn" type="submit">Submit Leave Request</button>
      </form>
    </div>
    <div class="card"><h2>Leave Requests</h2>
      <form method="GET" action="/loa" style="display:grid;grid-template-columns:2fr 1fr auto;gap:10px;align-items:end">
        <div><label class="muted">Search staff / reason</label><input name="q" value="${req.query.q || ''}"/></div>
        <div><label class="muted">Status</label>
          <select name="status">
            <option value="all">All</option>
            <option value="pending" ${status==='pending'?'selected':''}>Pending</option>
            <option value="approved" ${status==='approved'?'selected':''}>Approved</option>
            <option value="denied" ${status==='denied'?'selected':''}>Denied</option>
          </select>
        </div>
        <button class="btn" type="submit">Filter</button>
      </form>
    </div>
    ${list}
  `, highestRank));
});

app.post('/loa/request', checkAccess, async (req, res) => {
  const loas = read(files.loa);
  const loa = {
    id: Date.now().toString(),
    userId: req.user.id,
    username: req.user.username,
    reason: req.body.reason,
    start: req.body.start,
    end: req.body.end,
    availableBasics: !!req.body.availableBasics,
    status: 'pending',
    active: false,
    createdAt: new Date().toISOString()
  };
  loas.push(loa);
  save(files.loa, loas);
  addAudit({ type: 'loa_request', actorId: req.user.id, actor: req.user.username, detail: `LOA ${loa.id}: ${loa.reason}` });
  await postLoaReviewMessage(loa);
  res.redirect('/loa');
});

app.get('/announcements', checkAccess, async (req, res) => {
  const highestRank = await getHighestRoleName(req.user.id);
  const list = read(files.announcements).reverse().map(a => `<div class="card"><strong>${a.title}</strong><p class="muted">${a.content}</p><small class="muted">By ${a.author}</small></div>`).join('') || '<p class="muted">No announcements</p>';
  res.send(layout(req.user, 'Announcements', `<div class="hero"><h2>Announcements</h2><p class="muted">Staff updates</p></div>${list}`, highestRank));
});

app.get('/notifications', checkAccess, async (req, res) => {
  const highestRank = await getHighestRoleName(req.user.id);
  const notes = read(files.audit).filter(l => ['notification', 'announcement', 'loa_approved', 'loa_denied', 'ticket_create'].includes(l.type)).reverse().slice(0, 50);
  const list = notes.map(n => `<div class="card"><strong>${n.type}</strong><p class="muted">${n.detail || ''}</p><small class="muted">${n.actor || 'System'} · ${new Date(n.at).toLocaleString()}</small></div>`).join('') || '<p class="muted">No notifications</p>';
  res.send(layout(req.user, 'Notifications', `<div class="hero"><h2>Notifications</h2></div>${list}`, highestRank));
});

app.get('/admin/announcements', checkAccess, async (req, res) => {
  if (!req.user.hasBotManagement) return res.redirect('/announcements');
  const highestRank = await getHighestRoleName(req.user.id);
  const list = read(files.announcements).reverse().map(a => `<div class="card"><strong>${a.title}</strong><p class="muted">${a.content}</p></div>`).join('') || '<p class="muted">None</p>';
  res.send(layout(req.user, 'Admin Announcements', `
    <div class="card"><h2>Post Announcement</h2>
      <form method="POST" action="/admin/announcements/create">
        <input name="title" required/><textarea name="content" required rows="4"></textarea>
        <button class="btn" type="submit">Publish</button>
      </form>
    </div>${list}
  `, highestRank));
});
app.post('/admin/announcements/create', checkAccess, (req, res) => {
  if (!req.user.hasBotManagement) return res.redirect('/dashboard');
  const a = read(files.announcements);
  a.push({ id: Date.now(), title: req.body.title, content: req.body.content, author: req.user.username, createdAt: new Date().toISOString() });
  save(files.announcements, a);
  addAudit({ type: 'announcement', actorId: req.user.id, actor: req.user.username, detail: req.body.title });
  res.redirect('/admin/announcements');
});

app.get('/logs', checkAccess, async (req, res) => {
  if (!req.user.hasBotManagement) return res.redirect('/dashboard');
  const highestRank = await getHighestRoleName(req.user.id);
  const rows = read(files.audit).slice().reverse().slice(0, 400).map(l => `<div class="card" style="padding:14px"><strong>${l.type}</strong> <span class="muted">${new Date(l.at).toLocaleString()}</span><p style="margin-top:6px"><strong>${l.actor || 'System'}</strong>: ${l.detail || ''}</p></div>`).join('') || '<p class="muted">No logs yet. New actions will appear here.</p>';
  res.send(layout(req.user, 'Logs', `<div class="hero"><h2>Audit Logs</h2><p class="muted">Website + LOA + ticket activity</p></div>${rows}`, highestRank));
});

app.get('/settings', checkAccess, async (req, res) => {
  const highestRank = await getHighestRoleName(req.user.id);
  const p = getProfile(req.user.id);
  const tab = req.query.tab || 'profile';
  const tabs = `<div class="btn-row" style="margin-bottom:18px">
    <a class="btn ${tab==='profile'?'':'btn-outline'}" href="/settings?tab=profile">Profile</a>
    <a class="btn ${tab==='account'?'':'btn-outline'}" href="/settings?tab=account">Account</a>
    <a class="btn ${tab==='appearance'?'':'btn-outline'}" href="/settings?tab=appearance">Appearance</a>
    <a class="btn ${tab==='notifications'?'':'btn-outline'}" href="/settings?tab=notifications">Notifications</a>
  </div>`;
  let body = '';
  if (tab === 'profile') {
    body = `<div class="card"><form method="POST" action="/settings/profile">
      <input name="displayName" value="${p.displayName||''}" placeholder="Display name"/>
      <input name="tagline" value="${p.tagline||''}" placeholder="Tagline"/>
      <textarea name="bio" rows="4">${p.bio||''}</textarea>
      <input name="bannerUrl" value="${p.bannerUrl||''}" placeholder="Banner URL"/>
      <input name="timezone" value="${p.timezone||'America/Chicago'}"/>
      <button class="btn" type="submit">Save</button></form></div>`;
  } else if (tab === 'account') {
    body = `<div class="card"><p><strong>Discord ID:</strong> ${req.user.id}</p><p><strong>Username:</strong> ${req.user.username}</p><p><strong>Rank:</strong> ${highestRank}</p></div>`;
  } else if (tab === 'appearance') {
    body = `<div class="card"><form method="POST" action="/settings/appearance">
      <input name="accent" value="${p.accent||config.colors.primary}"/>
      <div class="switch-row"><div><strong>Compact mode</strong></div><label class="switch"><input type="checkbox" name="compactMode" ${p.compactMode?'checked':''}/><span class="slider"></span></label></div>
      <div class="switch-row"><div><strong>Collapse sidebar by default</strong></div><label class="switch"><input type="checkbox" name="collapseSidebar" ${p.collapseSidebar?'checked':''}/><span class="slider"></span></label></div>
      <button class="btn" type="submit">Save</button></form></div>`;
  } else {
    const rows = (config.notificationOptions||[]).map(o => `<div class="switch-row"><div><strong>${o.label}</strong></div><label class="switch"><input type="checkbox" name="notif_${o.key}" ${p.notifications[o.key]?'checked':''}/><span class="slider"></span></label></div>`).join('');
    body = `<div class="card"><form method="POST" action="/settings/notifications">${rows}<button class="btn" type="submit" style="margin-top:12px">Save Notifications</button></form></div>`;
  }
  res.send(layout(req.user, 'Settings', `<div class="hero"><h2>Settings</h2></div>${tabs}${body}`, highestRank));
});
app.post('/settings/profile', checkAccess, (req, res) => {
  saveProfile(req.user.id, { displayName: req.body.displayName||'', tagline: req.body.tagline||'', bio: req.body.bio||'', bannerUrl: req.body.bannerUrl||'', timezone: req.body.timezone||'America/Chicago' });
  res.redirect('/settings?tab=profile');
});
app.post('/settings/appearance', checkAccess, (req, res) => {
  saveProfile(req.user.id, { accent: req.body.accent||config.colors.primary, compactMode: !!req.body.compactMode, collapseSidebar: !!req.body.collapseSidebar });
  res.redirect('/settings?tab=appearance');
});
app.post('/settings/notifications', checkAccess, (req, res) => {
  const notifications = {};
  (config.notificationOptions||[]).forEach(o => { notifications[o.key] = !!req.body['notif_'+o.key]; });
  saveProfile(req.user.id, { notifications });
  res.redirect('/settings?tab=notifications');
});

app.listen(PORT, () => console.log('Staff Panel running on port ' + PORT));
