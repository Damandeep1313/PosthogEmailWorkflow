//this code is more efficient and doesnt skip any data, also has the unsubscribe logic
const express = require("express");
const mongoose = require("mongoose");
const axios = require("axios");
const sgMail = require("@sendgrid/mail");
const fs = require("fs");
require("dotenv").config();

// Setup
const app = express();
app.use(express.json());
const PORT = 3000;
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// MongoDB schema
const userSchema = new mongoose.Schema({
  email: String,
  count: Number,
  start_time: Date,
  end_time: Date,
  session_history: [Date],
  last_template_sent: String,
  last_template_sent_at: Date,
});
const User = mongoose.model("User", userSchema);

// Unsubscribed users schema
// This schema is used to store users who have unsubscribed from emails
// It contains a single field 'email' to store the email address of the unsubscribed user

const unsubscribedSchema = new mongoose.Schema({ email: String });
const UnsubscribedUser = mongoose.model(
  "UnsubscribedUser",
  unsubscribedSchema,
  "unsubscribed"
);
//

function shouldSendTemplate(user, templateName, cooldownDays = 14) {
  if (user.last_template_sent !== templateName) return true;

  if (!user.last_template_sent_at) return true;

  const now = new Date();
  const lastSent = new Date(user.last_template_sent_at);
  const diffDays = (now - lastSent) / (1000 * 60 * 60 * 24);

  return diffDays >= cooldownDays;
}

// Email sending function
function sendEmail(recipients, templateName) {
  const templateIdMap = {
    "Template A": "TEMPLATE_ID_A",
    "Template B": "TEMPLATE_ID_B",
    "Template X": "TEMPLATE_ID_X",
    Dormant: "d-c6fc3e6aee0c43718bff86e30567330e",
    Resurrecting: "d-7611a59443cd49af9ed5d7bb92fe321c",
    Returning: "d-05ad975e3347423fbb357c7d6424cff2",
  };

  const subjectMap = {
    Dormant: "We’ve missed you at On-Demand!",
    Resurrecting: "Let’s get back on track 🚀",
    Returning: "Welcome back to On-Demand!",
    "Template A": "Your Template A Subject",
    "Template B": "Your Template B Subject",
    "Template X": "Your Template X Subject",
  };

  const messages = recipients.map((email) => ({
    to: email,
    from: "info@on-demand.io",
    templateId: templateIdMap[templateName],
    dynamicTemplateData: {
    name: email.split("@")[0],
    subject: subjectMap[templateName], 
  },
  }));

  return sgMail.send(messages);
}

// Fetch PostHog data
const API_KEY = "phx_NPB9hVJVoijX72qCyJYi3azMQ59E87ZD7F25gNuvAhTXcC5";
const BASE_URL =
  "https://us.posthog.com/api/projects/128173/session_recordings/";
const LIMIT = 1000;

async function fetchSessionRecordings() {
  let allRecordings = [];
  let nextUrl = `${BASE_URL}?limit=${LIMIT}`;

  while (nextUrl) {
    try {
      const response = await axios.get(nextUrl, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      allRecordings = allRecordings.concat(response.data.results);
      nextUrl = response.data.next;
    } catch (err) {
      console.error("Error fetching from PostHog:", err.message);
      break;
    }
  }
  return allRecordings;
}

// Classify user based on inactivity
function classifyUser(user) {
  const now = new Date();
  const periodLengthDays = 7;
  const inactiveThresholdDays = 14;

  const sessions = user.session_history;
  const cutoffP0 = new Date(now - periodLengthDays * 24 * 60 * 60 * 1000);
  const cutoffP1 = new Date(now - 2 * periodLengthDays * 24 * 60 * 60 * 1000);
  const inactiveCutoff = new Date(
    now - inactiveThresholdDays * 24 * 60 * 60 * 1000
  );

  const sortedSessions = sessions.sort((a, b) => new Date(a) - new Date(b));
  const lastSession = sortedSessions[sortedSessions.length - 1];

  if (sortedSessions.length <= 1) {
    return null;
  }

  if (lastSession <= inactiveCutoff) {
    return "Dormant";
  }

  const P0 = sortedSessions.filter((date) => date > cutoffP0);
  const P1 = sortedSessions.filter(
    (date) => date <= cutoffP0 && date > cutoffP1
  );

  if (P0.length > 0 && P1.length === 0) {
    const accountAgeDays =
      (now - new Date(user.start_time)) / (1000 * 60 * 60 * 24);
    if (accountAgeDays >= 14) {
      return "Resurrecting";
    }
  }

  if (P0.length > 0 && P1.length > 0) {
    return "Returning";
  }

  return null;
}

// Main sync route
app.get("/sync", async (req, res) => {
  console.time("🔄 Sync duration");

  const recordings = await fetchSessionRecordings();
  console.log(`📦 Total recordings fetched: ${recordings.length}`);

  // Step 1: Group sessions by email
  const sessionMap = new Map();
  for (const rec of recordings) {
    const email = rec.person?.properties?.email;
    if (!email) continue;

    const end_time = new Date(rec.end_time || Date.now());

    if (!sessionMap.has(email)) {
      sessionMap.set(email, []);
    }

    sessionMap.get(email).push(end_time);
  }
  console.log(`📨 Unique emails found: ${sessionMap.size}`);

  const emailBuckets = {
    Dormant: [],
    Resurrecting: [],
    Returning: [],
  };

  let created = 0, updated = 0, skippedUnsub = 0, classified = 0;

  for (const [email, newSessions] of sessionMap.entries()) {
    const isUnsubscribed = await UnsubscribedUser.exists({ email });
    if (isUnsubscribed) {
      skippedUnsub++;
      console.log(`⛔ Skipping unsubscribed user: ${email}`);
      continue;
    }

    let user = await User.findOne({ email });

    if (!user) {
      // New user
      await User.create({
        email,
        start_time: newSessions[0],
        end_time: newSessions[newSessions.length - 1],
        count: newSessions.length,
        session_history: [...newSessions],
        last_template_sent: null,
        last_template_sent_at: null,
      });
      created++;
      console.log(`➕ Created new user: ${email}`);
      continue;
    }

    // Merge + dedupe session history
    const allSessions = [
      ...user.session_history.map((d) => new Date(d)),
      ...newSessions,
    ];

    const uniqueSessions = Array.from(
      new Set(allSessions.map((d) => d.toISOString()))
    ).map((d) => new Date(d));

    const newEndTime = new Date(
      Math.max(...uniqueSessions.map((d) => d.getTime()))
    );

    user.session_history = uniqueSessions;
    user.count = uniqueSessions.length;
    user.end_time = newEndTime;
    await user.save();
    updated++;
    

    // Classify
    const segment = classifyUser(user);
    if (segment && shouldSendTemplate(user, segment)) {
      emailBuckets[segment].push(email);
      user.last_template_sent = segment;
      user.last_template_sent_at = new Date();
      await user.save();
      classified++;
      console.log(`📬 Classified ${email} as ${segment}`);
    }
  }

  // Send emails
  for (const [segment, emails] of Object.entries(emailBuckets)) {
    if (emails.length > 0) {
      console.log(`📧 Sending ${segment} emails to: ${emails.join(", ")}`);
      await sendEmail(emails, segment);
    }
  }

  console.log(`✅ Sync complete:
- Created: ${created}
- Updated: ${updated}
- Skipped (unsubscribed): ${skippedUnsub}
- Classified for email: ${classified}
`);

  console.timeEnd("🔄 Sync duration");
  res.send("Sync complete");
});


app.post("/unsubscribe", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).send("Email is required");

  try {
    await UnsubscribedUser.updateOne(
      { email },
      { $set: { email } },
      { upsert: true }
    );
    res.send("Unsubscribed successfully.");
  } catch (err) {
    console.error("Unsubscribe error:", err);
    res.status(500).send("Error unsubscribing.");
  }
});

app.get("/unsubscribe", async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).send("Email query param is required");

  try {
    await UnsubscribedUser.updateOne(
      { email },
      { $set: { email } },
      { upsert: true }
    );
    res.send(`<h1>Unsubscribed successfully</h1><p>${email} has been unsubscribed.</p>`);
  } catch (err) {
    console.error("Unsubscribe GET error:", err);
    res.status(500).send("Error unsubscribing.");
  }
});


// DB and start server
mongoose
  .connect(
    "mongodb+srv://Damandeep:MongoDB@cluster0.9j661l9.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0"
  )
  .then(() => {
    console.log("MongoDB connected");
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  })
  .catch((err) => console.error("MongoDB error:", err));
