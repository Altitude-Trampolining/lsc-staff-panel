require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
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
  macros: path.join(dataDir, 'macros.json'),
  timeouts: path.join(dataDir, 'timeouts.json'),
  forceMessages: path.join(dataDir, 'forceMessages.json')
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
function withToast(url, message, type) {
  type = type || 'success';
  const join = url.indexOf('?') >= 0 ? '&' : '?';
  return url + join + 'toast=' + encodeURIComponent(message) + '&toastType=' + encodeURIComponent(type);
}

async function sendDiscordLog(title, description, color) {
  color = color || 0x38bdf8;
  const channelId = process.env.AUDIT_LOG_CHANNEL_ID;
  if (!channelId || !process.env.BOT_TOKEN) return;
  try {
    await fetch('https://discord.com/api/v10/channels/' + channelId + '/messages', {
      method: 'POST',
      headers: {
        Authorization: 'Bot ' + process.env.BOT_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        embeds: [{
          title: title,
          description: description,
          color: color,
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
  logs.push({
    id: Date.now().toString(),
    type: entry.type || 'audit',
    actorId: entry.actorId || '',
    actor: entry.actor || 'System',
    detail: entry.detail || '',
    at: new Date().toISOString()
  });
  save(files.audit, logs.slice(-3000));
  sendDiscordLog(
    entry.type || 'Audit',
    '**Actor:** ' + (entry.actor || 'System') + '\n**Detail:** ' + (entry.detail || '—')
  );
}

function defaultNotifications() {
  const n = {};
  (config.notificationOptions || []).forEach(function (o) {
    n[o.key] = true;
  });
  return n;
}

function getProfile(userId) {
  const all = read(files.profiles);
  const base = {
    displayName: '',
    bio: '',
    tagline: '',
    bannerUrl: '',
    timezone: 'America/Chicago',
    accent: config.colors.primary,
    compactMode: false,
    collapseSidebar: false,
    notifications: defaultNotifications()
  };
  const existing = all[userId] || {};
  return Object.assign({}, base, existing, {
    notifications: Object.assign({}, defaultNotifications(), existing.notifications || {})
  });
}

function saveProfile(userId, data) {
  const all = read(files.profiles);
  all[userId] = Object.assign({}, getProfile(userId), data);
  save(files.profiles, all);
}

function clearExpiredTimeouts() {
  const list = read(files.timeouts).filter(function (x) {
    return new Date(x.until).getTime() > Date.now();
  });
  save(files.timeouts, list);
}

function getTimeout(userId) {
  clearExpiredTimeouts();
  return read(files.timeouts).find(function (x) {
    return String(x.userId) === String(userId) && new Date(x.until).getTime() > Date.now();
  }) || null;
}

function getForceMessage(userId) {
  return read(files.forceMessages).find(function (x) {
    return String(x.userId) === String(userId);
  }) || null;
}

function clearForceMessage(userId) {
  save(
    files.forceMessages,
    read(files.forceMessages).filter(function (x) {
      return String(x.userId) !== String(userId);
    })
  );
}

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'lsc-secret',
  resave: false,
  saveUninitialized: false
});

passport.serializeUser(function (u, d) { d(null, u); });
passport.deserializeUser(function (o, d) { d(null, o); });
passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL,
  scope: ['identify', 'guilds']
}, function (accessToken, refreshToken, profile, done) {
  profile.accessToken = accessToken;
  return done(null, profile);
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

async function getMemberRoles(userId) {
  try {
    const res = await fetch(
      'https://discord.com/api/v10/guilds/' + process.env.GUILD_ID + '/members/' + userId,
      { headers: { Authorization: 'Bot ' + process.env.BOT_TOKEN } }
    );
    if (!res.ok) return [];
    return (await res.json()).roles || [];
  } catch (e) {
    return [];
  }
}

async function getGuildRoles() {
  try {
    const res = await fetch(
      'https://discord.com/api/v10/guilds/' + process.env.GUILD_ID + '/roles',
      { headers: { Authorization: 'Bot ' + process.env.BOT_TOKEN } }
    );
    if (!res.ok) return [];
    return await res.json();
  } catch (e) {
    return [];
  }
}

async function getHighestRoleName(userId) {
  try {
    const memberRoles = await getMemberRoles(userId);
    const guildRoles = await getGuildRoles();
    const userRoles = guildRoles
      .filter(function (r) { return memberRoles.indexOf(r.id) >= 0; })
      .sort(function (a, b) { return b.position - a.position; });
    return userRoles[0] ? userRoles[0].name : 'Staff';
  } catch (e) {
    return 'Staff';
  }
}

async function getMemberRoleNames(userId) {
  try {
    const memberRoles = await getMemberRoles(userId);
    const guildRoles = await getGuildRoles();
    return guildRoles
      .filter(function (r) { return memberRoles.indexOf(r.id) >= 0 && r.name !== '@everyone'; })
      .sort(function (a, b) { return b.position - a.position; })
      .map(function (r) { return r.name; });
  } catch (e) {
    return [];
  }
}

function containsBadWord(text) {
  const lower = String(text || '').toLowerCase();
  return config.badWords.some(function (w) { return lower.indexOf(w) >= 0; });
}

async function dmUser(userId, embed) {
  try {
    const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: {
        Authorization: 'Bot ' + process.env.BOT_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ recipient_id: userId })
    });
    const dm = await dmRes.json();
    if (!dm.id) return false;
    await fetch('https://discord.com/api/v10/channels/' + dm.id + '/messages', {
      method: 'POST',
      headers: {
        Authorization: 'Bot ' + process.env.BOT_TOKEN,
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

async function postLoaReviewMessage(loa) {
  const channelId = process.env.LOA_REVIEW_CHANNEL_ID;
  if (!channelId || !process.env.BOT_TOKEN) return;
  try {
    await fetch('https://discord.com/api/v10/channels/' + channelId + '/messages', {
      method: 'POST',
      headers: {
        Authorization: 'Bot ' + process.env.BOT_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        embeds: [{
          title: 'Leave of Absence Request',
          color: 0x38bdf8,
          fields: [
            { name: 'Staff', value: loa.username + '\n`' + loa.userId + '`', inline: true },
            { name: 'Available for basics?', value: loa.availableBasics ? 'Yes' : 'No', inline: true },
            { name: 'Dates', value: loa.start + ' → ' + loa.end },
            { name: 'Reason', value: loa.reason || '—' }
          ],
          footer: { text: 'LOA ID: ' + loa.id },
          timestamp: new Date().toISOString()
        }],
        components: [{
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Accept', custom_id: 'loa_accept_' + loa.id },
            { type: 2, style: 4, label: 'Deny', custom_id: 'loa_deny_' + loa.id }
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
  const webRole = guildRoles.find(function (r) { return r.name === config.roles.webAccess; });
  const botRole = guildRoles.find(function (r) { return r.name === config.roles.botManagement; });
  const hasWeb = webRole && memberRoles.indexOf(webRole.id) >= 0;
  const hasBot = botRole && memberRoles.indexOf(botRole.id) >= 0;

  if (!hasWeb && !hasBot) {
    return res.send(
      '<!DOCTYPE html><html><body style="background:#070b14;color:#fff;font-family:system-ui;display:flex;height:100vh;align-items:center;justify-content:center;text-align:center"><div><h1>Access Denied</h1><p>You need <b>' +
      config.roles.webAccess +
      '</b></p><a href="/logout" style="color:#38bdf8">Logout</a></div></body></html>'
    );
  }

  req.user.hasBotManagement = !!hasBot;

  clearExpiredTimeouts();
  const timeout = getTimeout(req.user.id);
  const allowedWhileTimedOut = req.path === '/timeout' || req.path === '/logout';
  if (timeout && !allowedWhileTimedOut) return res.redirect('/timeout');

  next();
}

function requireBotMgmt(req, res, next) {
  if (!req.user || !req.user.hasBotManagement) return res.status(403).send('Forbidden');
  next();
}

function layout(user, title, content, highestRank) {
  highestRank = highestRank || 'Staff';
  const isManager = user.hasBotManagement;
  const p = getProfile(user.id);
  const compactClass = p.compactMode ? 'compact' : '';
  const collapseClass = p.collapseSidebar ? 'collapse-side' : '';

  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0"/>' +
    '<title>' + title + ' • ' + config.siteName + '</title>' +
    '<link rel="icon" href="' + (config.favicon || config.logo) + '"/>' +
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">' +
    '<style>' +
    ':root{--bg:' + config.colors.background + ';--card:' + config.colors.card + ';--primary:' + config.colors.primary + ';--accent:' + config.colors.accent + ';--text:' + config.colors.text + ';--muted:' + config.colors.muted + ';--border:rgba(148,163,184,.14);--shadow:0 20px 50px rgba(0,0,0,.35)}' +
    'body.light{--bg:#f5f7fb;--card:#fff;--text:#0f172a;--muted:#64748b;--border:#e2e8f0}' +
    '*{box-sizing:border-box;margin:0;padding:0;scrollbar-width:none;-ms-overflow-style:none}' +
    '*::-webkit-scrollbar{width:0;height:0;display:none}' +
    'body{font-family:Inter,system-ui,sans-serif;background:radial-gradient(1200px 600px at 0% -10%,rgba(56,189,248,.16),transparent 55%),var(--bg);color:var(--text);min-height:100vh}' +
    '.sidebar{width:300px;height:100vh;position:fixed;left:0;top:0;background:rgba(10,16,28,.92);border-right:1px solid var(--border);padding:18px 12px;display:flex;flex-direction:column;z-index:40;overflow-y:auto}' +
    'body.collapse-side .sidebar{width:92px}body.collapse-side .logo-text,body.collapse-side .nav-label,body.collapse-side .nav a span.label{display:none}body.collapse-side .nav a{justify-content:center}body.collapse-side .main{margin-left:92px}' +
    '.logo{display:flex;align-items:center;gap:12px;padding:10px;margin-bottom:10px}' +
    '.logo img{width:44px;height:44px;border-radius:14px}' +
    '.logo-text{font-weight:900;font-size:14px}.logo-text span{display:block;color:var(--muted);font-size:11px;font-weight:600}' +
    '.nav-label{font-size:11px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#cbd5e1;padding:16px 12px 8px}' +
    '.nav a{display:flex;align-items:center;gap:10px;padding:12px;border-radius:14px;color:var(--muted);text-decoration:none;margin-bottom:4px;font-size:14px;font-weight:700}' +
    '.nav a:hover,.nav a.active{background:rgba(56,189,248,.14);color:var(--primary)}' +
    '.nav a .dot{width:8px;height:8px;border-radius:50%;background:currentColor;opacity:.55}' +
    '.main{margin-left:300px;padding:28px 34px 60px}' +
    '.topbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:22px}' +
    '.page-title h1{font-size:clamp(24px,3vw,34px);font-weight:900}' +
    '.page-title p{color:var(--muted);font-size:14px;margin-top:4px}' +
    '.profile{display:flex;align-items:center;gap:12px;background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:999px;padding:7px 14px 7px 7px}' +
    '.profile img{width:36px;height:36px;border-radius:50%}' +
    '.hero,.card{animation:rise .4s ease both}' +
    '@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}' +
    '.hero{background:linear-gradient(135deg,rgba(56,189,248,.16),rgba(251,113,133,.08));border:1px solid var(--border);border-radius:24px;padding:24px;margin-bottom:18px}' +
    '.card{background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:20px;padding:20px;margin-bottom:16px}' +
    'h2{font-size:18px;font-weight:800;margin-bottom:10px}.muted{color:var(--muted);font-size:14px}' +
    '.btn{background:linear-gradient(135deg,var(--primary),#0ea5e9);color:#041018;border:none;padding:11px 16px;border-radius:12px;cursor:pointer;font-weight:800;text-decoration:none;display:inline-flex;font-size:14px}' +
    '.btn-outline{background:transparent;color:var(--text);border:1px solid var(--border)}' +
    '.btn-row{display:flex;flex-wrap:wrap;gap:10px}' +
    'input,textarea,select{width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--border);background:rgba(255,255,255,.03);color:var(--text);margin:8px 0 12px;font-size:14px}' +
    '.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}' +
    '.stat{font-size:30px;font-weight:900}' +
    '.badge{display:inline-flex;background:rgba(56,189,248,.12);color:var(--primary);font-size:11px;padding:5px 10px;border-radius:999px;font-weight:800;margin:2px}' +
    '.badge-green{background:rgba(34,197,94,.12);color:#4ade80}.badge-red{background:rgba(239,68,68,.12);color:#f87171}.badge-yellow{background:rgba(234,179,8,.12);color:#facc15}' +
    '.msg{padding:14px 16px;border-radius:16px;margin-bottom:12px;border:1px solid var(--border)}' +
    '.msg.user{background:rgba(34,197,94,.08);border-left:3px solid #22c55e}' +
    '.msg.staff{background:rgba(56,189,248,.08);border-left:3px solid var(--primary)}' +
    '.msg.internal{background:rgba(234,179,8,.08);border-left:3px solid #eab308}' +
    '.switch-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid var(--border)}' +
    '.switch{position:relative;width:52px;height:30px;flex-shrink:0}.switch input{opacity:0;width:0;height:0}' +
    '.slider{position:absolute;cursor:pointer;inset:0;background:#334155;border-radius:999px}.slider:before{position:absolute;content:"";height:22px;width:22px;left:4px;top:4px;background:#fff;border-radius:50%;transition:.2s}' +
    '.switch input:checked + .slider{background:var(--primary)}.switch input:checked + .slider:before{transform:translateX(22px)}' +
    '.ticket-shell{display:grid;grid-template-columns:1.7fr .9fr;gap:16px}.chat-box{max-height:520px;overflow-y:auto}' +
    '.role-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}' +
    '.action-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}' +
    '.action-card{display:block;padding:16px;border-radius:16px;border:1px solid var(--border);background:rgba(255,255,255,.03);text-decoration:none;color:var(--text);font-weight:800}' +
    '.action-card span{display:block;color:var(--muted);font-size:12px;font-weight:600;margin-top:6px}' +
    '.page-enter{animation:pageIn .35s ease both}@keyframes pageIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}' +
    '#topProgress{position:fixed;top:0;left:0;height:3px;width:0%;background:linear-gradient(90deg,var(--primary),#22d3ee);z-index:9999;opacity:0}' +
    '#topProgress.active{opacity:1}' +
    '#toastWrap{position:fixed;right:18px;bottom:18px;z-index:10000;display:flex;flex-direction:column;gap:10px;max-width:min(360px,calc(100vw - 24px))}' +
    '.toast{background:rgba(13,21,36,.96);border:1px solid var(--border);border-left:3px solid #4ade80;color:var(--text);padding:12px 14px;border-radius:14px;font-size:14px;font-weight:600}' +
    '.toast.error{border-left-color:#f87171}' +
    '.mobile-top{display:none}' +
    '@media(max-width:980px){.sidebar{transform:translateX(-105%)}.sidebar.open{transform:none}.main{margin-left:0;padding:18px 16px 50px}.grid,.grid-4,.ticket-shell,.action-grid{grid-template-columns:1fr}.mobile-top{display:flex;justify-content:space-between;margin-bottom:14px}}' +
    '</style></head><body class="' + compactClass + ' ' + collapseClass + '">' +
    '<div id="topProgress"></div><div id="toastWrap"></div>' +
    '<div class="sidebar" id="sidebar">' +
    '<div class="logo"><img src="' + config.logo + '" alt=""/><div class="logo-text">' + config.siteName + '<span>' + config.siteSubtitle + '</span></div></div>' +
    '<div class="nav">' +
    '<div class="nav-label">Overview</div>' +
    '<a href="/dashboard" class="' + (title === 'Dashboard' ? 'active' : '') + '"><span class="dot"></span><span class="label">Dashboard</span></a>' +
    '<div class="nav-label">Community</div>' +
    '<a href="/support" class="' + (title === 'Support' ? 'active' : '') + '"><span class="dot"></span><span class="label">Support</span></a>' +
    '<a href="/announcements" class="' + (title === 'Announcements' ? 'active' : '') + '"><span class="dot"></span><span class="label">Announcements</span></a>' +
    '<a href="/notifications" class="' + (title === 'Notifications' ? 'active' : '') + '"><span class="dot"></span><span class="label">Notifications</span></a>' +
    '<div class="nav-label">Management</div>' +
    '<a href="/loa" class="' + (title === 'LOA' ? 'active' : '') + '"><span class="dot"></span><span class="label">Leave of Absence</span></a>' +
    '<a href="/settings" class="' + (title === 'Settings' ? 'active' : '') + '"><span class="dot"></span><span class="label">Settings</span></a>' +
    (isManager
      ? ('<div class="nav-label">Administration</div>' +
        '<a href="/admin" class="' + (title === 'Admin' ? 'active' : '') + '"><span class="dot"></span><span class="label">Admin</span></a>' +
        '<a href="/admin/announcements" class="' + (title === 'Admin Announcements' ? 'active' : '') + '"><span class="dot"></span><span class="label">Post Announcements</span></a>' +
        '<a href="/logs" class="' + (title === 'Logs' ? 'active' : '') + '"><span class="dot"></span><span class="label">Audit Logs</span></a>')
      : '') +
    '<a href="/logout" style="margin-top:auto;color:#fb7185"><span class="dot"></span><span class="label">Logout</span></a>' +
    '</div></div>' +
    '<div class="main">' +
    '<div class="mobile-top"><button class="btn btn-outline" type="button" onclick="document.getElementById(\'sidebar\').classList.toggle(\'open\')">Menu</button><button class="btn btn-outline" type="button" onclick="toggleTheme()">Theme</button></div>' +
    '<div class="topbar"><div class="page-title"><h1>' + title + '</h1><p>Lone Star College Administration</p></div>' +
    '<div style="display:flex;align-items:center;gap:12px">' +
    '<button class="btn btn-outline" onclick="toggleTheme()" style="padding:8px 12px">Theme</button>' +
    '<div class="profile"><img src="' + (user.avatar ? ('https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png') : 'https://via.placeholder.com/36') + '" alt=""/>' +
    '<div style="font-size:13px"><div style="font-weight:800">' + user.username + '</div><div class="muted" style="font-size:11px">' + highestRank + '</div></div></div></div></div>' +
    '<div class="page-enter">' + content + '</div></div>' +
    '<script src="https://cdn.jsdelivr.net/npm/socket.io-client@4/dist/socket.io.min.js"></script>' +
    '<script src="https://cdn.jsdelivr.net/npm/rrweb@1.1.3/dist/record/rrweb-record.min.js"></script>' +
    '<script>' +
    'function toggleTheme(){document.body.classList.toggle("light");localStorage.setItem("theme",document.body.classList.contains("light")?"light":"dark")}' +
    'if(localStorage.getItem("theme")==="light")document.body.classList.add("light");' +
    'var idle=0;function resetIdle(){idle=0}setInterval(function(){idle++;if(idle>=30)location.href="/logout"},60000);' +
    '["load","mousemove","keypress","click","scroll","touchstart"].forEach(function(e){window.addEventListener(e,resetIdle,{passive:true})});' +
    'function showToast(message,type){type=type||"success";var wrap=document.getElementById("toastWrap");if(!wrap||!message)return;var el=document.createElement("div");el.className="toast "+(type==="error"?"error":"");el.textContent=message;wrap.appendChild(el);setTimeout(function(){el.remove()},3200)}' +
    '(function(){var p=new URLSearchParams(location.search);var m=p.get("toast");if(m){showToast(m,p.get("toastType")||"success");p.delete("toast");p.delete("toastType");history.replaceState({},"",location.pathname+(p.toString()?"?"+p.toString():""))}})();' +
    // force message
    'fetch("/api/force-message").then(function(r){return r.json()}).then(function(data){if(!data||!data.hasMessage)return;var o=document.createElement("div");o.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:10050;display:flex;align-items:center;justify-content:center;padding:16px";o.innerHTML="<div style=\\"max-width:460px;width:100%;background:#0d1524;border:1px solid rgba(148,163,184,.2);border-radius:18px;padding:22px;color:#f1f5f9\\"><h2 style=\\"margin:0 0 10px\\">Message from administration</h2><p style=\\"color:#94a3b8\\">From: <strong>"+(data.by||"Admin")+"</strong></p><p style=\\"line-height:1.6;margin-top:8px\\">"+(data.message||"")+"</p><button id=\\"forceMsgOk\\" style=\\"margin-top:16px;background:#38bdf8;border:0;border-radius:12px;padding:11px 16px;font-weight:800;cursor:pointer\\">OK</button></div>";document.body.appendChild(o);document.getElementById("forceMsgOk").onclick=function(){fetch("/api/force-message/ack",{method:"POST"}).finally(function(){o.remove()})}}).catch(function(){});' +
    // session notice + recorder
    '(function(){var KEY="lsc_session_notice_v1";var socket=null;var buffer=[];function startRecording(){if(!window.rrwebRecord)return;socket=io({path:"/socket.io"});socket.emit("session:hello",{page:location.pathname});rrwebRecord({emit:function(ev){if(document.hidden)return;buffer.push(ev)},maskAllInputs:true,recordCanvas:false});setInterval(function(){if(!buffer.length||document.hidden)return;var batch=buffer.slice();buffer=[];socket.emit("session:events",{page:location.pathname,events:batch})},1000);function onHide(){if(document.hidden){buffer=[];socket&&socket.emit("session:left")}else{socket&&socket.emit("session:hello",{page:location.pathname})}}document.addEventListener("visibilitychange",onHide);window.addEventListener("blur",function(){socket&&socket.emit("session:left")});window.addEventListener("beforeunload",function(){socket&&socket.emit("session:left")})}function showNotice(){if(localStorage.getItem(KEY)==="hidden"){startRecording();return}var o=document.createElement("div");o.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:10040;display:flex;align-items:center;justify-content:center;padding:16px";o.innerHTML="<div style=\\"max-width:520px;width:100%;background:#0d1524;border:1px solid rgba(148,163,184,.2);border-radius:18px;padding:22px;color:#f1f5f9\\"><h2 style=\\"margin:0 0 12px\\">Activity notice</h2><p style=\\"color:#94a3b8;line-height:1.65\\">Your activity on this website is being recorded for support, security, and quality purposes. Only what happens on this site is visible to admins. Switching tabs or leaving the page stops the view.</p><div style=\\"display:flex;flex-wrap:wrap;gap:10px;margin-top:16px\\"><button id=\\"noticeOk\\" style=\\"background:#38bdf8;border:0;border-radius:12px;padding:11px 16px;font-weight:800;cursor:pointer\\">I understand</button><button id=\\"noticeStop\\" style=\\"background:transparent;border:1px solid rgba(148,163,184,.25);color:#e2e8f0;border-radius:12px;padding:11px 16px;font-weight:700;cursor:pointer\\">Stop showing me this popup every time I log in</button></div></div>";document.body.appendChild(o);document.getElementById("noticeOk").onclick=function(){o.remove();startRecording()};document.getElementById("noticeStop").onclick=function(){localStorage.setItem(KEY,"hidden");o.remove();startRecording()}}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",showNotice);else showNotice()})();' +
    '</script></body></html>';
}

function legalPage(title, body) {
  return '<!DOCTYPE html><html><head><title>' + title + '</title><link rel="icon" href="' + (config.favicon || config.logo) + '"/>' +
    '<style>body{margin:0;font-family:system-ui;background:#070b14;color:#f1f5f9;padding:40px 18px}.wrap{max-width:760px;margin:0 auto;background:#0d1524;border:1px solid rgba(148,163,184,.14);border-radius:20px;padding:28px}a{color:#38bdf8;text-decoration:none}p{color:#94a3b8;line-height:1.7;margin:12px 0}</style></head>' +
    '<body><div class="wrap"><h1>' + title + '</h1>' + body +
    '<p style="margin-top:24px"><a href="/login">← Back to login</a></p>' +
    '<p style="color:#64748b;font-size:12px">© 2026 Roblox, Lone Star College. All rights reserved.</p></div></body></html>';
}

app.get('/', function (req, res) {
  if (req.isAuthenticated()) return res.redirect('/dashboard');
  res.redirect('/login');
});

app.get('/login', function (req, res) {
  res.send(
    '<!DOCTYPE html><html><head><title>Staff Portal • ' + config.siteName + '</title>' +
    '<link rel="icon" href="' + (config.favicon || config.logo) + '"/>' +
    '<style>body{margin:0;font-family:Inter,system-ui;min-height:100vh;display:flex;align-items:center;justify-content:center;color:#f1f5f9;background:#070b14}' +
    '.box{width:min(440px,92vw);background:#0d1524;border:1px solid rgba(148,163,184,.14);border-radius:28px;padding:42px 34px;text-align:center}' +
    'img{width:84px;height:84px;border-radius:22px;margin-bottom:18px}h1{font-size:30px;font-weight:900;margin-bottom:8px}' +
    '.btn{display:inline-flex;width:100%;justify-content:center;background:#5865F2;color:#fff;text-decoration:none;padding:14px 18px;border-radius:14px;font-weight:800}' +
    '.legal{margin-top:22px;font-size:12px;color:#94a3b8}.legal a{color:#94a3b8;text-decoration:none;margin:0 6px}' +
    '.copy{margin-top:14px;font-size:11px;color:#64748b}</style></head><body><div class="box">' +
    '<img src="' + config.loginLogo + '"/><h1>Staff Portal</h1>' +
    '<p style="color:#94a3b8;margin-bottom:24px">' + config.siteName + '<br/>Authorized personnel only</p>' +
    '<a class="btn" href="/auth/discord">Continue with Discord</a>' +
    '<div class="legal"><a href="/privacy">Privacy</a>•<a href="/terms">Terms of Service</a>•<a href="/cookies">Cookies</a></div>' +
    '<div class="copy">© 2026 Roblox, Lone Star College. All rights reserved.</div></div></body></html>'
  );
});

app.get('/privacy', function (req, res) {
  res.send(legalPage('Privacy Policy', '<p>Staff portal uses Discord identity for authentication.</p><p>On-site activity may be monitored for support and security after notice.</p>'));
});
app.get('/terms', function (req, res) {
  res.send(legalPage('Terms of Service', '<p>Authorized staff only. Misuse is prohibited.</p>'));
});
app.get('/cookies', function (req, res) {
  res.send(legalPage('Cookies', '<p>Session cookies keep you signed in. Local storage saves UI preferences and notice dismissal.</p>'));
});

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/login' }), function (req, res) {
  addAudit({ type: 'login', actorId: req.user.id, actor: req.user.username, detail: 'Staff logged into website' });
  res.redirect(withToast('/dashboard', 'Welcome back'));
});
app.get('/logout', function (req, res) {
  if (req.user) addAudit({ type: 'logout', actorId: req.user.id, actor: req.user.username, detail: 'Staff logged out of website' });
  req.logout(function () { res.redirect('/login'); });
});

app.get('/timeout', checkAccess, function (req, res) {
  const t = getTimeout(req.user.id);
  if (!t) return res.redirect('/dashboard');
  const untilMs = new Date(t.until).getTime();
  res.send(
    '<!DOCTYPE html><html><head><title>Timed Out</title><style>' +
    'body{margin:0;font-family:system-ui;background:#070b14;color:#f1f5f9;display:flex;min-height:100vh;align-items:center;justify-content:center}' +
    '.box{max-width:480px;background:#0d1524;border:1px solid rgba(148,163,184,.14);border-radius:20px;padding:28px}' +
    '.btn{display:inline-block;margin-top:16px;background:#38bdf8;color:#041018;padding:12px 16px;border-radius:12px;text-decoration:none;font-weight:800}' +
    '.muted{color:#94a3b8}</style></head><body><div class="box">' +
    '<h1>You are timed out</h1>' +
    '<p class="muted">Reason: <strong>' + (t.reason || 'No reason provided') + '</strong></p>' +
    '<p class="muted">By: <strong>' + (t.by || 'Administration') + '</strong></p>' +
    '<p>Time remaining: <strong id="cd">--:--</strong></p>' +
    '<a class="btn" href="/logout">Log out</a>' +
    '<script>var until=' + untilMs + ';function tick(){var left=Math.max(0,until-Date.now());var m=Math.floor(left/60000),s=Math.floor((left%60000)/1000);document.getElementById("cd").textContent=String(m).padStart(2,"0")+":"+String(s).padStart(2,"0");if(left<=0)location.href="/dashboard"}tick();setInterval(tick,1000);</script>' +
    '</div></body></html>'
  );
});

app.get('/api/force-message', checkAccess, function (req, res) {
  const msg = getForceMessage(req.user.id);
  if (!msg) return res.json({ hasMessage: false });
  res.json({ hasMessage: true, message: msg.message, by: msg.by });
});
app.post('/api/force-message/ack', checkAccess, function (req, res) {
  clearForceMessage(req.user.id);
  res.json({ ok: true });
});

app.post('/api/modmail/ticket', function (req, res) {
  if (req.headers['x-modmail-secret'] !== process.env.MODMAIL_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const userId = String(req.body.userId || '');
  const username = req.body.username || 'Unknown';
  const content = req.body.content;
  const tickets = read(files.tickets);
  let ticket = tickets.find(function (t) {
    return String(t.userId) === userId && t.status !== 'closed';
  });
  const isNew = !ticket;
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
    ticket.messages.push({ from: 'user', author: username, content: content, timestamp: new Date().toISOString() });
  }
  save(files.tickets, tickets);
  addAudit({
    type: isNew ? 'ticket_create' : 'ticket_user_reply',
    actorId: userId,
    actor: username,
    detail: isNew ? ('New ticket #' + ticket.id) : ('Reply on #' + ticket.id)
  });
  res.json({ success: true, ticket: ticket });
});

app.post('/api/loa/:id/decision', async function (req, res) {
  if (req.headers['x-modmail-secret'] !== process.env.MODMAIL_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const loas = read(files.loa);
  const loa = loas.find(function (l) { return String(l.id) === String(req.params.id); });
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
      description: 'Your leave request has been **approved**.\n\n**Dates:** ' + loa.start + ' → ' + loa.end + '\n**Reason:** ' + loa.reason + (note ? ('\n**Note:** ' + note) : ''),
      footer: { text: 'Reviewed by ' + reviewer },
      timestamp: new Date().toISOString()
    });
    addAudit({ type: 'loa_approved', actorId: reviewerId, actor: reviewer, detail: 'Approved LOA ' + loa.id + ' for ' + loa.username });
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
      description: 'Your leave request has been **denied**.\n\n**Dates:** ' + loa.start + ' → ' + loa.end + '\n**Reason submitted:** ' + loa.reason + '\n**Denial reason:** ' + loa.denyReason,
      footer: { text: 'Reviewed by ' + reviewer },
      timestamp: new Date().toISOString()
    });
    addAudit({ type: 'loa_denied', actorId: reviewerId, actor: reviewer, detail: 'Denied LOA ' + loa.id + ' for ' + loa.username });
  }
  save(files.loa, loas);
  res.json({ success: true, loa: loa });
});

app.get('/dashboard', checkAccess, async function (req, res) {
  const announcements = read(files.announcements);
  const latest = announcements[announcements.length - 1];
  const chat = read(files.chat).slice(-40).reverse();
  const tickets = read(files.tickets);
  const openTickets = tickets.filter(function (t) {
    return ['pending_staff', 'claimed', 'open'].indexOf(t.status) >= 0;
  }).length;
  const qotd = config.questionsOfTheDay[new Date().getDate() % config.questionsOfTheDay.length];
  const highestRank = await getHighestRoleName(req.user.id);
  const chatHTML = chat.map(function (m) {
    return '<div style="padding:12px 0;border-bottom:1px solid var(--border)"><strong>' + m.username + '</strong> <span class="muted" style="font-size:12px">' + new Date(m.createdAt).toLocaleString() + '</span><p style="margin-top:5px">' + m.content + '</p></div>';
  }).join('') || '<p class="muted">No messages yet.</p>';
  const latestHTML = latest
    ? ('<p><strong>' + latest.title + '</strong></p><p class="muted">' + latest.content + '</p>')
    : '<p class="muted">No announcements yet.</p>';

  res.send(layout(req.user, 'Dashboard',
    '<div class="hero"><h2>Operations Center</h2><p class="muted">Welcome back, <strong>' + req.user.username + '</strong> · ' + highestRank + '</p>' +
    '<div class="btn-row" style="margin-top:14px"><a class="btn" href="/support">Open Support</a><a class="btn btn-outline" href="/loa">Request LOA</a><a class="btn btn-outline" href="/settings">Settings</a></div></div>' +
    '<div class="grid-4">' +
    '<div class="card"><div class="stat">' + openTickets + '</div><p class="muted">Open Tickets</p></div>' +
    '<div class="card"><div class="stat">' + tickets.length + '</div><p class="muted">Total Tickets</p></div>' +
    '<div class="card"><div class="stat">' + read(files.loa).filter(function (l) { return l.status === 'pending'; }).length + '</div><p class="muted">LOA Pending</p></div>' +
    '<div class="card"><div class="stat">' + announcements.length + '</div><p class="muted">Announcements</p></div></div>' +
    '<div class="grid"><div class="card"><h2>Latest Announcement</h2>' + latestHTML + '</div>' +
    '<div class="card"><h2>Question of the Day</h2><p style="margin-bottom:12px">' + qotd + '</p>' +
    '<form method="POST" action="/chat/post"><input type="hidden" name="type" value="qotd"/><textarea name="content" required rows="3"></textarea><button class="btn" type="submit">Post Answer</button></form></div></div>' +
    '<div class="card"><h2>Staff Chat</h2><div style="max-height:320px;overflow-y:auto;margin-bottom:12px">' + chatHTML + '</div>' +
    '<form method="POST" action="/chat/post"><input type="hidden" name="type" value="chat"/><textarea name="content" required rows="2"></textarea><button class="btn" type="submit">Send Message</button></form></div>' +
    '<div class="card"><h2>Quick Actions</h2><div class="action-grid">' +
    '<a class="action-card" href="/support">Support Queue<span>Claim & reply</span></a>' +
    '<a class="action-card" href="/loa">Leave of Absence<span>Request leave</span></a>' +
    '<a class="action-card" href="/announcements">Announcements<span>Read updates</span></a>' +
    '<a class="action-card" href="/notifications">Notifications<span>Alerts</span></a>' +
    '<a class="action-card" href="/settings">Settings<span>Preferences</span></a>' +
    '<a class="action-card" href="/support/macros">Macros<span>Templates</span></a></div></div>',
    highestRank
  ));
});

app.post('/chat/post', checkAccess, function (req, res) {
  const content = String(req.body.content || '').trim();
  if (!content) return res.redirect('/dashboard');
  if (containsBadWord(content)) return res.redirect(withToast('/dashboard', 'Message blocked', 'error'));
  const chat = read(files.chat);
  chat.push({
    id: Date.now(),
    userId: req.user.id,
    username: req.user.username,
    content: content,
    type: req.body.type || 'chat',
    createdAt: new Date().toISOString()
  });
  save(files.chat, chat);
  addAudit({ type: 'staff_chat', actorId: req.user.id, actor: req.user.username, detail: content.slice(0, 120) });
  res.redirect(withToast('/dashboard', 'Message sent'));
});

app.get('/support', checkAccess, async function (req, res) {
  const highestRank = await getHighestRoleName(req.user.id);
  const tickets = read(files.tickets);
  const open = tickets.filter(function (t) { return ['open', 'claimed', 'pending_staff'].indexOf(t.status) >= 0; });
  const waitingUser = tickets.filter(function (t) { return t.status === 'pending_user'; });
  const closed = tickets.filter(function (t) { return t.status === 'closed' || t.status === 'resolved'; });
  const status = req.query.status || 'all';
  const q = String(req.query.q || '').toLowerCase();
  let filtered = tickets.slice().reverse();
  if (status !== 'all') filtered = filtered.filter(function (t) { return t.status === status; });
  if (q) {
    filtered = filtered.filter(function (t) {
      return String(t.username || '').toLowerCase().indexOf(q) >= 0 || String(t.userId || '').indexOf(q) >= 0;
    });
  }
  const cards = filtered.map(function (t) {
    const last = t.messages && t.messages.length ? t.messages[t.messages.length - 1] : null;
    return '<a class="card" href="/support/ticket/' + t.id + '" style="display:block;text-decoration:none;color:inherit"><div style="display:flex;justify-content:space-between;gap:12px"><div>' +
      '<div style="font-weight:900;font-size:16px">' + t.username + '</div><div class="muted" style="margin:6px 0">#' + t.id + '</div>' +
      '<span class="badge">' + t.status + '</span> <span class="badge">' + (t.priority || 'normal') + '</span>' +
      '<p class="muted" style="margin-top:10px">' + (last ? last.content.slice(0, 140) : 'No messages yet') + '</p>' +
      '</div><span class="btn btn-outline">Open</span></div></a>';
  }).join('') || '<p class="muted">No tickets found.</p>';

  res.send(layout(req.user, 'Support',
    '<div class="hero"><h2>Support Queue</h2><p class="muted">Live ModMail conversations.</p>' +
    '<div class="btn-row" style="margin-top:12px"><a class="btn btn-outline" href="/support/macros">Macros</a></div></div>' +
    '<div class="grid-4">' +
    '<div class="card"><div class="stat">' + open.length + '</div><p class="muted">Needs Staff</p></div>' +
    '<div class="card"><div class="stat">' + waitingUser.length + '</div><p class="muted">Waiting User</p></div>' +
    '<div class="card"><div class="stat">' + closed.length + '</div><p class="muted">Closed</p></div>' +
    '<div class="card"><div class="stat">' + tickets.length + '</div><p class="muted">Total</p></div></div>' +
    '<div class="card"><form method="GET" action="/support" style="display:grid;grid-template-columns:2fr 1fr auto;gap:10px;align-items:end">' +
    '<div><label class="muted">Search</label><input name="q" value="' + (req.query.q || '') + '"/></div>' +
    '<div><label class="muted">Status</label><select name="status"><option value="all">All</option><option value="pending_staff">Pending Staff</option><option value="pending_user">Pending User</option><option value="claimed">Claimed</option><option value="closed">Closed</option></select></div>' +
    '<button class="btn" type="submit">Filter</button></form></div>' +
    '<div id="ticketList">' + cards + '</div>',
    highestRank
  ));
});

app.get('/support/ticket/:id', checkAccess, async function (req, res) {
  const tickets = read(files.tickets);
  const ticket = tickets.find(function (t) { return t.id === req.params.id; });
  if (!ticket) return res.redirect('/support');
  const highestRank = await getHighestRoleName(req.user.id);
  const macros = read(files.macros).filter(function (m) { return m.active; });
  const roleNames = await getMemberRoleNames(ticket.userId);
  let memberInfo = { username: ticket.username, id: ticket.userId, avatar: null };
  try {
    const ures = await fetch('https://discord.com/api/v10/users/' + ticket.userId, {
      headers: { Authorization: 'Bot ' + process.env.BOT_TOKEN }
    });
    if (ures.ok) {
      const u = await ures.json();
      memberInfo.username = u.username;
      if (u.avatar) memberInfo.avatar = 'https://cdn.discordapp.com/avatars/' + u.id + '/' + u.avatar + '.png';
    }
  } catch (e) {}

  const messages = (ticket.messages || []).map(function (m) {
    const cls = m.internal ? 'internal' : m.from;
    return '<div class="msg ' + cls + '"><div style="display:flex;justify-content:space-between"><strong>' + m.author + '</strong><span class="muted" style="font-size:12px">' + new Date(m.timestamp).toLocaleString() + '</span></div>' +
      (m.internal ? '<span class="badge badge-yellow">Internal</span>' : '') +
      '<p style="margin-top:8px">' + m.content + '</p></div>';
  }).join('') || '<p class="muted">No messages</p>';
  const macroOptions = macros.map(function (m) {
    return '<option value="' + m.id + '">' + m.title + '</option>';
  }).join('');
  const rolesHTML = roleNames.length
    ? roleNames.map(function (r) { return '<span class="badge">' + r + '</span>'; }).join('')
    : '<span class="muted">No roles found</span>';

  res.send(layout(req.user, 'Support',
    '<div class="ticket-shell"><div>' +
    '<div class="card" style="display:flex;justify-content:space-between;align-items:center"><div><h2 style="margin:0">' + ticket.username + '</h2><p class="muted">#' + ticket.id + ' · ' + ticket.status + ' · ' + (ticket.priority || 'normal') + '</p></div><a class="btn btn-outline" href="/support">Back</a></div>' +
    '<div class="card"><div class="chat-box" id="chatBox">' + messages + '</div>' +
    '<form method="POST" action="/support/ticket/' + ticket.id + '/reply" style="margin-top:14px">' +
    '<div class="grid"><select name="replyType"><option value="public">Public Reply</option><option value="internal">Internal Note</option></select>' +
    '<select name="macroId"><option value="">No macro</option>' + macroOptions + '</select></div>' +
    '<textarea name="content" rows="4"></textarea>' +
    '<div class="btn-row"><button class="btn" type="submit">Send</button>' +
    '<button class="btn btn-outline" type="submit" formaction="/support/ticket/' + ticket.id + '/close" formmethod="POST" onclick="return confirm(\'Close this ticket?\')">Close</button></div></form></div></div>' +
    '<div><div class="card"><h2>Member</h2>' +
    '<img src="' + (memberInfo.avatar || 'https://via.placeholder.com/72') + '" style="width:72px;height:72px;border-radius:50%;margin:8px 0"/>' +
    '<p style="font-weight:900">' + memberInfo.username + '</p><p class="muted">' + memberInfo.id + '</p>' +
    '<p style="margin-top:12px;font-weight:800">Discord Roles</p><div class="role-list">' + rolesHTML + '</div></div>' +
    '<div class="card"><h2>Claim</h2><form method="POST" action="/support/ticket/' + ticket.id + '/claim"><button class="btn" type="submit">' + (ticket.claimedBy ? 'Re-assign to Me' : 'Claim Ticket') + '</button></form></div>' +
    '<div class="card"><h2>Status</h2><form method="POST" action="/support/ticket/' + ticket.id + '/status">' +
    '<select name="status"><option value="pending_staff">Pending Staff</option><option value="pending_user">Pending User</option><option value="claimed">Claimed</option><option value="resolved">Resolved</option><option value="closed">Closed</option></select>' +
    '<button class="btn" type="submit">Update</button></form></div>' +
    '<div class="card"><h2>Priority</h2><form method="POST" action="/support/ticket/' + ticket.id + '/priority">' +
    '<select name="priority"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select>' +
    '<button class="btn" type="submit">Update</button></form></div></div></div>' +
    '<script>setInterval(function(){fetch(location.href).then(function(r){return r.text()}).then(function(html){var doc=new DOMParser().parseFromString(html,"text/html");var next=doc.getElementById("chatBox");var cur=document.getElementById("chatBox");if(next&&cur&&next.innerHTML!==cur.innerHTML){var nearBottom=cur.scrollHeight-cur.scrollTop-cur.clientHeight<80;cur.innerHTML=next.innerHTML;if(nearBottom)cur.scrollTop=cur.scrollHeight}}).catch(function(){})},5000);</script>',
    highestRank
  ));
});

app.post('/support/ticket/:id/claim', checkAccess, async function (req, res) {
  const tickets = read(files.tickets);
  const ticket = tickets.find(function (t) { return t.id === req.params.id; });
  if (ticket) {
    ticket.status = 'claimed';
    ticket.claimedBy = req.user.id;
    ticket.claimedByName = req.user.username;
    save(files.tickets, tickets);
    addAudit({ type: 'ticket_claim', actorId: req.user.id, actor: req.user.username, detail: 'Claimed #' + ticket.id });
    await dmUser(ticket.userId, {
      color: 0x003768,
      title: 'Ticket Claimed',
      description: 'Claimed by **' + req.user.username + '**',
      footer: { text: 'Lone Star College • ModMail' },
      timestamp: new Date().toISOString()
    });
  }
  res.redirect(withToast('/support/ticket/' + req.params.id, 'Ticket claimed'));
});

app.post('/support/ticket/:id/reply', checkAccess, async function (req, res) {
  const tickets = read(files.tickets);
  const ticket = tickets.find(function (t) { return t.id === req.params.id; });
  if (!ticket) return res.redirect('/support');
  let content = String(req.body.content || '').trim();
  if (req.body.macroId) {
    const macro = read(files.macros).find(function (m) { return m.id === req.body.macroId; });
    if (macro) {
      content = macro.content
        .replace(/\{\{username\}\}/g, ticket.username)
        .replace(/\{\{id\}\}/g, ticket.userId);
    }
  }
  if (!content) return res.redirect('/support/ticket/' + req.params.id);
  const isInternal = req.body.replyType === 'internal';
  ticket.messages.push({
    from: 'staff',
    author: req.user.username,
    content: content,
    internal: isInternal,
    timestamp: new Date().toISOString()
  });
  if (!isInternal) {
    ticket.status = 'pending_user';
    await dmUser(ticket.userId, {
      color: 0x003768,
      title: 'Lone Star College Staff',
      description: content,
      footer: { text: 'Replied by ' + req.user.username },
      timestamp: new Date().toISOString()
    });
  }
  save(files.tickets, tickets);
  addAudit({
    type: isInternal ? 'ticket_note' : 'ticket_reply',
    actorId: req.user.id,
    actor: req.user.username,
    detail: '#' + ticket.id
  });
  res.redirect(withToast('/support/ticket/' + req.params.id, isInternal ? 'Internal note saved' : 'Reply sent'));
});

app.post('/support/ticket/:id/status', checkAccess, function (req, res) {
  const tickets = read(files.tickets);
  const ticket = tickets.find(function (t) { return t.id === req.params.id; });
  if (ticket) {
    ticket.status = req.body.status;
    save(files.tickets, tickets);
  }
  res.redirect(withToast('/support/ticket/' + req.params.id, 'Status updated'));
});

app.post('/support/ticket/:id/priority', checkAccess, function (req, res) {
  const tickets = read(files.tickets);
  const ticket = tickets.find(function (t) { return t.id === req.params.id; });
  if (ticket) {
    ticket.priority = req.body.priority;
    save(files.tickets, tickets);
  }
  res.redirect(withToast('/support/ticket/' + req.params.id, 'Priority updated'));
});

app.post('/support/ticket/:id/close', checkAccess, function (req, res) {
  const tickets = read(files.tickets);
  const ticket = tickets.find(function (t) { return t.id === req.params.id; });
  if (ticket) {
    ticket.status = 'closed';
    save(files.tickets, tickets);
    addAudit({ type: 'ticket_close', actorId: req.user.id, actor: req.user.username, detail: '#' + ticket.id });
  }
  res.redirect(withToast('/support', 'Ticket closed'));
});

app.get('/support/macros', checkAccess, async function (req, res) {
  const highestRank = await getHighestRoleName(req.user.id);
  const macros = read(files.macros);
  const list = macros.map(function (m) {
    return '<div class="card"><strong>' + m.title + '</strong> <span class="badge">' + (m.active ? 'Active' : 'Inactive') + '</span><p class="muted">' + m.content + '</p>' +
      '<form method="POST" action="/support/macros/' + m.id + '/toggle" style="display:inline"><button class="btn btn-outline" type="submit">Toggle</button></form> ' +
      '<form method="POST" action="/support/macros/' + m.id + '/delete" style="display:inline"><button class="btn 
