module.exports = {
  siteName: "Lone Star College",
  siteSubtitle: "Staff Operations Portal",

  logo: "https://cdn.phototourl.com/member/2026-09-25-72dbe19e-0086-4a2b-b1ee-ee3e00a43c97.png",
  loginLogo: "https://cdn.phototourl.com/member/2026-09-25-72dbe19e-0086-4a2b-b1ee-ee3e00a43c97.png",
  favicon: "https://cdn.phototourl.com/member/2026-09-25-72dbe19e-0086-4a2b-b1ee-ee3e00a43c97.png",

  roles: {
    webAccess: "KEY | Web",
    botManagement: "KEY | Bot Management",
    tickets: "KEY | Tickets"
  },

  colors: {
    primary: "#0ea5e9",
    accent: "#B30838",
    background: "#050814",
    card: "#0c1322",
    text: "#eef3fb",
    muted: "#8b9bb8"
  },

  questionsOfTheDay: [
    "What’s one thing you can improve in your department this week?",
    "How can we make the student experience better?",
    "Who on the team deserves recognition today?",
    "What’s a challenge you’re currently facing?",
    "What are you most proud of this month?"
  ],

  badWords: ["fuck", "shit", "bitch", "asshole", "nigger", "faggot", "cunt", "retard"],

  notificationOptions: [
    { key: "discordDms", label: "Discord notifications (bot DMs)" },
    { key: "websiteAlerts", label: "Website / desktop alerts" },
    { key: "interfaceSounds", label: "Interface sounds" },
    { key: "ticketUpdates", label: "Ticket updates" },
    { key: "ticketReminder", label: "Ticket reminder" },
    { key: "payoutAlerts", label: "Payout alerts" },
    { key: "entryUpdates", label: "Entry updates" },
    { key: "projectUpdates", label: "Project updates" },
    { key: "leaveUpdates", label: "Leave updates" },
    { key: "eventUpdates", label: "Event updates" },
    { key: "surveyUpdates", label: "Survey updates" },
    { key: "safetyReports", label: "Safety reports" },
    { key: "investigationCases", label: "Investigation cases" },
    { key: "jobApplications", label: "Job applications" },
    { key: "bugReports", label: "Bug reports" }
  ]
};
