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

async function sendDiscordLog(title, description, color = 0x38bdf8) {
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
  sendDiscordLog(entry.type || 'Audit', `**Actor:** ${entry.actor || 'System'}\n**Detail:** ${entry.detail || '—'}`);
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
          color: 0x38bdf8,
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
    return res.send(`<!DOCTYPE html><html><body style="background:#070b14;color:#fff;font-family:system-ui;display:flex;height:100vh;align-items:center;justify-content:center;text-align:center"><div><h1>Access Denied</h1><p>You need <b>${config.roles.webAccess}</b></p><a href="/logout" style="color:#38bdf8">Logout</a></div></body></html>`);
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
:root{
  --bg:${config.colors.background};
  --card:${config.colors.card};
  --primary:${config.colors.primary};
  --accent:${config.colors.accent};
  --text:${config.colors.text};
  --muted:${config.colors.muted};
  --border:rgba(148,163,184,.14);
  --shadow:0 20px 50px rgba(0,0,0,.35);
  --glow:0 0 0 1px rgba(56,189,248,.18), 0 10px 30px rgba(56,189,248,.08);
}
body.light{
  --bg:#f5f7fb;--card:#ffffff;--text:#0f172a;--muted:#64748b;
  --border:#e2e8f0;--shadow:0 12px 30px rgba(15,23,42,.08);--glow:0 0 0 1px rgba(14,165,233,.12);
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{
  font-family:Inter,system-ui,sans-serif;
  background:
    radial-gradient(1200px 600px at 0% -10%, rgba(56,189,248,.16), transparent 55%),
    radial-gradient(900px 500px at 100% 0%, rgba(251,113,133,.10), transparent 50%),
    var(--bg);
  color:var(--text);
  min-height:100vh;
  line-height:1.5;
}
body.compact .card{padding:14px}
body.compact .main{padding:18px 18px 40px}

.sidebar{
  width:300px;height:100vh;position:fixed;left:0;top:0;
  background:rgba(10,16,28,.88);
  border-right:1px solid var(--border);
  backdrop-filter:blur(18px);
  padding:18px 12px;
  display:flex;flex-direction:column;
  z-index:40;
  transition:width .28s ease, transform .28s ease;
}
body.light .sidebar{background:rgba(255,255,255,.92)}
body.collapse-side .sidebar{width:92px}
body.collapse-side .logo-text,
body.collapse-side .nav-label,
body.collapse-side .nav a span.label{display:none}
body.collapse-side .nav a{justify-content:center}
body.collapse-side .main{margin-left:92px}

.logo{display:flex;align-items:center;gap:12px;padding:10px;margin-bottom:10px}
.logo img{width:44px;height:44px;border-radius:14px;object-fit:cover;box-shadow:var(--shadow)}
.logo-text{font-weight:900;font-size:14px;letter-spacing:-.02em}
.logo-text span{display:block;color:var(--muted);font-size:11px;font-weight:600;margin-top:2px}

.nav-label{
  font-size:11px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;
  color:#cbd5e1;padding:16px 12px 8px;opacity:.9
}
.nav a{
  display:flex;align-items:center;gap:10px;
  padding:12px 12px;border-radius:14px;color:var(--muted);
  text-decoration:none;margin-bottom:4px;font-size:14px;font-weight:700;
  transition:all .2s ease; position:relative;
}
.nav a:hover{background:rgba(56,189,248,.10);color:var(--primary);transform:translateX(3px)}
.nav a.active{background:rgba(56,189,248,.14);color:var(--primary);box-shadow:inset 3px 0 0 var(--primary)}
.nav a .dot{width:8px;height:8px;border-radius:50%;background:currentColor;opacity:.55}

.main{margin-left:300px;padding:28px 34px 60px;transition:margin-left .28s ease}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:22px}
.page-title h1{font-size:clamp(24px,3vw,34px);font-weight:900;letter-spacing:-.04em}
.page-title p{color:var(--muted);font-size:14px;margin-top:4px}

.profile{
  display:flex;align-items:center;gap:12px;
  background:rgba(255,255,255,.03);
  border:1px solid var(--border);
  border-radius:999px;padding:7px 14px 7px 7px;
  box-shadow:var(--shadow);
  transition:transform .2s ease, border-color .2s ease;
}
.profile:hover{transform:translateY(-1px);border-color:rgba(56,189,248,.28)}
.profile img{width:36px;height:36px;border-radius:50%}

.hero,.card,.stat-card,.action-card{
  animation:rise .45s ease both;
}
@keyframes rise{
  from{opacity:0;transform:translateY(10px)}
  to{opacity:1;transform:none}
}
.hero{
  background:linear-gradient(135deg, rgba(56,189,248,.16), rgba(251,113,133,.08));
  border:1px solid var(--border);
  border-radius:24px;padding:24px;
  margin-bottom:18px;box-shadow:var(--shadow);
  position:relative;overflow:hidden;
}
.hero:before{
  content:"";position:absolute;right:-40px;top:-40px;width:180px;height:180px;
  background:radial-gradient(circle,rgba(56,189,248,.25),transparent 70%);
  pointer-events:none;
}
.card{
  background:linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.015));
  border:1px solid var(--border);
  border-radius:20px;padding:20px;margin-bottom:16px;
  box-shadow:var(--shadow);
  transition:transform .2s ease, border-color .2s ease, box-shadow .2s ease;
}
.card:hover{transform:translateY(-2px);border-color:rgba(56,189,248,.22);box-shadow:var(--glow)}
h2{font-size:18px;font-weight:800;letter-spacing:-.02em;margin-bottom:10px}
.muted{color:var(--muted);font-size:14px}

.btn{
  background:linear-gradient(135deg, var(--primary), #0ea5e9);
  color:#041018;border:none;padding:11px 16px;border-radius:12px;
  cursor:pointer;font-weight:800;text-decoration:none;display:inline-flex;
  align-items:center;justify-content:center;gap:8px;font-size:14px;
  transition:transform .18s ease, filter .18s ease, box-shadow .18s ease;
  box-shadow:0 8px 20px rgba(56,189,248,.18);
}
.btn:hover{transform:translateY(-2px);filter:brightness(1.05)}
.btn:active{transform:translateY(0)}
.btn-outline{
  background:transparent;color:var(--text);border:1px solid var(--border);
  box-shadow:none;
}
.btn-outline:hover{border-color:rgba(56,189,248,.35);background:rgba(56,189,248,.08)}
.btn-accent{background:linear-gradient(135deg, var(--accent), #e11d48);color:#fff;box-shadow:0 8px 20px rgba(251,113,133,.18)}
.btn-row{display:flex;flex-wrap:wrap;gap:10px}

input,textarea,select{
  width:100%;padding:12px 14px;border-radius:12px;
  border:1px solid var(--border);
  background:rgba(255,255,255,.03);
  color:var(--text);margin:8px 0 12px;font-size:14px;
  transition:border-color .18s ease, box-shadow .18s ease;
}
input:focus,textarea:focus,select:focus{
  outline:none;border-color:rgba(56,189,248,.45);
  box-shadow:0 0 0 4px rgba(56,189,248,.12);
}
body.light input,body.light textarea,body.light select{background:#fff}

.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.stat{font-size:30px;font-weight:900;letter-spacing:-.04em}
.stat-card{text-align:left}

.badge{
  display:inline-flex;align-items:center;gap:6px;
  background:rgba(56,189,248,.12);color:var(--primary);
  font-size:11px;padding:5px 10px;border-radius:999px;font-weight:800;margin:2px;
}
.badge-green{background:rgba(34,197,94,.12);color:#4ade80}
.badge-red{background:rgba(239,68,68,.12);color:#f87171}
.badge-yellow{background:rgba(234,179,8,.12);color:#facc15}

.msg{
  padding:14px 16px;border-radius:16px;margin-bottom:12px;
  border:1px solid var(--border);
  animation:rise .35s ease both;
}
.msg.user{background:rgba(34,197,94,.08);border-left:3px solid #22c55e}
.msg.staff{background:rgba(56,189,248,.08);border-left:3px solid var(--primary)}
.msg.internal{background:rgba(234,179,8,.08);border-left:3px solid #eab308}

.switch-row{
  display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:14px 0;border-bottom:1px solid var(--border);
}
.switch{position:relative;width:52px;height:30px;flex-shrink:0}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;cursor:pointer;inset:0;background:#334155;border-radius:999px;transition:.22s}
.slider:before{position:absolute;content:"";height:22px;width:22px;left:4px;top:4px;background:#fff;border-radius:50%;transition:.22s;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.switch input:checked + .slider{background:var(--primary)}
.switch input:checked + .slider:before{transform:translateX(22px)}

.ticket-shell{display:grid;grid-template-columns:1.7fr .9fr;gap:16px}
.chat-box{max-height:520px;overflow-y:auto;padding-right:4px}
.role-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.action-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.action-card{
  display:block;padding:16px;border-radius:16px;border:1px solid var(--border);
  background:rgba(255,255,255,.03);text-decoration:none;color:var(--text);font-weight:800;
  transition:transform .2s ease, border-color .2s ease, background .2s ease;
}
.action-card:hover{transform:translateY(-3px);border-color:rgba(56,189,248,.35);background:rgba(56,189,248,.06)}
.action-card span{display:block;color:var(--muted);font-size:12px;font-weight:600;margin-top:6px}

.mobile-top{display:none}
@media(max-width:980px){
  .sidebar{transform:translateX(-105%)}
  .sidebar.open{transform:none}
  .main{margin-left:0;padding:18px 16px 50px}
  .grid,.grid-4,.ticket-shell,.action-grid{grid-template-columns:1fr}
  .mobile-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
}

/* loading shimmer */
.shimmer{
  background:linear-gradient(90deg, transparent, rgba(255,255,255,.06), transparent);
  background-size:200% 100%;
  animation:shimmer 1.4s infinite;
}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
</style>
</head>
<body class="${compactClass} ${collapseClass}">
<div class="sidebar" id="sidebar">
  <div class="logo">
    <img src="${config.logo}" alt="Logo"/>
    <div class="logo-text">${config.siteName}<span>${config.siteSubtitle}</span></div>
  </div>
  <div class="nav">
    <div class="nav-label">Overview</div>
    <a href="/dashboard" class="${title==='Dashboard'?'active':''}" title="Dashboard"><span class="dot"></span><span class="label">Dashboard</span></a>

    <div class="nav-label">Community</div>
    <a href="/support" class="${title==='Support'?'active':''}" title="Support"><span class="dot"></span><span class="label">Support</span></a>
    <a href="/announcements" class="${title==='Announcements'?'active':''}" title="Announcements"><span class="dot"></span><span class="label">Announcements</span></a>
    <a href="/notifications" class="${title==='Notifications'?'active':''}" title="Notifications"><span class="dot"></span><span class="label">Notifications</span></a>

    <div class="nav-label">Management</div>
    <a href="/loa" class="${title==='LOA'?'active':''}" title="Leave of Absence"><span class="dot"></span><span class="label">Leave of Absence</span></a>
    <a href="/settings" class="${title==='Settings'?'active':''}" title="Settings"><span class="dot"></span><span class="label">Settings</span></a>

    ${isManager ? `
      <div class="nav-label">Administration</div>
      <a href="/admin/announcements" class="${title==='Admin Announcements'?'active':''}" title="Post Announcements"><span class="dot"></span><span class="label">Post Announcements</span></a>
      <a href="/logs" class="${title==='Logs'?'active':''}" title="Audit Logs"><span class="dot"></span><span class="label">Audit Logs</span></a>
    ` : ''}

    <a href="/logout" style="margin-top:auto;color:#fb7185" title="Logout"><span class="dot"></span><span class="label">Logout</span></a>
  </div>
</div>

<div class="main">
  <div class="mobile-top">
    <button class="btn btn-outline" type="button" onclick="document.getElementById('sidebar').classList.toggle('open')">Menu</button>
    <button class="btn btn-outline" type="button" onclick="toggleTheme()">Theme</button>
  </div>

  <div class="topbar">
    <div class="page-title">
      <h1>${title}</h1>
      <p>Lone Star College Administration</p>
    </div>
    <div style="display:flex;align-items:center;gap:12px">
      <button class="btn btn-outline" onclick="toggleTheme()" style="padding:8px 12px">Theme</button>
      <div class="profile">
        <img src="${user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : 'https://via.placeholder.com/36'}" alt=""/>
        <div style="font-size:13px;line-height:1.2">
          <div style="font-weight:800">${user.username}</div>
          <div class="muted" style="font-size:11px">${highestRank}</div>
        </div>
      </div>
    </div>
  </div>
  ${content}
</div>

<script>
function toggleTheme(){
  document.body.classList.toggle('light');
  localStorage.setItem('theme', document.body.classList.contains('light') ? 'light' : 'dark');
}
if(localStorage.getItem('theme')==='light') document.body.classList.add('light');

var idle=0;
function resetIdle(){idle=0}
setInterval(function(){idle++; if(idle>=30) location.href='/logout'}, 60000);
['load','mousemove','keypress','click','scroll','touchstart'].forEach(function(e){
  window.addEventListener(e, resetIdle, {passive:true});
});
</script>
</body></html>`;
}

function legalPage(title, body) {
  return `<!DOCTYPE html><html><head><title>${title}</title><link rel="icon" href="${config.favicon || config.logo}"/>
  <style>
  body{margin:0;font-family:Inter,system-ui;background:#070b14;color:#f1f5f9;padding:40px 18px}
  .wrap{max-width:760px;margin:0 auto;background:#0d1524;border:1px solid rgba(148,163,184,.14);border-radius:20px;padding:28px}
  a{color:#38bdf8;text-decoration:none}p{color:#94a3b8;line-height:1.7;margin:12px 0}
  </style></head>
  <body><div class="wrap"><h1>${title}</h1>${body}
  <p style="margin-top:24px"><a href="/login">← Back to login</a></p>
  <p style="color:#64748b;font-size:12px">© 2026 Roblox, Lone Star College. All rights reserved.</p>
  </div></body></html>`;
}

app.get('/', (req, res) => req.isAuthenticated() ? res.redirect('/dashboard') : res.redirect('/login'));

app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html><html><head>
<title>Staff Portal • ${config.siteName}</title>
<link rel="icon" href="${config.favicon || config.logo}"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700;900&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#f1f5f9;
background:radial-gradient(1000px 600px at 15% -10%,rgba(56,189,248,.22),transparent 55%),radial-gradient(800px 500px at 100% 0%,rgba(251,113,133,.12),transparent 50%),#070b14}
.box{width:min(440px,92vw);background:rgba(13,21,36,.92);border:1px solid rgba(148,163,184,.14);border-radius:28px;padding:42px 34px;text-align:center;box-shadow:0 30px 80px rgba(0,0,0,.45);backdrop-filter:blur(16px);animation:rise .5s ease}
@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
img{width:84px;height:84px;border-radius:22px;margin-bottom:18px}
h1{font-size:30px;font-weight:900;letter-spacing:-.04em;margin-bottom:8px}
.sub{color:#94a3b8;margin-bottom:24px}
.btn{display:inline-flex;width:100%;justify-content:center;background:linear-gradient(135deg,#5865F2,#4752c4);color:#fff;text-decoration:none;padding:14px 18px;border-radius:14px;font-weight:800;transition:transform .18s ease}
.btn:hover{transform:translateY(-2px)}
.legal{margin-top:22px;font-size:12px;color:#94a3b8}
.legal a{color:#94a3b8;text-decoration:none;margin:0 6px}
.legal a:hover{color:#38bdf8}
.copy{margin-top:14px;font-size:11px;color:#64748b}
</style></head>
<body><div class="box">
  <img src="${config.loginLogo}" alt=""/>
  <h1>Staff Portal</h1>
  <p class="sub">${config.siteName}<br/>Authorized personnel only</p>
  <a class="btn" href="/auth/discord">Continue with Discord</a>
  <div class="legal"><a href="/privacy">Privacy</a>•<a href="/terms">Terms of Service</a>•<a href="/cookies">Cookies</a></div>
  <div class="copy">© 2026 Roblox, Lone Star College. All rights reserved.</div>
</div></body></html>`);
});

app.get('/privacy', (req, res) => res.send(legalPage('Privacy Policy', `<p>This Staff Portal is operated for Lone Star College administrative use.</p><p>Discord identity is used for authentication and access control.</p><p>Ticket, LOA, chat, and audit data may be stored for operations.</p>`)));
app.get('/terms', (req, res) => res.send(legalPage('Terms of Service', `<p>Access is limited to authorized staff with required Discord roles.</p><p>Misuse of ModMail, confidential data, or system access is prohibited.</p>`)));
app.get('/cookies', (req, res) => res.send(legalPage('Cookies', `<p>Essential session cookies keep you logged in securely.</p><p>Local storage saves theme and UI preferences only.</p>`)));

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/login' }), (req, res) => {
  addAudit({ type: 'login', actorId: req.user.id, actor: req.user.username, detail: 'Staff logged into website' });
  res.redirect('/dashboard');
});
app.get('/logout', (req, res) => {
  if (req.user) addAudit({ type: 'logout', actorId: req.user.id, actor: req.user.username, detail: 'Staff logged out of website' });
  req.logout(() => res.redirect('/login'));
});

// ===== APIs =====
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
  addAudit({ type: isNew ? 'ticket_create' : 'ticket_user_reply', actorId: userId, actor: username, detail: isNew ? `New ticket #${ticket.id}` : `Reply on #${ticket.id}` });
  res.json({ success: true, ticket });
});

app.post('/api/loa/:id/decision', async (req, res) => {
  if (req.headers['x-modmail-secret'] !== process.env.MODMAIL_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const loas = read(files.loa);
  const loa = loas.find(l => String(l.id) === String(req.params.id));
  if (!loa) return res.status(404).json({ error: 'Not found' });
  if (loa.status !== 'pending') return res.json({ success: false, error: 'Already decided' });

  const decision = req.body.decision;
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

// ===== PAGES =====
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
    <div class="hero">
      <h2>Operations Center</h2>
      <p class="muted">Welcome back, <strong>${req.user.username}</strong> · ${highestRank}</p>
      <div class="btn-row" style="margin-top:14px">
        <a class="btn" href="/support">Open Support</a>
        <a class="btn btn-outline" href="/loa">Request LOA</a>
        <a class="btn btn-outline" href="/settings">Settings</a>
      </div>
    </div>
    <div class="grid-4">
      <div class="card stat-card"><div class="stat">${openTickets}</div><p class="muted">Open Tickets</p></div>
      <div class="card stat-card"><div class="stat">${tickets.length}</div><p class="muted">Total Tickets</p></div>
      <div class="card stat-card"><div class="stat">${read(files.loa).filter(l => l.status === 'pending').length}</div><p class="muted">LOA Pending</p></div>
      <div class="card stat-card"><div class="stat">${announcements.length}</div><p class="muted">Announcements</p></div>
    </div>
    <div class="grid">
      <div class="card"><h2>Latest Announcement</h2>${latestHTML}</div>
      <div class="card"><h2>Question of the Day</h2><p style="margin-bottom:12px">${qotd}</p>
        <form method="POST" action="/chat/post"><input type="hidden" name="type" value="qotd"/><textarea name="content" required rows="3" placeholder="Share your answer..."></textarea><button class="btn" type="submit">Post Answer</button></form>
      </div>
    </div>
    <div class="card"><h2>Staff Chat</h2>
      <div style="max-height:320px;overflow-y:auto;margin-bottom:12px">${chatHTML}</div>
      <form method="POST" action="/chat/post"><input type="hidden" name="type" value="chat"/><textarea name="content" required rows="2" placeholder="Write a message..."></textarea><button class="btn" type="submit">Send Message</button></form>
    </div>
    <div class="card"><h2>Quick Actions</h2>
      <div class="action-grid">
        <a class="action-card" href="/support">Support Queue<span>Claim & reply to tickets</span></a>
        <a class="action-card" href="/loa">Leave of Absence<span>Request or track leave</span></a>
        <a class="action-card" href="/announcements">Announcements<span>Read staff updates</span></a>
        <a class="action-card" href="/notifications">Notifications<span>Recent portal alerts</span></a>
        <a class="action-card" href="/settings">Settings<span>Profile & preferences</span></a>
        <a class="action-card" href="/support/macros">Macros<span>Reply templates</span></a>
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
    <div class="hero">
      <h2>Support Queue</h2>
      <p class="muted">Live ModMail conversations with members.</p>
      <div class="btn-row" style="margin-top:12px"><a class="btn btn-outline" href="/support/macros">Macros</a></div>
    </div>
    <div class="grid-4">
      <div class="card"><div class="stat">${open.length}</div><p class="muted">Needs Staff</p></div>
      <div class="card"><div class="stat">${waitingUser.length}</div><p class="muted">Waiting on User</p></div>
      <div class="card"><div class="stat">${closed.length}</div><p class="muted">Closed</p></div>
      <div class="card"><div class="stat">${tickets.length}</div><p class="muted">Total</p></div>
    </div>
    <div class="card">
      <form method="GET" action="/support" style="display:grid;grid-template-columns:2fr 1fr auto;gap:10px;align-items:end">
        <div><label class="muted">Search</label><input name="q" value="${req.query.q || ''}" placeholder="Username or Discord ID"/></div>
        <div><label class="muted">Status</label>
          <select name="status">
            <option value="all">All</option>
            <option value="pending_staff">Pending Staff</option>
            <option value="pending_user">Pending User</option>
            <option value="claimed">Claimed</option>
            <option value="closed">Closed</option>
          </select>
        </div>
        <button class="btn" type="submit">Filter</button>
      </form>
    </div>
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
        <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:12px">
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
      setInterval(function(){
        fetch(location.href).then(r=>r.text()).then(html=>{
          var doc=new DOMParser().parseFromString(html,'text/html');
          var next=doc.getElementById('chatBox');
          var cur=document.getElementById('chatBox');
          if(next&&cur&&next.innerHTML!==cur.innerHTML){
            var nearBottom=cur.scrollHeight-cur.scrollTop-cur.clientHeight<80;
            cur.innerHTML=next.innerHTML;
            if(nearBottom) cur.scrollTop=cur.scrollHeight;
          }
        }).catch(()=>{});
      },5000);
    </script>
  `, highestRank));
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
  res.send(layout(req.user, 'Support', `<div class="card"><h2>Create Macro</h2><form method="POST" action="/support/macros/create"><input name="title" required placeholder="Title"/><textarea name="content" required rows="4" placeholder="Hello {{username}}..."></textarea><button class="btn" type="submit">Save</button></form></div>${list}`, highestRank));
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
    return `<div class="card"><strong>${l.username}</strong> <span class="badge ${badge}">${l.status}</span>
      <p class="muted" style="margin-top:8px">${l.reason}</p>
      <small class="muted">${l.start} → ${l.end} · Basics: ${l.availableBasics ? 'Yes' : 'No'}</small>
      ${l.denyReason ? `<p class="muted">Denied: ${l.denyReason}</p>` : ''}
      ${l.reviewNote ? `<p class="muted">Note: ${l.reviewNote}</p>` : ''}
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
        <textarea name="reason" required rows="3"></textarea>
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
    <div class="card">
      <form method="GET" action="/loa" style="display:grid;grid-template-columns:2fr 1fr auto;gap:10px;align-items:end">
        <div><label class="muted">Search</label><input name="q" value="${req.query.q || ''}"/></div>
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
  const notes = read(files.audit).filter(l => ['notification','announcement','loa_approved','loa_denied','ticket_create'].includes(l.type)).reverse().slice(0,50);
  const list = notes.map(n => `<div class="card"><strong>${n.type}</strong><p class="muted">${n.detail||''}</p><small class="muted">${n.actor||'System'} · ${new Date(n.at).toLocaleString()}</small></div>`).join('') || '<p class="muted">No notifications</p>';
  res.send(layout(req.user, 'Notifications', `<div class="hero"><h2>Notifications</h2></div>${list}`, highestRank));
});
app.get('/admin/announcements', checkAccess, async (req, res) => {
  if (!req.user.hasBotManagement) return res.redirect('/announcements');
  const highestRank = await getHighestRoleName(req.user.id);
  const list = read(files.announcements).reverse().map(a => `<div class="card"><strong>${a.title}</strong><p class="muted">${a.content}</p></div>`).join('') || '<p class="muted">None</p>';
  res.send(layout(req.user, 'Admin Announcements', `
    <div class="card"><h2>Post Announcement</h2>
      <form method="POST" action="/admin/announcements/create">
        <input name="title" required placeholder="Title"/>
        <textarea name="content" required rows="4"></textarea>
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
  const rows = read(files.audit).slice().reverse().slice(0,400).map(l => `<div class="card" style="padding:14px"><strong>${l.type}</strong> <span class="muted">${new Date(l.at).toLocaleString()}</span><p style="margin-top:6px"><strong>${l.actor||'System'}</strong>: ${l.detail||''}</p></div>`).join('') || '<p class="muted">No logs yet.</p>';
  res.send(layout(req.user, 'Logs', `<div class="hero"><h2>Audit Logs</h2><p class="muted">Website activity stream</p></div>${rows}`, highestRank));
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
  res.send(layout(req.user, 'Settings', `<div class="hero"><h2>Settings</h2><p class="muted">Profile, appearance, and notification preferences.</p></div>${tabs}${body}`, highestRank));
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
